//! User Durable Object for session management and user data.

use serde::{Deserialize, Serialize};
use std::cell::Cell;
use worker::*;

use crate::auth::{JwtManager, MagicLinkManager};
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
    device_info TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS magic_links (
    token_hash TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_magic_links_email ON magic_links(email);
CREATE INDEX IF NOT EXISTS idx_magic_links_expires_at ON magic_links(expires_at);
"#;

/// User data model.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: String,
    pub email: String,
    pub created_at: i64,
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
    pub device_info: Option<String>,
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
pub struct VerifyMagicLinkRequest {
    pub token: String,
    #[serde(default)]
    pub device_info: Option<String>,
}

/// Response with auth tokens.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthTokenResponse {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: i64,
    pub user: User,
}

/// Request to refresh a token.
#[derive(Debug, Deserialize)]
pub struct RefreshTokenRequest {
    pub refresh_token: String,
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
            (Method::Post, "/magic-link") => self.handle_create_magic_link(req).await,
            (Method::Post, "/verify") => self.handle_verify_magic_link(req).await,
            (Method::Post, "/refresh") => self.handle_refresh_token(req).await,
            (Method::Post, "/logout") => self.handle_logout(req).await,
            (Method::Get, "/user") => self.handle_get_user(req).await,
            (Method::Delete, "/sessions") => self.handle_delete_sessions(req).await,
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

        let existing_user: Option<User> = user_cursor.next::<User>().next().transpose()?;

        let user = match existing_user {
            Some(u) => u,
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

        // Create session
        let session_id = uuid::Uuid::new_v4().to_string();
        let jwt_manager = self.get_jwt_manager()?;

        let access_token = jwt_manager
            .create_access_token(&user.id, &user.email, &session_id)
            .map_err(|e| Error::RustError(format!("Failed to create access token: {}", e)))?;

        let refresh_token = jwt_manager
            .create_refresh_token(&user.id, &user.email, &session_id)
            .map_err(|e| Error::RustError(format!("Failed to create refresh token: {}", e)))?;

        // Store session (refresh token hash)
        let refresh_token_hash = manager.hash_token(&refresh_token);
        let expires_at = now + (30 * 24 * 60 * 60); // 30 days

        self.state.storage().sql().exec(
            "INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, device_info) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            vec![
                session_id.into(),
                user.id.clone().into(),
                refresh_token_hash.into(),
                now.into(),
                expires_at.into(),
                body.device_info.unwrap_or_default().into(),
            ],
        )?;

        json_ok(&AuthTokenResponse {
            access_token,
            refresh_token,
            expires_at: now + (24 * 60 * 60), // Access token expires in 24 hours
            user,
        })
    }

    /// Handle refreshing an access token.
    async fn handle_refresh_token(&self, mut req: Request) -> Result<Response> {
        let body: RefreshTokenRequest = req.json().await?;
        let manager = MagicLinkManager::default();
        let token_hash = manager.hash_token(&body.refresh_token);
        let now = chrono::Utc::now().timestamp();

        // Find the session
        let cursor = self.state.storage().sql().exec(
            "SELECT s.id, s.user_id, s.expires_at, u.email FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.token_hash = ?1",
            vec![token_hash.into()],
        )?;

        let row: Option<SessionWithEmailRow> = cursor.next::<SessionWithEmailRow>().next().transpose()?;

        let session = match row {
            Some(r) => {
                if now > r.expires_at {
                    return ApiError::unauthorized("Session expired").into_response();
                }

                (r.id, r.user_id, r.email)
            }
            None => {
                return ApiError::unauthorized("Invalid refresh token").into_response();
            }
        };

        let (session_id, user_id, email) = session;

        // Create new access token
        let jwt_manager = self.get_jwt_manager()?;
        let access_token = jwt_manager
            .create_access_token(&user_id, &email, &session_id)
            .map_err(|e| Error::RustError(format!("Failed to create access token: {}", e)))?;

        // Get full user data
        let user_cursor = self.state.storage().sql().exec(
            "SELECT id, email, created_at FROM users WHERE id = ?1",
            vec![user_id.into()],
        )?;

        let user: Option<User> = user_cursor.next::<User>().next().transpose()?;

        let user = match user {
            Some(u) => u,
            None => {
                return ApiError::internal("User not found").into_response();
            }
        };

        json_ok(&AuthTokenResponse {
            access_token,
            refresh_token: body.refresh_token, // Return the same refresh token
            expires_at: now + (24 * 60 * 60),
            user,
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

        let user: Option<User> = cursor.next::<User>().next().transpose()?;

        match user {
            Some(u) => json_ok(&u),
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
}
