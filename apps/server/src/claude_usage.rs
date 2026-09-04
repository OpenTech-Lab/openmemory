//! Reads the local Claude Code OAuth credentials file (never over the wire,
//! never logged) and fetches account-level plan/usage facts from Anthropic's
//! `oauth/usage` endpoint. Nothing in this module's return values may ever
//! contain `access_token` or `refresh_token` — callers in main.rs must only
//! ever forward the output of `summarize()` to the browser.

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result};
use serde::Deserialize;

/// Expand a leading `~` using `OPENMEMORY_HOME_DIR` (falling back to `HOME`),
/// then walk the path's ancestors looking for a component named exactly
/// `.claude`. Returns `Some(<.claude ancestor>/.credentials.json)` if found,
/// `None` otherwise (e.g. `~/.gemini`, `~/.codex`, or any path with no
/// `.claude` component).
pub(crate) fn credentials_path_for(
    agent_path: &str,
    resolve_user_path: impl Fn(&str) -> PathBuf,
) -> Option<PathBuf> {
    let expanded = resolve_user_path(agent_path);
    for ancestor in expanded.ancestors() {
        if ancestor
            .file_name()
            .map(|n| n == ".claude")
            .unwrap_or(false)
        {
            return Some(ancestor.join(".credentials.json"));
        }
    }
    None
}

#[derive(Deserialize)]
struct CredentialsFile {
    #[serde(rename = "claudeAiOauth")]
    claude_ai_oauth: ClaudeAiOauth,
}

#[derive(Deserialize)]
struct ClaudeAiOauth {
    #[serde(rename = "accessToken")]
    access_token: String,
    #[serde(rename = "expiresAt")]
    expires_at: i64,
    #[serde(rename = "subscriptionType", default)]
    subscription_type: Option<String>,
    #[serde(rename = "rateLimitTier", default)]
    rate_limit_tier: Option<String>,
}

/// Account facts read from the local credentials file. `access_token` never
/// leaves the scope of the function that produced it (`read_oauth` and its
/// direct caller in main.rs, which passes only `.access_token` into
/// `fetch_usage` and never into a response body).
pub(crate) struct OauthCreds {
    pub access_token: String,
    pub expires_at: i64,
    pub subscription_type: Option<String>,
    pub rate_limit_tier: Option<String>,
}

pub(crate) fn read_oauth(path: &Path) -> Result<OauthCreds> {
    let raw = std::fs::read_to_string(path).context("reading credentials file")?;
    let parsed: CredentialsFile = serde_json::from_str(&raw).context("parsing credentials file")?;
    Ok(OauthCreds {
        access_token: parsed.claude_ai_oauth.access_token,
        expires_at: parsed.claude_ai_oauth.expires_at,
        subscription_type: parsed.claude_ai_oauth.subscription_type,
        rate_limit_tier: parsed.claude_ai_oauth.rate_limit_tier,
    })
}

pub(crate) async fn fetch_usage(token: &str, timeout: Duration) -> Result<serde_json::Value> {
    let client = reqwest::Client::builder().timeout(timeout).build()?;

    let resp = client
        .get("https://api.anthropic.com/api/oauth/usage")
        .header("Authorization", format!("Bearer {}", token))
        .header("Accept", "application/json")
        .header("Content-Type", "application/json")
        .header("anthropic-beta", "oauth-2025-04-20")
        .send()
        .await?;

    let status = resp.status();
    let text = resp.text().await?;

    if !status.is_success() {
        let preview = &text[..text.len().min(300)];
        anyhow::bail!("oauth/usage returned {status}: {preview}");
    }

    let json: serde_json::Value = serde_json::from_str(&text)?;
    Ok(json)
}

/// Flatten the raw Anthropic response plus the locally-known plan facts into
/// the browser-facing schema. Never includes `access_token`/`refresh_token`.
pub(crate) fn summarize(oauth: &OauthCreds, raw: &serde_json::Value) -> serde_json::Value {
    let five_hour = serde_json::json!({
        "utilization": raw.get("five_hour").and_then(|v| v.get("utilization")).cloned().unwrap_or(serde_json::Value::Null),
        "resets_at": raw.get("five_hour").and_then(|v| v.get("resets_at")).cloned().unwrap_or(serde_json::Value::Null),
    });
    let seven_day = serde_json::json!({
        "utilization": raw.get("seven_day").and_then(|v| v.get("utilization")).cloned().unwrap_or(serde_json::Value::Null),
        "resets_at": raw.get("seven_day").and_then(|v| v.get("resets_at")).cloned().unwrap_or(serde_json::Value::Null),
    });

    let spend = raw.get("spend").filter(|v| !v.is_null());
    let extra = raw.get("extra_usage").filter(|v| !v.is_null());

    let extra_usage = if let Some(spend) = spend {
        Some(serde_json::json!({
            "enabled": spend.get("enabled").cloned().unwrap_or(serde_json::Value::Null),
            "utilization": spend.get("percent").cloned().unwrap_or(serde_json::Value::Null),
            "used_minor": spend.get("used").and_then(|v| v.get("amount_minor")).cloned().unwrap_or(serde_json::Value::Null),
            "limit_minor": spend.get("limit").and_then(|v| v.get("amount_minor")).cloned().unwrap_or(serde_json::Value::Null),
            "currency": spend.get("used").and_then(|v| v.get("currency")).cloned().unwrap_or(serde_json::json!("USD")),
            // Anthropic nests `exponent` under `used`/`limit`, not at the top
            // level of `spend` — prefer `used.exponent`, fall back to
            // `limit.exponent`.
            "exponent": spend.get("used").and_then(|v| v.get("exponent"))
                .or_else(|| spend.get("limit").and_then(|v| v.get("exponent")))
                .cloned().unwrap_or(serde_json::Value::Null),
            "severity": spend.get("severity").cloned().unwrap_or(serde_json::Value::Null),
        }))
    } else if let Some(extra) = extra {
        Some(serde_json::json!({
            "enabled": extra.get("is_enabled").cloned().unwrap_or(serde_json::Value::Null),
            "utilization": extra.get("utilization").cloned().unwrap_or(serde_json::Value::Null),
            "used_minor": extra.get("used_credits").cloned().unwrap_or(serde_json::Value::Null),
            "limit_minor": extra.get("monthly_limit").cloned().unwrap_or(serde_json::Value::Null),
            "currency": extra.get("currency").cloned().unwrap_or(serde_json::Value::Null),
            "exponent": extra.get("decimal_places").cloned().unwrap_or(serde_json::Value::Null),
            "severity": serde_json::Value::Null,
        }))
    } else {
        None
    };

    serde_json::json!({
        "supported": true,
        "state": "ok",
        "message": serde_json::Value::Null,
        "plan": oauth.subscription_type,
        "rate_limit_tier": oauth.rate_limit_tier,
        "five_hour": five_hour,
        "seven_day": seven_day,
        "extra_usage": extra_usage,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_resolve(p: &str) -> PathBuf {
        if let Some(rest) = p.strip_prefix("~/") {
            PathBuf::from("/home/tester").join(rest)
        } else if p == "~" {
            PathBuf::from("/home/tester")
        } else {
            PathBuf::from(p)
        }
    }

    #[test]
    fn credentials_path_for_claude_agent() {
        let got = credentials_path_for("~/.claude/projects", fake_resolve);
        assert_eq!(
            got,
            Some(PathBuf::from("/home/tester/.claude/.credentials.json"))
        );
    }

    #[test]
    fn credentials_path_for_claude_root() {
        let got = credentials_path_for("~/.claude", fake_resolve);
        assert_eq!(
            got,
            Some(PathBuf::from("/home/tester/.claude/.credentials.json"))
        );
    }

    #[test]
    fn credentials_path_for_gemini_agent_is_none() {
        let got = credentials_path_for("~/.gemini/projects", fake_resolve);
        assert_eq!(got, None);
    }

    #[test]
    fn credentials_path_for_codex_agent_is_none() {
        let got = credentials_path_for("~/.codex", fake_resolve);
        assert_eq!(got, None);
    }

    #[test]
    fn credentials_path_for_no_claude_component_is_none() {
        let got = credentials_path_for("/var/lib/some/other/path", fake_resolve);
        assert_eq!(got, None);
    }

    #[test]
    fn read_oauth_parses_documented_shape() {
        let dir = std::env::temp_dir().join(format!("claude_usage_test_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(".credentials.json");
        std::fs::write(
            &path,
            r#"{
                "mcpOAuth": {},
                "claudeAiOauth": {
                    "accessToken": "sk-fake-token",
                    "refreshToken": "sk-fake-refresh",
                    "expiresAt": 1234567890000,
                    "refreshTokenExpiresAt": 1234567890000,
                    "scopes": ["user:inference"],
                    "subscriptionType": "pro",
                    "rateLimitTier": "default"
                }
            }"#,
        )
        .unwrap();

        let creds = read_oauth(&path).expect("should parse");
        assert_eq!(creds.access_token, "sk-fake-token");
        assert_eq!(creds.expires_at, 1234567890000);
        assert_eq!(creds.subscription_type.as_deref(), Some("pro"));
        assert_eq!(creds.rate_limit_tier.as_deref(), Some("default"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn read_oauth_errors_cleanly_on_malformed_json() {
        let dir = std::env::temp_dir().join(format!("claude_usage_test_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(".credentials.json");
        std::fs::write(&path, "not json at all").unwrap();

        let result = read_oauth(&path);
        assert!(result.is_err());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn read_oauth_errors_cleanly_on_missing_key() {
        let dir = std::env::temp_dir().join(format!("claude_usage_test_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(".credentials.json");
        std::fs::write(&path, r#"{"mcpOAuth": {}}"#).unwrap();

        let result = read_oauth(&path);
        assert!(result.is_err());

        std::fs::remove_dir_all(&dir).ok();
    }

    fn fake_oauth() -> OauthCreds {
        OauthCreds {
            access_token: "unused".to_string(),
            expires_at: 0,
            subscription_type: Some("pro".to_string()),
            rate_limit_tier: Some("default".to_string()),
        }
    }

    #[test]
    fn summarize_prefers_spend_over_extra_usage() {
        let raw = serde_json::json!({
            "five_hour": { "utilization": 61.0, "resets_at": "2026-08-06T04:30:00Z" },
            "seven_day": { "utilization": 6.0, "resets_at": "2026-08-12T21:00:00Z" },
            "extra_usage": {
                "is_enabled": true, "monthly_limit": 5000, "used_credits": 4804.0,
                "utilization": 96.0, "currency": "USD", "decimal_places": 2
            },
            "spend": {
                "used": { "amount_minor": 4900, "currency": "USD", "exponent": 2 },
                "limit": { "amount_minor": 5000, "currency": "USD", "exponent": 2 },
                "percent": 98.0, "severity": "critical", "enabled": true
            }
        });
        let out = summarize(&fake_oauth(), &raw);
        let extra = &out["extra_usage"];
        assert_eq!(extra["used_minor"], serde_json::json!(4900));
        assert_eq!(extra["utilization"], serde_json::json!(98.0));
        assert_eq!(extra["severity"], serde_json::json!("critical"));
        assert_eq!(extra["exponent"], serde_json::json!(2));
    }

    #[test]
    fn summarize_falls_back_to_extra_usage_when_spend_absent() {
        let raw = serde_json::json!({
            "five_hour": { "utilization": 61.0, "resets_at": "2026-08-06T04:30:00Z" },
            "seven_day": { "utilization": 6.0, "resets_at": "2026-08-12T21:00:00Z" },
            "extra_usage": {
                "is_enabled": true, "monthly_limit": 5000, "used_credits": 4804.0,
                "utilization": 96.0, "currency": "USD", "decimal_places": 2
            },
            "spend": null
        });
        let out = summarize(&fake_oauth(), &raw);
        let extra = &out["extra_usage"];
        assert_eq!(extra["used_minor"], serde_json::json!(4804.0));
        assert_eq!(extra["utilization"], serde_json::json!(96.0));
        assert_eq!(extra["currency"], serde_json::json!("USD"));
    }
}
