use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use studio_dsp::recipe::{self, Audio, Step};
use tokio::sync::Notify;

use crate::{AppState, current_user};

const SCAN: Duration = Duration::from_secs(60);
const MAX_WATCHES: usize = 20;
const MAX_FRAMES: usize = 48000 * 3600;
const MAX_BYTES: usize = 2 << 30;
const CHUNK: usize = 16 << 20;
const LOG_LEN: usize = 300;
const TRIES: u32 = 3;
const AUDIO: [&str; 12] = ["wav", "wave", "flac", "mp3", "m4a", "aac", "aif", "aiff", "ogg", "oga", "caf", "mp4"];
const FMTS: [&str; 5] = ["wav24", "wav16", "wav32", "flac24", "flac16"];
const RATES: [u32; 4] = [0, 44100, 48000, 96000];
const RK_LEN: usize = 84;
const RK_TYPES: [&str; 4] = ["bell", "lowshelf", "highshelf", "notch"];
const RK_MODS: [&str; 4] = ["off", "chorus", "flanger", "phaser"];

#[derive(Clone, Serialize, Deserialize)]
pub struct Out {
    fmt: String,
    rate: u32,
    folder: String,
    tpl: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Watch {
    id: String,
    user: String,
    name: String,
    folder: String,
    steps: Vec<Value>,
    out: Out,
    on: bool,
    created: u64,
    #[serde(default)]
    last: u64,
}

#[derive(Clone, Serialize, Deserialize)]
struct LogLine {
    t: u64,
    watch: String,
    user: String,
    file: String,
    ok: bool,
    msg: String,
}

#[derive(Default, Serialize, Deserialize)]
struct Store {
    watches: Vec<Watch>,
    done: HashMap<String, u32>,
    log: Vec<LogLine>,
}

pub struct Watcher {
    dir: PathBuf,
    key: Option<String>,
    http: reqwest::Client,
    dj: String,
    store: Mutex<Store>,
    busy: Mutex<Option<(String, String)>>,
    wake: Notify,
}

pub type Shared = Arc<Watcher>;

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn load_key() -> Option<String> {
    let file = std::env::var("STUDIO_SERVICE_KEY_FILE")
        .ok()
        .or_else(|| std::env::var("CREDENTIALS_DIRECTORY").ok().map(|d| format!("{}/service-key", d)))?;
    let key = std::fs::read_to_string(file).ok()?.trim().to_string();
    (key.len() >= 32).then_some(key)
}

pub fn open(dj: String) -> Shared {
    let dir = PathBuf::from(
        std::env::var("STATE_DIRECTORY")
            .ok()
            .and_then(|s| s.split(':').next().map(str::to_string))
            .or_else(|| std::env::var("STUDIO_STATE").ok())
            .unwrap_or_else(|| "state".into()),
    );
    std::fs::create_dir_all(&dir).ok();
    let store = std::fs::read(dir.join("watch.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    let http = reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(1800))
        .build()
        .unwrap();
    Arc::new(Watcher { dir, key: load_key(), http, dj, store: Mutex::new(store), busy: Mutex::new(None), wake: Notify::new() })
}

impl Watcher {
    fn save(&self, s: &Store) {
        let Ok(b) = serde_json::to_vec(s) else { return };
        let tmp = self.dir.join("watch.json.tmp");
        if std::fs::write(&tmp, b).is_ok() {
            std::fs::rename(&tmp, self.dir.join("watch.json")).ok();
        }
    }

    fn log(&self, w: &Watch, file: &str, ok: bool, msg: String) {
        let mut s = self.store.lock().unwrap();
        s.log.push(LogLine { t: now(), watch: w.id.clone(), user: w.user.clone(), file: file.into(), ok, msg });
        let n = s.log.len();
        if n > LOG_LEN {
            s.log.drain(..n - LOG_LEN);
        }
        self.save(&s);
    }

    fn mark(&self, w: &Watch, sha: &str, ok: bool) {
        let mut s = self.store.lock().unwrap();
        let k = format!("{}/{}", w.id, sha);
        let v = s.done.entry(k).or_insert(0);
        *v = if ok { u32::MAX } else { *v + 1 };
        self.save(&s);
    }

    fn pending(&self, w: &Watch, sha: &str) -> bool {
        let s = self.store.lock().unwrap();
        s.done.get(&format!("{}/{}", w.id, sha)).map(|v| *v < TRIES).unwrap_or(true)
    }

    fn req(&self, m: reqwest::Method, user: &str, path: &str) -> Result<reqwest::RequestBuilder, String> {
        let key = self.key.as_deref().ok_or("no service key")?;
        Ok(self.http.request(m, format!("{}{}", self.dj, path)).header("x-delicate-service", key).header("x-delicate-user", user))
    }

    async fn list(&self, user: &str, folder: &str) -> Result<Vec<Value>, String> {
        let q = enc(&format!("{}/", folder));
        let r = self.req(reqwest::Method::GET, user, &format!("/api/locker/files?prefix={}", q))?.send().await.map_err(|e| e.to_string())?;
        if !r.status().is_success() {
            return Err(format!("locker {}", r.status().as_u16()));
        }
        let v: Value = r.json().await.map_err(|e| e.to_string())?;
        Ok(v["files"].as_array().cloned().unwrap_or_default())
    }

    async fn inputs(&self, w: &Watch) -> Result<Vec<Value>, String> {
        let files = self.list(&w.user, &w.folder).await?;
        Ok(files
            .into_iter()
            .filter(|f| f["folder"].as_str() == Some(w.folder.as_str()))
            .filter(|f| ext_of(f["path"].as_str().unwrap_or("")).map(|e| AUDIO.contains(&e.as_str())).unwrap_or(false))
            .filter(|f| f["sha256"].as_str().map(|s| !s.is_empty()).unwrap_or(false))
            .collect())
    }

    async fn upload(&self, user: &str, folder: &str, base: &str, ext: &str, bytes: Vec<u8>) -> Result<(String, bool), String> {
        let taken: HashSet<String> = self
            .list(user, folder)
            .await
            .unwrap_or_default()
            .iter()
            .filter_map(|f| f["path"].as_str().map(str::to_string))
            .collect();
        let mut path = format!("{}/{}.{}", folder, base, ext);
        let mut i = 2;
        while taken.contains(&path) {
            path = format!("{}/{} ({}).{}", folder, base, i, ext);
            i += 1;
        }
        let sha = hex(&Sha256::digest(&bytes));
        let r = self
            .req(reqwest::Method::POST, user, "/api/locker/upload")?
            .json(&json!({"path": path, "size": bytes.len(), "sha256": sha}))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if r.status().as_u16() == 402 {
            return Err("the Locker is full".into());
        }
        if !r.status().is_success() {
            return Err(format!("locker {}", r.status().as_u16()));
        }
        let st: Value = r.json().await.map_err(|e| e.to_string())?;
        if st["duplicate"].as_bool() == Some(true) {
            return Ok((st["path"].as_str().unwrap_or("").to_string(), true));
        }
        let id = st["id"].as_str().ok_or("upload id")?.to_string();
        let mut off = st["offset"].as_u64().unwrap_or(0) as usize;
        let mut rounds = 0;
        while off < bytes.len() {
            rounds += 1;
            if rounds > bytes.len() / CHUNK + 20 {
                return Err("upload stalled".into());
            }
            let end = (off + CHUNK).min(bytes.len());
            let r = self
                .req(reqwest::Method::PATCH, user, &format!("/api/locker/upload/{}", id))?
                .header("content-type", "application/octet-stream")
                .header("upload-offset", off.to_string())
                .body(bytes[off..end].to_vec())
                .send()
                .await
                .map_err(|e| e.to_string())?;
            let code = r.status().as_u16();
            if code != 200 && code != 409 {
                return Err(format!("locker {}", code));
            }
            let v: Value = r.json().await.map_err(|e| e.to_string())?;
            off = v["offset"].as_u64().ok_or("offset")? as usize;
        }
        let r = self.req(reqwest::Method::POST, user, &format!("/api/locker/upload/{}/finish", id))?.send().await.map_err(|e| e.to_string())?;
        if r.status().as_u16() == 402 {
            return Err("the Locker is full".into());
        }
        if !r.status().is_success() {
            return Err(format!("locker {}", r.status().as_u16()));
        }
        let v: Value = r.json().await.map_err(|e| e.to_string())?;
        Ok((v["path"].as_str().unwrap_or(&path).to_string(), false))
    }

    async fn process(&self, w: &Watch, f: &Value) -> Result<String, String> {
        let path = f["path"].as_str().unwrap_or("").to_string();
        let id = f["id"].as_str().ok_or("file id")?;
        let r = self.req(reqwest::Method::GET, &w.user, &format!("/api/stream/{}", id))?.send().await.map_err(|e| e.to_string())?;
        if !r.status().is_success() {
            return Err(format!("download {}", r.status().as_u16()));
        }
        if r.content_length().map(|n| n as usize > MAX_BYTES).unwrap_or(false) {
            return Err("file too large".into());
        }
        let src = r.bytes().await.map_err(|e| e.to_string())?.to_vec();
        let ext = ext_of(&path).unwrap_or_default();
        let steps = steps_of(&w.steps)?;
        let (fmt, rate) = (w.out.fmt.clone(), w.out.rate as usize);
        let (bytes, notes) = tokio::task::spawn_blocking(move || -> Result<(Vec<u8>, Vec<String>), String> {
            let mut a: Audio = recipe::decode(Box::new(std::io::Cursor::new(src)), &ext, MAX_FRAMES)?;
            let notes = recipe::run(&mut a, &steps)?;
            recipe::resample(&mut a, rate)?;
            let bits: usize = fmt[fmt.len() - 2..].parse().unwrap_or(24);
            let b = if fmt.starts_with("flac") { recipe::flac(&a, bits)? } else { recipe::wav(&a, bits)? };
            Ok((b, notes))
        })
        .await
        .map_err(|_| "processing crashed".to_string())??;
        let ext = if w.out.fmt.starts_with("flac") { "flac" } else { "wav" };
        let (to, dup) = self.upload(&w.user, &w.out.folder, &name_of(&w.out.tpl, &path), ext, bytes).await?;
        let mut msg = if dup { format!("already in the Locker as {}", to) } else { to };
        if !notes.is_empty() {
            msg = format!("{} · {}", msg, notes.join(" · "));
        }
        Ok(msg)
    }

    async fn pass(&self) {
        let list: Vec<Watch> = self.store.lock().unwrap().watches.iter().filter(|w| w.on).cloned().collect();
        for w in list {
            let files = match self.inputs(&w).await {
                Ok(f) => f,
                Err(e) => {
                    self.log(&w, &w.folder, false, e);
                    continue;
                }
            };
            for f in files {
                let sha = f["sha256"].as_str().unwrap_or("").to_string();
                if !self.pending(&w, &sha) || !self.alive(&w.id) {
                    continue;
                }
                let path = f["path"].as_str().unwrap_or("").to_string();
                *self.busy.lock().unwrap() = Some((w.id.clone(), path.clone()));
                let res = self.process(&w, &f).await;
                *self.busy.lock().unwrap() = None;
                match res {
                    Ok(m) => {
                        self.mark(&w, &sha, true);
                        self.log(&w, &path, true, m);
                    }
                    Err(e) => {
                        self.mark(&w, &sha, false);
                        self.log(&w, &path, false, e);
                    }
                }
            }
            let mut s = self.store.lock().unwrap();
            if let Some(x) = s.watches.iter_mut().find(|x| x.id == w.id) {
                x.last = now();
            }
            self.save(&s);
        }
    }

    fn alive(&self, id: &str) -> bool {
        self.store.lock().unwrap().watches.iter().any(|w| w.id == id && w.on)
    }
}

pub async fn run(w: Shared) {
    if w.key.is_none() {
        println!("watch folders off: no service key");
        return;
    }
    loop {
        w.pass().await;
        let _ = tokio::time::timeout(SCAN, w.wake.notified()).await;
    }
}

fn enc(s: &str) -> String {
    s.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-_.~/".contains(&b) { (b as char).to_string() } else { format!("%{:02X}", b) })
        .collect()
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

fn ext_of(p: &str) -> Option<String> {
    let name = p.rsplit('/').next()?;
    let (_, e) = name.rsplit_once('.')?;
    Some(e.to_ascii_lowercase())
}

fn clean(s: &str) -> String {
    s.chars().filter(|c| !c.is_control() && !"\\/:*?\"<>|".contains(*c)).collect::<String>().trim().trim_matches('.').trim().chars().take(120).collect()
}

fn folder_of(s: &str) -> String {
    s.split('/').map(|x| clean(x)).filter(|x| !x.is_empty()).collect::<Vec<_>>().join("/")
}

fn name_of(tpl: &str, path: &str) -> String {
    let file = path.rsplit('/').next().unwrap_or(path);
    let stem = file.rsplit_once('.').map(|x| x.0).unwrap_or(file);
    let date = date_of(now());
    let n = clean(&tpl.replace("$name", stem).replace("$date", &date));
    if n.is_empty() { "export".into() } else { n }
}

fn date_of(t: u64) -> String {
    let z = (t / 86400) as i64 + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{:04}-{:02}-{:02}", y, m, d)
}

fn num(v: &Value, lo: f64, hi: f64, d: f64) -> f64 {
    let x = match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    };
    x.filter(|x| x.is_finite()).map(|x| x.clamp(lo, hi)).unwrap_or(d)
}

fn on(v: &Value) -> f64 {
    let t = match v {
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map(|x| x != 0.0).unwrap_or(false),
        Value::String(s) => !s.is_empty(),
        Value::Null => false,
        _ => true,
    };
    if t { 1.0 } else { 0.0 }
}

fn ord(v: &Value) -> f64 {
    let x = num(v, 0.0, 99.0, 4.0);
    if [2.0, 4.0, 8.0].contains(&x) { x } else { 4.0 }
}

pub fn rk_cfg(o: &Value) -> Vec<f64> {
    let (hp, lp, cp, lm) = (&o["hp"], &o["lp"], &o["comp"], &o["lim"]);
    let mut a = vec![
        on(&hp["on"]),
        num(&hp["f"], 10.0, 2000.0, 30.0),
        ord(&hp["ord"]),
        on(&lp["on"]),
        num(&lp["f"], 1000.0, 24000.0, 18000.0),
        ord(&lp["ord"]),
        on(&cp["on"]),
        num(&cp["thr"], -80.0, 0.0, -18.0),
        num(&cp["ratio"], 1.0, 100.0, 3.0),
        num(&cp["knee"], 0.0, 40.0, 6.0),
        num(&cp["att"], 0.1, 500.0, 5.0),
        num(&cp["rel"], 5.0, 5000.0, 150.0),
        num(&cp["makeup"], -24.0, 40.0, 0.0),
        on(&lm["on"]),
        num(&lm["ceil"], -12.0, 0.0, -1.0),
        num(&lm["look"], 0.5, 20.0, 2.0),
        num(&lm["rel"], 1.0, 2000.0, 100.0),
        num(&o["out"], -24.0, 24.0, 0.0),
        0.0,
    ];
    a.resize(RK_LEN, 0.0);
    let bands = o["bands"].as_array().cloned().unwrap_or_default();
    let bands = &bands[..bands.len().min(8)];
    a[19] = bands.len() as f64;
    for (k, b) in bands.iter().enumerate() {
        let t = b["type"].as_str().and_then(|t| RK_TYPES.iter().position(|x| *x == t)).unwrap_or(0) as f64;
        let bon = if b.is_object() && b["on"] != Value::Bool(false) { 1.0 } else { 0.0 };
        let v = [bon, t, num(&b["f"], 20.0, 22000.0, 1000.0), num(&b["g"], -30.0, 30.0, 0.0), num(&b["q"], 0.1, 40.0, 0.71)];
        a[20 + 5 * k..25 + 5 * k].copy_from_slice(&v);
    }
    let (md, dl, rv, gt, ds) = (&o["mod"], &o["delay"], &o["rev"], &o["gate"], &o["ds"]);
    let mode = md["mode"].as_str().and_then(|m| RK_MODS.iter().position(|x| *x == m)).unwrap_or(0) as f64;
    let sq = if gt["square"] == Value::Bool(false) { 0.0 } else { 1.0 };
    let sp = [
        mode,
        num(&md["rate"], 0.01, 20.0, 0.5),
        num(&md["depth"], 0.0, 1.0, 0.5),
        num(&md["fb"], 0.0, 0.95, 0.5),
        num(&md["mix"], 0.0, 1.0, 0.5),
        on(&dl["on"]),
        num(&dl["ms"], 1.0, 2000.0, 250.0),
        num(&dl["fb"], 0.0, 0.95, 0.45),
        num(&dl["mix"], 0.0, 1.0, 0.35),
        on(&dl["pp"]),
        on(&rv["on"]),
        num(&rv["decay"], 0.1, 20.0, 2.0),
        num(&rv["damp"], 0.0, 1.0, 0.5),
        num(&rv["pre"], 0.0, 200.0, 10.0),
        num(&rv["mix"], 0.0, 1.0, 0.25),
        num(&rv["cut"], 10.0, 2000.0, 180.0),
        on(&gt["on"]),
        num(&gt["rate"], 0.05, 40.0, 4.0),
        num(&gt["depth"], 0.0, 1.0, 1.0),
        sq,
        on(&ds["on"]),
        num(&ds["f"], 1000.0, 16000.0, 6000.0),
        num(&ds["thr"], -60.0, 0.0, -30.0),
        num(&ds["range"], 0.0, 24.0, 6.0),
    ];
    a[60..84].copy_from_slice(&sp);
    a
}

fn steps_of(v: &[Value]) -> Result<Vec<Step>, String> {
    v.iter()
        .map(|s| {
            Ok(match s["kind"].as_str().unwrap_or("") {
                "fx" => Step::Rack(rk_cfg(s.get("cfg").filter(|c| c.is_object()).ok_or("effects step without settings")?)),
                "loud" => Step::Loud { target: num(&s["target"], -60.0, 0.0, -14.0), ceil: num(&s["ceil"], -12.0, 0.0, -1.0) },
                "norm" => Step::Norm { peak: num(&s["peak"], -60.0, 0.0, -1.0) },
                "dc" => Step::Dc,
                "mono" => Step::Mono,
                "stretch" => Step::Stretch { speed: num(&s["speed"], 25.0, 400.0, 100.0) / 100.0, semis: num(&s["semis"], -24.0, 24.0, 0.0) },
                k => return Err(format!("unknown step {}", k)),
            })
        })
        .collect()
}

#[derive(Deserialize)]
pub struct NewWatch {
    name: Option<String>,
    folder: String,
    steps: Vec<Value>,
    out: Value,
    #[serde(default)]
    existing: bool,
}

#[derive(Deserialize)]
pub struct Patch {
    on: Option<bool>,
}

fn bad(code: StatusCode, msg: &str) -> Response {
    (code, Json(json!({"error": msg}))).into_response()
}

fn view(wt: &Watcher, user: &str) -> Value {
    let s = wt.store.lock().unwrap();
    let busy = wt.busy.lock().unwrap().clone();
    let mine: Vec<&Watch> = s.watches.iter().filter(|w| w.user == user).collect();
    let ids: HashSet<&str> = mine.iter().map(|w| w.id.as_str()).collect();
    let watches: Vec<Value> = mine
        .iter()
        .map(|w| {
            let n = s.done.iter().filter(|(k, v)| **v == u32::MAX && k.starts_with(&format!("{}/", w.id))).count();
            let b = busy.as_ref().filter(|b| b.0 == w.id).map(|b| b.1.clone());
            json!({"id": w.id, "name": w.name, "folder": w.folder, "steps": w.steps, "out": w.out, "on": w.on, "created": w.created, "last": w.last, "done": n, "busy": b})
        })
        .collect();
    let log: Vec<&LogLine> = s.log.iter().rev().filter(|l| l.user == user && ids.contains(l.watch.as_str())).take(60).collect();
    json!({"on": wt.key.is_some(), "watches": watches, "log": log, "scan": SCAN.as_secs()})
}

pub async fn get_all(State(st): State<AppState>, headers: HeaderMap) -> Response {
    let u = match current_user(&st, &headers).await {
        Ok(u) => u,
        Err(c) => return c.into_response(),
    };
    Json(view(&st.watch, &u.username)).into_response()
}

pub async fn create(State(st): State<AppState>, headers: HeaderMap, Json(n): Json<NewWatch>) -> Response {
    let u = match current_user(&st, &headers).await {
        Ok(u) => u,
        Err(c) => return c.into_response(),
    };
    let wt = &st.watch;
    if wt.key.is_none() {
        return bad(StatusCode::SERVICE_UNAVAILABLE, "off");
    }
    let folder = folder_of(&n.folder);
    let fmt = n.out["fmt"].as_str().unwrap_or("wav24").to_string();
    let rate = n.out["rate"].as_u64().or_else(|| n.out["rate"].as_str().and_then(|s| s.parse().ok())).unwrap_or(0) as u32;
    let out = Out {
        fmt: if FMTS.contains(&fmt.as_str()) { fmt } else { "wav24".into() },
        rate: if RATES.contains(&rate) { rate } else { 0 },
        folder: folder_of(n.out["folder"].as_str().unwrap_or("")),
        tpl: n.out["tpl"].as_str().map(|s| s.chars().take(120).collect()).unwrap_or_else(|| "$name".into()),
    };
    if folder.is_empty() {
        return bad(StatusCode::BAD_REQUEST, "folder");
    }
    if out.folder.is_empty() || out.folder == folder {
        return bad(StatusCode::BAD_REQUEST, "same-folder");
    }
    if n.steps.is_empty() || n.steps.len() > 20 {
        return bad(StatusCode::BAD_REQUEST, "steps");
    }
    if let Err(e) = steps_of(&n.steps) {
        return bad(StatusCode::BAD_REQUEST, &e);
    }
    if wt.store.lock().unwrap().watches.iter().filter(|w| w.user == u.username).count() >= MAX_WATCHES {
        return bad(StatusCode::BAD_REQUEST, "too-many");
    }
    let id = format!("w{:x}{:04x}", SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0), rand16());
    let w = Watch {
        id: id.clone(),
        user: u.username.clone(),
        name: n.name.map(|s| s.chars().take(80).collect()).filter(|s: &String| !s.trim().is_empty()).unwrap_or_else(|| folder.clone()),
        folder,
        steps: n.steps,
        out,
        on: true,
        created: now(),
        last: 0,
    };
    let skip = if n.existing {
        Vec::new()
    } else {
        match wt.inputs(&w).await {
            Ok(f) => f.iter().filter_map(|f| f["sha256"].as_str().map(str::to_string)).collect(),
            Err(e) => return bad(StatusCode::BAD_GATEWAY, &e),
        }
    };
    {
        let mut s = wt.store.lock().unwrap();
        for sha in skip {
            s.done.insert(format!("{}/{}", id, sha), u32::MAX - 1);
        }
        s.watches.push(w);
        wt.save(&s);
    }
    wt.wake.notify_one();
    Json(view(wt, &u.username)).into_response()
}

fn rand16() -> u16 {
    let mut b = [0u8; 2];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        use std::io::Read;
        f.read_exact(&mut b).ok();
    }
    u16::from_le_bytes(b)
}

pub async fn patch(State(st): State<AppState>, headers: HeaderMap, Path(id): Path<String>, Json(p): Json<Patch>) -> Response {
    let u = match current_user(&st, &headers).await {
        Ok(u) => u,
        Err(c) => return c.into_response(),
    };
    let wt = &st.watch;
    {
        let mut s = wt.store.lock().unwrap();
        let Some(w) = s.watches.iter_mut().find(|w| w.id == id && w.user == u.username) else {
            return StatusCode::NOT_FOUND.into_response();
        };
        if let Some(v) = p.on {
            w.on = v;
        }
        wt.save(&s);
    }
    wt.wake.notify_one();
    Json(view(wt, &u.username)).into_response()
}

pub async fn remove(State(st): State<AppState>, headers: HeaderMap, Path(id): Path<String>) -> Response {
    let u = match current_user(&st, &headers).await {
        Ok(u) => u,
        Err(c) => return c.into_response(),
    };
    let wt = &st.watch;
    {
        let mut s = wt.store.lock().unwrap();
        let before = s.watches.len();
        s.watches.retain(|w| !(w.id == id && w.user == u.username));
        if s.watches.len() == before {
            return StatusCode::NOT_FOUND.into_response();
        }
        let pre = format!("{}/", id);
        s.done.retain(|k, _| !k.starts_with(&pre));
        s.log.retain(|l| l.watch != id);
        wt.save(&s);
    }
    Json(view(wt, &u.username)).into_response()
}

pub async fn run_now(State(st): State<AppState>, headers: HeaderMap, Path(id): Path<String>) -> Response {
    let u = match current_user(&st, &headers).await {
        Ok(u) => u,
        Err(c) => return c.into_response(),
    };
    let wt = &st.watch;
    {
        let mut s = wt.store.lock().unwrap();
        if !s.watches.iter().any(|w| w.id == id && w.user == u.username) {
            return StatusCode::NOT_FOUND.into_response();
        }
        let pre = format!("{}/", id);
        for (k, v) in s.done.iter_mut() {
            if k.starts_with(&pre) && *v < u32::MAX - 1 {
                *v = 0;
            }
        }
        wt.save(&s);
    }
    wt.wake.notify_one();
    Json(view(wt, &u.username)).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_dates() {
        assert_eq!(date_of(0), "1970-01-01");
        assert_eq!(date_of(1_793_059_200), "2026-10-27");
        assert_eq!(name_of("$name (master)", "In/Track one.mp3"), "Track one (master)");
        assert_eq!(name_of("../$name", "In/a.wav"), "a");
        assert_eq!(folder_of(" Studio//../Out "), "Studio/Out");
        assert_eq!(enc("In Box/ä"), "In%20Box/%C3%A4");
    }

    #[test]
    fn cfg_matches_the_browser() {
        let c = rk_cfg(&json!({"hp": {"on": true, "f": 80, "ord": 8}, "bands": [{"type": "highshelf", "f": 9000, "g": 3, "q": 0.7}], "comp": {"on": true, "thr": -20}, "match": true, "rev": {"on": true}, "ds": {"on": true, "f": 6500}}));
        assert_eq!(c.len(), RK_LEN);
        assert_eq!(&c[0..3], &[1.0, 80.0, 8.0]);
        assert_eq!(c[18], 0.0);
        assert_eq!(c[19], 1.0);
        assert_eq!(&c[20..25], &[1.0, 2.0, 9000.0, 3.0, 0.7]);
        assert_eq!(c[6], 1.0);
        assert_eq!(c[7], -20.0);
        assert_eq!(c[70], 1.0);
        assert_eq!(c[79], 1.0);
        assert_eq!(&c[80..84], &[1.0, 6500.0, -30.0, 6.0]);
        let d = rk_cfg(&json!({}));
        assert_eq!(d[19], 0.0);
        assert_eq!(d[60], 0.0);
        assert!(steps_of(&[json!({"kind": "fx"})]).is_err());
        assert_eq!(steps_of(&[json!({"kind": "loud", "target": "-16"}), json!({"kind": "dc"})]).unwrap().len(), 2);
    }
}
