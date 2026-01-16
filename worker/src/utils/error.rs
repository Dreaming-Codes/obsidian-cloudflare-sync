//! Error types for consistent API error responses.

use serde::Serialize;
use worker::*;

use super::response::json_response;

/// Structured API error response.
#[derive(Debug, Serialize)]
pub struct ApiError {
    pub error: ApiErrorDetail,
}

/// Detail fields for an API error.
#[derive(Debug, Serialize)]
pub struct ApiErrorDetail {
    pub code: String,
    pub message: String,
    pub status: u16,
}

impl ApiError {
    /// Create a new API error with the given code, message, and status.
    pub fn new(code: &str, message: &str, status: u16) -> Self {
        Self {
            error: ApiErrorDetail {
                code: code.to_string(),
                message: message.to_string(),
                status,
            },
        }
    }

    /// Create a 400 Bad Request error.
    #[allow(dead_code)]
    pub fn bad_request(message: &str) -> Self {
        Self::new("BAD_REQUEST", message, 400)
    }

    /// Create a 401 Unauthorized error.
    #[allow(dead_code)]
    pub fn unauthorized(message: &str) -> Self {
        Self::new("UNAUTHORIZED", message, 401)
    }

    /// Create a 403 Forbidden error.
    #[allow(dead_code)]
    pub fn forbidden(message: &str) -> Self {
        Self::new("FORBIDDEN", message, 403)
    }

    /// Create a 404 Not Found error.
    pub fn not_found(message: &str) -> Self {
        Self::new("NOT_FOUND", message, 404)
    }

    /// Create a 409 Conflict error.
    #[allow(dead_code)]
    pub fn conflict(message: &str) -> Self {
        Self::new("CONFLICT", message, 409)
    }

    /// Create a 500 Internal Server Error.
    pub fn internal(message: &str) -> Self {
        Self::new("INTERNAL_ERROR", message, 500)
    }

    /// Convert this error into an HTTP Response.
    pub fn into_response(self) -> Result<Response> {
        let status = self.error.status;
        json_response(&self, status)
    }
}

/// Application-level error types.
#[derive(Debug, thiserror::Error)]
#[allow(dead_code)]
pub enum AppError {
    #[error("Unauthorized: {0}")]
    Unauthorized(String),

    #[error("Forbidden: {0}")]
    Forbidden(String),

    #[error("Not found: {0}")]
    NotFound(String),

    #[error("Bad request: {0}")]
    BadRequest(String),

    #[error("Conflict: {0}")]
    Conflict(String),

    #[error("Internal error: {0}")]
    Internal(String),

    #[error("Worker error: {0}")]
    Worker(#[from] worker::Error),
}

impl AppError {
    /// Convert this error into an API error response.
    #[allow(dead_code)]
    pub fn into_response(self) -> Result<Response> {
        let api_error = match self {
            AppError::Unauthorized(msg) => ApiError::unauthorized(&msg),
            AppError::Forbidden(msg) => ApiError::forbidden(&msg),
            AppError::NotFound(msg) => ApiError::not_found(&msg),
            AppError::BadRequest(msg) => ApiError::bad_request(&msg),
            AppError::Conflict(msg) => ApiError::conflict(&msg),
            AppError::Internal(msg) => ApiError::internal(&msg),
            AppError::Worker(e) => ApiError::internal(&e.to_string()),
        };
        api_error.into_response()
    }
}
