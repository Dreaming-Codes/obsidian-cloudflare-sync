//! Magic link token generation and verification.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{Duration, Utc};
use sha2::{Digest, Sha256};

/// Magic link token with metadata.
#[derive(Debug, Clone)]
pub struct MagicLinkToken {
    /// The raw token to send to the user
    pub token: String,
    /// Hash of the token for storage
    pub token_hash: String,
    /// When the token expires (Unix timestamp)
    pub expires_at: i64,
}

/// Manager for creating and verifying magic link tokens.
pub struct MagicLinkManager {
    /// How long magic links are valid (in minutes)
    expiry_minutes: i64,
}

impl MagicLinkManager {
    /// Create a new magic link manager.
    pub fn new(expiry_minutes: i64) -> Self {
        Self { expiry_minutes }
    }

    /// Create a new magic link manager with default 15 minute expiry.
    pub fn default() -> Self {
        Self::new(15)
    }

    /// Generate a new magic link token.
    pub fn generate_token(&self) -> MagicLinkToken {
        // Generate 32 random bytes
        let mut random_bytes = [0u8; 32];
        getrandom::getrandom(&mut random_bytes).expect("Failed to generate random bytes");

        // Encode as URL-safe base64
        let token = URL_SAFE_NO_PAD.encode(random_bytes);

        // Hash the token for storage
        let token_hash = self.hash_token(&token);

        // Calculate expiry
        let expires_at = (Utc::now() + Duration::minutes(self.expiry_minutes)).timestamp();

        MagicLinkToken {
            token,
            token_hash,
            expires_at,
        }
    }

    /// Hash a token for secure storage.
    pub fn hash_token(&self, token: &str) -> String {
        let mut hasher = Sha256::new();
        hasher.update(token.as_bytes());
        hex::encode(hasher.finalize())
    }

    /// Verify a token against its hash.
    pub fn verify_token(&self, token: &str, stored_hash: &str) -> bool {
        let computed_hash = self.hash_token(token);
        // Use constant-time comparison to prevent timing attacks
        constant_time_eq(computed_hash.as_bytes(), stored_hash.as_bytes())
    }

    /// Check if a token has expired.
    pub fn is_expired(&self, expires_at: i64) -> bool {
        Utc::now().timestamp() > expires_at
    }
}

/// Constant-time byte comparison to prevent timing attacks.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }

    let mut result = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        result |= x ^ y;
    }
    result == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_token_generation() {
        let manager = MagicLinkManager::default();
        let token = manager.generate_token();

        assert!(!token.token.is_empty());
        assert!(!token.token_hash.is_empty());
        assert!(token.expires_at > Utc::now().timestamp());
    }

    #[test]
    fn test_token_verification() {
        let manager = MagicLinkManager::default();
        let token = manager.generate_token();

        assert!(manager.verify_token(&token.token, &token.token_hash));
        assert!(!manager.verify_token("wrong-token", &token.token_hash));
    }
}
