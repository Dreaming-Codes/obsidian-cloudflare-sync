//! JWT encoding and decoding for authentication tokens.

use chrono::{Duration, Utc};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, TokenData, Validation};
use serde::{Deserialize, Serialize};

/// JWT claims structure.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Claims {
    /// Subject (user ID)
    pub sub: String,
    /// User email
    pub email: String,
    /// Issued at (Unix timestamp)
    pub iat: i64,
    /// Expiration time (Unix timestamp)
    pub exp: i64,
    /// Session ID for invalidation
    pub session_id: String,
    /// Device ID for multi-device sync tracking
    pub device_id: String,
}

impl Claims {
    /// Create new claims for a user.
    pub fn new(user_id: &str, email: &str, session_id: &str, device_id: &str, expires_in_hours: i64) -> Self {
        let now = Utc::now();
        let exp = now + Duration::hours(expires_in_hours);

        Self {
            sub: user_id.to_string(),
            email: email.to_string(),
            iat: now.timestamp(),
            exp: exp.timestamp(),
            session_id: session_id.to_string(),
            device_id: device_id.to_string(),
        }
    }

    /// Check if the token is expired.
    pub fn is_expired(&self) -> bool {
        Utc::now().timestamp() > self.exp
    }
}

/// JWT manager for encoding and decoding tokens.
pub struct JwtManager {
    encoding_key: EncodingKey,
    decoding_key: DecodingKey,
}

impl JwtManager {
    /// Create a new JWT manager with the given secret.
    pub fn new(secret: &str) -> Self {
        Self {
            encoding_key: EncodingKey::from_secret(secret.as_bytes()),
            decoding_key: DecodingKey::from_secret(secret.as_bytes()),
        }
    }

    /// Encode claims into a JWT token.
    pub fn encode(&self, claims: &Claims) -> Result<String, jsonwebtoken::errors::Error> {
        encode(&Header::default(), claims, &self.encoding_key)
    }

    /// Decode and validate a JWT token.
    pub fn decode(&self, token: &str) -> Result<TokenData<Claims>, jsonwebtoken::errors::Error> {
        let mut validation = Validation::default();
        validation.validate_exp = true;

        decode::<Claims>(token, &self.decoding_key, &validation)
    }

    /// Create a new access token for a user.
    pub fn create_access_token(
        &self,
        user_id: &str,
        email: &str,
        session_id: &str,
        device_id: &str,
    ) -> Result<String, jsonwebtoken::errors::Error> {
        // Access tokens expire in 24 hours
        let claims = Claims::new(user_id, email, session_id, device_id, 24);
        self.encode(&claims)
    }

    /// Create a new refresh token for a user.
    pub fn create_refresh_token(
        &self,
        user_id: &str,
        email: &str,
        session_id: &str,
        device_id: &str,
    ) -> Result<String, jsonwebtoken::errors::Error> {
        // Refresh tokens expire in 30 days
        let claims = Claims::new(user_id, email, session_id, device_id, 24 * 30);
        self.encode(&claims)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_jwt_roundtrip() {
        let manager = JwtManager::new("test-secret");
        let claims = Claims::new("user-123", "test@example.com", "session-456", "device-789", 24);

        let token = manager.encode(&claims).unwrap();
        let decoded = manager.decode(&token).unwrap();

        assert_eq!(decoded.claims.sub, "user-123");
        assert_eq!(decoded.claims.email, "test@example.com");
        assert_eq!(decoded.claims.session_id, "session-456");
        assert_eq!(decoded.claims.device_id, "device-789");
    }
}
