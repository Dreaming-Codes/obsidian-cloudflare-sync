//! Comment route handlers.
//!
//! Routes comment requests to the DocumentDO which manages comments per document.

use worker::*;

use crate::auth::JwtManager;
use crate::utils::ApiError;

/// Handle comment-related routes.
/// Routes: /docs/{doc_id}/comments/*
/// All routes require authentication and are forwarded to DocumentDO.
pub async fn handle_comment_routes(mut req: Request, env: &Env) -> Result<Response> {
    let path = req.path();
    let method = req.method();

    // All comment routes require authentication
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

    // Parse doc_id from path: /docs/{doc_id}/comments[/{comment_id}]
    let path_parts: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    
    // Expected: ["docs", "{doc_id}", "comments"] or ["docs", "{doc_id}", "comments", "{comment_id}"]
    if path_parts.len() < 3 || path_parts[0] != "docs" || path_parts[2] != "comments" {
        return ApiError::bad_request("Invalid comment route format").into_response();
    }

    let doc_id = path_parts[1];
    if doc_id.is_empty() {
        return ApiError::bad_request("Document ID is required").into_response();
    }

    // Get the DocumentDO for this document
    let doc_do = env.durable_object("DOCUMENT_DO")?;
    let stub = doc_do.id_from_name(doc_id)?.get_stub()?;

    // Map external paths to internal DO paths
    let internal_path = if path_parts.len() == 3 {
        // /docs/{doc_id}/comments -> /comments
        "/comments".to_string()
    } else if path_parts.len() == 4 {
        // /docs/{doc_id}/comments/{comment_id} -> /comments/{comment_id}
        format!("/comments/{}", path_parts[3])
    } else {
        return ApiError::not_found("Comment route not found").into_response();
    };

    // Validate method and path combination
    match (method.clone(), path_parts.len()) {
        (Method::Get, 3) => {} // GET /docs/{doc_id}/comments - list comments
        (Method::Post, 3) => {} // POST /docs/{doc_id}/comments - create comment
        (Method::Put, 4) => {} // PUT /docs/{doc_id}/comments/{id} - update comment
        (Method::Delete, 4) => {} // DELETE /docs/{doc_id}/comments/{id} - delete comment
        _ => return ApiError::not_found("Comment route not found").into_response(),
    }

    // Create request to DO with same body and headers
    let url = format!("https://internal{}", internal_path);
    let mut do_req = Request::new(&url, method.clone())?;

    // Copy Authorization header
    do_req.headers_mut()?.set("Authorization", &auth_header)?;
    do_req.headers_mut()?.set("Content-Type", "application/json")?;

    // Copy body if present (for POST/PUT)
    if method == Method::Post || method == Method::Put {
        if let Ok(body) = req.bytes().await {
            if !body.is_empty() {
                let headers = Headers::new();
                headers.set("Authorization", &auth_header)?;
                headers.set("Content-Type", "application/json")?;

                do_req = Request::new_with_init(
                    &url,
                    &RequestInit {
                        body: Some(body.into()),
                        headers,
                        method: method.clone(),
                        ..RequestInit::default()
                    },
                )?;
            }
        }
    }

    // Forward to DocumentDO
    stub.fetch_with_request(do_req).await
}
