//! WebSocket sync protocol message types.
//!
//! Defines the binary protocol for CRDT sync between client and server.

use serde::{Deserialize, Serialize};

/// Messages sent from the client to the server.
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMessage {
    /// Subscribe to a document for sync.
    Subscribe { doc_id: String },

    /// Unsubscribe from a document.
    Unsubscribe { doc_id: String },

    /// Sync step 1: Send state vector to get missing updates.
    SyncStep1 {
        doc_id: String,
        /// Base64 encoded state vector
        state_vector: String,
    },

    /// Sync step 2: Acknowledge receipt of updates.
    SyncStep2 {
        doc_id: String,
        /// Base64 encoded update
        update: String,
    },

    /// Send a CRDT update to the document.
    Update {
        doc_id: String,
        /// Base64 encoded yrs update
        update: String,
    },

    /// Send awareness update (cursor position, selection, etc.).
    Awareness {
        doc_id: String,
        /// Base64 encoded awareness data
        data: String,
    },

    /// Ping to keep connection alive.
    Ping { timestamp: i64 },
}

/// Messages sent from the server to the client.
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMessage {
    /// Confirmation of subscription.
    Subscribed { doc_id: String },

    /// Confirmation of unsubscription.
    Unsubscribed { doc_id: String },

    /// Sync step 1 response: Server's state vector.
    SyncStep1 {
        doc_id: String,
        /// Base64 encoded state vector
        state_vector: String,
    },

    /// Sync step 2: Updates the client is missing.
    SyncStep2 {
        doc_id: String,
        /// Base64 encoded update
        update: String,
    },

    /// Broadcast update from another client.
    Update {
        doc_id: String,
        /// Base64 encoded yrs update
        update: String,
        /// User ID who made the update
        from_user: String,
    },

    /// Broadcast awareness update from another client.
    Awareness {
        doc_id: String,
        /// Base64 encoded awareness data
        data: String,
        /// User ID whose awareness this is
        from_user: String,
    },

    /// Error message.
    Error { code: String, message: String },

    /// Pong response to keep connection alive.
    Pong { timestamp: i64 },

    /// User joined the document.
    UserJoined {
        doc_id: String,
        user_id: String,
        email: String,
    },

    /// User left the document.
    UserLeft { doc_id: String, user_id: String },
}

impl ServerMessage {
    /// Create an error message.
    pub fn error(code: &str, message: &str) -> Self {
        Self::Error {
            code: code.to_string(),
            message: message.to_string(),
        }
    }

    /// Create a permission denied error.
    pub fn permission_denied() -> Self {
        Self::error("PERMISSION_DENIED", "You don't have permission to access this document")
    }

    /// Create a document not found error.
    pub fn doc_not_found(doc_id: &str) -> Self {
        Self::error("DOC_NOT_FOUND", &format!("Document not found: {}", doc_id))
    }

    /// Create an invalid message error.
    pub fn invalid_message(details: &str) -> Self {
        Self::error("INVALID_MESSAGE", details)
    }
}
