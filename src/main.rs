use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, HeaderName, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{path::{Path, PathBuf}, time::Duration};
use tower_http::{
    services::{ServeDir, ServeFile},
    set_header::SetResponseHeaderLayer,
};

mod cdrip;
mod review;
mod transcribe;
mod watch;

const BIND: &str = "127.0.0.1:4541";
const WEB_DIR: &str = "/opt/delicate-studio/web";
const DJ_API: &str = "http://127.0.0.1:4540";
const WHISPER: &str = "http://127.0.0.1:4546/inference";

#[derive(Clone)]
struct AppState {
    http: reqwest::Client,
    dj: String,
    web: PathBuf,
    watch: watch::Shared,
    slow: reqwest::Client,
    whisper: String,
    tq: transcribe::Shared,
    reviews: review::Shared,
    cd: cdrip::Shared,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct User {
    username: String,
    #[serde(default)]
    role: String,
    #[serde(default)]
    plan: String,
}

async fn current_user(state: &AppState, headers: &HeaderMap) -> Result<User, StatusCode> {
    let Some(cookie) = headers.get(header::COOKIE) else { return Err(StatusCode::UNAUTHORIZED); };
    let res = state
        .http
        .get(format!("{}/api/me", state.dj))
        .header(header::COOKIE, cookie.clone())
        .send()
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;
    match res.status().as_u16() {
        200 => res.json::<User>().await.map_err(|_| StatusCode::BAD_GATEWAY),
        401 => Err(StatusCode::UNAUTHORIZED),
        403 => Err(StatusCode::FORBIDDEN),
        _ => Err(StatusCode::BAD_GATEWAY),
    }
}

async fn me(State(state): State<AppState>, headers: HeaderMap) -> Response {
    match current_user(&state, &headers).await {
        Ok(u) => Json(u).into_response(),
        Err(code) => code.into_response(),
    }
}

fn newest_mtime(dir: &Path, depth: u32) -> u64 {
    let mut latest = 0u64;
    let Ok(rd) = std::fs::read_dir(dir) else { return 0; };
    for e in rd.flatten() {
        let Ok(m) = e.metadata() else { continue; };
        if m.is_dir() {
            if depth > 0 { latest = latest.max(newest_mtime(&e.path(), depth - 1)); }
            continue;
        }
        if let Ok(t) = m.modified() {
            if let Ok(d) = t.duration_since(std::time::UNIX_EPOCH) { latest = latest.max(d.as_secs()); }
        }
    }
    latest
}

async fn version(State(state): State<AppState>) -> Response {
    let web = state.web.clone();
    let v = tokio::task::spawn_blocking(move || newest_mtime(&web, 2)).await.unwrap_or(0);
    Json(json!({ "version": format!("{:x}", v) })).into_response()
}

#[tokio::main]
async fn main() {
    let web = PathBuf::from(std::env::var("STUDIO_WEB").unwrap_or_else(|_| WEB_DIR.to_string()));
    let dj = std::env::var("STUDIO_DJ").unwrap_or_else(|_| DJ_API.to_string());
    let http = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    let watch = watch::open(dj.clone());
    tokio::spawn(watch::run(watch.clone()));
    let slow = reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(1800))
        .build()
        .unwrap();
    let whisper = std::env::var("STUDIO_WHISPER").unwrap_or_else(|_| WHISPER.to_string());
    let base = PathBuf::from(
        std::env::var("STATE_DIRECTORY")
            .ok()
            .and_then(|s| s.split(':').next().map(str::to_string))
            .or_else(|| std::env::var("STUDIO_STATE").ok())
            .unwrap_or_else(|| "state".into()),
    );
    let reviews = review::open(base);
    tokio::spawn(review::run(reviews.clone()));
    let state = AppState { http, dj, web: web.clone(), watch, slow, whisper, tq: transcribe::open(), reviews, cd: cdrip::open() };
    let api = Router::new()
        .route("/me", get(me))
        .route("/version", get(version))
        .route("/watch", get(watch::get_all).post(watch::create))
        .route("/watch/{id}", axum::routing::patch(watch::patch).delete(watch::remove))
        .route("/watch/{id}/run", post(watch::run_now))
        .route("/transcribe", post(transcribe::run).layer(axum::extract::DefaultBodyLimit::max(transcribe::MAX_BODY)))
        .route("/reviews", get(review::list).post(review::create))
        .route("/reviews/{id}", axum::routing::delete(review::remove))
        .route("/reviews/{id}/data", axum::routing::put(review::part).layer(axum::extract::DefaultBodyLimit::max(review::PART + 4096)))
        .route("/reviews/{id}/done", post(review::done))
        .route("/reviews/{id}/comments/{cid}", post(review::resolve))
        .route("/cd/mb/{id}", get(cdrip::mb))
        .route("/cd/ar/{name}", get(cdrip::ar))
        .route("/pub/{token}", get(review::pub_get))
        .route("/pub/{token}/audio", get(review::pub_audio))
        .route("/pub/{token}/comments", post(review::pub_comment))
        .fallback(|| async { StatusCode::NOT_FOUND })
        .with_state(state);
    let app = Router::new()
        .nest("/api/studio", api)
        .route_service("/r/{token}", ServeFile::new(web.join("review.html")))
        .fallback_service(ServeDir::new(&web).fallback(ServeFile::new(web.join("index.html"))))
        .layer(SetResponseHeaderLayer::if_not_present(header::CACHE_CONTROL, HeaderValue::from_static("no-cache")))
        .layer(SetResponseHeaderLayer::overriding(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff")))
        .layer(SetResponseHeaderLayer::overriding(HeaderName::from_static("cross-origin-opener-policy"), HeaderValue::from_static("same-origin")))
        .layer(SetResponseHeaderLayer::overriding(HeaderName::from_static("cross-origin-embedder-policy"), HeaderValue::from_static("require-corp")));
    let bind = std::env::var("STUDIO_BIND").unwrap_or_else(|_| BIND.to_string());
    let listener = tokio::net::TcpListener::bind(&bind).await.unwrap();
    println!("delicate-studio listening on {}", bind);
    axum::serve(listener, app).await.unwrap();
}
