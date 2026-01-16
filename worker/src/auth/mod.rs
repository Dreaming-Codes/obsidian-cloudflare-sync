//! Authentication module for magic link email auth and JWT handling.

pub mod jwt;
pub mod magic_link;
pub mod resend;

pub use jwt::{Claims, JwtManager};
pub use magic_link::MagicLinkManager;
pub use resend::ResendClient;
