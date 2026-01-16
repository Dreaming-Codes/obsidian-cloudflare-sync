//! WebSocket route handler for real-time sync.

use worker::*;

use crate::auth::JwtManager;
use crate::utils::ApiError;

/// Handle WebSocket upgrade requests.
/// Routes the WebSocket connection to the appropriate DocumentDO.
pub async fn handle_websocket_upgrade(req: Request, env: Env) -> Result<Response> {
    // Verify JWT token from query parameter or header
    let url = req.url()?;
    let token = url
        .query_pairs()
        .find(|(k, _)| k == "token")
        .map(|(_, v)| v.to_string())
        .or_else(|| {
            req.headers()
                .get("Authorization")
                .ok()
                .flatten()
                .and_then(|h| h.strip_prefix("Bearer ").map(String::from))
        });

    let token = match token {
        Some(t) => t,
        None => {
            return ApiError::unauthorized("Missing authentication token").into_response();
        }
    };

    // Validate JWT
    let jwt_secret = env.secret("JWT_SECRET")?.to_string();
    let jwt_manager = JwtManager::new(&jwt_secret);

    let claims = match jwt_manager.decode(&token) {
        Ok(data) => data.claims,
        Err(_) => {
            return ApiError::unauthorized("Invalid authentication token").into_response();
        }
    };

    // Get doc_id from query parameter
    let doc_id = url
        .query_pairs()
        .find(|(k, _)| k == "doc")
        .map(|(_, v)| v.to_string());

    let doc_id = match doc_id {
        Some(d) => d,
        None => {
            return ApiError::bad_request("Missing document ID").into_response();
        }
    };

    // Get the DocumentDO for this document
    let document_do = env.durable_object("DOCUMENT_DO")?;
    let stub = document_do.id_from_name(&doc_id)?.get_stub()?;

    // Create a new request with user info headers for the DO
    let headers = Headers::new();
    headers.set("X-User-Id", &claims.sub)?;
    headers.set("X-User-Email", &claims.email)?;
    headers.set("Upgrade", "websocket")?;

    let do_req = Request::new_with_init(
        &format!("https://internal/ws?doc={}", doc_id),
        RequestInit::new()
            .with_method(Method::Get)
            .with_headers(headers),
    )?;

    // Forward to DocumentDO which will handle the WebSocket
    stub.fetch_with_request(do_req).await
}
