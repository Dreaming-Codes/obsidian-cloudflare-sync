//! Cloudflare Sync Worker - Rust-based API gateway for Obsidian sync.
//!
//! This worker provides:
//! - Magic link authentication via Resend
//! - File storage via R2
//! - Real-time sync via Durable Objects with WebSocket hibernation
//! - Granular permission management

use serde::Serialize;
use worker::*;

mod auth;
mod durable_objects;
mod models;
mod routes;
mod utils;

use routes::{handle_auth_routes, handle_file_routes};
use utils::{json_ok, ApiError};

// Re-export Durable Objects for wrangler
pub use durable_objects::UserDurableObject;

/// Health check response.
#[derive(Debug, Serialize)]
struct HealthResponse {
    status: &'static str,
    version: &'static str,
}

/// Apply CORS headers to a response.
fn cors_headers(mut response: Response, origin: Option<&str>) -> Response {
    let headers = response.headers_mut();

    // Allow the requesting origin, or * for development
    let allow_origin = origin.unwrap_or("*");
    let _ = headers.set("Access-Control-Allow-Origin", allow_origin);
    let _ = headers.set(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, DELETE, OPTIONS",
    );
    let _ = headers.set(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization",
    );
    let _ = headers.set("Access-Control-Max-Age", "86400");

    response
}

/// Handle CORS preflight requests.
fn handle_preflight(origin: Option<&str>) -> Result<Response> {
    let response = Response::empty()?.with_status(204);
    Ok(cors_headers(response, origin))
}

/// Main fetch handler.
#[event(fetch)]
async fn fetch(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    // Get origin for CORS
    let origin = req.headers().get("Origin").ok().flatten();
    let origin_ref = origin.as_deref();

    // Handle CORS preflight
    if req.method() == Method::Options {
        return handle_preflight(origin_ref);
    }

    // Route the request
    let response = route(req, env).await;

    // Apply CORS headers to all responses
    match response {
        Ok(resp) => Ok(cors_headers(resp, origin_ref)),
        Err(e) => {
            console_error!("Request error: {:?}", e);
            let error_response = ApiError::internal(&e.to_string()).into_response()?;
            Ok(cors_headers(error_response, origin_ref))
        }
    }
}

/// Route requests to appropriate handlers.
async fn route(req: Request, env: Env) -> Result<Response> {
    let path = req.path();
    let method = req.method();

    match (method.clone(), path.as_str()) {
        // Health check
        (Method::Get, "/health") => {
            let response = HealthResponse {
                status: "ok",
                version: env!("CARGO_PKG_VERSION"),
            };
            json_ok(&response)
        }

        // API version info
        (Method::Get, "/") => {
            let response = serde_json::json!({
                "name": "Cloudflare Sync API",
                "version": env!("CARGO_PKG_VERSION"),
                "endpoints": {
                    "health": "/health",
                    "auth": "/auth/*",
                    "files": "/files/*",
                    "share": "/share/*",
                    "ws": "/ws"
                }
            });
            json_ok(&response)
        }

        // Auth routes
        (_, p) if p.starts_with("/auth/") || p == "/auth" => {
            handle_auth_routes(req, env, &path).await
        }

        // File routes
        (_, p) if p.starts_with("/files") => {
            handle_file_routes(req, env, &path).await
        }

        // Share routes (to be implemented in Phase 8)
        (_, p) if p.starts_with("/share") => {
            ApiError::new("NOT_IMPLEMENTED", "Share routes not yet implemented", 501)
                .into_response()
        }

        // WebSocket routes (to be implemented in Phase 7)
        (_, "/ws") => {
            ApiError::new("NOT_IMPLEMENTED", "WebSocket not yet implemented", 501).into_response()
        }

        // 404 for everything else
        _ => ApiError::not_found("Endpoint not found").into_response(),
    }
}
