//! R2 bucket helper functions for file storage.

use sha2::{Digest, Sha256};
use worker::*;

use crate::models::{FileMeta, FileVersion};

/// R2 key helpers for organizing files.
pub struct R2Keys;

impl R2Keys {
    /// Get the base path for a user's files.
    pub fn user_base(user_id: &str) -> String {
        format!("{}/files", user_id)
    }

    /// Hash a file path to create a safe R2 key component.
    pub fn hash_path(path: &str) -> String {
        let mut hasher = Sha256::new();
        hasher.update(path.as_bytes());
        hex::encode(hasher.finalize())
    }

    /// Get the R2 key for a file's content.
    pub fn content_key(user_id: &str, path: &str) -> String {
        let path_hash = Self::hash_path(path);
        format!("{}/files/{}/content", user_id, path_hash)
    }

    /// Get the R2 key for a file's metadata.
    pub fn meta_key(user_id: &str, path: &str) -> String {
        let path_hash = Self::hash_path(path);
        format!("{}/files/{}/meta.json", user_id, path_hash)
    }

    /// Get the R2 key for a specific version of a file.
    pub fn version_key(user_id: &str, path: &str, timestamp: i64) -> String {
        let path_hash = Self::hash_path(path);
        format!("{}/files/{}/versions/{}", user_id, path_hash, timestamp)
    }

    /// Get the prefix for listing all versions of a file.
    pub fn versions_prefix(user_id: &str, path: &str) -> String {
        let path_hash = Self::hash_path(path);
        format!("{}/files/{}/versions/", user_id, path_hash)
    }

    /// Get the prefix for listing all of a user's files.
    pub fn files_prefix(user_id: &str) -> String {
        format!("{}/files/", user_id)
    }
}

/// Helper for R2 operations.
pub struct R2Helper<'a> {
    bucket: &'a Bucket,
}

impl<'a> R2Helper<'a> {
    /// Create a new R2 helper.
    pub fn new(bucket: &'a Bucket) -> Self {
        Self { bucket }
    }

    /// Get file metadata from R2.
    pub async fn get_meta(&self, user_id: &str, path: &str) -> Result<Option<FileMeta>> {
        let key = R2Keys::meta_key(user_id, path);
        let obj = self.bucket.get(&key).execute().await?;

        match obj {
            Some(o) => {
                let body = o.body().ok_or_else(|| Error::RustError("No body in meta object".into()))?;
                let bytes = body.bytes().await?;
                let meta: FileMeta = serde_json::from_slice(&bytes)
                    .map_err(|e| Error::RustError(format!("Failed to parse meta: {}", e)))?;
                Ok(Some(meta))
            }
            None => Ok(None),
        }
    }

    /// Save file metadata to R2.
    pub async fn put_meta(&self, user_id: &str, path: &str, meta: &FileMeta) -> Result<()> {
        let key = R2Keys::meta_key(user_id, path);
        let json = serde_json::to_vec(meta)
            .map_err(|e| Error::RustError(format!("Failed to serialize meta: {}", e)))?;

        self.bucket
            .put(&key, json)
            .http_metadata(HttpMetadata {
                content_type: Some("application/json".to_string()),
                ..Default::default()
            })
            .execute()
            .await?;

        Ok(())
    }

    /// Get file content from R2.
    pub async fn get_content(&self, user_id: &str, path: &str) -> Result<Option<Vec<u8>>> {
        let key = R2Keys::content_key(user_id, path);
        let obj = self.bucket.get(&key).execute().await?;

        match obj {
            Some(o) => {
                // Handle empty files - body() may return None for 0-byte objects
                match o.body() {
                    Some(body) => {
                        let bytes = body.bytes().await?;
                        Ok(Some(bytes.to_vec()))
                    }
                    None => {
                        // Empty file - return empty vec
                        Ok(Some(Vec::new()))
                    }
                }
            }
            None => Ok(None),
        }
    }

    /// Save file content to R2, creating a version if the file already exists.
    pub async fn put_content(
        &self,
        user_id: &str,
        path: &str,
        content: Vec<u8>,
        content_type: &str,
        mtime: i64,
    ) -> Result<(FileMeta, bool)> {
        // Calculate content hash
        let mut hasher = Sha256::new();
        hasher.update(&content);
        let content_hash = hex::encode(hasher.finalize());

        // Check if file exists and create version if needed
        let existing_meta = self.get_meta(user_id, path).await?;
        let version_created = existing_meta.is_some();

        if let Some(ref old_meta) = existing_meta {
            // Only create version if content actually changed
            if old_meta.content_hash != content_hash {
                self.create_version(user_id, path, old_meta).await?;
            }
        }

        // Store content
        let content_key = R2Keys::content_key(user_id, path);
        self.bucket
            .put(&content_key, content.clone())
            .http_metadata(HttpMetadata {
                content_type: Some(content_type.to_string()),
                ..Default::default()
            })
            .execute()
            .await?;

        // Create or update metadata
        let meta = if let Some(mut m) = existing_meta {
            m.size = content.len() as u64;
            m.mtime = mtime;
            m.content_type = content_type.to_string();
            m.content_hash = content_hash;
            m.deleted = false;
            m.touch();
            m
        } else {
            FileMeta::new(
                path.to_string(),
                content.len() as u64,
                mtime,
                content_type.to_string(),
                content_hash,
            )
        };

        self.put_meta(user_id, path, &meta).await?;

        Ok((meta, version_created))
    }

    /// Create a version backup of the current file content.
    async fn create_version(&self, user_id: &str, path: &str, meta: &FileMeta) -> Result<()> {
        // Get current content
        if let Some(content) = self.get_content(user_id, path).await? {
            let timestamp = meta.updated_at;
            let version_key = R2Keys::version_key(user_id, path, timestamp);

            self.bucket
                .put(&version_key, content)
                .http_metadata(HttpMetadata {
                    content_type: Some(meta.content_type.clone()),
                    ..Default::default()
                })
                .execute()
                .await?;
        }

        Ok(())
    }

    /// Soft delete a file (marks as deleted but keeps data).
    pub async fn soft_delete(&self, user_id: &str, path: &str) -> Result<bool> {
        if let Some(mut meta) = self.get_meta(user_id, path).await? {
            // Create version before deleting
            self.create_version(user_id, path, &meta).await?;

            meta.deleted = true;
            meta.touch();
            self.put_meta(user_id, path, &meta).await?;

            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// List all files for a user.
    pub async fn list_files(
        &self,
        user_id: &str,
        cursor: Option<String>,
        limit: Option<u32>,
    ) -> Result<(Vec<FileMeta>, Option<String>, bool)> {
        let prefix = R2Keys::files_prefix(user_id);
        
        let mut list_builder = self.bucket.list().prefix(&prefix);
        
        if let Some(c) = cursor {
            list_builder = list_builder.cursor(&c);
        }
        
        if let Some(l) = limit {
            list_builder = list_builder.limit(l);
        }

        let objects = list_builder.execute().await?;
        let mut files = Vec::new();

        // Filter for meta.json files and load their content
        for obj in objects.objects() {
            let key = obj.key();
            if key.ends_with("/meta.json") {
                // Load the meta file
                if let Some(o) = self.bucket.get(&key).execute().await? {
                    if let Some(body) = o.body() {
                        let bytes = body.bytes().await?;
                        if let Ok(meta) = serde_json::from_slice::<FileMeta>(&bytes) {
                            files.push(meta);
                        }
                    }
                }
            }
        }

        let next_cursor = objects.cursor();
        let has_more = objects.truncated();

        Ok((files, next_cursor, has_more))
    }

    /// List versions of a file.
    pub async fn list_versions(&self, user_id: &str, path: &str) -> Result<Vec<FileVersion>> {
        let prefix = R2Keys::versions_prefix(user_id, path);
        let objects = self.bucket.list().prefix(&prefix).execute().await?;

        let mut versions = Vec::new();

        for obj in objects.objects() {
            let key = obj.key();
            // Extract timestamp from key
            if let Some(ts_str) = key.strip_prefix(&prefix) {
                if let Ok(timestamp) = ts_str.parse::<i64>() {
                    versions.push(FileVersion {
                        timestamp,
                        size: obj.size() as u64,
                        content_hash: String::new(), // Would need to store this separately
                    });
                }
            }
        }

        // Sort by timestamp descending (newest first)
        versions.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));

        Ok(versions)
    }

    /// Get a specific version of a file.
    pub async fn get_version(&self, user_id: &str, path: &str, timestamp: i64) -> Result<Option<Vec<u8>>> {
        let key = R2Keys::version_key(user_id, path, timestamp);
        let obj = self.bucket.get(&key).execute().await?;

        match obj {
            Some(o) => {
                // Handle empty files - body() may return None for 0-byte objects
                match o.body() {
                    Some(body) => {
                        let bytes = body.bytes().await?;
                        Ok(Some(bytes.to_vec()))
                    }
                    None => {
                        // Empty file version - return empty vec
                        Ok(Some(Vec::new()))
                    }
                }
            }
            None => Ok(None),
        }
    }
}
