use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, HeaderName, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{path::{Path, PathBuf}, time::Duration};
use tower_http::{
    services::{ServeDir, ServeFile},
    set_header::SetResponseHeaderLayer,
};

const BIND: &str = "127.0.0.1:4541";
const WEB_DIR: &str = "/opt/delicate-studio/web";
const DJ_API: &str = "http://127.0.0.1:4540";

#[derive(Clone)]
struct AppState {
    http: reqwest::Client,
    dj: String,
    web: PathBuf,
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
    let state = AppState { http, dj, web: web.clone() };
    let studio = Router::new()
        .route("/api/me", get(me))
        .route("/api/version", get(version))
        .fallback_service(ServeDir::new(&web).fallback(ServeFile::new(web.join("index.html"))))
        .with_state(state);
    let app = Router::new()
        .route_service("/studio/", ServeFile::new(web.join("index.html")))
        .nest("/studio", studio)
        .layer(SetResponseHeaderLayer::if_not_present(header::CACHE_CONTROL, HeaderValue::from_static("no-cache")))
        .layer(SetResponseHeaderLayer::overriding(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff")))
        .layer(SetResponseHeaderLayer::overriding(HeaderName::from_static("cross-origin-opener-policy"), HeaderValue::from_static("same-origin")))
        .layer(SetResponseHeaderLayer::overriding(HeaderName::from_static("cross-origin-embedder-policy"), HeaderValue::from_static("require-corp")));
    let bind = std::env::var("STUDIO_BIND").unwrap_or_else(|_| BIND.to_string());
    let listener = tokio::net::TcpListener::bind(&bind).await.unwrap();
    println!("delicate-studio listening on {}", bind);
    axum::serve(listener, app).await.unwrap();
}
