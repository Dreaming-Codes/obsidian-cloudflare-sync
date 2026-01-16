//! Route handlers for the API.

pub mod auth;
pub mod files;

pub use auth::handle_auth_routes;
pub use files::handle_file_routes;
