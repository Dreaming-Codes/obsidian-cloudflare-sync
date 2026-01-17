//! Share route handlers.
//!
//! Routes share requests to the UserDO which manages share storage.

use serde::Deserialize;
use urlencoding::decode;
use worker::*;

use crate::auth::{JwtManager, ResendClient};
use crate::models::ShareResponse;
use crate::utils::{ApiError, R2Helper};

/// Get the User Durable Object stub.
fn get_user_do(env: &Env) -> Result<Stub> {
    let namespace = env.durable_object("USER_DO")?;
    let id = namespace.id_from_name("global-users")?;
    id.get_stub()
}

/// Request body for creating a share (for parsing).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateShareBody {
    resource_path: String,
    invitee_email: String,
    permission: String,
}

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
    let claims = match jwt_manager.decode(token) {
        Ok(data) => data.claims,
        Err(_) => return ApiError::unauthorized("Invalid token").into_response(),
    };

    // Special handling for POST /share to send email after creation
    if method == Method::Post && path == "/share" {
        return handle_create_share(req, env, &auth_header, &claims.email).await;
    }

    // Map external paths to internal DO paths
    let internal_path = match (method.clone(), path.as_str()) {
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

    let stub = get_user_do(env)?;
    let url = format!("http://do{}", internal_path);

    // Build headers
    let headers = Headers::new();
    headers.set("Authorization", &auth_header)?;
    headers.set("Content-Type", "application/json")?;

    // Create the DO request based on method and body
    let do_req = match method {
        Method::Get | Method::Delete => {
            Request::new_with_init(
                &url,
                RequestInit::new()
                    .with_method(method)
                    .with_headers(headers),
            )?
        }
        Method::Post | Method::Put => {
            // Read body from original request
            let body = req.bytes().await?;
            if body.is_empty() {
                Request::new_with_init(
                    &url,
                    RequestInit::new()
                        .with_method(method)
                        .with_headers(headers),
                )?
            } else {
                Request::new_with_init(
                    &url,
                    RequestInit::new()
                        .with_method(method)
                        .with_headers(headers)
                        .with_body(Some(body.into())),
                )?
            }
        }
        _ => return ApiError::not_found("Method not allowed").into_response(),
    };

    // Forward to UserDO
    stub.fetch_with_request(do_req).await
}

/// Handle POST /share - create share and send email notification.
async fn handle_create_share(
    mut req: Request,
    env: &Env,
    auth_header: &str,
    owner_email: &str,
) -> Result<Response> {
    // Read and parse the request body
    let body_bytes = req.bytes().await?;
    let create_req: CreateShareBody = serde_json::from_slice(&body_bytes)
        .map_err(|e| Error::RustError(format!("Invalid request body: {}", e)))?;

    // Forward to DO
    let stub = get_user_do(env)?;
    let headers = Headers::new();
    headers.set("Authorization", auth_header)?;
    headers.set("Content-Type", "application/json")?;

    let do_req = Request::new_with_init(
        "http://do/shares",
        RequestInit::new()
            .with_method(Method::Post)
            .with_headers(headers)
            .with_body(Some(body_bytes.into())),
    )?;

    let mut do_response = stub.fetch_with_request(do_req).await?;

    // Check if share was created successfully
    if do_response.status_code() == 200 {
        // Parse the response to check success
        let response_text = do_response.text().await?;
        let share_response: std::result::Result<ShareResponse, _> = serde_json::from_str(&response_text);

        if let Ok(ref resp) = share_response {
            if resp.success && resp.share.is_some() {
                // Send email notification (fire and forget - don't block on email)
                let resend = ResendClient::from_env(env);
                if let Ok(client) = resend {
                    let _ = client
                        .send_share_invitation(
                            &create_req.invitee_email,
                            owner_email,
                            &create_req.resource_path,
                            &create_req.permission,
                        )
                        .await;
                }
            }
        }

        // Return the original response
        let headers = do_response.headers().clone();
        Ok(Response::ok(response_text)?.with_headers(headers))
    } else {
        // Return error response as-is
        Ok(do_response)
    }
}

/// Handle GET /shared-files/{owner_id}/{path} - Download a file shared by another user.
///
/// This endpoint allows users to download files that have been shared with them.
/// It verifies that the requester has an accepted share for the file before allowing access.
pub async fn handle_shared_file_download(req: Request, env: &Env, path: &str) -> Result<Response> {
    // Authenticate user
    let auth_header = req.headers().get("Authorization")?.unwrap_or_default();
    if !auth_header.starts_with("Bearer ") {
        return ApiError::unauthorized("Missing authorization header").into_response();
    }

    let token = &auth_header[7..];
    let jwt_secret = env.secret("JWT_SECRET")?.to_string();
    let jwt_manager = JwtManager::new(&jwt_secret);

    let claims = match jwt_manager.decode(token) {
        Ok(data) => data.claims,
        Err(_) => return ApiError::unauthorized("Invalid token").into_response(),
    };

    // Parse path: /shared-files/{owner_id}/{file_path...}
    let path_without_prefix = path.strip_prefix("/shared-files/").unwrap_or("");
    
    // Find the first slash to separate owner_id from file_path
    let (owner_id, file_path) = match path_without_prefix.find('/') {
        Some(idx) => {
            let owner = &path_without_prefix[..idx];
            let file = &path_without_prefix[idx + 1..];
            (owner, file)
        }
        None => {
            return ApiError::bad_request("Invalid path format. Expected /shared-files/{owner_id}/{file_path}").into_response();
        }
    };

    if owner_id.is_empty() || file_path.is_empty() {
        return ApiError::bad_request("Owner ID and file path are required").into_response();
    }

    // Decode the file path (may be URL-encoded)
    let decoded_file_path = decode(file_path)
        .map_err(|e| Error::RustError(format!("Failed to decode path: {}", e)))?
        .into_owned();

    // Check if user has permission to access this file via UserDO
    // Query the shares table for an accepted share matching this resource
    let stub = get_user_do(env)?;
    let permission_url = format!(
        "http://do/permissions?path={}&owner_id={}",
        urlencoding::encode(&decoded_file_path),
        urlencoding::encode(owner_id)
    );
    
    let headers = Headers::new();
    headers.set("Authorization", &auth_header)?;
    
    let perm_req = Request::new_with_init(
        &permission_url,
        RequestInit::new()
            .with_method(Method::Get)
            .with_headers(headers),
    )?;
    
    let perm_response = stub.fetch_with_request(perm_req).await?;
    
    // If permission check fails (403), user doesn't have access
    if perm_response.status_code() == 403 {
        return ApiError::forbidden("You don't have access to this file").into_response();
    }
    
    if perm_response.status_code() != 200 {
        return ApiError::internal("Failed to check permissions").into_response();
    }

    // User has permission - fetch the file from R2 using owner's user_id
    let bucket = env.bucket("VAULT_STORAGE")?;
    let r2 = R2Helper::new(&bucket);

    // Get file metadata
    let meta = match r2.get_meta(owner_id, &decoded_file_path).await? {
        Some(m) if !m.deleted => m,
        Some(_) => return ApiError::not_found("File not found or has been deleted").into_response(),
        None => return ApiError::not_found("File not found").into_response(),
    };

    // Get file content
    let content = match r2.get_content(owner_id, &decoded_file_path).await? {
        Some(c) => c,
        None => return ApiError::not_found("File content not found").into_response(),
    };

    // Build response with appropriate headers
    let response_headers = Headers::new();
    response_headers.set("Content-Type", &meta.content_type)?;
    response_headers.set("Content-Length", &content.len().to_string())?;
    response_headers.set("X-File-Hash", &meta.content_hash)?;
    response_headers.set("X-File-Mtime", &meta.mtime.to_string())?;

    Ok(Response::from_bytes(content)?.with_headers(response_headers))
}
