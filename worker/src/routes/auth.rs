//! Authentication route handlers.

use serde::{Deserialize, Serialize};
use worker::*;

use crate::auth::ResendClient;
use crate::utils::ApiError;

/// Request body for magic link creation.
#[derive(Debug, Deserialize, Serialize)]
pub struct MagicLinkRequest {
    pub email: String,
}

/// Handle all auth-related routes.
pub async fn handle_auth_routes(req: Request, env: Env, path: &str) -> Result<Response> {
    let method = req.method();
    
    // Strip /auth prefix
    let sub_path = path.strip_prefix("/auth").unwrap_or(path);

    match (method, sub_path) {
        (Method::Post, "/magic-link") => handle_magic_link(req, env).await,
        (Method::Get, "/verify") => handle_verify(req, env).await,
        (Method::Post, "/refresh") => handle_refresh(req, env).await,
        (Method::Post, "/logout") => handle_logout(req, env).await,
        (Method::Get, "/me") => handle_me(req, env).await,
        (Method::Delete, "/sessions") => handle_delete_sessions(req, env).await,
        _ => ApiError::not_found("Auth endpoint not found").into_response(),
    }
}

/// Get the User Durable Object stub.
fn get_user_do(env: &Env) -> Result<Stub> {
    // Use a single global User DO for simplicity
    // In production, you might want to shard by email domain or user ID
    let namespace = env.durable_object("USER_DO")?;
    let id = namespace.id_from_name("global-users")?;
    id.get_stub()
}

/// Handle POST /auth/magic-link - Request a magic link.
async fn handle_magic_link(mut req: Request, env: Env) -> Result<Response> {
    let body: MagicLinkRequest = req.json().await?;
    let email = body.email.to_lowercase().trim().to_string();

    // Validate email
    if !email.contains('@') || !email.contains('.') {
        return ApiError::bad_request("Invalid email format").into_response();
    }

    // Forward to User DO to create magic link
    let stub = get_user_do(&env)?;
    
    let do_req = Request::new_with_init(
        "https://fake-host/magic-link",
        RequestInit::new()
            .with_method(Method::Post)
            .with_body(Some(serde_json::to_string(&body)?.into())),
    )?;
    
    let do_response = stub.fetch_with_request(do_req).await?;
    
    // If magic link was created, send the email
    if do_response.status_code() == 200 {
        // Get the token from the DO (we need to modify the flow)
        // For now, we'll create the token here and pass it
        let manager = crate::auth::MagicLinkManager::default();
        let token = manager.generate_token();
        
        // Send email via Resend
        let resend = ResendClient::from_env(&env)?;
        match resend.send_magic_link(&email, &token.token).await {
            Ok(response) => {
                if response.error.is_some() {
                    return ApiError::internal("Failed to send email").into_response();
                }
            }
            Err(e) => {
                console_log!("Failed to send magic link email: {:?}", e);
                return ApiError::internal("Failed to send email").into_response();
            }
        }

        // Store the magic link in the DO
        let store_req = Request::new_with_init(
            "https://fake-host/magic-link",
            RequestInit::new()
                .with_method(Method::Post)
                .with_body(Some(
                    serde_json::to_string(&serde_json::json!({
                        "email": email,
                        "token_hash": token.token_hash,
                        "expires_at": token.expires_at
                    }))?
                    .into(),
                )),
        )?;
        
        stub.fetch_with_request(store_req).await?;

        crate::utils::json_ok(&serde_json::json!({
            "success": true,
            "message": "Magic link sent to your email"
        }))
    } else {
        Ok(do_response)
    }
}

/// Handle GET /auth/verify?token=xxx - Verify a magic link.
async fn handle_verify(req: Request, env: Env) -> Result<Response> {
    let url = req.url()?;
    let token = url
        .query_pairs()
        .find(|(k, _)| k == "token")
        .map(|(_, v)| v.to_string());

    let token = match token {
        Some(t) => t,
        None => return ApiError::bad_request("Missing token parameter").into_response(),
    };

    // Get device info from User-Agent
    let device_info = req.headers().get("User-Agent")?.unwrap_or_default();

    // Forward to User DO
    let stub = get_user_do(&env)?;
    
    let do_req = Request::new_with_init(
        "https://fake-host/verify",
        RequestInit::new()
            .with_method(Method::Post)
            .with_body(Some(
                serde_json::to_string(&serde_json::json!({
                    "token": token,
                    "device_info": device_info
                }))?
                .into(),
            )),
    )?;

    stub.fetch_with_request(do_req).await
}

/// Handle POST /auth/refresh - Refresh an access token.
async fn handle_refresh(mut req: Request, env: Env) -> Result<Response> {
    let stub = get_user_do(&env)?;
    
    // Clone the body for forwarding
    let body = req.text().await?;
    
    let do_req = Request::new_with_init(
        "https://fake-host/refresh",
        RequestInit::new()
            .with_method(Method::Post)
            .with_body(Some(body.into())),
    )?;

    stub.fetch_with_request(do_req).await
}

/// Handle POST /auth/logout - Logout (invalidate refresh token).
async fn handle_logout(mut req: Request, env: Env) -> Result<Response> {
    let stub = get_user_do(&env)?;
    
    let body = req.text().await?;
    
    let do_req = Request::new_with_init(
        "https://fake-host/logout",
        RequestInit::new()
            .with_method(Method::Post)
            .with_body(Some(body.into())),
    )?;

    stub.fetch_with_request(do_req).await
}

/// Handle GET /auth/me - Get current user info.
async fn handle_me(req: Request, env: Env) -> Result<Response> {
    let stub = get_user_do(&env)?;
    
    // Forward the Authorization header
    let auth_header = req.headers().get("Authorization")?.unwrap_or_default();
    
    let headers = Headers::new();
    headers.set("Authorization", &auth_header)?;
    
    let do_req = Request::new_with_init(
        "https://fake-host/user",
        RequestInit::new()
            .with_method(Method::Get)
            .with_headers(headers),
    )?;

    stub.fetch_with_request(do_req).await
}

/// Handle DELETE /auth/sessions - Logout from all devices.
async fn handle_delete_sessions(req: Request, env: Env) -> Result<Response> {
    let stub = get_user_do(&env)?;
    
    let auth_header = req.headers().get("Authorization")?.unwrap_or_default();
    
    let headers = Headers::new();
    headers.set("Authorization", &auth_header)?;
    
    let do_req = Request::new_with_init(
        "https://fake-host/sessions",
        RequestInit::new()
            .with_method(Method::Delete)
            .with_headers(headers),
    )?;

    stub.fetch_with_request(do_req).await
}
