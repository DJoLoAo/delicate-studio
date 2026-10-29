use axum::{
    Json,
    extract::{Path, Query, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::json;
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

use crate::{AppState, current_user};

const MB: &str = "https://musicbrainz.org";
const AR: &str = "http://www.accuraterip.com";
const AGENT: &str = "DelicateStudio/1.0 ( https://studio.delicateaudio.com )";
const KEEP: Duration = Duration::from_secs(3600);
const CAP: usize = 256;

pub struct Cd {
    mb: String,
    ar: String,
    last: Mutex<Option<Instant>>,
    cache: Mutex<HashMap<String, (Instant, u16, Vec<u8>)>>,
}

pub type Shared = Arc<Cd>;

pub fn open() -> Shared {
    Arc::new(Cd {
        mb: std::env::var("STUDIO_MB").unwrap_or_else(|_| MB.to_string()),
        ar: std::env::var("STUDIO_AR").unwrap_or_else(|_| AR.to_string()),
        last: Mutex::new(None),
        cache: Mutex::new(HashMap::new()),
    })
}

#[derive(Deserialize)]
pub struct MbQuery {
    #[serde(default)]
    toc: String,
}

fn discid_ok(s: &str) -> bool {
    s.len() == 28 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-')
}

fn toc_ok(s: &str) -> bool {
    let n: Vec<&str> = s.split(' ').collect();
    s.len() <= 1200 && n.len() >= 4 && n.len() <= 103 && n.iter().all(|x| !x.is_empty() && x.len() <= 7 && x.bytes().all(|b| b.is_ascii_digit()))
}

fn dbar_ok(s: &str) -> bool {
    let b = s.as_bytes();
    s.len() == 39 && s.starts_with("dBAR-") && s.ends_with(".bin") && b[5..8].iter().all(u8::is_ascii_digit) && b[8] == b'-' && b[17] == b'-' && b[26] == b'-'
        && [9..17, 18..26, 27..35].iter().all(|r| b[r.clone()].iter().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()))
}

async fn cached(cd: &Cd, key: &str) -> Option<(u16, Vec<u8>)> {
    let c = cd.cache.lock().await;
    c.get(key).filter(|(t, _, _)| t.elapsed() < KEEP).map(|(_, s, b)| (*s, b.clone()))
}

async fn remember(cd: &Cd, key: String, status: u16, body: Vec<u8>) {
    let mut c = cd.cache.lock().await;
    if c.len() >= CAP {
        c.retain(|_, (t, _, _)| t.elapsed() < KEEP);
        if c.len() >= CAP { c.clear(); }
    }
    c.insert(key, (Instant::now(), status, body));
}

async fn fetch(st: &AppState, key: String, url: String, throttle: bool) -> Result<(u16, Vec<u8>), Response> {
    let cd = &st.cd;
    if let Some(hit) = cached(cd, &key).await { return Ok(hit); }
    if throttle {
        let mut last = cd.last.lock().await;
        if let Some(t) = *last {
            let gap = Duration::from_millis(1100);
            if t.elapsed() < gap { tokio::time::sleep(gap - t.elapsed()).await; }
        }
        *last = Some(Instant::now());
    }
    let res = st.slow.get(&url).header(header::USER_AGENT, AGENT).header(header::ACCEPT, "application/json").timeout(Duration::from_secs(20)).send().await;
    let res = match res {
        Ok(r) => r,
        Err(e) if e.is_connect() || e.is_timeout() => return Err((StatusCode::SERVICE_UNAVAILABLE, Json(json!({ "error": "offline" }))).into_response()),
        Err(_) => return Err((StatusCode::BAD_GATEWAY, Json(json!({ "error": "upstream" }))).into_response()),
    };
    let status = res.status().as_u16();
    if status != 200 && status != 404 { return Err((StatusCode::BAD_GATEWAY, Json(json!({ "error": "upstream", "status": status }))).into_response()); }
    let body = match res.bytes().await {
        Ok(b) if b.len() <= 4 << 20 => b.to_vec(),
        _ => return Err((StatusCode::BAD_GATEWAY, Json(json!({ "error": "upstream" }))).into_response()),
    };
    remember(cd, key, status, body.clone()).await;
    Ok((status, body))
}

pub async fn mb(State(st): State<AppState>, headers: HeaderMap, Path(id): Path<String>, Query(q): Query<MbQuery>) -> Response {
    if let Err(code) = current_user(&st, &headers).await { return code.into_response(); }
    if !discid_ok(&id) { return (StatusCode::BAD_REQUEST, Json(json!({ "error": "discid" }))).into_response(); }
    if !q.toc.is_empty() && !toc_ok(&q.toc) { return (StatusCode::BAD_REQUEST, Json(json!({ "error": "toc" }))).into_response(); }
    let toc = if q.toc.is_empty() { String::new() } else { format!("&toc={}", q.toc.replace(' ', "+")) };
    let url = format!("{}/ws/2/discid/{}?inc=artist-credits+labels+recordings+isrcs+discids&cdstubs=no&fmt=json{}", st.cd.mb, id, toc);
    match fetch(&st, format!("mb:{}:{}", id, q.toc), url, true).await {
        Ok((200, b)) => ([(header::CONTENT_TYPE, HeaderValue::from_static("application/json"))], b).into_response(),
        Ok(_) => (StatusCode::NOT_FOUND, Json(json!({ "error": "not-found" }))).into_response(),
        Err(r) => r,
    }
}

pub async fn ar(State(st): State<AppState>, headers: HeaderMap, Path(name): Path<String>) -> Response {
    if let Err(code) = current_user(&st, &headers).await { return code.into_response(); }
    if !dbar_ok(&name) { return (StatusCode::BAD_REQUEST, Json(json!({ "error": "name" }))).into_response(); }
    let id1 = &name[9..17];
    let c: Vec<char> = id1.chars().rev().take(3).collect();
    let url = format!("{}/accuraterip/{}/{}/{}/{}", st.cd.ar, c[0], c[1], c[2], name);
    match fetch(&st, format!("ar:{}", name), url, false).await {
        Ok((200, b)) if b.len() >= 13 => ([(header::CONTENT_TYPE, HeaderValue::from_static("application/octet-stream"))], b).into_response(),
        Ok(_) => (StatusCode::NOT_FOUND, Json(json!({ "error": "not-found" }))).into_response(),
        Err(r) => r,
    }
}

pub async fn offsets(State(st): State<AppState>, headers: HeaderMap) -> Response {
    if let Err(code) = current_user(&st, &headers).await { return code.into_response(); }
    let url = format!("{}/accuraterip/DriveOffsets.bin", st.cd.ar);
    match fetch(&st, "ar:offsets".to_string(), url, false).await {
        Ok((200, b)) if b.len() >= 69 => ([(header::CONTENT_TYPE, HeaderValue::from_static("application/octet-stream"))], b).into_response(),
        Ok(_) => (StatusCode::NOT_FOUND, Json(json!({ "error": "not-found" }))).into_response(),
        Err(r) => r,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        assert!(dbar_ok("dBAR-003-00084264-001cc184-19117f03.bin"));
        assert!(!dbar_ok("dBAR-003-00084264-001CC184-19117f03.bin"));
        assert!(!dbar_ok("dBAR-003-00084264-001cc184-19117f03.bin/../x"));
        assert!(discid_ok("dUmct3Sk4dAt1a98qUKYKC0ZjYU-"));
        assert!(!discid_ok("dUmct3Sk4dAt1a98qUKYKC0ZjYU/"));
        assert!(toc_ok("1 3 335953 150 75408 130223"));
        assert!(!toc_ok("1 3 x 150"));
    }
}
