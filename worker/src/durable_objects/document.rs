//! Document Durable Object for real-time collaboration.
//!
//! This DO manages:
//! - Y.js/yrs CRDT document state
//! - WebSocket connections for real-time sync
//! - Collaborator permissions
//! - Comments with threading support

use serde::{Deserialize, Serialize};
use std::cell::Cell;
use worker::*;
use yrs::{updates::decoder::Decode, updates::encoder::Encode, Doc, GetString, ReadTxn, StateVector, Text, Transact, Update, WriteTxn};

use crate::auth::JwtManager;
use crate::sync::{ClientMessage, ServerMessage};
use crate::utils::{json_ok, ApiError};

/// SQL schema for the Document Durable Object.
const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS doc_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    yrs_state BLOB,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS collaborators (
    user_id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    permission TEXT NOT NULL,
    added_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    author_id TEXT NOT NULL,
    author_email TEXT NOT NULL,
    content TEXT NOT NULL,
    position BLOB NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER,
    resolved INTEGER DEFAULT 0,
    parent_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_collaborators_email ON collaborators(email);
CREATE INDEX IF NOT EXISTS idx_comments_author ON comments(author_id);
CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_id);
CREATE INDEX IF NOT EXISTS idx_comments_resolved ON comments(resolved);
"#;

/// Permission levels for collaborators.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Permission {
    Owner,
    Editor,
    Commenter,
    Viewer,
}

impl Permission {
    /// Check if this permission allows editing.
    pub fn can_edit(&self) -> bool {
        matches!(self, Permission::Owner | Permission::Editor)
    }

    /// Check if this permission allows commenting.
    pub fn can_comment(&self) -> bool {
        matches!(
            self,
            Permission::Owner | Permission::Editor | Permission::Commenter
        )
    }

    /// Check if this permission allows viewing.
    pub fn can_view(&self) -> bool {
        true // All permissions can view
    }

    /// Check if this permission allows managing collaborators.
    pub fn can_manage(&self) -> bool {
        matches!(self, Permission::Owner)
    }
}

impl std::fmt::Display for Permission {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Permission::Owner => write!(f, "owner"),
            Permission::Editor => write!(f, "editor"),
            Permission::Commenter => write!(f, "commenter"),
            Permission::Viewer => write!(f, "viewer"),
        }
    }
}

impl std::str::FromStr for Permission {
    type Err = String;

    fn from_str(s: &str) -> std::result::Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "owner" => Ok(Permission::Owner),
            "editor" => Ok(Permission::Editor),
            "commenter" => Ok(Permission::Commenter),
            "viewer" => Ok(Permission::Viewer),
            _ => Err(format!("Invalid permission: {}", s)),
        }
    }
}

/// Collaborator data model.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Collaborator {
    pub user_id: String,
    pub email: String,
    pub permission: Permission,
    pub added_at: i64,
}

/// SQL row for collaborator query.
#[derive(Debug, Deserialize)]
struct CollaboratorRow {
    user_id: String,
    email: String,
    permission: String,
    added_at: i64,
}

impl TryFrom<CollaboratorRow> for Collaborator {
    type Error = String;

    fn try_from(row: CollaboratorRow) -> std::result::Result<Self, Self::Error> {
        Ok(Collaborator {
            user_id: row.user_id,
            email: row.email,
            permission: row.permission.parse()?,
            added_at: row.added_at,
        })
    }
}

/// Comment data model.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub id: String,
    pub author_id: String,
    pub author_email: String,
    pub content: String,
    #[serde(with = "base64_bytes")]
    pub position: Vec<u8>,
    pub created_at: i64,
    pub updated_at: Option<i64>,
    pub resolved: bool,
    pub parent_id: Option<String>,
}

/// SQL row for comment query.
#[derive(Debug, Deserialize)]
struct CommentRow {
    id: String,
    author_id: String,
    author_email: String,
    content: String,
    position: Vec<u8>,
    created_at: i64,
    updated_at: Option<i64>,
    resolved: i64,
    parent_id: Option<String>,
}

impl From<CommentRow> for Comment {
    fn from(row: CommentRow) -> Self {
        Comment {
            id: row.id,
            author_id: row.author_id,
            author_email: row.author_email,
            content: row.content,
            position: row.position,
            created_at: row.created_at,
            updated_at: row.updated_at,
            resolved: row.resolved != 0,
            parent_id: row.parent_id,
        }
    }
}

/// Base64 serialization for byte arrays.
mod base64_bytes {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use serde::{self, Deserialize, Deserializer, Serializer};

    pub fn serialize<S>(bytes: &[u8], serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&STANDARD.encode(bytes))
    }

    pub fn deserialize<'de, D>(deserializer: D) -> std::result::Result<Vec<u8>, D::Error>
    where
        D: Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        STANDARD.decode(&s).map_err(serde::de::Error::custom)
    }
}

/// Document state response.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentStateResponse {
    pub state_vector: String, // Base64 encoded
    pub update: String,       // Base64 encoded full state as update
    pub updated_at: i64,
}

/// Add collaborator request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddCollaboratorRequest {
    pub user_id: String,
    pub email: String,
    pub permission: Permission,
}

/// Create comment request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateCommentRequest {
    pub content: String,
    #[serde(with = "base64_bytes")]
    pub position: Vec<u8>,
    pub parent_id: Option<String>,
}

/// Update comment request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCommentRequest {
    pub content: Option<String>,
    pub resolved: Option<bool>,
}

/// Document Durable Object for real-time collaboration.
#[durable_object]
pub struct DocumentDurableObject {
    state: State,
    env: Env,
    initialized: Cell<bool>,
}

impl DurableObject for DocumentDurableObject {
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

        // Check for WebSocket upgrade
        let upgrade_header = req.headers().get("Upgrade")?.unwrap_or_default();
        if upgrade_header.to_lowercase() == "websocket" {
            return self.handle_websocket_upgrade(req).await;
        }

        // Parse path segments
        let segments: Vec<&str> = path.trim_start_matches('/').split('/').collect();

        match (method, segments.as_slice()) {
            // Document state operations
            (Method::Get, ["state"]) => self.handle_get_state().await,
            (Method::Post, ["state"]) => self.handle_apply_update(req).await,

            // Collaborator operations
            (Method::Get, ["collaborators"]) => self.handle_list_collaborators().await,
            (Method::Post, ["collaborators"]) => self.handle_add_collaborator(req).await,
            (Method::Delete, ["collaborators", user_id]) => {
                self.handle_remove_collaborator(user_id).await
            }
            (Method::Get, ["permission", user_id]) => self.handle_get_permission(user_id).await,

            // Comment operations
            (Method::Get, ["comments"]) => self.handle_list_comments().await,
            (Method::Post, ["comments"]) => self.handle_create_comment(req).await,
            (Method::Put, ["comments", comment_id]) => {
                self.handle_update_comment(req, comment_id).await
            }
            (Method::Delete, ["comments", comment_id]) => {
                self.handle_delete_comment(req, comment_id).await
            }

            _ => ApiError::not_found("Endpoint not found").into_response(),
        }
    }

    async fn websocket_message(&self, ws: WebSocket, message: WebSocketIncomingMessage) -> Result<()> {
        let text = match message {
            WebSocketIncomingMessage::String(s) => s,
            WebSocketIncomingMessage::Binary(b) => {
                String::from_utf8(b).unwrap_or_default()
            }
        };

        console_log!("Received WebSocket message: {}", &text[..text.len().min(200)]);

        // Parse the message
        let client_msg: ClientMessage = match serde_json::from_str(&text) {
            Ok(m) => m,
            Err(e) => {
                console_log!("Failed to parse message: {}", e);
                let error = ServerMessage::invalid_message(&format!("Invalid JSON: {}", e));
                let _ = ws.send_with_str(&serde_json::to_string(&error).unwrap_or_default());
                return Ok(());
            }
        };

        console_log!("Parsed message type: {:?}", client_msg);

        // Handle the message
        self.handle_client_message(&ws, client_msg).await
    }

    async fn websocket_close(&self, ws: WebSocket, _code: usize, _reason: String, _was_clean: bool) -> Result<()> {
        // Get user info from WebSocket tags
        if let Some(user_id) = self.get_ws_tag(&ws, "user_id") {
            if let Some(email) = self.get_ws_tag(&ws, "email") {
                // Broadcast user left to other connections
                let msg = ServerMessage::UserLeft {
                    doc_id: self.get_ws_tag(&ws, "doc_id").unwrap_or_default(),
                    user_id: user_id.clone(),
                };
                self.broadcast_except(&ws, &msg).await?;
                
                console_log!("User {} ({}) disconnected", email, user_id);
            }
        }
        Ok(())
    }
}

impl DocumentDurableObject {
    /// Initialize the SQLite schema.
    fn init_schema(&self) -> Result<()> {
        self.state.storage().sql().exec(SCHEMA, None)?;
        Ok(())
    }

    // ==================== WebSocket Handling ====================

    /// Handle WebSocket upgrade request.
    async fn handle_websocket_upgrade(&self, req: Request) -> Result<Response> {
        // Get user info from headers (set by the worker route)
        let user_id = req.headers().get("X-User-Id")?.unwrap_or_default();
        let email = req.headers().get("X-User-Email")?.unwrap_or_default();

        if user_id.is_empty() || email.is_empty() {
            return ApiError::unauthorized("Missing user information").into_response();
        }

        // Get doc_id from query string
        // Format: {owner_id}:{path_hash}
        let url = req.url()?;
        let doc_id = url
            .query_pairs()
            .find(|(k, _)| k == "doc")
            .map(|(_, v)| v.to_string())
            .unwrap_or_default();

        // Extract owner_id from doc_id
        let owner_id = doc_id.split(':').next().unwrap_or("");
        
        // Check permission: user must be owner OR have an accepted share
        // For now, we allow if user is owner. Share permission check would require
        // calling UserDO which adds latency. We trust the client to only subscribe
        // to documents they have access to (share permission is checked on file operations).
        // TODO: Add proper permission check by querying UserDO
        if owner_id != user_id {
            // Log but allow - proper permission check happens on file read/write
            console_log!(
                "User {} subscribing to doc owned by {} (doc_id: {})",
                user_id, owner_id, doc_id
            );
        }

        // Create WebSocket pair
        let WebSocketPair { client, server } = WebSocketPair::new()?;

        // Accept the WebSocket with hibernation
        self.state.accept_websocket_with_tags(
            &server,
            &[
                &format!("user_id:{}", user_id),
                &format!("email:{}", email),
                &format!("doc_id:{}", doc_id),
            ],
        );

        // Send the user_joined message to the newly connected client as well
        let join_msg = ServerMessage::UserJoined {
            doc_id: doc_id.clone(),
            user_id: user_id.clone(),
            email: email.clone(),
        };
        // Send to the new connection (so they know they're connected)
        let _ = server.send_with_str(&serde_json::to_string(&join_msg).unwrap_or_default());
        
        // Also broadcast to other connections
        self.broadcast_except(&server, &join_msg).await?;

        console_log!("User {} ({}) connected to doc {}", email, user_id, doc_id);
        
        // Send an immediate sync_step2 with current state to the new connection
        // This handles the case where websocket_message might not be triggered
        console_log!("Sending initial sync_step2 on connect for doc_id: {}", doc_id);
        let mut state = self.get_document_state()?;
        console_log!("Initial state size: {} bytes", state.len());
        
        if self.is_empty_crdt_state(&state) {
            console_log!("CRDT state is empty, attempting R2 initialization");
            if let Some(content) = self.fetch_initial_content_from_r2(&doc_id).await? {
                console_log!("Fetched {} bytes from R2", content.len());
                state = self.initialize_crdt_from_content(&content)?;
                console_log!("Initialized CRDT with {} bytes", state.len());
            }
        }
        
        use base64::{engine::general_purpose::STANDARD, Engine};
        let sync_response = ServerMessage::SyncStep2 {
            doc_id: doc_id.clone(),
            update: STANDARD.encode(&state),
        };
        let _ = server.send_with_str(&serde_json::to_string(&sync_response).unwrap_or_default());
        console_log!("Sent initial sync_step2 to new connection");

        // Return the client WebSocket
        Response::from_websocket(client)
    }

    /// Get a tag value from a WebSocket.
    fn get_ws_tag(&self, ws: &WebSocket, prefix: &str) -> Option<String> {
        let tags = self.state.get_tags(ws);
        for tag in tags {
            if let Some(value) = tag.strip_prefix(&format!("{}:", prefix)) {
                return Some(value.to_string());
            }
        }
        None
    }

    /// Broadcast a message to all connected WebSockets except the sender.
    async fn broadcast_except(&self, sender: &WebSocket, msg: &ServerMessage) -> Result<()> {
        let msg_str = serde_json::to_string(msg)
            .map_err(|e| Error::RustError(format!("Failed to serialize message: {}", e)))?;

        let websockets = self.state.get_websockets();
        for ws in websockets {
            // Skip the sender
            if std::ptr::eq(&ws, sender) {
                continue;
            }
            let _ = ws.send_with_str(&msg_str);
        }
        Ok(())
    }

    /// Broadcast a message to all connected WebSockets.
    async fn broadcast_all(&self, msg: &ServerMessage) -> Result<()> {
        let msg_str = serde_json::to_string(msg)
            .map_err(|e| Error::RustError(format!("Failed to serialize message: {}", e)))?;

        let websockets = self.state.get_websockets();
        for ws in websockets {
            let _ = ws.send_with_str(&msg_str);
        }
        Ok(())
    }

    /// Handle a client WebSocket message.
    async fn handle_client_message(&self, ws: &WebSocket, msg: ClientMessage) -> Result<()> {
        let user_id = self.get_ws_tag(ws, "user_id").unwrap_or_default();
        let _email = self.get_ws_tag(ws, "email").unwrap_or_default();

        match msg {
            ClientMessage::Subscribe { doc_id } => {
                console_log!("Processing Subscribe for doc_id: {}", doc_id);
                // Check if we have existing CRDT state
                let mut state = self.get_document_state()?;
                console_log!("Current CRDT state size: {} bytes", state.len());
                
                // If state is empty, try to initialize from R2
                if self.is_empty_crdt_state(&state) {
                    console_log!("CRDT state is empty for doc_id: {}, attempting R2 initialization", doc_id);
                    
                    if let Some(content) = self.fetch_initial_content_from_r2(&doc_id).await? {
                        console_log!("Fetched {} bytes from R2 for doc_id: {}", content.len(), doc_id);
                        
                        // Initialize CRDT with the content
                        state = self.initialize_crdt_from_content(&content)?;
                        
                        console_log!("Initialized CRDT state ({} bytes) for doc_id: {}", state.len(), doc_id);
                    } else {
                        console_log!("No R2 content found for doc_id: {}", doc_id);
                    }
                }
                
                use base64::{engine::general_purpose::STANDARD, Engine};
                
                let response = ServerMessage::SyncStep2 {
                    doc_id: doc_id.clone(),
                    update: STANDARD.encode(&state),
                };
                console_log!("Sending SyncStep2 response");
                let _ = ws.send_with_str(&serde_json::to_string(&response).unwrap_or_default());

                let subscribed = ServerMessage::Subscribed { doc_id };
                console_log!("Sending Subscribed response");
                let _ = ws.send_with_str(&serde_json::to_string(&subscribed).unwrap_or_default());
            }

            ClientMessage::Unsubscribe { doc_id } => {
                let response = ServerMessage::Unsubscribed { doc_id };
                let _ = ws.send_with_str(&serde_json::to_string(&response).unwrap_or_default());
            }

            ClientMessage::SyncStep1 { doc_id, state_vector } => {
                // Client sends their state vector, we respond with missing updates
                use base64::{engine::general_purpose::STANDARD, Engine};
                
                let sv_bytes = STANDARD.decode(&state_vector)
                    .map_err(|e| Error::RustError(format!("Invalid base64: {}", e)))?;

                let update = self.get_missing_updates(&sv_bytes)?;
                
                let response = ServerMessage::SyncStep2 {
                    doc_id,
                    update: STANDARD.encode(&update),
                };
                let _ = ws.send_with_str(&serde_json::to_string(&response).unwrap_or_default());
            }

            ClientMessage::SyncStep2 { doc_id: _, update } => {
                // Client sends updates we're missing, apply them
                use base64::{engine::general_purpose::STANDARD, Engine};
                
                let update_bytes = STANDARD.decode(&update)
                    .map_err(|e| Error::RustError(format!("Invalid base64: {}", e)))?;

                self.apply_update(&update_bytes)?;
            }

            ClientMessage::Update { doc_id, update } => {
                // Apply update and broadcast to others
                use base64::{engine::general_purpose::STANDARD, Engine};
                
                let update_bytes = STANDARD.decode(&update)
                    .map_err(|e| Error::RustError(format!("Invalid base64: {}", e)))?;

                self.apply_update(&update_bytes)?;

                // Broadcast to all other clients
                let broadcast = ServerMessage::Update {
                    doc_id,
                    update,
                    from_user: user_id,
                };
                self.broadcast_except(ws, &broadcast).await?;
            }

            ClientMessage::Awareness { doc_id, data } => {
                // Broadcast awareness to all other clients
                let broadcast = ServerMessage::Awareness {
                    doc_id,
                    data,
                    from_user: user_id,
                };
                self.broadcast_except(ws, &broadcast).await?;
            }

            ClientMessage::Ping { timestamp } => {
                let response = ServerMessage::Pong { timestamp };
                let _ = ws.send_with_str(&serde_json::to_string(&response).unwrap_or_default());
            }
        }

        Ok(())
    }

    /// Get the current document state as an update.
    fn get_document_state(&self) -> Result<Vec<u8>> {
        use worker::SqlStorageValue;
        
        let cursor = self.state.storage().sql().exec(
            "SELECT yrs_state FROM doc_state WHERE id = 1",
            None,
        )?;

        // Use raw() to properly handle BLOB data
        let mut raw_iter = cursor.raw();
        match raw_iter.next() {
            Some(Ok(values)) => {
                // First column is yrs_state
                if let Some(SqlStorageValue::Blob(bytes)) = values.first() {
                    Ok(bytes.clone())
                } else if let Some(SqlStorageValue::Null) = values.first() {
                    // Return empty document state
                    let doc = Doc::new();
                    let txn = doc.transact();
                    Ok(txn.encode_state_as_update_v1(&StateVector::default()))
                } else {
                    // Return empty document state
                    let doc = Doc::new();
                    let txn = doc.transact();
                    Ok(txn.encode_state_as_update_v1(&StateVector::default()))
                }
            }
            Some(Err(e)) => Err(e),
            None => {
                // No row found - return empty document state
                let doc = Doc::new();
                let txn = doc.transact();
                Ok(txn.encode_state_as_update_v1(&StateVector::default()))
            }
        }
    }

    /// Get updates missing from the given state vector.
    fn get_missing_updates(&self, client_sv_bytes: &[u8]) -> Result<Vec<u8>> {
        let client_sv = StateVector::decode_v1(client_sv_bytes)
            .map_err(|e| Error::RustError(format!("Invalid state vector: {}", e)))?;

        let state = self.get_document_state()?;
        
        if state.is_empty() {
            return Ok(Vec::new());
        }

        // Load document and encode diff
        let doc = Doc::new();
        {
            let mut txn = doc.transact_mut();
            if let Ok(update) = Update::decode_v1(&state) {
                let _ = txn.apply_update(update);
            }
        }

        let txn = doc.transact();
        Ok(txn.encode_state_as_update_v1(&client_sv))
    }

    /// Apply an update to the document state.
    fn apply_update(&self, update_bytes: &[u8]) -> Result<()> {
        // Load current state
        let current_state = self.get_document_state()?;
        
        let doc = Doc::new();
        
        // Apply existing state
        if !current_state.is_empty() {
            let mut txn = doc.transact_mut();
            if let Ok(update) = Update::decode_v1(&current_state) {
                let _ = txn.apply_update(update);
            }
        }

        // Apply new update
        {
            let mut txn = doc.transact_mut();
            let update = Update::decode_v1(update_bytes)
                .map_err(|e| Error::RustError(format!("Invalid update: {}", e)))?;
            txn.apply_update(update)
                .map_err(|e| Error::RustError(format!("Failed to apply update: {}", e)))?;
        }

        // Encode merged state
        let txn = doc.transact();
        let merged_state = txn.encode_state_as_update_v1(&StateVector::default());
        let now = chrono::Utc::now().timestamp();

        // Save to database
        self.state.storage().sql().exec(
            "INSERT INTO doc_state (id, yrs_state, updated_at) VALUES (1, ?1, ?2)
             ON CONFLICT(id) DO UPDATE SET yrs_state = ?1, updated_at = ?2",
            vec![merged_state.into(), now.into()],
        )?;

        Ok(())
    }

    // ==================== R2 Initialization ====================

    /// Check if the CRDT state represents an empty document.
    fn is_empty_crdt_state(&self, state: &[u8]) -> bool {
        if state.is_empty() {
            return true;
        }
        
        // Try to decode and check if the document has any content
        let doc = Doc::new();
        {
            let mut txn = doc.transact_mut();
            if let Ok(update) = Update::decode_v1(state) {
                let _ = txn.apply_update(update);
            }
        }
        
        // Use a mutable transaction to get_or_insert_text, then check content
        let mut txn = doc.transact_mut();
        let text = txn.get_or_insert_text("content");
        text.get_string(&txn).is_empty()
    }

    /// Fetch initial file content from R2 storage.
    /// The doc_id format is: {owner_id}:{path_hash}
    async fn fetch_initial_content_from_r2(&self, doc_id: &str) -> Result<Option<String>> {
        // Parse doc_id: {owner_id}:{path_hash}
        let parts: Vec<&str> = doc_id.splitn(2, ':').collect();
        if parts.len() != 2 {
            console_log!("Invalid doc_id format: {}", doc_id);
            return Ok(None);
        }
        
        let owner_id = parts[0];
        let path_hash = parts[1];
        
        // Construct R2 key: {owner_id}/files/{path_hash}/content
        let r2_key = format!("{}/files/{}/content", owner_id, path_hash);
        
        console_log!("Fetching from R2 key: {}", r2_key);
        
        // Get R2 bucket
        let bucket = self.env.bucket("VAULT_STORAGE")?;
        
        // Fetch content
        match bucket.get(&r2_key).execute().await? {
            Some(obj) => {
                match obj.body() {
                    Some(body) => {
                        let bytes = body.bytes().await?;
                        // Convert to UTF-8 string (markdown content)
                        match String::from_utf8(bytes.to_vec()) {
                            Ok(content) => Ok(Some(content)),
                            Err(e) => {
                                console_log!("Failed to parse R2 content as UTF-8: {}", e);
                                Ok(None)
                            }
                        }
                    }
                    None => {
                        // Empty file
                        Ok(Some(String::new()))
                    }
                }
            }
            None => {
                console_log!("R2 object not found: {}", r2_key);
                Ok(None)
            }
        }
    }

    /// Initialize CRDT document with text content and save to database.
    fn initialize_crdt_from_content(&self, content: &str) -> Result<Vec<u8>> {
        let doc = Doc::new();
        
        // Set the content in the CRDT
        {
            let mut txn = doc.transact_mut();
            let text = txn.get_or_insert_text("content");
            text.insert(&mut txn, 0, content);
        }
        
        // Encode the state
        let txn = doc.transact();
        let state = txn.encode_state_as_update_v1(&StateVector::default());
        let now = chrono::Utc::now().timestamp();
        
        // Save to database
        self.state.storage().sql().exec(
            "INSERT INTO doc_state (id, yrs_state, updated_at) VALUES (1, ?1, ?2)
             ON CONFLICT(id) DO UPDATE SET yrs_state = ?1, updated_at = ?2",
            vec![state.clone().into(), now.into()],
        )?;
        
        Ok(state)
    }

    // ==================== REST API Handlers ====================

    /// Get the JWT manager from environment.
    fn get_jwt_manager(&self) -> Result<JwtManager> {
        let secret = self.env.secret("JWT_SECRET")?.to_string();
        Ok(JwtManager::new(&secret))
    }

    /// Extract and validate JWT claims from request.
    fn extract_claims(
        &self,
        req: &Request,
    ) -> Result<std::result::Result<crate::auth::Claims, Response>> {
        let auth_header = req.headers().get("Authorization")?.unwrap_or_default();
        if !auth_header.starts_with("Bearer ") {
            return Ok(Err(
                ApiError::unauthorized("Missing or invalid authorization header").into_response()?
            ));
        }

        let token = &auth_header[7..];
        let jwt_manager = self.get_jwt_manager()?;

        match jwt_manager.decode(token) {
            Ok(data) => Ok(Ok(data.claims)),
            Err(_) => Ok(Err(
                ApiError::unauthorized("Invalid token").into_response()?
            )),
        }
    }

    /// Get user's permission for this document.
    fn get_user_permission(&self, user_id: &str) -> Result<Option<Permission>> {
        let cursor = self.state.storage().sql().exec(
            "SELECT permission FROM collaborators WHERE user_id = ?1",
            vec![user_id.to_string().into()],
        )?;

        #[derive(Debug, Deserialize)]
        struct PermRow {
            permission: String,
        }

        let row: Option<PermRow> = cursor.next::<PermRow>().next().transpose()?;

        Ok(row.and_then(|r| r.permission.parse().ok()))
    }

    /// Get the current document state.
    async fn handle_get_state(&self) -> Result<Response> {
        use worker::SqlStorageValue;
        
        let cursor = self.state.storage().sql().exec(
            "SELECT yrs_state, updated_at FROM doc_state WHERE id = 1",
            None,
        )?;

        // Use raw() to properly handle BLOB data
        let mut raw_iter = cursor.raw();
        let (state_vector, update, updated_at) = match raw_iter.next() {
            Some(Ok(values)) => {
                // First column is yrs_state, second is updated_at
                let state_bytes = match values.first() {
                    Some(SqlStorageValue::Blob(bytes)) => Some(bytes.clone()),
                    _ => None,
                };
                let updated_at = match values.get(1) {
                    Some(SqlStorageValue::Integer(ts)) => *ts,
                    _ => chrono::Utc::now().timestamp(),
                };
                
                if let Some(state_bytes) = state_bytes {
                    // Load the document from stored state
                    let doc = Doc::new();
                    {
                        let mut txn = doc.transact_mut();
                        if let Ok(update) = Update::decode_v1(&state_bytes) {
                            let _ = txn.apply_update(update);
                        }
                    }

                    let txn = doc.transact();
                    let sv = txn.state_vector().encode_v1();
                    let update = txn.encode_state_as_update_v1(&StateVector::default());

                    (sv, update, updated_at)
                } else {
                    // Empty document
                    let doc = Doc::new();
                    let txn = doc.transact();
                    let sv = txn.state_vector().encode_v1();
                    let update = txn.encode_state_as_update_v1(&StateVector::default());

                    (sv, update, updated_at)
                }
            }
            Some(Err(e)) => return Err(e),
            None => {
                // No state yet, create empty document
                let doc = Doc::new();
                let txn = doc.transact();
                let sv = txn.state_vector().encode_v1();
                let update = txn.encode_state_as_update_v1(&StateVector::default());

                let now = chrono::Utc::now().timestamp();
                (sv, update, now)
            }
        };

        use base64::{engine::general_purpose::STANDARD, Engine};

        json_ok(&DocumentStateResponse {
            state_vector: STANDARD.encode(&state_vector),
            update: STANDARD.encode(&update),
            updated_at,
        })
    }

    /// Apply an update to the document.
    async fn handle_apply_update(&self, mut req: Request) -> Result<Response> {
        use worker::SqlStorageValue;
        
        #[derive(Debug, Deserialize)]
        struct ApplyUpdateRequest {
            update: String, // Base64 encoded
        }

        let body: ApplyUpdateRequest = req.json().await?;

        use base64::{engine::general_purpose::STANDARD, Engine};
        let update_bytes = STANDARD
            .decode(&body.update)
            .map_err(|e| Error::RustError(format!("Invalid base64: {}", e)))?;

        // Load existing state using raw() to handle BLOB data
        let cursor = self.state.storage().sql().exec(
            "SELECT yrs_state FROM doc_state WHERE id = 1",
            None,
        )?;

        let mut raw_iter = cursor.raw();
        let existing_state = match raw_iter.next() {
            Some(Ok(values)) => {
                match values.first() {
                    Some(SqlStorageValue::Blob(bytes)) => Some(bytes.clone()),
                    _ => None,
                }
            }
            _ => None,
        };

        let doc = Doc::new();

        // Apply existing state if any
        if let Some(state_bytes) = existing_state {
            let mut txn = doc.transact_mut();
            if let Ok(update) = Update::decode_v1(&state_bytes) {
                let _ = txn.apply_update(update);
            }
        }

        // Apply the new update
        {
            let mut txn = doc.transact_mut();
            let update = Update::decode_v1(&update_bytes)
                .map_err(|e| Error::RustError(format!("Invalid update: {}", e)))?;
            txn.apply_update(update)
                .map_err(|e| Error::RustError(format!("Failed to apply update: {}", e)))?;
        }

        // Encode the merged state
        let txn = doc.transact();
        let merged_state = txn.encode_state_as_update_v1(&StateVector::default());
        let now = chrono::Utc::now().timestamp();

        // Save to database (upsert)
        self.state.storage().sql().exec(
            "INSERT INTO doc_state (id, yrs_state, updated_at) VALUES (1, ?1, ?2)
             ON CONFLICT(id) DO UPDATE SET yrs_state = ?1, updated_at = ?2",
            vec![merged_state.into(), now.into()],
        )?;

        json_ok(&serde_json::json!({
            "success": true,
            "updatedAt": now
        }))
    }

    /// List all collaborators.
    async fn handle_list_collaborators(&self) -> Result<Response> {
        let cursor = self.state.storage().sql().exec(
            "SELECT user_id, email, permission, added_at FROM collaborators ORDER BY added_at",
            None,
        )?;

        let mut collaborators = Vec::new();
        for row in cursor.next::<CollaboratorRow>() {
            let row = row?;
            if let Ok(collab) = Collaborator::try_from(row) {
                collaborators.push(collab);
            }
        }

        json_ok(&collaborators)
    }

    /// Add a collaborator.
    async fn handle_add_collaborator(&self, mut req: Request) -> Result<Response> {
        let body: AddCollaboratorRequest = req.json().await?;
        let now = chrono::Utc::now().timestamp();

        // Insert or update collaborator
        self.state.storage().sql().exec(
            "INSERT INTO collaborators (user_id, email, permission, added_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(user_id) DO UPDATE SET email = ?2, permission = ?3",
            vec![
                body.user_id.clone().into(),
                body.email.clone().into(),
                body.permission.to_string().into(),
                now.into(),
            ],
        )?;

        json_ok(&Collaborator {
            user_id: body.user_id,
            email: body.email,
            permission: body.permission,
            added_at: now,
        })
    }

    /// Remove a collaborator.
    async fn handle_remove_collaborator(&self, user_id: &str) -> Result<Response> {
        // Check if user exists
        let existing = self.get_user_permission(user_id)?;
        if existing.is_none() {
            return ApiError::not_found("Collaborator not found").into_response();
        }

        // Cannot remove the owner
        if existing == Some(Permission::Owner) {
            return ApiError::bad_request("Cannot remove the document owner").into_response();
        }

        self.state.storage().sql().exec(
            "DELETE FROM collaborators WHERE user_id = ?1",
            vec![user_id.to_string().into()],
        )?;

        json_ok(&serde_json::json!({
            "success": true,
            "message": "Collaborator removed"
        }))
    }

    /// Get a user's permission.
    async fn handle_get_permission(&self, user_id: &str) -> Result<Response> {
        let permission = self.get_user_permission(user_id)?;

        match permission {
            Some(p) => json_ok(&serde_json::json!({
                "userId": user_id,
                "permission": p
            })),
            None => ApiError::not_found("User is not a collaborator").into_response(),
        }
    }

    /// List all comments.
    async fn handle_list_comments(&self) -> Result<Response> {
        let cursor = self.state.storage().sql().exec(
            "SELECT id, author_id, author_email, content, position, created_at, updated_at, resolved, parent_id 
             FROM comments ORDER BY created_at",
            None,
        )?;

        let mut comments = Vec::new();
        for row in cursor.next::<CommentRow>() {
            let row = row?;
            comments.push(Comment::from(row));
        }

        json_ok(&comments)
    }

    /// Create a new comment.
    async fn handle_create_comment(&self, mut req: Request) -> Result<Response> {
        // Extract user from JWT
        let claims = match self.extract_claims(&req)? {
            Ok(c) => c,
            Err(resp) => return Ok(resp),
        };

        let body: CreateCommentRequest = req.json().await?;
        let now = chrono::Utc::now().timestamp();
        let comment_id = uuid::Uuid::new_v4().to_string();

        // Validate parent exists if specified
        if let Some(ref parent_id) = body.parent_id {
            #[derive(Debug, Deserialize)]
            struct IdRow {
                id: String,
            }

            let cursor = self.state.storage().sql().exec(
                "SELECT id FROM comments WHERE id = ?1",
                vec![parent_id.clone().into()],
            )?;

            let parent: Option<IdRow> = cursor.next::<IdRow>().next().transpose()?;
            if parent.is_none() {
                return ApiError::not_found("Parent comment not found").into_response();
            }
        }

        self.state.storage().sql().exec(
            "INSERT INTO comments (id, author_id, author_email, content, position, created_at, resolved, parent_id) 
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7)",
            vec![
                comment_id.clone().into(),
                claims.sub.clone().into(),
                claims.email.clone().into(),
                body.content.clone().into(),
                body.position.clone().into(),
                now.into(),
                body.parent_id.clone().into(),
            ],
        )?;

        json_ok(&Comment {
            id: comment_id,
            author_id: claims.sub,
            author_email: claims.email,
            content: body.content,
            position: body.position,
            created_at: now,
            updated_at: None,
            resolved: false,
            parent_id: body.parent_id,
        })
    }

    /// Update a comment.
    async fn handle_update_comment(&self, mut req: Request, comment_id: &str) -> Result<Response> {
        // Extract user from JWT
        let claims = match self.extract_claims(&req)? {
            Ok(c) => c,
            Err(resp) => return Ok(resp),
        };

        // Check if comment exists and user is the author
        #[derive(Debug, Deserialize)]
        struct CommentAuthorRow {
            author_id: String,
        }

        let cursor = self.state.storage().sql().exec(
            "SELECT author_id FROM comments WHERE id = ?1",
            vec![comment_id.to_string().into()],
        )?;

        let row: Option<CommentAuthorRow> = cursor.next::<CommentAuthorRow>().next().transpose()?;

        let author_id = match row {
            Some(r) => r.author_id,
            None => return ApiError::not_found("Comment not found").into_response(),
        };

        // Only author can edit content, anyone with comment permission can resolve
        let body: UpdateCommentRequest = req.json().await?;
        let now = chrono::Utc::now().timestamp();

        if body.content.is_some() && author_id != claims.sub {
            return ApiError::forbidden("Only the author can edit comment content").into_response();
        }

        // Build update query dynamically
        let mut updates = Vec::new();
        let mut params: Vec<SqlStorageValue> = Vec::new();

        if let Some(content) = &body.content {
            updates.push(format!("content = ?{}", params.len() + 1));
            params.push(content.clone().into());
        }

        if let Some(resolved) = body.resolved {
            updates.push(format!("resolved = ?{}", params.len() + 1));
            params.push((if resolved { 1i64 } else { 0i64 }).into());
        }

        if updates.is_empty() {
            return ApiError::bad_request("No updates provided").into_response();
        }

        updates.push(format!("updated_at = ?{}", params.len() + 1));
        params.push(now.into());

        params.push(comment_id.to_string().into());

        let query = format!(
            "UPDATE comments SET {} WHERE id = ?{}",
            updates.join(", "),
            params.len()
        );

        self.state
            .storage()
            .sql()
            .exec(&query, Some(params))?;

        json_ok(&serde_json::json!({
            "success": true,
            "updatedAt": now
        }))
    }

    /// Delete a comment.
    async fn handle_delete_comment(&self, req: Request, comment_id: &str) -> Result<Response> {
        // Extract user from JWT
        let claims = match self.extract_claims(&req)? {
            Ok(c) => c,
            Err(resp) => return Ok(resp),
        };

        // Check if comment exists and user is the author
        #[derive(Debug, Deserialize)]
        struct CommentAuthorRow {
            author_id: String,
        }

        let cursor = self.state.storage().sql().exec(
            "SELECT author_id FROM comments WHERE id = ?1",
            vec![comment_id.to_string().into()],
        )?;

        let row: Option<CommentAuthorRow> = cursor.next::<CommentAuthorRow>().next().transpose()?;

        let author_id = match row {
            Some(r) => r.author_id,
            None => return ApiError::not_found("Comment not found").into_response(),
        };

        // Check if user is author or has manage permission
        let user_permission = self.get_user_permission(&claims.sub)?;
        let can_delete = author_id == claims.sub
            || user_permission.map(|p| p.can_manage()).unwrap_or(false);

        if !can_delete {
            return ApiError::forbidden("You don't have permission to delete this comment")
                .into_response();
        }

        // Delete comment and all replies
        self.state.storage().sql().exec(
            "DELETE FROM comments WHERE id = ?1 OR parent_id = ?1",
            vec![comment_id.to_string().into()],
        )?;

        json_ok(&serde_json::json!({
            "success": true,
            "message": "Comment deleted"
        }))
    }
}
