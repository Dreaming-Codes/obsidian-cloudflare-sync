//! 3-way merge utilities for conflict resolution.

use diffy::{merge, MergeOptions};

/// Result of a 3-way merge operation.
#[derive(Debug)]
pub enum MergeResult {
    /// Merge succeeded without conflicts.
    Clean(String),
    /// Merge had conflicts, result contains conflict markers.
    Conflict(String),
    /// Content is binary or otherwise not mergeable.
    NotMergeable,
}

/// Check if content appears to be text (not binary).
fn is_text_content(content: &[u8]) -> bool {
    // Check for null bytes which indicate binary content
    if content.contains(&0) {
        return false;
    }
    
    // Check if content is valid UTF-8
    std::str::from_utf8(content).is_ok()
}

/// Perform a 3-way merge of text content.
/// 
/// # Arguments
/// * `base` - The common ancestor version
/// * `local` - The local changes (what the client is uploading)
/// * `remote` - The remote changes (what's currently on the server)
/// 
/// # Returns
/// * `MergeResult::Clean` - If merge succeeded without conflicts
/// * `MergeResult::Conflict` - If merge had conflicts, with conflict markers embedded
/// * `MergeResult::NotMergeable` - If content is binary
pub fn merge_text(base: &[u8], local: &[u8], remote: &[u8]) -> MergeResult {
    // Check if all content is text
    if !is_text_content(base) || !is_text_content(local) || !is_text_content(remote) {
        return MergeResult::NotMergeable;
    }

    // Convert to strings (safe because we checked above)
    let base_str = std::str::from_utf8(base).unwrap();
    let local_str = std::str::from_utf8(local).unwrap();
    let remote_str = std::str::from_utf8(remote).unwrap();

    // If local and remote are identical, no merge needed
    if local_str == remote_str {
        return MergeResult::Clean(local_str.to_string());
    }

    // If local equals base, remote wins (no local changes)
    if local_str == base_str {
        return MergeResult::Clean(remote_str.to_string());
    }

    // If remote equals base, local wins (no remote changes)
    if remote_str == base_str {
        return MergeResult::Clean(local_str.to_string());
    }

    // Perform 3-way merge
    let options = MergeOptions::default();
    
    match merge(base_str, local_str, remote_str) {
        Ok(merged) => MergeResult::Clean(merged),
        Err(conflict) => {
            // diffy returns the merged content with conflict markers
            // Format the conflict markers to be more readable
            let conflict_str = conflict.to_string();
            MergeResult::Conflict(format_conflict_markers(&conflict_str))
        }
    }
}

/// Format conflict markers to be more user-friendly.
fn format_conflict_markers(content: &str) -> String {
    content
        .replace("<<<<<<< ", "<<<<<<< LOCAL (your changes)\n")
        .replace(">>>>>>> ", ">>>>>>> REMOTE (server changes)\n")
}

/// Merge binary content - simply returns the local version with a note that
/// the remote version was overwritten.
/// 
/// For binary files, we can't merge, so we have options:
/// 1. Keep local (last-write-wins from the uploader's perspective)
/// 2. Keep remote (reject the upload)
/// 3. Keep both (create a conflict file)
/// 
/// This function implements option 1 - the uploader wins for binary files.
pub fn merge_binary_last_write_wins(local: &[u8]) -> Vec<u8> {
    local.to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_no_conflict_different_sections() {
        let base = "line1\nline2\nline3\n";
        let local = "modified_line1\nline2\nline3\n";
        let remote = "line1\nline2\nmodified_line3\n";

        match merge_text(base.as_bytes(), local.as_bytes(), remote.as_bytes()) {
            MergeResult::Clean(result) => {
                assert!(result.contains("modified_line1"));
                assert!(result.contains("modified_line3"));
            }
            _ => panic!("Expected clean merge"),
        }
    }

    #[test]
    fn test_conflict_same_line() {
        let base = "line1\nline2\nline3\n";
        let local = "local_change\nline2\nline3\n";
        let remote = "remote_change\nline2\nline3\n";

        match merge_text(base.as_bytes(), local.as_bytes(), remote.as_bytes()) {
            MergeResult::Conflict(result) => {
                assert!(result.contains("<<<<<<<"));
                assert!(result.contains(">>>>>>>"));
            }
            _ => panic!("Expected conflict"),
        }
    }

    #[test]
    fn test_binary_detection() {
        let binary = b"hello\x00world";
        let text = b"hello world";

        assert!(!is_text_content(binary));
        assert!(is_text_content(text));
    }

    #[test]
    fn test_local_equals_base() {
        let base = "unchanged\n";
        let local = "unchanged\n";
        let remote = "remote_changed\n";

        match merge_text(base.as_bytes(), local.as_bytes(), remote.as_bytes()) {
            MergeResult::Clean(result) => {
                assert_eq!(result, "remote_changed\n");
            }
            _ => panic!("Expected clean merge with remote winning"),
        }
    }

    #[test]
    fn test_remote_equals_base() {
        let base = "unchanged\n";
        let local = "local_changed\n";
        let remote = "unchanged\n";

        match merge_text(base.as_bytes(), local.as_bytes(), remote.as_bytes()) {
            MergeResult::Clean(result) => {
                assert_eq!(result, "local_changed\n");
            }
            _ => panic!("Expected clean merge with local winning"),
        }
    }
}
