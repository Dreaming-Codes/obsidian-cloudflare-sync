//! JSON response helper for consistent API responses.

use serde::Serialize;
use worker::*;

/// Create a JSON response with the given data and status code.
#[allow(dead_code)]
pub fn json_response<T: Serialize>(data: &T, status: u16) -> Result<Response> {
    let body = serde_json::to_string(data).map_err(|e| Error::RustError(e.to_string()))?;

    Response::from_body(ResponseBody::Body(body.into_bytes()))
        .map(|resp| resp.with_status(status))
        .map(|resp| {
            resp.with_headers({
                let headers = Headers::new();
                let _ = headers.set("Content-Type", "application/json");
                headers
            })
        })
}

/// Create a JSON success response (200 OK).
pub fn json_ok<T: Serialize>(data: &T) -> Result<Response> {
    json_response(data, 200)
}

/// Create a JSON created response (201 Created).
#[allow(dead_code)]
pub fn json_created<T: Serialize>(data: &T) -> Result<Response> {
    json_response(data, 201)
}

/// Create a 204 No Content response.
#[allow(dead_code)]
pub fn no_content() -> Result<Response> {
    Response::empty().map(|resp| resp.with_status(204))
}
