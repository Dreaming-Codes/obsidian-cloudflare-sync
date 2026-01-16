//! User Durable Object for session management and user data.

use serde::{Deserialize, Serialize};
use std::cell::Cell;
use worker::{SqlCursor, *};

use crate::auth::{JwtManager, MagicLinkManager};
use crate::models::{
    CreateShareRequest, ListSharesResponse, ResourceType, ShareInvite, SharePermission,
    ShareResponse, UpdateShareRequest,
};
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

CREATE TABLE IF NOT EXISTS shares (
    id TEXT PRIMARY KEY,
    resource_path TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    owner_email TEXT NOT NULL,
    invitee_email TEXT NOT NULL,
    invitee_id TEXT,
    permission TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    accepted_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_magic_links_email ON magic_links(email);
CREATE INDEX IF NOT EXISTS idx_magic_links_expires_at ON magic_links(expires_at);
CREATE INDEX IF NOT EXISTS idx_shares_owner_id ON shares(owner_id);
CREATE INDEX IF NOT EXISTS idx_shares_invitee_email ON shares(invitee_email);
CREATE INDEX IF NOT EXISTS idx_shares_invitee_id ON shares(invitee_id);
CREATE INDEX IF NOT EXISTS idx_shares_resource_path ON shares(resource_path);
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
            // Auth routes
            (Method::Post, "/magic-link") => self.handle_create_magic_link(req).await,
            (Method::Post, "/verify") => self.handle_verify_magic_link(req).await,
            (Method::Post, "/refresh") => self.handle_refresh_token(req).await,
            (Method::Post, "/logout") => self.handle_logout(req).await,
            (Method::Get, "/user") => self.handle_get_user(req).await,
            (Method::Delete, "/sessions") => self.handle_delete_sessions(req).await,
            // Share routes
            (Method::Post, "/shares") => self.handle_create_share(req).await,
            (Method::Get, "/shares") => self.handle_list_my_shares(req).await,
            (Method::Get, "/shared-with-me") => self.handle_list_shared_with_me(req).await,
            (Method::Get, p) if p.starts_with("/shares/") => self.handle_get_share(req, &p[8..]).await,
            (Method::Put, p) if p.starts_with("/shares/") => self.handle_update_share(req, &p[8..]).await,
            (Method::Delete, p) if p.starts_with("/shares/") => self.handle_delete_share(req, &p[8..]).await,
            (Method::Post, p) if p.ends_with("/accept") && p.starts_with("/shares/") => {
                let share_id = &p[8..p.len() - 7]; // Remove "/shares/" and "/accept"
                self.handle_accept_share(req, share_id).await
            }
            (Method::Get, "/permissions") => self.handle_check_permission(req).await,
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

        let user: Option<UserRow> = user_cursor.next::<UserRow>().next().transpose()?;

        let user: User = match user {
            Some(u) => u.into(),
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

    // ========================================================================
    // Share Handlers
    // ========================================================================

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

    /// Handle creating a new share.
    async fn handle_create_share(&self, mut req: Request) -> Result<Response> {
        let claims = match self.extract_claims(&req) {
            Ok(c) => c,
            Err(_) => return ApiError::unauthorized("Invalid token").into_response(),
        };

        let body: CreateShareRequest = req.json().await?;

        if !body.is_valid() {
            return ApiError::bad_request("Invalid share request").into_response();
        }

        // Cannot share with yourself
        if body.invitee_email.to_lowercase() == claims.email.to_lowercase() {
            return ApiError::bad_request("Cannot share with yourself").into_response();
        }

        // Cannot share with owner permission
        if body.permission == SharePermission::Owner {
            return ApiError::bad_request("Cannot share with owner permission").into_response();
        }

        let now = chrono::Utc::now().timestamp();
        let share_id = uuid::Uuid::new_v4().to_string();

        // Check if share already exists for this resource/invitee combination
        let existing_cursor = self.state.storage().sql().exec(
            "SELECT id FROM shares WHERE resource_path = ?1 AND owner_id = ?2 AND invitee_email = ?3",
            vec![
                body.resource_path.clone().into(),
                claims.sub.clone().into(),
                body.invitee_email.to_lowercase().into(),
            ],
        )?;

        #[derive(Debug, Deserialize)]
        struct IdRow {
            #[allow(dead_code)]
            id: String,
        }
        if existing_cursor.next::<IdRow>().next().is_some() {
            return ApiError::bad_request("Share already exists for this user").into_response();
        }

        // Create the share
        self.state.storage().sql().exec(
            "INSERT INTO shares (id, resource_path, resource_type, owner_id, owner_email, invitee_email, permission, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            vec![
                share_id.clone().into(),
                body.resource_path.clone().into(),
                body.resource_type.to_string().into(),
                claims.sub.clone().into(),
                claims.email.clone().into(),
                body.invitee_email.to_lowercase().into(),
                body.permission.to_string().into(),
                now.into(),
            ],
        )?;

        let share = ShareInvite {
            id: share_id,
            resource_path: body.resource_path,
            resource_type: body.resource_type,
            owner_id: claims.sub,
            owner_email: claims.email,
            invitee_email: body.invitee_email.to_lowercase(),
            permission: body.permission,
            created_at: now,
            accepted_at: None,
            invitee_id: None,
        };

        json_ok(&ShareResponse::success(share))
    }

    /// Handle listing shares created by the user.
    async fn handle_list_my_shares(&self, req: Request) -> Result<Response> {
        let claims = match self.extract_claims(&req) {
            Ok(c) => c,
            Err(_) => return ApiError::unauthorized("Invalid token").into_response(),
        };

        let cursor = self.state.storage().sql().exec(
            "SELECT id, resource_path, resource_type, owner_id, owner_email, invitee_email, invitee_id, permission, created_at, accepted_at FROM shares WHERE owner_id = ?1 ORDER BY created_at DESC",
            vec![claims.sub.into()],
        )?;

        let shares = self.collect_shares(cursor)?;
        json_ok(&ListSharesResponse::new(shares))
    }

    /// Handle listing shares where user is the invitee.
    async fn handle_list_shared_with_me(&self, req: Request) -> Result<Response> {
        let claims = match self.extract_claims(&req) {
            Ok(c) => c,
            Err(_) => return ApiError::unauthorized("Invalid token").into_response(),
        };

        // Query by invitee_id (if accepted) OR invitee_email (if pending)
        let cursor = self.state.storage().sql().exec(
            "SELECT id, resource_path, resource_type, owner_id, owner_email, invitee_email, invitee_id, permission, created_at, accepted_at FROM shares WHERE invitee_id = ?1 OR (invitee_email = ?2 AND invitee_id IS NULL) ORDER BY created_at DESC",
            vec![claims.sub.into(), claims.email.to_lowercase().into()],
        )?;

        let shares = self.collect_shares(cursor)?;
        json_ok(&ListSharesResponse::new(shares))
    }

    /// Handle getting a specific share.
    async fn handle_get_share(&self, req: Request, share_id: &str) -> Result<Response> {
        let claims = match self.extract_claims(&req) {
            Ok(c) => c,
            Err(_) => return ApiError::unauthorized("Invalid token").into_response(),
        };

        let cursor = self.state.storage().sql().exec(
            "SELECT id, resource_path, resource_type, owner_id, owner_email, invitee_email, invitee_id, permission, created_at, accepted_at FROM shares WHERE id = ?1",
            vec![share_id.into()],
        )?;

        let shares = self.collect_shares(cursor)?;
        let share = match shares.into_iter().next() {
            Some(s) => s,
            None => return ApiError::not_found("Share not found").into_response(),
        };

        // Only owner or invitee can view
        let is_owner = share.owner_id == claims.sub;
        let is_invitee = share.invitee_id.as_ref() == Some(&claims.sub)
            || share.invitee_email.to_lowercase() == claims.email.to_lowercase();

        if !is_owner && !is_invitee {
            return ApiError::forbidden("Access denied").into_response();
        }

        json_ok(&ShareResponse::success(share))
    }

    /// Handle updating a share's permission.
    async fn handle_update_share(&self, mut req: Request, share_id: &str) -> Result<Response> {
        let claims = match self.extract_claims(&req) {
            Ok(c) => c,
            Err(_) => return ApiError::unauthorized("Invalid token").into_response(),
        };

        let body: UpdateShareRequest = req.json().await?;

        // Cannot update to owner permission
        if body.permission == SharePermission::Owner {
            return ApiError::bad_request("Cannot set owner permission").into_response();
        }

        // Check ownership
        let cursor = self.state.storage().sql().exec(
            "SELECT owner_id FROM shares WHERE id = ?1",
            vec![share_id.into()],
        )?;

        #[derive(Debug, Deserialize)]
        struct OwnerRow {
            owner_id: String,
        }
        let row: Option<OwnerRow> = cursor.next::<OwnerRow>().next().transpose()?;

        match row {
            Some(r) if r.owner_id == claims.sub => {}
            Some(_) => return ApiError::forbidden("Only owner can update share").into_response(),
            None => return ApiError::not_found("Share not found").into_response(),
        }

        // Update the share
        self.state.storage().sql().exec(
            "UPDATE shares SET permission = ?1 WHERE id = ?2",
            vec![body.permission.to_string().into(), share_id.into()],
        )?;

        // Return updated share
        self.handle_get_share(req, share_id).await
    }

    /// Handle deleting/revoking a share.
    async fn handle_delete_share(&self, req: Request, share_id: &str) -> Result<Response> {
        let claims = match self.extract_claims(&req) {
            Ok(c) => c,
            Err(_) => return ApiError::unauthorized("Invalid token").into_response(),
        };

        // Check ownership
        let cursor = self.state.storage().sql().exec(
            "SELECT owner_id FROM shares WHERE id = ?1",
            vec![share_id.into()],
        )?;

        #[derive(Debug, Deserialize)]
        struct OwnerRow {
            owner_id: String,
        }
        let row: Option<OwnerRow> = cursor.next::<OwnerRow>().next().transpose()?;

        match row {
            Some(r) if r.owner_id == claims.sub => {}
            Some(_) => return ApiError::forbidden("Only owner can delete share").into_response(),
            None => return ApiError::not_found("Share not found").into_response(),
        }

        // Delete the share
        self.state.storage().sql().exec(
            "DELETE FROM shares WHERE id = ?1",
            vec![share_id.into()],
        )?;

        json_ok(&serde_json::json!({
            "success": true,
            "message": "Share deleted"
        }))
    }

    /// Handle accepting a share invitation.
    async fn handle_accept_share(&self, req: Request, share_id: &str) -> Result<Response> {
        let claims = match self.extract_claims(&req) {
            Ok(c) => c,
            Err(_) => return ApiError::unauthorized("Invalid token").into_response(),
        };

        let now = chrono::Utc::now().timestamp();

        // Check if share exists and is for this user
        let cursor = self.state.storage().sql().exec(
            "SELECT invitee_email, invitee_id, accepted_at FROM shares WHERE id = ?1",
            vec![share_id.into()],
        )?;

        #[derive(Debug, Deserialize)]
        struct InviteeRow {
            invitee_email: String,
            invitee_id: Option<String>,
            accepted_at: Option<i64>,
        }
        let row: Option<InviteeRow> = cursor.next::<InviteeRow>().next().transpose()?;

        match row {
            Some(r) => {
                // Check if already accepted
                if r.accepted_at.is_some() {
                    return ApiError::bad_request("Share already accepted").into_response();
                }

                // Check if invitee matches
                if r.invitee_email.to_lowercase() != claims.email.to_lowercase() {
                    return ApiError::forbidden("This share is not for you").into_response();
                }
            }
            None => return ApiError::not_found("Share not found").into_response(),
        }

        // Accept the share
        self.state.storage().sql().exec(
            "UPDATE shares SET invitee_id = ?1, accepted_at = ?2 WHERE id = ?3",
            vec![claims.sub.into(), now.into(), share_id.into()],
        )?;

        json_ok(&serde_json::json!({
            "success": true,
            "message": "Share accepted"
        }))
    }

    /// Handle checking permission for a resource.
    async fn handle_check_permission(&self, req: Request) -> Result<Response> {
        let claims = match self.extract_claims(&req) {
            Ok(c) => c,
            Err(_) => return ApiError::unauthorized("Invalid token").into_response(),
        };

        // Get resource_path from query
        let url = req.url()?;
        let resource_path = url
            .query_pairs()
            .find(|(k, _)| k == "path")
            .map(|(_, v)| v.to_string())
            .unwrap_or_default();

        // Get owner_id from query (the owner of the resource)
        let owner_id = url
            .query_pairs()
            .find(|(k, _)| k == "owner_id")
            .map(|(_, v)| v.to_string())
            .unwrap_or_default();

        if resource_path.is_empty() || owner_id.is_empty() {
            return ApiError::bad_request("Missing path or owner_id parameter").into_response();
        }

        // If user is the owner, they have full access
        if owner_id == claims.sub {
            return json_ok(&serde_json::json!({
                "permission": "owner",
                "source": "owner"
            }));
        }

        // Check for direct share
        let cursor = self.state.storage().sql().exec(
            "SELECT permission FROM shares WHERE resource_path = ?1 AND owner_id = ?2 AND (invitee_id = ?3 OR invitee_email = ?4) AND accepted_at IS NOT NULL",
            vec![
                resource_path.clone().into(),
                owner_id.clone().into(),
                claims.sub.clone().into(),
                claims.email.to_lowercase().into(),
            ],
        )?;

        #[derive(Debug, Deserialize)]
        struct PermRow {
            permission: String,
        }
        if let Some(row) = cursor.next::<PermRow>().next().transpose()? {
            return json_ok(&serde_json::json!({
                "permission": row.permission,
                "source": "direct"
            }));
        }

        // Check for inherited permission from parent folders
        let path_parts: Vec<&str> = resource_path.split('/').collect();
        for i in (0..path_parts.len()).rev() {
            let parent_path = path_parts[..i].join("/");
            if parent_path.is_empty() {
                continue;
            }

            let cursor = self.state.storage().sql().exec(
                "SELECT permission FROM shares WHERE resource_path = ?1 AND resource_type = 'folder' AND owner_id = ?2 AND (invitee_id = ?3 OR invitee_email = ?4) AND accepted_at IS NOT NULL",
                vec![
                    parent_path.into(),
                    owner_id.clone().into(),
                    claims.sub.clone().into(),
                    claims.email.to_lowercase().into(),
                ],
            )?;

            if let Some(row) = cursor.next::<PermRow>().next().transpose()? {
                return json_ok(&serde_json::json!({
                    "permission": row.permission,
                    "source": "inherited"
                }));
            }
        }

        // No permission found
        ApiError::forbidden("No access to this resource").into_response()
    }

    /// Helper to collect shares from SQL cursor.
    fn collect_shares(&self, cursor: SqlCursor) -> Result<Vec<ShareInvite>> {
        #[derive(Debug, Deserialize)]
        struct ShareRow {
            id: String,
            resource_path: String,
            resource_type: String,
            owner_id: String,
            owner_email: String,
            invitee_email: String,
            invitee_id: Option<String>,
            permission: String,
            created_at: i64,
            accepted_at: Option<i64>,
        }

        let mut shares = Vec::new();
        for row in cursor.next::<ShareRow>() {
            let row = row?;
            shares.push(ShareInvite {
                id: row.id,
                resource_path: row.resource_path,
                resource_type: row
                    .resource_type
                    .parse()
                    .unwrap_or(ResourceType::File),
                owner_id: row.owner_id,
                owner_email: row.owner_email,
                invitee_email: row.invitee_email,
                invitee_id: row.invitee_id,
                permission: row
                    .permission
                    .parse()
                    .unwrap_or(SharePermission::Viewer),
                created_at: row.created_at,
                accepted_at: row.accepted_at,
            });
        }
        Ok(shares)
    }
}
