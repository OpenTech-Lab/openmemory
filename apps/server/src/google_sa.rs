//! Google service-account access-token minting, shared by the MCP
//! `env_google_service_account_request` tool and workflow http steps
//! (`auth_mode: "google_service_account"`). The service-account key, the signed
//! assertion and the access token stay inside the server process; callers use
//! the token for one outbound request and never return it.

use anyhow::{Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use serde_json::{json, Value};

const DEFAULT_TOKEN_URI: &str = "https://oauth2.googleapis.com/token";

/// The fields of a GCP service-account key file that the token exchange needs.
pub struct ServiceAccountKey {
    client_email: String,
    private_key_pem: String,
    token_uri: String,
}

// Hand-written so a stray `{:?}` can never print the private key.
impl std::fmt::Debug for ServiceAccountKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ServiceAccountKey")
            .field("client_email", &self.client_email)
            .field("private_key_pem", &"<redacted>")
            .field("token_uri", &self.token_uri)
            .finish()
    }
}

/// Parse the stored secret value: a service-account JSON key file uploaded via
/// `env_set_file`, which is stored base64-encoded.
pub fn parse_service_account(stored: &str) -> Result<ServiceAccountKey> {
    let decoded = STANDARD.decode(stored.trim()).context(
        "stored value isn't valid base64 (expected a file uploaded via env_set_file)",
    )?;
    let sa_json: Value = serde_json::from_slice(&decoded)
        .context("decoded file isn't valid JSON (expected a GCP service account key file)")?;
    Ok(ServiceAccountKey {
        client_email: sa_json["client_email"]
            .as_str()
            .context("service account JSON missing client_email")?
            .to_string(),
        private_key_pem: sa_json["private_key"]
            .as_str()
            .context("service account JSON missing private_key")?
            .to_string(),
        token_uri: sa_json["token_uri"]
            .as_str()
            .unwrap_or(DEFAULT_TOKEN_URI)
            .to_string(),
    })
}

/// Sign the RS256 JWT-bearer assertion for Google's server-to-server OAuth2
/// flow. `now` is a unix timestamp (a parameter so tests are deterministic).
pub fn sign_assertion(sa: &ServiceAccountKey, scopes: &[String], now: i64) -> Result<String> {
    let claims = json!({
        "iss": sa.client_email,
        "scope": scopes.join(" "),
        "aud": sa.token_uri,
        "iat": now,
        "exp": now + 3600,
    });
    let encoding_key = EncodingKey::from_rsa_pem(sa.private_key_pem.as_bytes())
        .context("failed to parse service account private key (expected PEM)")?;
    encode(&Header::new(Algorithm::RS256), &claims, &encoding_key)
        .context("failed to sign service account JWT assertion")
}

/// Exchange a freshly signed assertion for a short-lived access token.
pub async fn mint_access_token(
    client: &reqwest::Client,
    stored_secret: &str,
    scopes: &[String],
) -> Result<String> {
    let sa = parse_service_account(stored_secret)?;
    let assertion = sign_assertion(&sa, scopes, chrono::Utc::now().timestamp())?;
    let token_response = client
        .post(&sa.token_uri)
        .form(&[
            ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
            ("assertion", assertion.as_str()),
        ])
        .send()
        .await
        .context("token exchange request failed")?;
    let token_status = token_response.status();
    let token_body: Value = token_response
        .json()
        .await
        .context("failed to parse token endpoint response")?;
    if !token_status.is_success() {
        anyhow::bail!(
            "Token exchange failed (HTTP {}): {}",
            token_status,
            token_body
        );
    }
    Ok(token_body["access_token"]
        .as_str()
        .context("token endpoint response missing access_token")?
        .to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;

    // Throwaway 2048-bit RSA key generated for these tests only; it signs
    // nothing real.
    const TEST_KEY_PEM: &str = include_str!("../tests/fixtures/test_rsa_private.pem");

    fn stored(sa: &Value) -> String {
        STANDARD.encode(sa.to_string())
    }

    #[test]
    fn parses_base64_service_account_and_defaults_token_uri() {
        let sa = parse_service_account(&stored(&json!({
            "client_email": "agent@example.iam.gserviceaccount.com",
            "private_key": "pem",
        })))
        .unwrap();
        assert_eq!(sa.client_email, "agent@example.iam.gserviceaccount.com");
        assert_eq!(sa.token_uri, DEFAULT_TOKEN_URI);
    }

    #[test]
    fn rejects_non_base64_and_missing_fields() {
        assert!(parse_service_account("not base64 !!")
            .unwrap_err()
            .to_string()
            .contains("base64"));
        assert!(parse_service_account(&stored(&json!({"private_key": "x"})))
            .unwrap_err()
            .to_string()
            .contains("client_email"));
        assert!(parse_service_account(&stored(&json!({"client_email": "x"})))
            .unwrap_err()
            .to_string()
            .contains("private_key"));
    }

    #[test]
    fn signs_rs256_assertion_with_scopes_audience_and_expiry() {
        let sa = parse_service_account(&stored(&json!({
            "client_email": "agent@example.iam.gserviceaccount.com",
            "private_key": TEST_KEY_PEM,
            "token_uri": "https://oauth2.example/token",
        })))
        .unwrap();
        let scopes = vec!["scope-a".to_string(), "scope-b".to_string()];
        let jwt = sign_assertion(&sa, &scopes, 1_000).unwrap();
        let parts: Vec<&str> = jwt.split('.').collect();
        assert_eq!(parts.len(), 3);
        let header: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[0]).unwrap()).unwrap();
        let claims: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap();
        assert_eq!(header["alg"], "RS256");
        assert_eq!(claims["iss"], "agent@example.iam.gserviceaccount.com");
        assert_eq!(claims["scope"], "scope-a scope-b");
        assert_eq!(claims["aud"], "https://oauth2.example/token");
        assert_eq!(claims["exp"], 4_600);
    }

    #[test]
    fn bad_private_key_is_an_error_not_a_panic() {
        let sa = parse_service_account(&stored(&json!({
            "client_email": "x",
            "private_key": "-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----",
        })))
        .unwrap();
        assert!(sign_assertion(&sa, &[], 0).is_err());
    }
}
