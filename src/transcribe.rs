use axum::{
    Json,
    body::Bytes,
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use reqwest::multipart::{Form, Part};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tokio::sync::Semaphore;

use crate::{AppState, current_user};

pub const MAX_BODY: usize = 32 << 20;
const MAX_WAIT: usize = 16;

pub struct Queue {
    gate: Semaphore,
    waiting: AtomicUsize,
}

pub type Shared = Arc<Queue>;

pub fn open() -> Shared {
    Arc::new(Queue { gate: Semaphore::new(1), waiting: AtomicUsize::new(0) })
}

#[derive(Deserialize)]
pub struct Params {
    #[serde(default)]
    lang: String,
    #[serde(default)]
    prompt: String,
}

fn lang_ok(l: &str) -> bool {
    l == "auto" || ((2..=3).contains(&l.len()) && l.bytes().all(|b| b.is_ascii_lowercase()))
}

fn wav_ok(b: &[u8]) -> bool {
    b.len() > 44 && &b[0..4] == b"RIFF" && &b[8..12] == b"WAVE"
}

fn clean(v: Value) -> Value {
    let segs = v.get("segments").and_then(|s| s.as_array()).cloned().unwrap_or_default();
    let out: Vec<Value> = segs
        .iter()
        .map(|s| {
            let words: Vec<Value> = s
                .get("words")
                .and_then(|w| w.as_array())
                .map(|ws| {
                    ws.iter()
                        .filter_map(|w| {
                            let t = w.get("word")?.as_str()?;
                            if t.starts_with("[_") || t.starts_with("<|") { return None; }
                            Some(json!({ "w": t, "a": w.get("start").and_then(|x| x.as_f64()).unwrap_or(0.0), "b": w.get("end").and_then(|x| x.as_f64()).unwrap_or(0.0), "p": w.get("probability").and_then(|x| x.as_f64()).unwrap_or(0.0) }))
                        })
                        .collect()
                })
                .unwrap_or_default();
            json!({ "a": s.get("start").and_then(|x| x.as_f64()).unwrap_or(0.0), "b": s.get("end").and_then(|x| x.as_f64()).unwrap_or(0.0), "text": s.get("text").and_then(|x| x.as_str()).unwrap_or("").trim(), "words": words })
        })
        .collect();
    json!({ "language": v.get("language").and_then(|x| x.as_str()).unwrap_or(""), "segments": out })
}

pub async fn run(State(st): State<AppState>, headers: HeaderMap, Query(q): Query<Params>, body: Bytes) -> Response {
    if let Err(code) = current_user(&st, &headers).await { return code.into_response(); }
    let lang = if q.lang.is_empty() { "auto".to_string() } else { q.lang.to_lowercase() };
    if !lang_ok(&lang) { return (StatusCode::BAD_REQUEST, Json(json!({ "error": "language" }))).into_response(); }
    if !wav_ok(&body) { return (StatusCode::BAD_REQUEST, Json(json!({ "error": "wav" }))).into_response(); }
    let prompt: String = q.prompt.chars().filter(|c| !c.is_control()).take(400).collect();
    let tq = st.tq.clone();
    if tq.waiting.fetch_add(1, Ordering::SeqCst) >= MAX_WAIT {
        tq.waiting.fetch_sub(1, Ordering::SeqCst);
        return (StatusCode::TOO_MANY_REQUESTS, Json(json!({ "error": "busy" }))).into_response();
    }
    let permit = tq.gate.acquire().await;
    tq.waiting.fetch_sub(1, Ordering::SeqCst);
    let Ok(_permit) = permit else { return StatusCode::SERVICE_UNAVAILABLE.into_response(); };
    let Ok(part) = Part::bytes(body.to_vec()).file_name("chunk.wav").mime_str("audio/wav") else { return StatusCode::INTERNAL_SERVER_ERROR.into_response(); };
    let mut form = Form::new()
        .part("file", part)
        .text("response_format", "verbose_json")
        .text("temperature", "0.0")
        .text("temperature_inc", "0.2")
        .text("token_timestamps", "true")
        .text("language", lang);
    if !prompt.is_empty() { form = form.text("prompt", prompt); }
    let res = match st.slow.post(&st.whisper).multipart(form).send().await {
        Ok(r) => r,
        Err(e) if e.is_connect() => return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({ "error": "offline" }))).into_response(),
        Err(_) => return (StatusCode::BAD_GATEWAY, Json(json!({ "error": "whisper" }))).into_response(),
    };
    if !res.status().is_success() { return (StatusCode::BAD_GATEWAY, Json(json!({ "error": "whisper", "status": res.status().as_u16() }))).into_response(); }
    match res.json::<Value>().await {
        Ok(v) if v.get("error").is_none() => Json(clean(v)).into_response(),
        _ => (StatusCode::BAD_GATEWAY, Json(json!({ "error": "whisper" }))).into_response(),
    }
}
