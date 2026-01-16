//! Resend email API client for sending magic link emails.

use serde::{Deserialize, Serialize};
use worker::*;

/// Request body for Resend API.
#[derive(Debug, Serialize)]
struct ResendEmailRequest<'a> {
    from: &'a str,
    to: Vec<&'a str>,
    subject: &'a str,
    html: String,
}

/// Response from Resend API.
#[derive(Debug, Deserialize)]
pub struct ResendEmailResponse {
    pub id: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

/// Resend email client.
pub struct ResendClient {
    api_key: String,
    from_email: String,
    base_url: String,
}

impl ResendClient {
    /// Create a new Resend client.
    pub fn new(api_key: String, from_email: String, base_url: String) -> Self {
        Self {
            api_key,
            from_email,
            base_url,
        }
    }

    /// Create a Resend client from environment variables.
    pub fn from_env(env: &Env) -> Result<Self> {
        let api_key = env.secret("RESEND_API_KEY")?.to_string();
        let base_url = env.var("BASE_URL")?.to_string();
        let from_email = env
            .var("FROM_EMAIL")
            .map(|v| v.to_string())
            .unwrap_or_else(|_| "Cloudflare Sync <noreply@elysiumcraftrp.org>".to_string());

        Ok(Self::new(api_key, from_email, base_url))
    }

    /// Send a magic link email to the given address.
    pub async fn send_magic_link(&self, email: &str, token: &str) -> Result<ResendEmailResponse> {
        let verify_url = format!("{}/auth/verify?token={}", self.base_url, token);

        let html = format!(
            r#"<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 20px; max-width: 600px; margin: 0 auto;">
    <h1 style="color: #333;">Sign in to Cloudflare Sync</h1>
    <p style="color: #666; font-size: 16px; line-height: 1.5;">
        Click the button below to sign in to your account. This link will expire in 15 minutes.
    </p>
    <a href="{}" style="display: inline-block; background-color: #0070f3; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 500; margin: 20px 0;">
        Sign in
    </a>
    <p style="color: #999; font-size: 14px;">
        If you didn't request this email, you can safely ignore it.
    </p>
    <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
    <p style="color: #999; font-size: 12px;">
        If the button doesn't work, copy and paste this link into your browser:<br>
        <a href="{}" style="color: #0070f3;">{}</a>
    </p>
</body>
</html>"#,
            verify_url, verify_url, verify_url
        );

        let request_body = ResendEmailRequest {
            from: &self.from_email,
            to: vec![email],
            subject: "Sign in to Cloudflare Sync",
            html,
        };

        let body = serde_json::to_string(&request_body)
            .map_err(|e| Error::RustError(format!("Failed to serialize request: {}", e)))?;

        let headers = Headers::new();
        headers.set("Authorization", &format!("Bearer {}", self.api_key))?;
        headers.set("Content-Type", "application/json")?;

        let mut init = RequestInit::new();
        init.with_method(Method::Post)
            .with_headers(headers)
            .with_body(Some(body.into()));

        let request = Request::new_with_init("https://api.resend.com/emails", &init)?;
        let mut response = Fetch::Request(request).send().await?;

        let response_text = response.text().await?;

        serde_json::from_str(&response_text)
            .map_err(|e| Error::RustError(format!("Failed to parse Resend response: {}", e)))
    }
}
