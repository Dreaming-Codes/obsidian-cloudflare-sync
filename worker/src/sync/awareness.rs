//! Awareness data for collaborative cursors and presence.

use serde::{Deserialize, Serialize};

/// Awareness state for a user in a document.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AwarenessState {
    /// User ID
    pub user_id: String,

    /// User email/display name
    pub user_name: String,

    /// User's assigned color for cursors/selections
    pub color: String,

    /// Current cursor position (optional)
    pub cursor: Option<CursorPosition>,

    /// Current selection (optional)
    pub selection: Option<Selection>,

    /// Timestamp of last activity
    pub last_active: i64,
}

/// Cursor position in the document.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorPosition {
    /// Line number (0-indexed)
    pub line: u32,

    /// Character position in line (0-indexed)
    pub ch: u32,
}

/// Selection range in the document.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    /// Start of selection
    pub anchor: CursorPosition,

    /// End of selection (where cursor is)
    pub head: CursorPosition,
}

/// Collection of all users' awareness states for a document.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DocumentAwareness {
    /// Map of user_id to awareness state
    pub states: std::collections::HashMap<String, AwarenessState>,
}

impl DocumentAwareness {
    /// Create a new empty awareness collection.
    pub fn new() -> Self {
        Self {
            states: std::collections::HashMap::new(),
        }
    }

    /// Update a user's awareness state.
    pub fn update(&mut self, state: AwarenessState) {
        self.states.insert(state.user_id.clone(), state);
    }

    /// Remove a user's awareness state.
    pub fn remove(&mut self, user_id: &str) {
        self.states.remove(user_id);
    }

    /// Get all active users (active within the last 30 seconds).
    pub fn active_users(&self, now: i64) -> Vec<&AwarenessState> {
        self.states
            .values()
            .filter(|s| now - s.last_active < 30)
            .collect()
    }
}

/// Predefined colors for user cursors.
pub const USER_COLORS: &[&str] = &[
    "#F44336", // Red
    "#2196F3", // Blue
    "#4CAF50", // Green
    "#FF9800", // Orange
    "#9C27B0", // Purple
    "#00BCD4", // Cyan
    "#E91E63", // Pink
    "#795548", // Brown
    "#607D8B", // Blue Grey
    "#3F51B5", // Indigo
];

/// Get a color for a user based on their ID hash.
pub fn get_user_color(user_id: &str) -> &'static str {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    user_id.hash(&mut hasher);
    let index = (hasher.finish() as usize) % USER_COLORS.len();
    USER_COLORS[index]
}
