mod drive;
mod mac;
mod rip;
mod sim;

use drive::{Drive, SECTOR};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}},
    time::{Duration, Instant},
};
use tokio::{net::TcpListener, sync::mpsc};
use tokio_tungstenite::tungstenite::{
    Message,
    handshake::server::{ErrorResponse, Request, Response},
    http::StatusCode,
};

const VERSION: &str = env!("CARGO_PKG_VERSION");
const PORT: u16 = 47391;
const ORIGIN: &str = "https://studio.delicateaudio.com";

type Shared = Arc<Mutex<Box<dyn Drive>>>;

struct Cfg {
    origins: Vec<String>,
    state: PathBuf,
    sim: Option<String>,
}

struct Pairing {
    code: String,
    until: Instant,
    tries: u32,
}

struct St {
    cfg: Cfg,
    drives: Mutex<Vec<Shared>>,
    pairing: Mutex<Option<Pairing>>,
    jobs: Mutex<Vec<(u64, Arc<AtomicBool>)>>,
}

fn random_hex(n: usize) -> String {
    let mut b = vec![0u8; n];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") { let _ = std::io::Read::read_exact(&mut f, &mut b); }
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

fn state_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    if cfg!(target_os = "macos") { PathBuf::from(home).join("Library/Application Support/Delicate Bridge") }
    else { std::env::var("XDG_CONFIG_HOME").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from(home).join(".config")).join("delicate-bridge") }
}

fn tokens(st: &St) -> Vec<String> {
    std::fs::read_to_string(st.cfg.state.join("tokens")).unwrap_or_default().lines().map(|l| l.trim().to_string()).filter(|l| l.len() == 64).collect()
}

fn add_token(st: &St, t: &str) {
    let _ = std::fs::create_dir_all(&st.cfg.state);
    let mut all = tokens(st);
    all.push(t.to_string());
    let keep = all.len().saturating_sub(20);
    let _ = std::fs::write(st.cfg.state.join("tokens"), all[keep..].join("\n") + "\n");
    #[cfg(unix)]
    { use std::os::unix::fs::PermissionsExt; let _ = std::fs::set_permissions(st.cfg.state.join("tokens"), std::fs::Permissions::from_mode(0o600)); }
}

fn scan(cfg: &Cfg) -> Vec<Shared> {
    if let Some(dir) = &cfg.sim {
        return match sim::SimDrive::open(dir) {
            Ok(d) => vec![Arc::new(Mutex::new(Box::new(d) as Box<dyn Drive>))],
            Err(e) => { eprintln!("sim: {}", e); Vec::new() }
        };
    }
    mac::list().into_iter().map(|d| Arc::new(Mutex::new(d))).collect()
}

fn hex(b: &[u8]) -> String { b.iter().map(|x| format!("{:02x}", x)).collect() }

fn disc_info(d: &mut dyn Drive) -> Result<Value, String> {
    let toc = d.toc()?;
    let audio: Vec<(usize, u8, u32)> = toc.tracks.iter().enumerate().filter(|(_, t)| !t.data).map(|(i, t)| (i, t.number, t.lba)).collect();
    if audio.is_empty() { return Err("no audio tracks".into()); }
    let probe = audio[0].2;
    let caps = rip::caps(d, probe);
    let isrc: Vec<Value> = audio.iter().map(|(_, n, _)| d.isrc(*n).map(Value::from).unwrap_or(Value::Null)).collect();
    let mut pre = Vec::new();
    if caps.q {
        for w in audio.windows(2) {
            if let Some(i0) = rip::index0(d, w[1].1, w[0].2, w[1].2) { pre.push(json!({ "track": w[1].1, "index0": i0 })); }
        }
    }
    let first = audio[0].2;
    let htoa = if first > 0 {
        let n = first.min(2000);
        let mut pk = 0;
        let mut at = 0;
        while at < n { let k = 26.min(n - at); if let Ok(r) = d.read(at, k, false, false) { pk = pk.max(rip::peak(&r.audio)); } at += k; }
        json!({ "sectors": first, "peak": pk })
    } else { Value::Null };
    Ok(json!({
        "name": d.name(),
        "toc": toc,
        "ends": audio.iter().map(|(i, _, _)| toc.end_of(*i)).collect::<Vec<_>>(),
        "isrc": isrc,
        "mcn": d.mcn(),
        "cdtext": d.cdtext().map(|b| hex(&b)),
        "pregaps": pre,
        "htoa": htoa,
        "c2": caps.c2,
        "q": caps.q,
    }))
}

async fn session(st: Arc<St>, stream: tokio::net::TcpStream) {
    let origins = st.cfg.origins.clone();
    let check = move |req: &Request, resp: Response| -> Result<Response, ErrorResponse> {
        let host = req.headers().get("host").and_then(|h| h.to_str().ok()).unwrap_or("");
        let origin = req.headers().get("origin").and_then(|h| h.to_str().ok()).unwrap_or("");
        let host_ok = host.starts_with("127.0.0.1:") || host.starts_with("localhost:") || host == "127.0.0.1" || host == "localhost";
        if !host_ok || !origins.iter().any(|o| o == origin) {
            let mut e = ErrorResponse::new(Some("forbidden".into()));
            *e.status_mut() = StatusCode::FORBIDDEN;
            return Err(e);
        }
        Ok(resp)
    };
    let Ok(ws) = tokio_tungstenite::accept_hdr_async(stream, check).await else { return; };
    let (mut tx, mut rx) = ws.split();
    let (out, mut outq) = mpsc::channel::<Message>(64);
    let writer = tokio::spawn(async move { while let Some(m) = outq.recv().await { if tx.send(m).await.is_err() { break; } } });
    let mut authed = false;
    while let Some(Ok(msg)) = rx.next().await {
        let Message::Text(t) = msg else { continue; };
        let Ok(m) = serde_json::from_str::<Value>(&t) else { continue; };
        let id = m.get("id").cloned().unwrap_or(Value::Null);
        let op = m.get("op").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let reply = |v: Value| { let mut v = v; v["id"] = id.clone(); Message::Text(v.to_string().into()) };
        if op == "hello" {
            let tok = m.get("token").and_then(|v| v.as_str()).unwrap_or("");
            authed = !tok.is_empty() && tokens(&st).iter().any(|x| x == tok);
            let _ = out.send(reply(if authed { json!({ "ok": true, "version": VERSION, "platform": std::env::consts::OS }) } else { json!({ "error": "pair" }) })).await;
            continue;
        }
        if op == "pair" {
            let code = m.get("code").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let r = {
                let mut p = st.pairing.lock().unwrap();
                if code.is_empty() {
                    let c: String = random_hex(4).chars().filter_map(|x| x.to_digit(16)).map(|d| char::from(b'0' + (d % 10) as u8)).take(6).collect();
                    println!("\n  Pairing code for Delicate Studio:  {} {}\n", &c[..3], &c[3..]);
                    *p = Some(Pairing { code: c, until: Instant::now() + Duration::from_secs(300), tries: 0 });
                    json!({ "ok": true, "shown": true })
                } else {
                    match p.as_mut() {
                        Some(x) if x.until > Instant::now() && x.tries < 5 => {
                            x.tries += 1;
                            if x.code == code.replace(' ', "") {
                                *p = None;
                                let t = random_hex(32);
                                add_token(&st, &t);
                                authed = true;
                                json!({ "ok": true, "token": t, "version": VERSION, "platform": std::env::consts::OS })
                            } else { json!({ "error": "code" }) }
                        }
                        _ => { *p = None; json!({ "error": "expired" }) }
                    }
                }
            };
            let _ = out.send(reply(r)).await;
            continue;
        }
        if !authed { let _ = out.send(reply(json!({ "error": "pair" }))).await; continue; }
        match op.as_str() {
            "drives" => {
                let st2 = st.clone();
                let list = tokio::task::spawn_blocking(move || {
                    let found = scan(&st2.cfg);
                    let names: Vec<Value> = found.iter().enumerate().map(|(i, d)| json!({ "i": i, "name": d.lock().unwrap().name() })).collect();
                    *st2.drives.lock().unwrap() = found;
                    names
                }).await.unwrap_or_default();
                let _ = out.send(reply(json!({ "ok": true, "drives": list }))).await;
            }
            "disc" => {
                let d = st.drives.lock().unwrap().get(m.get("drive").and_then(|v| v.as_u64()).unwrap_or(0) as usize).cloned();
                let r = match d {
                    None => json!({ "error": "drive" }),
                    Some(d) => tokio::task::spawn_blocking(move || { let mut g = d.lock().unwrap(); disc_info(&mut **g) }).await.unwrap_or_else(|e| Err(e.to_string())).map(|v| { let mut v = v; v["ok"] = json!(true); v }).unwrap_or_else(|e| json!({ "error": e })),
                };
                let _ = out.send(reply(r)).await;
            }
            "rip" => {
                let job = m.get("job").and_then(|v| v.as_u64()).unwrap_or(1);
                let from = m.get("from").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                let to = m.get("to").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                let end = m.get("end").and_then(|v| v.as_u64()).unwrap_or(to as u64) as u32;
                let Some(d) = st.drives.lock().unwrap().get(m.get("drive").and_then(|v| v.as_u64()).unwrap_or(0) as usize).cloned() else { let _ = out.send(reply(json!({ "error": "drive" }))).await; continue; };
                if to <= from { let _ = out.send(reply(json!({ "error": "range" }))).await; continue; }
                let stop = Arc::new(AtomicBool::new(false));
                st.jobs.lock().unwrap().push((job, stop.clone()));
                let (out2, st2, idv) = (out.clone(), st.clone(), id.clone());
                tokio::task::spawn_blocking(move || {
                    let mut g = d.lock().unwrap();
                    let c2 = rip::caps(&mut **g, from).c2;
                    let o = rip::Opts::default();
                    let rep = rip::rip(&mut **g, from, to, end, &o, c2, &mut |lba, data| {
                        if stop.load(Ordering::SeqCst) { return false; }
                        let mut f = Vec::with_capacity(12 + data.len());
                        f.extend_from_slice(&(job as u32).to_le_bytes());
                        f.extend_from_slice(&lba.to_le_bytes());
                        f.extend_from_slice(&((data.len() / SECTOR) as u32).to_le_bytes());
                        f.extend_from_slice(data);
                        out2.blocking_send(Message::Binary(f.into())).is_ok()
                    });
                    let cancelled = stop.load(Ordering::SeqCst);
                    st2.jobs.lock().unwrap().retain(|j| j.0 != job);
                    let mut v = json!({ "ok": !cancelled, "cancelled": cancelled, "report": rep });
                    v["id"] = idv;
                    let _ = out2.blocking_send(Message::Text(v.to_string().into()));
                });
            }
            "cancel" => {
                let job = m.get("job").and_then(|v| v.as_u64()).unwrap_or(0);
                for j in st.jobs.lock().unwrap().iter() { if j.0 == job { j.1.store(true, Ordering::SeqCst); } }
                let _ = out.send(reply(json!({ "ok": true }))).await;
            }
            _ => { let _ = out.send(reply(json!({ "error": "op" }))).await; }
        }
    }
    for j in st.jobs.lock().unwrap().iter() { j.1.store(true, Ordering::SeqCst); }
    drop(out);
    let _ = writer.await;
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let val = |k: &str| args.iter().position(|a| a == k).and_then(|i| args.get(i + 1)).cloned();
    let mut origins = vec![ORIGIN.to_string()];
    if let Some(o) = val("--origin") { origins.push(o); }
    let port: u16 = val("--port").and_then(|p| p.parse().ok()).unwrap_or(PORT);
    let cfg = Cfg { origins, state: val("--state").map(PathBuf::from).unwrap_or_else(state_dir), sim: val("--sim") };
    let st = Arc::new(St { drives: Mutex::new(scan(&cfg)), cfg, pairing: Mutex::new(None), jobs: Mutex::new(Vec::new()) });
    let n = st.drives.lock().unwrap().len();
    let listener = match TcpListener::bind(("127.0.0.1", port)).await {
        Ok(l) => l,
        Err(e) => { eprintln!("Delicate Bridge: port {} is taken ({}). Is the bridge already running?", port, e); std::process::exit(1); }
    };
    println!("Delicate Bridge {} on 127.0.0.1:{} · {} drive{} · open Delicate Studio and choose Import a CD.", VERSION, port, n, if n == 1 { "" } else { "s" });
    loop {
        let Ok((s, _)) = listener.accept().await else { continue; };
        tokio::spawn(session(st.clone(), s));
    }
}
