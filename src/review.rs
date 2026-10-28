use axum::{
    Json,
    body::Bytes,
    extract::{Path, Query, Request, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tower::ServiceExt;
use tower_http::services::ServeFile;

use crate::{AppState, current_user};

pub const PART: usize = 900 << 10;
const MAX_FILE: u64 = 400 << 20;
const MAX_USER: u64 = 4 << 30;
const MAX_REVIEWS: usize = 60;
const MAX_COMMENTS: usize = 1000;
const MAX_PEAKS: usize = 4000;

#[derive(Clone, Serialize, Deserialize)]
pub struct Comment {
    id: String,
    at: f64,
    name: String,
    text: String,
    created: u64,
    #[serde(default)]
    done: bool,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Review {
    id: String,
    token: String,
    owner: String,
    name: String,
    doc: String,
    a: u64,
    sr: u32,
    ch: u32,
    frames: u64,
    size: u64,
    got: u64,
    done: bool,
    created: u64,
    expires: u64,
    peaks: Vec<f32>,
    comments: Vec<Comment>,
}

#[derive(Default, Serialize, Deserialize)]
struct Store {
    reviews: Vec<Review>,
}

pub struct Reviews {
    dir: PathBuf,
    store: Mutex<Store>,
}

pub type Shared = Arc<Reviews>;

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn token(n: usize) -> String {
    let mut b = vec![0u8; n];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") { f.read_exact(&mut b).ok(); }
    const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    b.iter().map(|x| A[(*x & 63) as usize] as char).collect()
}

fn clip(s: &str, n: usize) -> String {
    s.chars().filter(|c| !c.is_control() || *c == '\n').take(n).collect::<String>().trim().to_string()
}

fn bad(code: StatusCode, e: &str) -> Response {
    (code, Json(json!({ "error": e }))).into_response()
}

pub fn open(base: PathBuf) -> Shared {
    let dir = base.join("reviews");
    std::fs::create_dir_all(&dir).ok();
    let store = std::fs::read(dir.join("reviews.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    Arc::new(Reviews { dir, store: Mutex::new(store) })
}

impl Reviews {
    fn save(&self, s: &Store) {
        let Ok(b) = serde_json::to_vec(s) else { return };
        let tmp = self.dir.join("reviews.json.tmp");
        if std::fs::write(&tmp, b).is_ok() { std::fs::rename(&tmp, self.dir.join("reviews.json")).ok(); }
    }

    fn file(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{}.flac", id))
    }

    fn sweep(&self) {
        let t = now();
        let mut s = self.store.lock().unwrap();
        let gone: Vec<String> = s.reviews.iter().filter(|r| (r.expires > 0 && r.expires < t) || (!r.done && r.created + 86400 < t)).map(|r| r.id.clone()).collect();
        if gone.is_empty() { return; }
        for id in &gone { std::fs::remove_file(self.file(id)).ok(); }
        s.reviews.retain(|r| !gone.contains(&r.id));
        self.save(&s);
    }
}

pub async fn run(r: Shared) {
    loop {
        r.sweep();
        tokio::time::sleep(Duration::from_secs(3600)).await;
    }
}

fn own_view(r: &Review) -> Value {
    json!({ "id": r.id, "token": r.token, "name": r.name, "doc": r.doc, "a": r.a, "sr": r.sr, "frames": r.frames, "size": r.size, "done": r.done, "created": r.created, "expires": r.expires, "comments": r.comments })
}

#[derive(Deserialize)]
pub struct NewReview {
    name: String,
    #[serde(default)]
    doc: String,
    #[serde(default)]
    a: u64,
    sr: u32,
    ch: u32,
    frames: u64,
    size: u64,
    #[serde(default)]
    days: u64,
    #[serde(default)]
    peaks: Vec<f32>,
}

pub async fn create(State(st): State<AppState>, headers: HeaderMap, Json(n): Json<NewReview>) -> Response {
    let u = match current_user(&st, &headers).await { Ok(u) => u, Err(c) => return c.into_response() };
    if n.size == 0 || n.size > MAX_FILE { return bad(StatusCode::PAYLOAD_TOO_LARGE, "size"); }
    if !(8000..=384000).contains(&n.sr) || n.ch == 0 || n.ch > 8 || n.frames == 0 { return bad(StatusCode::BAD_REQUEST, "audio"); }
    let rv = &st.reviews;
    let mut s = rv.store.lock().unwrap();
    let mine: Vec<&Review> = s.reviews.iter().filter(|r| r.owner == u.username).collect();
    if mine.len() >= MAX_REVIEWS { return bad(StatusCode::BAD_REQUEST, "too-many"); }
    if mine.iter().map(|r| r.size).sum::<u64>() + n.size > MAX_USER { return bad(StatusCode::INSUFFICIENT_STORAGE, "full"); }
    let id = format!("r{}", token(14));
    let r = Review {
        id: id.clone(),
        token: token(24),
        owner: u.username.clone(),
        name: { let x = clip(&n.name, 160); if x.is_empty() { "Review".into() } else { x } },
        doc: clip(&n.doc, 80),
        a: n.a,
        sr: n.sr,
        ch: n.ch,
        frames: n.frames,
        size: n.size,
        got: 0,
        done: false,
        created: now(),
        expires: if n.days == 0 { 0 } else { now() + n.days.min(366) * 86400 },
        peaks: n.peaks.into_iter().take(MAX_PEAKS).map(|v| if v.is_finite() { v.clamp(0.0, 1.0) } else { 0.0 }).collect(),
        comments: vec![],
    };
    std::fs::File::create(rv.file(&id)).ok();
    let out = json!({ "id": r.id, "token": r.token, "part": PART });
    s.reviews.push(r);
    rv.save(&s);
    Json(out).into_response()
}

#[derive(Deserialize)]
pub struct Off {
    off: u64,
}

pub async fn part(State(st): State<AppState>, headers: HeaderMap, Path(id): Path<String>, Query(q): Query<Off>, body: Bytes) -> Response {
    let u = match current_user(&st, &headers).await { Ok(u) => u, Err(c) => return c.into_response() };
    let rv = &st.reviews;
    let mut s = rv.store.lock().unwrap();
    let Some(r) = s.reviews.iter_mut().find(|r| r.id == id && r.owner == u.username) else { return bad(StatusCode::NOT_FOUND, "review"); };
    if r.done { return bad(StatusCode::CONFLICT, "done"); }
    if q.off != r.got { return (StatusCode::CONFLICT, Json(json!({ "error": "offset", "got": r.got }))).into_response(); }
    if r.got + body.len() as u64 > r.size { return bad(StatusCode::PAYLOAD_TOO_LARGE, "size"); }
    let ok = std::fs::OpenOptions::new().append(true).open(rv.file(&id)).and_then(|mut f| f.write_all(&body)).is_ok();
    if !ok { return bad(StatusCode::INTERNAL_SERVER_ERROR, "write"); }
    r.got += body.len() as u64;
    let got = r.got;
    rv.save(&s);
    Json(json!({ "got": got })).into_response()
}

#[derive(Deserialize)]
pub struct Done {
    sha256: String,
}

pub async fn done(State(st): State<AppState>, headers: HeaderMap, Path(id): Path<String>, Json(d): Json<Done>) -> Response {
    let u = match current_user(&st, &headers).await { Ok(u) => u, Err(c) => return c.into_response() };
    let rv = st.reviews.clone();
    let path = rv.file(&id);
    {
        let s = rv.store.lock().unwrap();
        let Some(r) = s.reviews.iter().find(|r| r.id == id && r.owner == u.username) else { return bad(StatusCode::NOT_FOUND, "review"); };
        if r.got != r.size { return bad(StatusCode::CONFLICT, "incomplete"); }
    }
    let sha = tokio::task::spawn_blocking(move || std::fs::read(path).map(|b| Sha256::digest(&b).iter().map(|x| format!("{:02x}", x)).collect::<String>()).unwrap_or_default()).await.unwrap_or_default();
    if sha.is_empty() || sha != d.sha256.to_lowercase() { return bad(StatusCode::UNPROCESSABLE_ENTITY, "sha256"); }
    let mut s = rv.store.lock().unwrap();
    let Some(r) = s.reviews.iter_mut().find(|r| r.id == id) else { return bad(StatusCode::NOT_FOUND, "review"); };
    r.done = true;
    let out = own_view(r);
    rv.save(&s);
    Json(out).into_response()
}

#[derive(Deserialize)]
pub struct ListQ {
    #[serde(default)]
    doc: String,
}

pub async fn list(State(st): State<AppState>, headers: HeaderMap, Query(q): Query<ListQ>) -> Response {
    let u = match current_user(&st, &headers).await { Ok(u) => u, Err(c) => return c.into_response() };
    st.reviews.sweep();
    let s = st.reviews.store.lock().unwrap();
    let v: Vec<Value> = s.reviews.iter().filter(|r| r.owner == u.username && r.done && (q.doc.is_empty() || r.doc == q.doc)).map(own_view).collect();
    Json(json!({ "reviews": v })).into_response()
}

pub async fn remove(State(st): State<AppState>, headers: HeaderMap, Path(id): Path<String>) -> Response {
    let u = match current_user(&st, &headers).await { Ok(u) => u, Err(c) => return c.into_response() };
    let rv = &st.reviews;
    let mut s = rv.store.lock().unwrap();
    let n = s.reviews.len();
    s.reviews.retain(|r| !(r.id == id && r.owner == u.username));
    if s.reviews.len() == n { return bad(StatusCode::NOT_FOUND, "review"); }
    std::fs::remove_file(rv.file(&id)).ok();
    rv.save(&s);
    StatusCode::NO_CONTENT.into_response()
}

#[derive(Deserialize)]
pub struct Resolve {
    done: bool,
}

pub async fn resolve(State(st): State<AppState>, headers: HeaderMap, Path((id, cid)): Path<(String, String)>, Json(b): Json<Resolve>) -> Response {
    let u = match current_user(&st, &headers).await { Ok(u) => u, Err(c) => return c.into_response() };
    let rv = &st.reviews;
    let mut s = rv.store.lock().unwrap();
    let Some(r) = s.reviews.iter_mut().find(|r| r.id == id && r.owner == u.username) else { return bad(StatusCode::NOT_FOUND, "review"); };
    let Some(c) = r.comments.iter_mut().find(|c| c.id == cid) else { return bad(StatusCode::NOT_FOUND, "comment"); };
    c.done = b.done;
    rv.save(&s);
    StatusCode::NO_CONTENT.into_response()
}

fn live<'a>(s: &'a mut Store, tok: &str) -> Option<&'a mut Review> {
    let t = now();
    s.reviews.iter_mut().find(|r| r.token == tok && r.done && (r.expires == 0 || r.expires >= t))
}

pub async fn pub_get(State(st): State<AppState>, Path(tok): Path<String>) -> Response {
    let mut s = st.reviews.store.lock().unwrap();
    let Some(r) = live(&mut s, &tok) else { return bad(StatusCode::NOT_FOUND, "review"); };
    let comments: Vec<Value> = r.comments.iter().map(|c| json!({ "id": c.id, "at": c.at, "name": c.name, "text": c.text, "created": c.created, "done": c.done })).collect();
    Json(json!({ "name": r.name, "secs": r.frames as f64 / r.sr as f64, "peaks": r.peaks, "expires": r.expires, "comments": comments })).into_response()
}

pub async fn pub_audio(State(st): State<AppState>, Path(tok): Path<String>, req: Request) -> Response {
    let path = {
        let mut s = st.reviews.store.lock().unwrap();
        let Some(r) = live(&mut s, &tok) else { return bad(StatusCode::NOT_FOUND, "review"); };
        st.reviews.file(&r.id)
    };
    match ServeFile::new_with_mime(path, &"audio/flac".parse().unwrap()).oneshot(req).await {
        Ok(mut res) => {
            res.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("private, max-age=3600"));
            res.into_response()
        }
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

#[derive(Deserialize)]
pub struct NewComment {
    #[serde(default)]
    name: String,
    at: f64,
    text: String,
}

pub async fn pub_comment(State(st): State<AppState>, Path(tok): Path<String>, Json(n): Json<NewComment>) -> Response {
    let text = clip(&n.text, 2000);
    if text.is_empty() { return bad(StatusCode::BAD_REQUEST, "text"); }
    let rv = &st.reviews;
    let mut s = rv.store.lock().unwrap();
    let Some(r) = live(&mut s, &tok) else { return bad(StatusCode::NOT_FOUND, "review"); };
    if r.comments.len() >= MAX_COMMENTS { return bad(StatusCode::TOO_MANY_REQUESTS, "full"); }
    let secs = r.frames as f64 / r.sr as f64;
    let at = if n.at.is_finite() { n.at.clamp(0.0, secs) } else { 0.0 };
    let name = { let x = clip(&n.name, 60); if x.is_empty() { "Guest".into() } else { x } };
    let c = Comment { id: format!("c{}", token(10)), at: (at * 1000.0).round() / 1000.0, name, text, created: now(), done: false };
    let out = json!({ "id": c.id, "at": c.at, "name": c.name, "text": c.text, "created": c.created, "done": false });
    r.comments.push(c);
    r.comments.sort_by(|x, y| x.at.partial_cmp(&y.at).unwrap_or(std::cmp::Ordering::Equal));
    rv.save(&s);
    Json(out).into_response()
}
