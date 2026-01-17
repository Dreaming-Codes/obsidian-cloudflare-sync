//! WebSocket route handlers for real-time sync notifications.

use worker::*;

use crate::auth::JwtManager;

/// Get the SyncNotify Durable Object stub for a user.
fn get_sync_notify_do(env: &Env, user_id: &str) -> Result<Stub> {
    let namespace = env.durable_object("SYNC_NOTIFY_DO")?;
    // Each user has their own SyncNotify DO instance
    let id = namespace.id_from_name(user_id)?;
    id.get_stub()
}

/// Handle WebSocket connection request.
/// Authenticates via token query parameter and forwards to user's SyncNotify DO.
pub async fn handle_ws_routes(req: Request, env: Env) -> Result<Response> {
    // Extract token from query parameter
    let url = req.url()?;
    let token = url
        .query_pairs()
        .find(|(k, _)| k == "token")
        .map(|(_, v)| v.into_owned());

    let token = match token {
        Some(t) => t,
        None => return Response::error("Missing token parameter", 401),
    };

    // Validate JWT to get user_id for routing to correct DO
    let secret = env.secret("JWT_SECRET")?.to_string();
    let jwt_manager = JwtManager::new(&secret);

    let claims = match jwt_manager.decode(&token) {
        Ok(data) => data.claims,
        Err(_) => return Response::error("Invalid token", 401),
    };

    // Forward to user's SyncNotify DO
    let stub = get_sync_notify_do(&env, &claims.sub)?;

    // Build the internal request URL with the token
    let do_url = format!("http://do/ws?token={}", urlencoding::encode(&token));

    let do_req = Request::new_with_init(
        &do_url,
        RequestInit::new()
            .with_method(Method::Get)
            .with_headers(req.headers().clone()),
    )?;

    stub.fetch_with_request(do_req).await
}

/// Broadcast a sync notification to all devices of a user (except origin).
/// Called from file routes after successful upload/delete.
pub async fn broadcast_sync_notification(
    env: &Env,
    user_id: &str,
    path: &str,
    action: &str,
    origin_device: &str,
    content_hash: Option<&str>,
) -> Result<()> {
    let stub = get_sync_notify_do(env, user_id)?;

    let body = serde_json::json!({
        "path": path,
        "action": action,
        "originDevice": origin_device,
        "contentHash": content_hash,
    });

    let headers = Headers::new();
    headers.set("Content-Type", "application/json")?;

    let do_req = Request::new_with_init(
        "http://do/broadcast",
        RequestInit::new()
            .with_method(Method::Post)
            .with_headers(headers)
            .with_body(Some(body.to_string().into())),
    )?;

    // Fire and forget - don't block on broadcast
    let _ = stub.fetch_with_request(do_req).await;

    Ok(())
}
