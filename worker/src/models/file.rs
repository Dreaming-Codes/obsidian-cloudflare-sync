//! File metadata and related types.

use serde::{Deserialize, Serialize};

/// File metadata stored alongside content in R2.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMeta {
    /// Original file path in the vault (e.g., "notes/daily/2026-01-16.md")
    pub path: String,
    /// File size in bytes
    pub size: u64,
    /// Last modified time (Unix timestamp in milliseconds)
    pub mtime: i64,
    /// MIME content type (e.g., "text/markdown", "image/png")
    pub content_type: String,
    /// SHA-256 hash of file content for change detection
    pub content_hash: String,
    /// Whether the file has been soft-deleted
    pub deleted: bool,
    /// When the file was created (Unix timestamp)
    pub created_at: i64,
    /// When the file was last updated (Unix timestamp)
    pub updated_at: i64,
}

impl FileMeta {
    /// Create new file metadata.
    pub fn new(path: String, size: u64, mtime: i64, content_type: String, content_hash: String) -> Self {
        let now = chrono::Utc::now().timestamp();
        Self {
            path,
            size,
            mtime,
            content_type,
            content_hash,
            deleted: false,
            created_at: now,
            updated_at: now,
        }
    }

    /// Mark the file as updated.
    pub fn touch(&mut self) {
        self.updated_at = chrono::Utc::now().timestamp();
    }
}

/// File version metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileVersion {
    /// Version timestamp (Unix timestamp)
    pub timestamp: i64,
    /// File size at this version
    pub size: u64,
    /// Content hash at this version
    pub content_hash: String,
}

/// Response for listing files.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListFilesResponse {
    pub files: Vec<FileMeta>,
    /// Cursor for pagination (if more files exist)
    pub cursor: Option<String>,
    /// Whether there are more files to fetch
    pub has_more: bool,
}

/// Response after uploading a file.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileUploadResponse {
    pub success: bool,
    pub path: String,
    pub size: u64,
    pub content_hash: String,
    /// Whether a new version was created (file already existed)
    pub version_created: bool,
    /// Whether a 3-way merge was performed
    pub merged: bool,
    /// Whether the merge had conflicts (conflict markers inserted)
    pub had_conflict: bool,
}

/// Response for listing file versions.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListVersionsResponse {
    pub path: String,
    pub versions: Vec<FileVersion>,
}
