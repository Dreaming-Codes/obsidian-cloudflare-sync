//! SyncNotify Durable Object for WebSocket-based sync notifications.
//!
//! Each user has one SyncNotify DO instance that:
//! - Accepts WebSocket connections from all their devices
//! - Broadcasts sync notifications when any device uploads/deletes a file
//! - Tracks connected devices to avoid notifying the originator

use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::collections::HashMap;
use worker::*;

use crate::auth::JwtManager;

/// Message types for WebSocket communication.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SyncMessage {
    /// Server -> Client: A file was changed, sync needed
    #[serde(rename = "sync")]
    FileChanged {
        path: String,
        action: FileAction,
        #[serde(rename = "originDevice")]
        origin_device: String,
        #[serde(rename = "contentHash")]
        content_hash: Option<String>,
    },
    /// Server -> Client: Connection established
    #[serde(rename = "connected")]
    Connected {
        #[serde(rename = "deviceId")]
        device_id: String,
    },
    /// Server -> Client: Ping to keep connection alive
    #[serde(rename = "ping")]
    Ping,
    /// Client -> Server: Pong response
    #[serde(rename = "pong")]
    Pong,
    /// Server -> Client: Error message
    #[serde(rename = "error")]
    Error { message: String },
}

/// File action types.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileAction {
    Upload,
    Delete,
}

/// Request to broadcast a sync notification (internal, from file routes).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BroadcastRequest {
    pub path: String,
    pub action: FileAction,
    pub origin_device: String,
    pub content_hash: Option<String>,
}

/// WebSocket attachment data for reconnection.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WsAttachment {
    conn_id: String,
    device_id: String,
    user_id: String,
}

/// Connected client info (stored in-memory, rebuilt from WebSockets on wake).
struct ConnectedClient {
    device_id: String,
    websocket: WebSocket,
}

/// SyncNotify Durable Object - manages WebSocket connections for a user.
#[durable_object]
pub struct SyncNotifyDurableObject {
    state: State,
    env: Env,
    /// Map of connection ID -> client info (rebuilt from state.get_web_sockets())
    clients: RefCell<HashMap<String, ConnectedClient>>,
}

impl DurableObject for SyncNotifyDurableObject {
    fn new(state: State, env: Env) -> Self {
        Self {
            state,
            env,
            clients: RefCell::new(HashMap::new()),
        }
    }

    async fn fetch(&self, req: Request) -> Result<Response> {
        // Rebuild clients map from hibernated WebSockets
        self.rebuild_clients_from_websockets();

        let path = req.path();
        let method = req.method();

        match (method, path.as_str()) {
            // WebSocket upgrade
            (Method::Get, "/ws") => self.handle_websocket_upgrade(req).await,
            // Broadcast notification (called from file routes)
            (Method::Post, "/broadcast") => self.handle_broadcast(req).await,
            // Get connected client count (for debugging)
            (Method::Get, "/status") => self.handle_status().await,
            _ => Response::error("Not found", 404),
        }
    }

    async fn websocket_message(
        &self,
        ws: WebSocket,
        message: WebSocketIncomingMessage,
    ) -> Result<()> {
        // Rebuild clients on wake
        self.rebuild_clients_from_websockets();

        if let WebSocketIncomingMessage::String(text) = message {
            // Parse the message
            if let Ok(msg) = serde_json::from_str::<SyncMessage>(&text) {
                match msg {
                    SyncMessage::Pong => {
                        // Client responded to ping, connection is alive
                    }
                    _ => {
                        // Clients shouldn't send other message types
                        let error = SyncMessage::Error {
                            message: "Unexpected message type".to_string(),
                        };
                        if let Ok(json) = serde_json::to_string(&error) {
                            let _ = ws.send_with_str(&json);
                        }
                    }
                }
            }
        }

        Ok(())
    }

    async fn websocket_close(
        &self,
        ws: WebSocket,
        _code: usize,
        _reason: String,
        _was_clean: bool,
    ) -> Result<()> {
        // Get connection ID from attachment and remove
        if let Ok(Some(attachment)) = ws.deserialize_attachment::<WsAttachment>() {
            self.clients.borrow_mut().remove(&attachment.conn_id);
        }
        Ok(())
    }

    async fn websocket_error(&self, ws: WebSocket, _error: Error) -> Result<()> {
        // Get connection ID from attachment and remove
        if let Ok(Some(attachment)) = ws.deserialize_attachment::<WsAttachment>() {
            self.clients.borrow_mut().remove(&attachment.conn_id);
        }
        let _ = ws.close(Some(1011), Some("WebSocket error"));
        Ok(())
    }
}

impl SyncNotifyDurableObject {
    /// Get the JWT manager from environment.
    fn get_jwt_manager(&self) -> Result<JwtManager> {
        let secret = self.env.secret("JWT_SECRET")?.to_string();
        Ok(JwtManager::new(&secret))
    }

    /// Rebuild the clients map from hibernated WebSockets.
    /// Called on each fetch/websocket event since DO may have hibernated.
    fn rebuild_clients_from_websockets(&self) {
        let websockets = self.state.get_websockets();
        let mut clients = self.clients.borrow_mut();

        // Clear and rebuild
        clients.clear();

        for ws in websockets {
            if let Ok(Some(attachment)) = ws.deserialize_attachment::<WsAttachment>() {
                clients.insert(
                    attachment.conn_id.clone(),
                    ConnectedClient {
                        device_id: attachment.device_id,
                        websocket: ws,
                    },
                );
            }
        }
    }

    /// Handle WebSocket upgrade request.
    async fn handle_websocket_upgrade(&self, req: Request) -> Result<Response> {
        // Extract token from query parameter
        let url = req.url()?;
        let token = url
            .query_pairs()
            .find(|(k, _)| k == "token")
            .map(|(_, v)| v.into_owned());

        let token = match token {
            Some(t) => t,
            None => return Response::error("Missing token parameter", 401),
        };

        // Validate JWT
        let jwt_manager = self.get_jwt_manager()?;
        let claims = match jwt_manager.decode(&token) {
            Ok(data) => data.claims,
            Err(_) => return Response::error("Invalid token", 401),
        };

        // Create WebSocket pair
        let WebSocketPair { client, server } = WebSocketPair::new()?;

        // Accept the server side with hibernation
        self.state.accept_web_socket(&server);

        // Generate a connection ID
        let conn_id = uuid::Uuid::new_v4().to_string();
        let device_id = claims.device_id.clone();

        // Store connection metadata for hibernation recovery
        let attachment = WsAttachment {
            conn_id: conn_id.clone(),
            device_id: device_id.clone(),
            user_id: claims.sub.clone(),
        };
        server.serialize_attachment(&attachment)?;

        // Store the connected client in memory
        self.clients.borrow_mut().insert(
            conn_id,
            ConnectedClient {
                device_id: device_id.clone(),
                websocket: server.clone(),
            },
        );

        // Send connected message
        let connected_msg = SyncMessage::Connected {
            device_id,
        };
        if let Ok(json) = serde_json::to_string(&connected_msg) {
            let _ = server.send_with_str(&json);
        }

        // Return the client WebSocket to the caller
        Response::from_websocket(client)
    }

    /// Handle broadcast request from file routes.
    async fn handle_broadcast(&self, mut req: Request) -> Result<Response> {
        let body: BroadcastRequest = req.json().await?;

        let message = SyncMessage::FileChanged {
            path: body.path,
            action: body.action,
            origin_device: body.origin_device.clone(),
            content_hash: body.content_hash,
        };

        let json = serde_json::to_string(&message)
            .map_err(|e| Error::RustError(format!("Failed to serialize message: {}", e)))?;

        // Broadcast to all connected clients except the origin device
        let clients = self.clients.borrow();
        let mut sent_count = 0;

        for client in clients.values() {
            // Skip the device that made the change
            if client.device_id == body.origin_device {
                continue;
            }

            // Send message, ignore errors for individual clients
            if client.websocket.send_with_str(&json).is_ok() {
                sent_count += 1;
            }
        }

        Response::ok(format!("Broadcast to {} clients", sent_count))
    }

    /// Handle status request (for debugging).
    async fn handle_status(&self) -> Result<Response> {
        let clients = self.clients.borrow();
        let device_ids: Vec<&str> = clients.values().map(|c| c.device_id.as_str()).collect();

        Response::from_json(&serde_json::json!({
            "connectedClients": clients.len(),
            "devices": device_ids,
        }))
    }
}
