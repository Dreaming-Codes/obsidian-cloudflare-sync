//! User Durable Object for session management and user data.

use serde::{Deserialize, Serialize};
use std::cell::Cell;
use worker::*;

use crate::auth::{JwtManager, MagicLinkManager};
use crate::models::{FileMeta, ListFilesResponse};
use crate::utils::{json_ok, ApiError};

/// SQL schema for the User Durable Object.
const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    device_id TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (device_id) REFERENCES devices(id)
);

CREATE TABLE IF NOT EXISTS magic_links (
    token_hash TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    platform TEXT,
    last_seen_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS device_file_sync (
    device_id TEXT NOT NULL,
    path TEXT NOT NULL,
    last_synced_hash TEXT NOT NULL,
    last_synced_at INTEGER NOT NULL,
    PRIMARY KEY (device_id, path),
    FOREIGN KEY (device_id) REFERENCES devices(id)
);

CREATE TABLE IF NOT EXISTS file_versions (
    user_id TEXT NOT NULL,
    path TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, path, content_hash),
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_device_id ON sessions(device_id);
CREATE INDEX IF NOT EXISTS idx_magic_links_email ON magic_links(email);
CREATE INDEX IF NOT EXISTS idx_magic_links_expires_at ON magic_links(expires_at);
CREATE INDEX IF NOT EXISTS idx_devices_user_id ON devices(user_id);
CREATE INDEX IF NOT EXISTS idx_device_file_sync_path ON device_file_sync(path);
CREATE INDEX IF NOT EXISTS idx_file_versions_path ON file_versions(user_id, path);

CREATE TABLE IF NOT EXISTS files (
    path TEXT NOT NULL,
    user_id TEXT NOT NULL,
    size INTEGER NOT NULL,
    mtime INTEGER NOT NULL,
    content_type TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    deleted INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, path)
);

CREATE INDEX IF NOT EXISTS idx_files_user_id ON files(user_id);
CREATE INDEX IF NOT EXISTS idx_files_updated_at ON files(user_id, updated_at);
"#;

/// User data model.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: String,
    pub email: String,
    pub created_at: i64,
}

/// SQL row for user query (uses snake_case from database).
#[derive(Debug, Deserialize)]
struct UserRow {
    id: String,
    email: String,
    created_at: i64,
}

impl From<UserRow> for User {
    fn from(row: UserRow) -> Self {
        Self {
            id: row.id,
            email: row.email,
            created_at: row.created_at,
        }
    }
}

/// Session data model.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct Session {
    pub id: String,
    pub user_id: String,
    pub created_at: i64,
    pub expires_at: i64,
    pub device_id: Option<String>,
}

/// Device data model.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub user_id: String,
    pub name: String,
    pub platform: Option<String>,
    pub last_seen_at: i64,
    pub created_at: i64,
}

/// SQL row for device query.
#[derive(Debug, Deserialize)]
struct DeviceRow {
    id: String,
    user_id: String,
    name: String,
    platform: Option<String>,
    last_seen_at: i64,
    created_at: i64,
}

impl From<DeviceRow> for Device {
    fn from(row: DeviceRow) -> Self {
        Self {
            id: row.id,
            user_id: row.user_id,
            name: row.name,
            platform: row.platform,
            last_seen_at: row.last_seen_at,
            created_at: row.created_at,
        }
    }
}

/// Magic link data model.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct MagicLink {
    pub token_hash: String,
    pub email: String,
    pub created_at: i64,
    pub expires_at: i64,
    pub used: bool,
}

/// SQL row for magic link query.
#[derive(Debug, Deserialize)]
struct MagicLinkRow {
    email: String,
    expires_at: i64,
    used: i64,
}

/// SQL row for session query with email.
#[derive(Debug, Deserialize)]
struct SessionWithEmailRow {
    id: String,
    user_id: String,
    expires_at: i64,
    email: String,
    device_id: Option<String>,
}

/// Request to create a magic link.
#[derive(Debug, Deserialize)]
pub struct CreateMagicLinkRequest {
    pub email: String,
    #[serde(default)]
    pub token_hash: Option<String>,
    #[serde(default)]
    pub expires_at: Option<i64>,
}

/// Response with the magic link token.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateMagicLinkResponse {
    pub success: bool,
    pub message: String,
}

/// Request to verify a magic link.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyMagicLinkRequest {
    pub token: String,
    /// Device name (e.g., "MacBook Pro", "iPhone 15")
    pub device_name: String,
    /// Platform (e.g., "macos", "ios", "windows", "android", "linux")
    #[serde(default)]
    pub platform: Option<String>,
    /// Existing device ID if re-authenticating on same device
    #[serde(default)]
    pub device_id: Option<String>,
}

/// Response with auth tokens.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthTokenResponse {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: i64,
    pub user: User,
    pub device: Device,
}

/// Request to refresh a token.
#[derive(Debug, Deserialize)]
pub struct RefreshTokenRequest {
    pub refresh_token: String,
}

/// SQL row for file query (uses snake_case from database).
#[derive(Debug, Deserialize)]
struct FileRow {
    path: String,
    user_id: String,
    size: i64,
    mtime: i64,
    content_type: String,
    content_hash: String,
    deleted: i64,
    created_at: i64,
    updated_at: i64,
}

/// Request to upsert file metadata.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertFileRequest {
    pub path: String,
    pub size: u64,
    pub mtime: i64,
    pub content_type: String,
    pub content_hash: String,
}

/// Request to delete file metadata.
#[derive(Debug, Deserialize)]
pub struct DeleteFileRequest {
    pub path: String,
    /// If true, permanently delete. If false, soft delete.
    #[serde(default)]
    pub hard_delete: bool,
}

/// Query params for listing files.
#[derive(Debug, Deserialize)]
pub struct ListFilesQuery {
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub offset: Option<u32>,
    /// If provided, only return files updated after this timestamp
    #[serde(default)]
    pub since: Option<i64>,
}

/// User Durable Object for managing user sessions and magic links.
#[durable_object]
pub struct UserDurableObject {
    state: State,
    env: Env,
    initialized: Cell<bool>,
}

impl DurableObject for UserDurableObject {
    fn new(state: State, env: Env) -> Self {
        Self {
            state,
            env,
            initialized: Cell::new(false),
        }
    }

    async fn fetch(&self, req: Request) -> Result<Response> {
        // Initialize schema on first request
        if !self.initialized.get() {
            self.init_schema()?;
            self.initialized.set(true);
        }

        let path = req.path();
        let method = req.method();

        match (method, path.as_str()) {
            // Auth routes
            (Method::Post, "/magic-link") => self.handle_create_magic_link(req).await,
            (Method::Post, "/verify") => self.handle_verify_magic_link(req).await,
            (Method::Post, "/refresh") => self.handle_refresh_token(req).await,
            (Method::Post, "/logout") => self.handle_logout(req).await,
            (Method::Get, "/user") => self.handle_get_user(req).await,
            (Method::Delete, "/sessions") => self.handle_delete_sessions(req).await,
            // File metadata routes
            (Method::Get, "/files") => self.handle_list_files(req).await,
            (Method::Put, "/files") => self.handle_upsert_file(req).await,
            (Method::Delete, "/files") => self.handle_delete_file(req).await,
            (Method::Post, "/files/clear") => self.handle_clear_files(req).await,
            _ => ApiError::not_found("Endpoint not found").into_response(),
        }
    }
}

impl UserDurableObject {
    /// Initialize the SQLite schema.
    fn init_schema(&self) -> Result<()> {
        self.state.storage().sql().exec(SCHEMA, None)?;
        Ok(())
    }

    /// Get the JWT manager from environment.
    fn get_jwt_manager(&self) -> Result<JwtManager> {
        let secret = self.env.secret("JWT_SECRET")?.to_string();
        Ok(JwtManager::new(&secret))
    }

    /// Handle creating a new magic link.
    async fn handle_create_magic_link(&self, mut req: Request) -> Result<Response> {
        let body: CreateMagicLinkRequest = req.json().await?;
        let email = body.email.to_lowercase().trim().to_string();

        // Validate email format (basic check)
        if !email.contains('@') || !email.contains('.') {
            return ApiError::bad_request("Invalid email format").into_response();
        }

        // Get token_hash and expires_at from request (sent by worker route)
        // or generate new ones
        let manager = MagicLinkManager::default();
        let (token_hash, expires_at) = match (body.token_hash, body.expires_at) {
            (Some(hash), Some(exp)) => (hash, exp),
            _ => {
                let token = manager.generate_token();
                (token.token_hash, token.expires_at)
            }
        };

        let now = chrono::Utc::now().timestamp();

        // Delete any existing unused magic links for this email
        self.state.storage().sql().exec(
            "DELETE FROM magic_links WHERE email = ?1 AND used = 0",
            vec![email.clone().into()],
        )?;

        // Store the magic link
        self.state.storage().sql().exec(
            "INSERT INTO magic_links (token_hash, email, created_at, expires_at, used) VALUES (?1, ?2, ?3, ?4, 0)",
            vec![
                token_hash.into(),
                email.clone().into(),
                now.into(),
                expires_at.into(),
            ],
        )?;

        json_ok(&CreateMagicLinkResponse {
            success: true,
            message: format!("Magic link created for {}", email),
        })
    }

    /// Handle verifying a magic link and creating a session.
    async fn handle_verify_magic_link(&self, mut req: Request) -> Result<Response> {
        let body: VerifyMagicLinkRequest = req.json().await?;
        let manager = MagicLinkManager::default();
        let token_hash = manager.hash_token(&body.token);
        let now = chrono::Utc::now().timestamp();

        // Find the magic link
        let cursor = self.state.storage().sql().exec(
            "SELECT email, expires_at, used FROM magic_links WHERE token_hash = ?1",
            vec![token_hash.clone().into()],
        )?;

        let row: Option<MagicLinkRow> = cursor.next::<MagicLinkRow>().next().transpose()?;

        let email = match row {
            Some(r) => {
                if r.used != 0 {
                    return ApiError::bad_request("Magic link already used").into_response();
                }
                if now > r.expires_at {
                    return ApiError::bad_request("Magic link expired").into_response();
                }

                r.email
            }
            None => {
                return ApiError::bad_request("Invalid magic link").into_response();
            }
        };

        // Mark magic link as used
        self.state.storage().sql().exec(
            "UPDATE magic_links SET used = 1 WHERE token_hash = ?1",
            vec![token_hash.into()],
        )?;

        // Find or create user
        let user_cursor = self.state.storage().sql().exec(
            "SELECT id, email, created_at FROM users WHERE email = ?1",
            vec![email.clone().into()],
        )?;

        let existing_user: Option<UserRow> = user_cursor.next::<UserRow>().next().transpose()?;

        let user: User = match existing_user {
            Some(u) => u.into(),
            None => {
                // Create new user
                let user_id = uuid::Uuid::new_v4().to_string();
                self.state.storage().sql().exec(
                    "INSERT INTO users (id, email, created_at) VALUES (?1, ?2, ?3)",
                    vec![user_id.clone().into(), email.clone().into(), now.into()],
                )?;

                User {
                    id: user_id,
                    email,
                    created_at: now,
                }
            }
        };

        // Find or create device
        let device = if let Some(existing_device_id) = body.device_id {
            // Try to find existing device
            let device_cursor = self.state.storage().sql().exec(
                "SELECT id, user_id, name, platform, last_seen_at, created_at FROM devices WHERE id = ?1 AND user_id = ?2",
                vec![existing_device_id.clone().into(), user.id.clone().into()],
            )?;

            let existing_device: Option<DeviceRow> = device_cursor.next::<DeviceRow>().next().transpose()?;

            match existing_device {
                Some(d) => {
                    // Update last_seen_at and name/platform
                    self.state.storage().sql().exec(
                        "UPDATE devices SET name = ?1, platform = ?2, last_seen_at = ?3 WHERE id = ?4",
                        vec![
                            body.device_name.clone().into(),
                            body.platform.clone().unwrap_or_default().into(),
                            now.into(),
                            existing_device_id.into(),
                        ],
                    )?;
                    Device {
                        id: d.id,
                        user_id: d.user_id,
                        name: body.device_name,
                        platform: body.platform,
                        last_seen_at: now,
                        created_at: d.created_at,
                    }
                }
                None => {
                    // Device ID provided but not found, create new device
                    let device_id = uuid::Uuid::new_v4().to_string();
                    self.state.storage().sql().exec(
                        "INSERT INTO devices (id, user_id, name, platform, last_seen_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                        vec![
                            device_id.clone().into(),
                            user.id.clone().into(),
                            body.device_name.clone().into(),
                            body.platform.clone().unwrap_or_default().into(),
                            now.into(),
                            now.into(),
                        ],
                    )?;
                    Device {
                        id: device_id,
                        user_id: user.id.clone(),
                        name: body.device_name,
                        platform: body.platform,
                        last_seen_at: now,
                        created_at: now,
                    }
                }
            }
        } else {
            // Create new device
            let device_id = uuid::Uuid::new_v4().to_string();
            self.state.storage().sql().exec(
                "INSERT INTO devices (id, user_id, name, platform, last_seen_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                vec![
                    device_id.clone().into(),
                    user.id.clone().into(),
                    body.device_name.clone().into(),
                    body.platform.clone().unwrap_or_default().into(),
                    now.into(),
                    now.into(),
                ],
            )?;
            Device {
                id: device_id,
                user_id: user.id.clone(),
                name: body.device_name,
                platform: body.platform,
                last_seen_at: now,
                created_at: now,
            }
        };

        // Create session
        let session_id = uuid::Uuid::new_v4().to_string();
        let jwt_manager = self.get_jwt_manager()?;

        let access_token = jwt_manager
            .create_access_token(&user.id, &user.email, &session_id, &device.id)
            .map_err(|e| Error::RustError(format!("Failed to create access token: {}", e)))?;

        let refresh_token = jwt_manager
            .create_refresh_token(&user.id, &user.email, &session_id, &device.id)
            .map_err(|e| Error::RustError(format!("Failed to create refresh token: {}", e)))?;

        // Store session (refresh token hash) linked to device
        let refresh_token_hash = manager.hash_token(&refresh_token);
        let expires_at = now + (30 * 24 * 60 * 60); // 30 days

        self.state.storage().sql().exec(
            "INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, device_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            vec![
                session_id.into(),
                user.id.clone().into(),
                refresh_token_hash.into(),
                now.into(),
                expires_at.into(),
                device.id.clone().into(),
            ],
        )?;

        json_ok(&AuthTokenResponse {
            access_token,
            refresh_token,
            expires_at: now + (24 * 60 * 60), // Access token expires in 24 hours
            user,
            device,
        })
    }

    /// Handle refreshing an access token.
    async fn handle_refresh_token(&self, mut req: Request) -> Result<Response> {
        let body: RefreshTokenRequest = req.json().await?;
        let manager = MagicLinkManager::default();
        let token_hash = manager.hash_token(&body.refresh_token);
        let now = chrono::Utc::now().timestamp();

        // Find the session with device_id
        let cursor = self.state.storage().sql().exec(
            "SELECT s.id, s.user_id, s.expires_at, s.device_id, u.email FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.token_hash = ?1",
            vec![token_hash.into()],
        )?;

        let row: Option<SessionWithEmailRow> = cursor.next::<SessionWithEmailRow>().next().transpose()?;

        let session = match row {
            Some(r) => {
                if now > r.expires_at {
                    return ApiError::unauthorized("Session expired").into_response();
                }

                (r.id, r.user_id, r.email, r.device_id)
            }
            None => {
                return ApiError::unauthorized("Invalid refresh token").into_response();
            }
        };

        let (session_id, user_id, email, device_id) = session;

        // device_id is required for token creation
        let dev_id = match &device_id {
            Some(id) => id.clone(),
            None => return ApiError::internal("Session has no associated device").into_response(),
        };

        // Create new access token
        let jwt_manager = self.get_jwt_manager()?;
        let access_token = jwt_manager
            .create_access_token(&user_id, &email, &session_id, &dev_id)
            .map_err(|e| Error::RustError(format!("Failed to create access token: {}", e)))?;

        // Get full user data
        let user_cursor = self.state.storage().sql().exec(
            "SELECT id, email, created_at FROM users WHERE id = ?1",
            vec![user_id.clone().into()],
        )?;

        let user: Option<UserRow> = user_cursor.next::<UserRow>().next().transpose()?;

        let user: User = match user {
            Some(u) => u.into(),
            None => {
                return ApiError::internal("User not found").into_response();
            }
        };

        // Get device data and update last_seen_at
        let device = if let Some(dev_id) = device_id {
            let device_cursor = self.state.storage().sql().exec(
                "SELECT id, user_id, name, platform, last_seen_at, created_at FROM devices WHERE id = ?1",
                vec![dev_id.clone().into()],
            )?;

            let device_row: Option<DeviceRow> = device_cursor.next::<DeviceRow>().next().transpose()?;

            match device_row {
                Some(d) => {
                    // Update last_seen_at
                    self.state.storage().sql().exec(
                        "UPDATE devices SET last_seen_at = ?1 WHERE id = ?2",
                        vec![now.into(), dev_id.into()],
                    )?;
                    Device::from(DeviceRow {
                        last_seen_at: now,
                        ..d
                    })
                }
                None => {
                    return ApiError::internal("Device not found").into_response();
                }
            }
        } else {
            return ApiError::internal("Session has no associated device").into_response();
        };

        json_ok(&AuthTokenResponse {
            access_token,
            refresh_token: body.refresh_token, // Return the same refresh token
            expires_at: now + (24 * 60 * 60),
            user,
            device,
        })
    }

    /// Handle logout (invalidate session).
    async fn handle_logout(&self, mut req: Request) -> Result<Response> {
        let body: RefreshTokenRequest = req.json().await?;
        let manager = MagicLinkManager::default();
        let token_hash = manager.hash_token(&body.refresh_token);

        // Delete the session
        self.state.storage().sql().exec(
            "DELETE FROM sessions WHERE token_hash = ?1",
            vec![token_hash.into()],
        )?;

        json_ok(&serde_json::json!({
            "success": true,
            "message": "Logged out successfully"
        }))
    }

    /// Handle getting user info from a valid session.
    async fn handle_get_user(&self, req: Request) -> Result<Response> {
        // Extract user ID from Authorization header
        let auth_header = req.headers().get("Authorization")?.unwrap_or_default();
        if !auth_header.starts_with("Bearer ") {
            return ApiError::unauthorized("Missing or invalid authorization header").into_response();
        }

        let token = &auth_header[7..];
        let jwt_manager = self.get_jwt_manager()?;

        let claims = match jwt_manager.decode(token) {
            Ok(data) => data.claims,
            Err(_) => {
                return ApiError::unauthorized("Invalid token").into_response();
            }
        };

        // Get user data
        let cursor = self.state.storage().sql().exec(
            "SELECT id, email, created_at FROM users WHERE id = ?1",
            vec![claims.sub.into()],
        )?;

        let user: Option<UserRow> = cursor.next::<UserRow>().next().transpose()?;

        match user {
            Some(u) => json_ok(&User::from(u)),
            None => ApiError::not_found("User not found").into_response(),
        }
    }

    /// Handle deleting all sessions for a user (logout everywhere).
    async fn handle_delete_sessions(&self, req: Request) -> Result<Response> {
        // Extract user ID from Authorization header
        let auth_header = req.headers().get("Authorization")?.unwrap_or_default();
        if !auth_header.starts_with("Bearer ") {
            return ApiError::unauthorized("Missing or invalid authorization header").into_response();
        }

        let token = &auth_header[7..];
        let jwt_manager = self.get_jwt_manager()?;

        let claims = match jwt_manager.decode(token) {
            Ok(data) => data.claims,
            Err(_) => {
                return ApiError::unauthorized("Invalid token").into_response();
            }
        };

        // Delete all sessions for this user
        self.state.storage().sql().exec(
            "DELETE FROM sessions WHERE user_id = ?1",
            vec![claims.sub.into()],
        )?;

        json_ok(&serde_json::json!({
            "success": true,
            "message": "All sessions deleted"
        }))
    }

    // ============================================================================
    // File Metadata Handlers
    // ============================================================================

    /// Extract and validate JWT claims from request.
    fn extract_claims(&self, req: &Request) -> Result<crate::auth::Claims> {
        let auth_header = req.headers().get("Authorization")?.unwrap_or_default();
        if !auth_header.starts_with("Bearer ") {
            return Err(Error::RustError("Missing authorization header".to_string()));
        }

        let token = &auth_header[7..];
        let jwt_manager = self.get_jwt_manager()?;

        jwt_manager
            .decode(token)
            .map(|data| data.claims)
            .map_err(|e| Error::RustError(format!("Invalid token: {}", e)))
    }

    /// Handle listing files for a user.
    async fn handle_list_files(&self, req: Request) -> Result<Response> {
        let claims = match self.extract_claims(&req) {
            Ok(c) => c,
            Err(_) => return ApiError::unauthorized("Invalid token").into_response(),
        };

        // Parse query params
        let url = req.url()?;
        let limit = url
            .query_pairs()
            .find(|(k, _)| k == "limit")
            .and_then(|(_, v)| v.parse::<u32>().ok())
            .unwrap_or(1000);
        let offset = url
            .query_pairs()
            .find(|(k, _)| k == "offset")
            .and_then(|(_, v)| v.parse::<u32>().ok())
            .unwrap_or(0);
        let since = url
            .query_pairs()
            .find(|(k, _)| k == "since")
            .and_then(|(_, v)| v.parse::<i64>().ok());

        let cursor = if let Some(since_ts) = since {
            self.state.storage().sql().exec(
                "SELECT path, user_id, size, mtime, content_type, content_hash, deleted, created_at, updated_at 
                 FROM files WHERE user_id = ?1 AND updated_at > ?2 ORDER BY updated_at ASC LIMIT ?3 OFFSET ?4",
                vec![claims.sub.into(), since_ts.into(), (limit as i64).into(), (offset as i64).into()],
            )?
        } else {
            self.state.storage().sql().exec(
                "SELECT path, user_id, size, mtime, content_type, content_hash, deleted, created_at, updated_at 
                 FROM files WHERE user_id = ?1 ORDER BY path ASC LIMIT ?2 OFFSET ?3",
                vec![claims.sub.into(), (limit as i64).into(), (offset as i64).into()],
            )?
        };

        let mut files = Vec::new();
        for row in cursor.next::<FileRow>() {
            let row = row?;
            files.push(FileMeta {
                path: row.path,
                size: row.size as u64,
                mtime: row.mtime,
                content_type: row.content_type,
                content_hash: row.content_hash,
                deleted: row.deleted != 0,
                created_at: row.created_at,
                updated_at: row.updated_at,
            });
        }

        // Check if there are more files
        let has_more = files.len() == limit as usize;

        json_ok(&ListFilesResponse {
            files,
            cursor: None, // We use offset-based pagination
            has_more,
        })
    }

    /// Handle upserting file metadata.
    async fn handle_upsert_file(&self, mut req: Request) -> Result<Response> {
        let claims = match self.extract_claims(&req) {
            Ok(c) => c,
            Err(_) => return ApiError::unauthorized("Invalid token").into_response(),
        };

        let body: UpsertFileRequest = req.json().await?;
        let now = chrono::Utc::now().timestamp();

        // Check if file exists
        let cursor = self.state.storage().sql().exec(
            "SELECT created_at FROM files WHERE user_id = ?1 AND path = ?2",
            vec![claims.sub.clone().into(), body.path.clone().into()],
        )?;

        #[derive(Debug, Deserialize)]
        struct ExistsRow {
            created_at: i64,
        }
        let existing: Option<ExistsRow> = cursor.next::<ExistsRow>().next().transpose()?;

        if let Some(existing_row) = existing {
            // Update existing file
            self.state.storage().sql().exec(
                "UPDATE files SET size = ?1, mtime = ?2, content_type = ?3, content_hash = ?4, deleted = 0, updated_at = ?5 
                 WHERE user_id = ?6 AND path = ?7",
                vec![
                    (body.size as i64).into(),
                    body.mtime.into(),
                    body.content_type.clone().into(),
                    body.content_hash.clone().into(),
                    now.into(),
                    claims.sub.into(),
                    body.path.clone().into(),
                ],
            )?;

            json_ok(&FileMeta {
                path: body.path,
                size: body.size,
                mtime: body.mtime,
                content_type: body.content_type,
                content_hash: body.content_hash,
                deleted: false,
                created_at: existing_row.created_at,
                updated_at: now,
            })
        } else {
            // Insert new file
            self.state.storage().sql().exec(
                "INSERT INTO files (path, user_id, size, mtime, content_type, content_hash, deleted, created_at, updated_at) 
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8)",
                vec![
                    body.path.clone().into(),
                    claims.sub.into(),
                    (body.size as i64).into(),
                    body.mtime.into(),
                    body.content_type.clone().into(),
                    body.content_hash.clone().into(),
                    now.into(),
                    now.into(),
                ],
            )?;

            json_ok(&FileMeta {
                path: body.path,
                size: body.size,
                mtime: body.mtime,
                content_type: body.content_type,
                content_hash: body.content_hash,
                deleted: false,
                created_at: now,
                updated_at: now,
            })
        }
    }

    /// Handle deleting file metadata.
    async fn handle_delete_file(&self, mut req: Request) -> Result<Response> {
        let claims = match self.extract_claims(&req) {
            Ok(c) => c,
            Err(_) => return ApiError::unauthorized("Invalid token").into_response(),
        };

        let body: DeleteFileRequest = req.json().await?;
        let now = chrono::Utc::now().timestamp();

        if body.hard_delete {
            // Permanently delete
            self.state.storage().sql().exec(
                "DELETE FROM files WHERE user_id = ?1 AND path = ?2",
                vec![claims.sub.into(), body.path.clone().into()],
            )?;
        } else {
            // Soft delete
            self.state.storage().sql().exec(
                "UPDATE files SET deleted = 1, updated_at = ?1 WHERE user_id = ?2 AND path = ?3",
                vec![now.into(), claims.sub.into(), body.path.clone().into()],
            )?;
        }

        json_ok(&serde_json::json!({
            "success": true,
            "path": body.path
        }))
    }

    /// Handle clearing all file metadata for a user (for re-sync).
    async fn handle_clear_files(&self, req: Request) -> Result<Response> {
        let claims = match self.extract_claims(&req) {
            Ok(c) => c,
            Err(_) => return ApiError::unauthorized("Invalid token").into_response(),
        };

        // Delete all files for this user
        self.state.storage().sql().exec(
            "DELETE FROM files WHERE user_id = ?1",
            vec![claims.sub.into()],
        )?;

        json_ok(&serde_json::json!({
            "success": true,
            "message": "All file metadata cleared"
        }))
    }
}
