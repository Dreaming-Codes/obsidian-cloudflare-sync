//! Sync module for real-time CRDT synchronization.

pub mod awareness;
pub mod protocol;

pub use awareness::{AwarenessState, DocumentAwareness, get_user_color};
pub use protocol::{ClientMessage, ServerMessage};
