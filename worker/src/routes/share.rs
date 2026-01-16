//! Share route handlers.
//!
//! Routes share requests to the UserDO which manages share storage.

use worker::*;

use crate::auth::JwtManager;
use crate::utils::ApiError;

/// Handle share-related routes.
/// All share routes require authentication and are forwarded to UserDO.
pub async fn handle_share_routes(mut req: Request, env: &Env) -> Result<Response> {
    let path = req.path();
    let method = req.method();

    // All share routes require authentication
    let auth_header = req.headers().get("Authorization")?.unwrap_or_default();
    if !auth_header.starts_with("Bearer ") {
        return ApiError::unauthorized("Missing authorization header").into_response();
    }

    let token = &auth_header[7..];
    let jwt_secret = env.secret("JWT_SECRET")?.to_string();
    let jwt_manager = JwtManager::new(&jwt_secret);

    // Validate token
    let _claims = match jwt_manager.decode(token) {
        Ok(data) => data.claims,
        Err(_) => return ApiError::unauthorized("Invalid token").into_response(),
    };

    // Get the UserDO (single instance for all users)
    let user_do = env.durable_object("USER_DO")?;
    let stub = user_do.id_from_name("global")?.get_stub()?;

    // Map external paths to internal DO paths
    let internal_path = match (method.clone(), path.as_str()) {
        (Method::Post, "/share") => "/shares".to_string(),
        (Method::Get, "/shares") => "/shares".to_string(),
        (Method::Get, "/shared-with-me") => "/shared-with-me".to_string(),
        (Method::Get, p) if p.starts_with("/share/") => format!("/shares/{}", &p[7..]),
        (Method::Put, p) if p.starts_with("/share/") => format!("/shares/{}", &p[7..]),
        (Method::Delete, p) if p.starts_with("/share/") => format!("/shares/{}", &p[7..]),
        (Method::Post, p) if p.starts_with("/share/") && p.ends_with("/accept") => {
            format!("/shares/{}", &p[7..])
        }
        (Method::Get, "/permissions") => "/permissions".to_string(),
        _ => return ApiError::not_found("Share route not found").into_response(),
    };

    // Create request to DO with same body and headers
    let url = format!("https://internal{}", internal_path);
    let mut do_req = Request::new(&url, method)?;

    // Copy Authorization header
    do_req.headers_mut()?.set("Authorization", &auth_header)?;
    do_req.headers_mut()?.set("Content-Type", "application/json")?;

    // Copy body if present
    if let Ok(body) = req.bytes().await {
        if !body.is_empty() {
            // Create request with body
            let init = RequestInit::default();
            let headers = Headers::new();
            headers.set("Authorization", &auth_header)?;
            headers.set("Content-Type", "application/json")?;

            do_req = Request::new_with_init(
                &url,
                &RequestInit {
                    body: Some(body.into()),
                    headers,
                    ..init
                },
            )?;
        }
    }

    // Forward to UserDO
    stub.fetch_with_request(do_req).await
}
