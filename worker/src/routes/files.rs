//! File route handlers for R2 storage operations.

use serde::Deserialize;
use sha2::{Digest, Sha256};
use urlencoding::decode;
use worker::*;

use crate::auth::JwtManager;
use crate::models::FileUploadResponse;
use crate::routes::ws::broadcast_sync_notification;
use crate::utils::{json_ok, merge::MergeResult, no_content, ApiError, R2Helper};

/// Query parameters for listing files.
#[derive(Debug, Deserialize)]
pub struct ListFilesQuery {
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub since: Option<i64>,
}

/// Authenticated user context.
pub struct AuthContext {
    pub user_id: String,
    pub email: String,
    pub device_id: String,
}

/// Get the User Durable Object stub.
fn get_user_do(env: &Env) -> Result<Stub> {
    let namespace = env.durable_object("USER_DO")?;
    let id = namespace.id_from_name("global-users")?;
    id.get_stub()
}

/// Extract and validate JWT from Authorization header.
pub fn extract_auth(req: &Request, env: &Env) -> Result<AuthContext> {
    let auth_header = req
        .headers()
        .get("Authorization")?
        .ok_or_else(|| Error::RustError("Missing Authorization header".into()))?;

    if !auth_header.starts_with("Bearer ") {
        return Err(Error::RustError("Invalid Authorization header format".into()));
    }

    let token = &auth_header[7..];
    let secret = env.secret("JWT_SECRET")?.to_string();
    let jwt_manager = JwtManager::new(&secret);

    let token_data = jwt_manager
        .decode(token)
        .map_err(|e| Error::RustError(format!("Invalid token: {}", e)))?;

    Ok(AuthContext {
        user_id: token_data.claims.sub,
        email: token_data.claims.email,
        device_id: token_data.claims.device_id,
    })
}

/// Handle all file-related routes.
pub async fn handle_file_routes(req: Request, env: Env, path: &str) -> Result<Response> {
    // All file routes require authentication
    let auth = match extract_auth(&req, &env) {
        Ok(a) => a,
        Err(_) => return ApiError::unauthorized("Invalid or missing authentication").into_response(),
    };

    let method = req.method();

    // Strip /files prefix
    let sub_path = path.strip_prefix("/files").unwrap_or("");

    // Route based on method and path pattern
    match method {
        Method::Get if sub_path.is_empty() => handle_list_files(req, env, auth).await,
        Method::Post if sub_path == "/clear" => handle_clear_files(req, env).await,
        Method::Get if sub_path.ends_with("/versions") => {
            let file_path = sub_path.strip_suffix("/versions").unwrap_or("");
            handle_list_versions(env, auth, file_path).await
        }
        Method::Get if sub_path.contains("/versions/") => {
            // Extract file path and timestamp
            if let Some(idx) = sub_path.find("/versions/") {
                let file_path = &sub_path[..idx];
                let timestamp_str = &sub_path[idx + 10..];
                if let Ok(timestamp) = timestamp_str.parse::<i64>() {
                    return handle_get_version(env, auth, file_path, timestamp).await;
                }
            }
            ApiError::bad_request("Invalid version path").into_response()
        }
        Method::Get => handle_get_file(env, auth, sub_path).await,
        Method::Put => handle_put_file(req, env, auth, sub_path).await,
        Method::Delete => handle_delete_file(req, env, auth, sub_path).await,
        _ => ApiError::not_found("File endpoint not found").into_response(),
    }
}

/// GET /files - List all files for the authenticated user.
/// Uses User DO SQLite for fast metadata queries.
async fn handle_list_files(req: Request, env: Env, _auth: AuthContext) -> Result<Response> {
    let url = req.url()?;
    
    // Build query string for DO
    let mut query_parts = Vec::new();
    for (k, v) in url.query_pairs() {
        query_parts.push(format!("{}={}", k, v));
    }
    let query_string = if query_parts.is_empty() {
        String::new()
    } else {
        format!("?{}", query_parts.join("&"))
    };

    // Forward the Authorization header to the DO
    let auth_header = req.headers().get("Authorization")?.unwrap_or_default();
    
    let headers = Headers::new();
    headers.set("Authorization", &auth_header)?;

    let stub = get_user_do(&env)?;
    let do_req = Request::new_with_init(
        &format!("http://do/files{}", query_string),
        RequestInit::new()
            .with_method(Method::Get)
            .with_headers(headers),
    )?;

    stub.fetch_with_request(do_req).await
}

/// POST /files/clear - Clear all file metadata (for re-sync).
async fn handle_clear_files(req: Request, env: Env) -> Result<Response> {
    // Forward the Authorization header to the DO
    let auth_header = req.headers().get("Authorization")?.unwrap_or_default();
    
    let headers = Headers::new();
    headers.set("Authorization", &auth_header)?;

    let stub = get_user_do(&env)?;
    let do_req = Request::new_with_init(
        "http://do/files/clear",
        RequestInit::new()
            .with_method(Method::Post)
            .with_headers(headers),
    )?;

    stub.fetch_with_request(do_req).await
}

/// GET /files/{path} - Download a file.
async fn handle_get_file(env: Env, auth: AuthContext, file_path: &str) -> Result<Response> {
    if file_path.is_empty() {
        return ApiError::bad_request("File path is required").into_response();
    }

    // Remove leading slash if present and decode URL-encoded path
    let clean_path = file_path.strip_prefix('/').unwrap_or(file_path);
    let decoded_path = decode(clean_path)
        .map_err(|e| Error::RustError(format!("Failed to decode path: {}", e)))?
        .into_owned();

    let bucket = env.bucket("VAULT_STORAGE")?;
    let r2 = R2Helper::new(&bucket);

    // Check metadata first
    let meta = match r2.get_meta(&auth.user_id, &decoded_path).await? {
        Some(m) if !m.deleted => m,
        Some(_) => return ApiError::not_found("File not found").into_response(),
        None => return ApiError::not_found("File not found").into_response(),
    };

    // Get content
    let content = match r2.get_content(&auth.user_id, &decoded_path).await? {
        Some(c) => c,
        None => return ApiError::not_found("File content not found").into_response(),
    };

    // Build response with appropriate headers
    let headers = Headers::new();
    headers.set("Content-Type", &meta.content_type)?;
    headers.set("Content-Length", &content.len().to_string())?;
    headers.set("X-File-Hash", &meta.content_hash)?;
    headers.set("X-File-Mtime", &meta.mtime.to_string())?;

    Ok(Response::from_bytes(content)?.with_headers(headers))
}

/// PUT /files/{path} - Upload or update a file.
/// Stores content in R2 and metadata in User DO SQLite.
/// Supports 3-way merge via X-Base-Hash header for conflict resolution.
async fn handle_put_file(mut req: Request, env: Env, auth: AuthContext, file_path: &str) -> Result<Response> {
    if file_path.is_empty() {
        return ApiError::bad_request("File path is required").into_response();
    }

    // Remove leading slash if present and decode URL-encoded path
    let clean_path = file_path.strip_prefix('/').unwrap_or(file_path);
    let decoded_path = decode(clean_path)
        .map_err(|e| Error::RustError(format!("Failed to decode path: {}", e)))?
        .into_owned();

    // Get content type from header or default
    let content_type = req
        .headers()
        .get("Content-Type")?
        .unwrap_or_else(|| "application/octet-stream".to_string());

    // Get mtime from header or use current time
    let mtime: i64 = req
        .headers()
        .get("X-File-Mtime")?
        .and_then(|s| s.parse().ok())
        .unwrap_or_else(|| chrono::Utc::now().timestamp_millis());

    // Get base hash for conflict detection (the version the client edited from)
    let base_hash = req.headers().get("X-Base-Hash")?;

    // Get auth header for DO request
    let auth_header = req
        .headers()
        .get("Authorization")?
        .unwrap_or_default();

    // Read body - empty files are allowed (0-byte files are valid in a vault)
    let uploaded_content = req.bytes().await?.to_vec();

    let bucket = env.bucket("VAULT_STORAGE")?;
    let r2 = R2Helper::new(&bucket);

    // Check for conflicts and perform merge if needed
    let existing_meta = r2.get_meta(&auth.user_id, &decoded_path).await?;
    
    let (final_content, merged, had_conflict) = if let Some(ref meta) = existing_meta {
        // File exists - check for conflict
        let current_hash = &meta.content_hash;
        
        // Calculate hash of uploaded content
        let mut hasher = Sha256::new();
        hasher.update(&uploaded_content);
        let uploaded_hash = hex::encode(hasher.finalize());
        
        // If uploaded content is same as current, no change needed
        if &uploaded_hash == current_hash {
            return json_ok(&FileUploadResponse {
                success: true,
                path: decoded_path,
                size: meta.size,
                content_hash: meta.content_hash.clone(),
                version_created: false,
                merged: false,
                had_conflict: false,
            });
        }
        
        // Check if we have a conflict (base_hash differs from current server hash)
        if let Some(ref base) = base_hash {
            if base != current_hash {
                // CONFLICT DETECTED: The file on the server changed since the client's base version
                
                // Try to get the base version for 3-way merge
                if let Some(base_content) = r2.get_version_by_hash(&auth.user_id, &decoded_path, base).await? {
                    // Get current server content
                    if let Some(remote_content) = r2.get_content(&auth.user_id, &decoded_path).await? {
                        // Perform 3-way merge
                        match crate::utils::merge::merge_text(&base_content, &uploaded_content, &remote_content) {
                            MergeResult::Clean(merged_text) => {
                                // Merge succeeded without conflicts
                                (merged_text.into_bytes(), true, false)
                            }
                            MergeResult::Conflict(conflict_text) => {
                                // Merge had conflicts - conflict markers inserted
                                (conflict_text.into_bytes(), true, true)
                            }
                            MergeResult::NotMergeable => {
                                // Binary file or can't merge - last-write-wins (uploaded content wins)
                                (uploaded_content, false, false)
                            }
                        }
                    } else {
                        // Couldn't get remote content - just use uploaded
                        (uploaded_content, false, false)
                    }
                } else {
                    // Base version not found - can't merge, use uploaded content (last-write-wins)
                    (uploaded_content, false, false)
                }
            } else {
                // No conflict: base == current, safe to overwrite
                (uploaded_content, false, false)
            }
        } else {
            // No base hash provided - treat as blind overwrite (last-write-wins)
            (uploaded_content, false, false)
        }
    } else {
        // File doesn't exist - no conflict possible
        (uploaded_content, false, false)
    };

    // Store the final content
    let (meta, version_created) = r2
        .put_content(&auth.user_id, &decoded_path, final_content, &content_type, mtime)
        .await?;

    // Update metadata in User DO SQLite
    let stub = get_user_do(&env)?;
    let headers = Headers::new();
    headers.set("Authorization", &auth_header)?;
    headers.set("Content-Type", "application/json")?;

    let upsert_body = serde_json::json!({
        "path": meta.path,
        "size": meta.size,
        "mtime": meta.mtime,
        "contentType": meta.content_type,
        "contentHash": meta.content_hash,
    });

    let do_req = Request::new_with_init(
        "http://do/files",
        RequestInit::new()
            .with_method(Method::Put)
            .with_headers(headers)
            .with_body(Some(upsert_body.to_string().into())),
    )?;

    // Fire and forget - don't block on DO response for upload speed
    // The metadata will be eventually consistent
    let _ = stub.fetch_with_request(do_req).await;

    // Broadcast sync notification to other devices
    let _ = broadcast_sync_notification(
        &env,
        &auth.user_id,
        &meta.path,
        "upload",
        &auth.device_id,
        Some(&meta.content_hash),
    )
    .await;

    json_ok(&FileUploadResponse {
        success: true,
        path: meta.path,
        size: meta.size,
        content_hash: meta.content_hash,
        version_created,
        merged,
        had_conflict,
    })
}

/// DELETE /files/{path} - Soft delete a file.
/// Deletes from R2 and marks as deleted in User DO SQLite.
async fn handle_delete_file(req: Request, env: Env, auth: AuthContext, file_path: &str) -> Result<Response> {
    if file_path.is_empty() {
        return ApiError::bad_request("File path is required").into_response();
    }

    // Remove leading slash if present and decode URL-encoded path
    let clean_path = file_path.strip_prefix('/').unwrap_or(file_path);
    let decoded_path = decode(clean_path)
        .map_err(|e| Error::RustError(format!("Failed to decode path: {}", e)))?
        .into_owned();

    // Get auth header for DO request
    let auth_header = req
        .headers()
        .get("Authorization")?
        .unwrap_or_default();

    let bucket = env.bucket("VAULT_STORAGE")?;
    let r2 = R2Helper::new(&bucket);

    let deleted = r2.soft_delete(&auth.user_id, &decoded_path).await?;

    if deleted {
        // Update metadata in User DO SQLite (soft delete)
        let stub = get_user_do(&env)?;
        let headers = Headers::new();
        headers.set("Authorization", &auth_header)?;
        headers.set("Content-Type", "application/json")?;

        let delete_body = serde_json::json!({
            "path": decoded_path,
            "hard_delete": false,
        });

        let do_req = Request::new_with_init(
            "http://do/files",
            RequestInit::new()
                .with_method(Method::Delete)
                .with_headers(headers)
                .with_body(Some(delete_body.to_string().into())),
        )?;

        let _ = stub.fetch_with_request(do_req).await;

        // Broadcast sync notification to other devices
        let _ = broadcast_sync_notification(
            &env,
            &auth.user_id,
            &decoded_path,
            "delete",
            &auth.device_id,
            None,
        )
        .await;

        no_content()
    } else {
        ApiError::not_found("File not found").into_response()
    }
}

/// GET /files/{path}/versions - List all versions of a file.
async fn handle_list_versions(env: Env, auth: AuthContext, file_path: &str) -> Result<Response> {
    if file_path.is_empty() {
        return ApiError::bad_request("File path is required").into_response();
    }

    // Remove leading slash if present and decode URL-encoded path
    let clean_path = file_path.strip_prefix('/').unwrap_or(file_path);
    let decoded_path = decode(clean_path)
        .map_err(|e| Error::RustError(format!("Failed to decode path: {}", e)))?
        .into_owned();

    let bucket = env.bucket("VAULT_STORAGE")?;
    let r2 = R2Helper::new(&bucket);

    let versions = r2.list_versions(&auth.user_id, &decoded_path).await?;

    json_ok(&crate::models::file::ListVersionsResponse {
        path: decoded_path,
        versions,
    })
}

/// GET /files/{path}/versions/{timestamp} - Get a specific version of a file.
async fn handle_get_version(env: Env, auth: AuthContext, file_path: &str, timestamp: i64) -> Result<Response> {
    if file_path.is_empty() {
        return ApiError::bad_request("File path is required").into_response();
    }

    // Remove leading slash if present and decode URL-encoded path
    let clean_path = file_path.strip_prefix('/').unwrap_or(file_path);
    let decoded_path = decode(clean_path)
        .map_err(|e| Error::RustError(format!("Failed to decode path: {}", e)))?
        .into_owned();

    let bucket = env.bucket("VAULT_STORAGE")?;
    let r2 = R2Helper::new(&bucket);

    // Get current metadata for content type
    let meta = r2.get_meta(&auth.user_id, &decoded_path).await?;
    let content_type = meta
        .map(|m| m.content_type)
        .unwrap_or_else(|| "application/octet-stream".to_string());

    // Get version content
    let content = match r2.get_version(&auth.user_id, &decoded_path, timestamp).await? {
        Some(c) => c,
        None => return ApiError::not_found("Version not found").into_response(),
    };

    let headers = Headers::new();
    headers.set("Content-Type", &content_type)?;
    headers.set("Content-Length", &content.len().to_string())?;
    headers.set("X-Version-Timestamp", &timestamp.to_string())?;

    Ok(Response::from_bytes(content)?.with_headers(headers))
}
