# Cloudflare Sync Plugin - Implementation Plan

## Overview

A real-time collaborative sync plugin for Obsidian using Cloudflare infrastructure:

- **R2**: Long-term storage for all file types (markdown, attachments, etc.)
- **Durable Objects**: Real-time sync coordination with WebSocket hibernation + SQLite
- **Workers (Rust)**: API gateway, authentication, routing via `workers-rs`
- **Resend**: Magic link email authentication

## User Choices

| Decision | Choice |
|----------|--------|
| Authentication | Magic Link (Email only) |
| Collaboration Scope | Character-level CRDT (using yrs/Y.js) |
| Platform Support | Desktop + Mobile |
| Permission Model | Granular (Owner/Editor/Commenter/Viewer) |
| Backend Language | Rust |
| Server URL | User-configurable (default: `https://sync.elysiumcraftrp.org`) |
| File Types | All files synced |
| Storage Limits | None |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          OBSIDIAN PLUGIN (TypeScript)                    │
│  ┌──────────────┐  ┌─────────────┐  ┌──────────────┐  ┌──────────────┐ │
│  │ SyncManager  │  │ CRDTEngine  │  │ WebSocket    │  │ SettingsTab  │ │
│  │              │  │ (yjs)       │  │ Client       │  │              │ │
│  └──────────────┘  └─────────────┘  └──────────────┘  └──────────────┘ │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │ WebSocket + REST
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    CLOUDFLARE WORKER (Rust via workers-rs)               │
│  ┌──────────────┐  ┌─────────────┐  ┌──────────────┐  ┌──────────────┐ │
│  │ Auth         │  │ Router      │  │ Middleware   │  │ Validator    │ │
│  │ (Magic Link) │  │             │  │ (JWT/Perms)  │  │              │ │
│  └──────────────┘  └─────────────┘  └──────────────┘  └──────────────┘ │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │
         ┌───────────────────────────┼───────────────────────────┐
         │                           │                           │
         ▼                           ▼                           ▼
┌────────────────────┐  ┌────────────────────────┐  ┌─────────────────────┐
│   DURABLE OBJECT   │  │     DURABLE OBJECT     │  │         R2          │
│   (Per Document)   │  │       (Per User)       │  │    (File Storage)   │
│ ┌────────────────┐ │  │ ┌────────────────────┐ │  │ ┌─────────────────┐ │
│ │ yrs Doc State  │ │  │ │ Session Management │ │  │ │ File Content    │ │
│ │ Awareness      │ │  │ │ Permissions Cache  │ │  │ │ File Versions   │ │
│ │ WS Connections │ │  │ │ Magic Link Tokens  │ │  │ │ All File Types  │ │
│ │ Collaborators  │ │  │ └────────────────────┘ │  │ └─────────────────┘ │
│ │ Comments       │ │  └────────────────────────┘  └─────────────────────┘
│ └────────────────┘ │
│     SQLite DB      │
└────────────────────┘
```

---

## Project Structure

```
cloudflare-sync/
├── src/                           # Obsidian Plugin (TypeScript)
│   ├── main.ts                    # Plugin entry, lifecycle
│   ├── settings.ts                # Settings interface & tab
│   ├── types.ts                   # Shared TypeScript types
│   ├── sync/
│   │   ├── SyncManager.ts         # Orchestrates all sync
│   │   ├── CRDTDocument.ts        # Y.js document wrapper
│   │   ├── WebSocketClient.ts     # WS with reconnection
│   │   └── FileWatcher.ts         # Vault change detection
│   ├── auth/
│   │   ├── AuthManager.ts         # JWT storage, refresh
│   │   └── MagicLinkModal.ts      # Login UI
│   ├── sharing/
│   │   ├── ShareManager.ts        # Permission management
│   │   └── ShareModal.ts          # Share UI
│   ├── comments/
│   │   ├── CommentManager.ts      # Comment CRUD
│   │   └── CommentView.ts         # Inline display
│   └── ui/
│       ├── StatusBar.ts           # Sync status
│       └── NotificationManager.ts # Toast notifications
│
├── worker/                        # Cloudflare Worker (Rust)
│   ├── .cargo/
│   │   └── config.toml            # WASM target configuration
│   ├── Cargo.toml
│   ├── wrangler.toml
│   └── src/
│       ├── lib.rs                 # Entry point, router
│       ├── auth/
│       │   ├── mod.rs
│       │   ├── magic_link.rs      # Token gen/verify
│       │   ├── jwt.rs             # JWT encode/decode
│       │   └── resend.rs          # Email API client
│       ├── durable_objects/
│       │   ├── mod.rs
│       │   ├── document.rs        # DocumentDO
│       │   └── user.rs            # UserDO
│       ├── routes/
│       │   ├── mod.rs
│       │   ├── auth.rs            # /auth/*
│       │   ├── files.rs           # /files/*
│       │   ├── share.rs           # /share/*
│       │   └── websocket.rs       # /ws/*
│       ├── models/
│       │   ├── mod.rs
│       │   ├── user.rs
│       │   ├── file.rs
│       │   ├── share.rs
│       │   └── comment.rs
│       ├── sync/
│       │   ├── mod.rs
│       │   ├── protocol.rs        # WS message types
│       │   └── awareness.rs       # Cursor presence
│       └── utils/
│           ├── mod.rs
│           ├── error.rs
│           ├── response.rs        # JSON response helpers
│           ├── r2.rs
│           └── crypto.rs
│
├── manifest.json
├── package.json
├── esbuild.config.mjs
├── tsconfig.json
└── PLAN.md                        # This file
```

---

## Rust Worker Configuration

### Cargo.toml

Use Rust 2024 edition and latest crate versions. Dependencies will be added via `cargo add` to ensure latest versions:

```toml
[package]
name = "cloudflare-sync-worker"
version = "0.1.0"
edition = "2024"
authors = ["DreamingCodes <me@dreaming.codes>"]

[lib]
crate-type = ["cdylib"]

# Aggressive release optimization for minimal WASM size
[profile.release]
lto = "fat"              # Full link-time optimization
opt-level = "s"          # Optimize for size
panic = "abort"          # No unwinding, smaller binary
strip = true             # Remove symbols
codegen-units = 1        # Single codegen unit for better optimization
overflow-checks = false  # Disable overflow checks for performance

# WASM-specific optimization
[package.metadata.wasm-pack.profile.release]
wasm-opt = ["-O4", "--enable-simd"]

[dependencies]
# Core worker dependencies (add via: cargo add worker worker-macros)
worker = "0.7"
worker-macros = "0.7"

# Serialization (add via: cargo add serde --features derive)
serde = { version = "1", features = ["derive"] }
serde_json = "1"

# CRDT (add via: cargo add yrs)
yrs = "0.21"

# Auth (add via: cargo add jsonwebtoken)
jsonwebtoken = "9"

# Crypto (add via: cargo add sha2 hex base64)
sha2 = "0.10"
hex = "0.4"
base64 = "0.22"

# Utilities (add via: cargo add uuid --features v4,serde)
uuid = { version = "1", features = ["v4", "serde"] }
chrono = { version = "0.4", features = ["serde", "wasmbind"] }
thiserror = "2"
futures = "0.3"
getrandom = { version = "0.2", features = ["js"] }
```

### .cargo/config.toml

Enable SIMD for better WASM performance:

```toml
[target.wasm32-unknown-unknown]
rustflags = ["-C", "target-feature=+simd128"]
```

### wrangler.toml

```toml
name = "cloudflare-sync"
main = "build/index.js"
compatibility_date = "2025-01-15"

[build]
command = "cargo install -q worker-build@^0.7 && worker-build --release"

[[r2_buckets]]
binding = "VAULT_STORAGE"
bucket_name = "obsidian-vault-storage"

[[durable_objects.bindings]]
name = "DOCUMENT_DO"
class_name = "DocumentDurableObject"

[[durable_objects.bindings]]
name = "USER_DO"
class_name = "UserDurableObject"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["DocumentDurableObject", "UserDurableObject"]

# Secrets (set via `wrangler secret put`)
# - RESEND_API_KEY
# - JWT_SECRET
```

---

## Rust Best Practices (from example project)

### 1. JSON Response Helper

Create a reusable response helper for consistent API responses:

```rust
// src/utils/response.rs
use serde::Serialize;
use worker::*;

pub fn json_response<T: Serialize>(data: &T, status: u16) -> Result<Response> {
    let body = serde_json::to_string(data)?;
    let headers = Headers::new();
    headers.set("Content-Type", "application/json")?;

    Ok(Response::builder()
        .with_status(status)
        .with_headers(headers)
        .fixed(body.into_bytes()))
}
```

### 2. Structured Error Responses

Use structured error types for consistent error handling:

```rust
// src/utils/error.rs
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct ApiError {
    pub error: ApiErrorDetail,
}

#[derive(Debug, Serialize)]
pub struct ApiErrorDetail {
    pub code: String,
    pub message: String,
    pub status: u16,
}

impl ApiError {
    pub fn new(code: &str, message: &str, status: u16) -> Self {
        Self {
            error: ApiErrorDetail {
                code: code.to_string(),
                message: message.to_string(),
                status,
            },
        }
    }

    pub fn not_found(message: &str) -> Self {
        Self::new("NOT_FOUND", message, 404)
    }

    pub fn unauthorized(message: &str) -> Self {
        Self::new("UNAUTHORIZED", message, 401)
    }

    pub fn bad_request(message: &str) -> Self {
        Self::new("BAD_REQUEST", message, 400)
    }

    pub fn internal(message: &str) -> Self {
        Self::new("INTERNAL_ERROR", message, 500)
    }
}
```

### 3. JsError Conversion Pattern

When working with web_sys APIs, use this pattern:

```rust
let headers = web_sys::Headers::new()
    .map_err(|e| Error::JsError(format!("{:?}", e)))?;
headers.set("Content-Type", "application/json")
    .map_err(|e| Error::JsError(format!("{:?}", e)))?;
```

### 4. Request Validation with Helper Methods

Add validation methods directly on request types:

```rust
impl SomeRequest {
    pub fn is_valid(&self) -> bool {
        !self.required_field.is_empty()
    }

    pub fn has_optional_data(&self) -> bool {
        self.optional_field.as_ref().map(|f| !f.is_empty()).unwrap_or(false)
    }
}
```

### 5. Graceful Degradation Pattern

Chain fallback behaviors for resilience:

```rust
// Try primary method first
if let Ok(Some(result)) = try_primary_method(&request).await {
    return json_response(&result, 200);
}

// Fall back to secondary method
if let Some(result) = try_secondary_method(&context) {
    return json_response(&result, 200);
}

// Final fallback: error response
json_response(&ApiError::not_found("Resource not found"), 404)
```

### 6. Entry Point Pattern

Use `#[event(fetch)]` macro for the main handler:

```rust
use worker::*;

#[event(fetch)]
async fn fetch(req: Request, env: Env, ctx: Context) -> Result<Response> {
    // Router or direct handling
    Router::new()
        .get("/health", |_, _| Response::ok("OK"))
        .post_async("/api/endpoint", handle_endpoint)
        .run(req, env)
        .await
}
```

---

## Implementation Phases

### Phase 1: Rust Worker Scaffold ✅ COMPLETED

---

### Phase 2: Authentication - Magic Link ✅ COMPLETED

**Implemented**:
- `worker/src/auth/jwt.rs` - JWT encoding/decoding with Claims
- `worker/src/auth/magic_link.rs` - Token generation with SHA256
- `worker/src/auth/resend.rs` - Resend API client for emails
- `worker/src/durable_objects/user.rs` - UserDO with SQLite schema
- `worker/src/routes/auth.rs` - Auth route handlers

**Server Routes**:
- `POST /auth/magic-link` - Generate token, send email
- `GET /auth/verify?token=xxx` - Verify token, return JWT
- `POST /auth/refresh` - Refresh expiring JWT
- `POST /auth/logout` - Invalidate session
- `GET /auth/me` - Get current user
- `DELETE /auth/sessions` - Logout all devices

---

### Phase 3: R2 File Storage ✅ COMPLETED

**Implemented**:
- `worker/src/models/file.rs` - FileMeta, FileVersion, response types
- `worker/src/utils/r2.rs` - R2Helper with versioning support
- `worker/src/routes/files.rs` - File route handlers with JWT auth

**R2 Bucket Structure**:
```
/{user_id}/files/{path_hash}/
  content              # Current file content
  meta.json            # File metadata
  versions/{timestamp} # Historical versions
```

**Server Routes**:
- `GET /files` - List all files with metadata
- `GET /files/{path}` - Download file
- `PUT /files/{path}` - Upload file (creates version if exists)
- `DELETE /files/{path}` - Soft delete
- `GET /files/{path}/versions` - List versions
- `GET /files/{path}/versions/{ts}` - Get specific version

---

### Phase 4: Plugin Foundation ✅ COMPLETED

**Implemented**:
- `manifest.json` - Updated with cloudflare-sync plugin info
- `src/types.ts` - Shared TypeScript types for API, auth, files
- `src/settings.ts` - CloudflareSyncSettings interface and SettingsTab
- `src/auth/AuthManager.ts` - JWT storage, refresh, magic link auth
- `src/auth/MagicLinkModal.ts` - Email login UI with state management
- `src/ui/StatusBar.ts` - Sync status display in status bar
- `src/ui/NotificationManager.ts` - Toast notification system
- `src/main.ts` - Plugin lifecycle, commands, manager initialization
- `styles.css` - Plugin styling for all UI components

**Plugin Features**:
- Settings tab with server URL, auth, sync toggle
- Magic link authentication flow
- Status bar with connection/sync status
- Commands: login, logout, sync-now, toggle-sync
- Auto token refresh before expiry

---

### Phase 5: Basic File Sync ✅ COMPLETED

**Implemented**:
- `src/utils/hash.ts` - SHA-256 file hashing utilities
- `src/sync/FileWatcher.ts` - Vault change detection with debouncing
- `src/sync/FileSync.ts` - Upload/download operations with R2
- `src/sync/SyncManager.ts` - Orchestrates sync, handles conflicts
- Updated `src/main.ts` - Integrated SyncManager lifecycle

**Features**:
- Automatic file watching (create, modify, delete, rename)
- Debounced change detection (500ms)
- Full sync on startup and every 5 minutes
- Hash-based change detection
- Support for all file types (binary and text)
- Version support for file history

---

### Phase 6: Durable Objects Setup ✅ COMPLETED

**Implemented**:
- `worker/src/durable_objects/document.rs` - DocumentDO with SQLite schema
- SQLite tables: `doc_state`, `collaborators`, `comments`
- Permission model (Owner/Editor/Commenter/Viewer)
- REST API handlers for state, collaborators, comments
- Added `yrs` dependency to Cargo.toml

**DocumentDO Schema**:
```sql
CREATE TABLE doc_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  yrs_state BLOB,
  updated_at INTEGER NOT NULL
);

CREATE TABLE collaborators (
  user_id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  permission TEXT NOT NULL,  -- owner/editor/commenter/viewer
  added_at INTEGER NOT NULL
);

CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL,
  author_email TEXT NOT NULL,
  content TEXT NOT NULL,
  position BLOB NOT NULL,    -- yrs RelativePosition
  created_at INTEGER NOT NULL,
  updated_at INTEGER,
  resolved INTEGER DEFAULT 0,
  parent_id TEXT             -- for threading
);
```

---

### Phase 7: Real-Time Sync (WebSocket + CRDT) ✅ COMPLETED

**Implemented (Worker)**:
- `worker/src/sync/protocol.rs` - WebSocket message types (ClientMessage, ServerMessage)
- `worker/src/sync/awareness.rs` - Cursor/presence awareness structures
- `worker/src/routes/websocket.rs` - WebSocket upgrade handler with JWT auth
- WebSocket handling in DocumentDO with hibernation API
- CRDT state management with yrs
- Message broadcasting to connected clients

**Implemented (Plugin)**:
- `src/sync/WebSocketClient.ts` - WebSocket client with exponential backoff reconnection
- `src/sync/CRDTDocument.ts` - Y.js document wrapper and manager
- `src/sync/RealtimeSyncManager.ts` - Integrates WebSocket, CRDT, and Obsidian editor
- `src/auth/AuthManager.ts` - Added `getValidToken()` for async token refresh
- `src/types.ts` - WebSocket protocol types
- `src/main.ts` - Integrated RealtimeSyncManager lifecycle

**WebSocket Protocol**:
```rust
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMessage {
    Subscribe { doc_id: String },
    Unsubscribe { doc_id: String },
    SyncStep1 { doc_id: String, state_vector: String },  // base64
    SyncStep2 { doc_id: String, update: String },        // base64
    Update { doc_id: String, update: String },           // base64
    Awareness { doc_id: String, data: String },          // base64
    Ping,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMessage {
    Subscribed { doc_id: String },
    SyncStep2 { doc_id: String, update: String },
    Update { doc_id: String, update: String, from_user: String },
    Awareness { doc_id: String, data: String, from_user: String },
    UserJoined { doc_id: String, user_id: String, email: String },
    UserLeft { doc_id: String, user_id: String },
    Pong,
    Error { code: String, message: String },
}
```

---

### Phase 8: Permissions & Sharing
**Goal**: Granular file/folder sharing

**Permission Model**:
```rust
#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Permission {
    Owner,      // Full control
    Editor,     // Read + write content + comments
    Commenter,  // Read + add comments
    Viewer,     // Read only
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareInvite {
    pub id: String,
    pub resource_path: String,
    pub resource_type: ResourceType,  // File | Folder
    pub owner_id: String,
    pub invitee_email: String,
    pub permission: Permission,
    pub created_at: i64,
    pub accepted_at: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum ResourceType {
    File,
    Folder,
}
```

**Server Routes**:
- `POST /share` - Create invite, send email
- `GET /shares` - List shares I created
- `GET /shared-with-me` - Shares received
- `GET /share/{id}` - Get share details
- `PUT /share/{id}` - Update permission
- `DELETE /share/{id}` - Revoke
- `POST /share/{id}/accept` - Accept invite

**Permission Checking**:
- Middleware checks permission before file operations
- Folder permissions cascade to children
- Cache in UserDO for performance

**Plugin Tasks**:
1. Create `ShareModal`:
   - Add collaborator by email
   - Permission dropdown
   - List current collaborators
2. Context menu "Share..." on files/folders
3. Sidebar section for shared items
4. Visual indicators (icons) for shared files

**Commits**:
- `feat(worker): permission model and share routes`
- `feat(worker): permission checking middleware`
- `feat(plugin): share modal and UI`

---

### Phase 9: Comments System
**Goal**: Inline comments synced via CRDT

**Comment Features**:
- Create comment at cursor position
- Edit/delete own comments
- Resolve/unresolve comments
- Threaded replies
- Highlight commented text

**Markdown Fallback** (for viewers without plugin):
```markdown
Text with comment.[^comment-abc123]

[^comment-abc123]: **user@example.com** (2026-01-15):
  This needs more detail.
```

**Plugin Tasks**:
1. Create `CommentManager`
2. Create comment popover UI
3. Highlight text with comments
4. Sync comments via Y.js

**Commits**:
- `feat(worker): comment storage in DocumentDO`
- `feat(plugin): comment system with inline UI`

---

### Phase 10: Offline Support & Polish
**Goal**: Work offline, graceful error handling

**Offline Support**:
1. Queue operations when disconnected
2. Store pending changes in plugin data
3. Sync on reconnect
4. Visual offline indicator

**Polish**:
1. Comprehensive error messages
2. Loading states throughout
3. Debounce expensive operations
4. Lazy-load Y.js
5. Mobile testing
6. Performance profiling

**Commits**:
- `feat(plugin): offline support with operation queue`
- `fix: error handling and UX polish`
- `feat(plugin): mobile compatibility`

---

## API Endpoints Summary

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| GET | `/health` | Health check | No |
| POST | `/auth/magic-link` | Request magic link | No |
| GET | `/auth/verify` | Verify magic link | No |
| POST | `/auth/refresh` | Refresh JWT | Yes |
| POST | `/auth/logout` | Logout | Yes |
| GET | `/files` | List all files | Yes |
| GET | `/files/{path}` | Download file | Yes |
| PUT | `/files/{path}` | Upload file | Yes |
| DELETE | `/files/{path}` | Delete file | Yes |
| GET | `/files/{path}/versions` | List versions | Yes |
| POST | `/share` | Create share | Yes |
| GET | `/shares` | List my shares | Yes |
| GET | `/shared-with-me` | Shares received | Yes |
| PUT | `/share/{id}` | Update share | Yes |
| DELETE | `/share/{id}` | Revoke share | Yes |
| POST | `/share/{id}/accept` | Accept invite | Yes |
| WS | `/ws` | WebSocket endpoint | Yes |

---

## Commit Strategy

Each phase produces 1-3 focused commits:
- Prefix: `feat(worker):` or `feat(plugin):` or `fix:`
- Small, atomic changes
- Working state after each commit
- Run build before committing

---

## Implementation Order

1. **Phase 1**: Worker scaffold (foundation)
2. **Phase 2**: Authentication (required for everything)
3. **Phase 3**: R2 storage (basic sync)
4. **Phase 4**: Plugin foundation (connect to backend)
5. **Phase 5**: Basic file sync (MVP functionality)
6. **Phase 6**: Durable Objects (prepare for real-time)
7. **Phase 7**: Real-time CRDT sync (core feature)
8. **Phase 8**: Sharing & permissions
9. **Phase 9**: Comments
10. **Phase 10**: Polish & offline

---

## Notes

- Server URL is user-configurable, default: `https://sync.elysiumcraftrp.org`
- All file types are synced (not just markdown)
- No storage limits implemented
- Mobile support is a requirement
- yrs (Rust) on server, yjs (JS) on client - they are wire-compatible
- Use `cargo add` to add dependencies (ensures latest versions)
- Rust edition 2024 for latest language features
- Aggressive WASM optimization for minimal bundle size
