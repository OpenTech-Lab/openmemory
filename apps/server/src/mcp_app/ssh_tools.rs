//! `env_ssh_execute` — run a shell command on a remote host over SSH,
//! entirely server-side. The private key and username are resolved from
//! encrypted env params and used to authenticate; only stdout/stderr/exit
//! code are returned to the agent, never the credential.
//!
//! This is materially more dangerous than the HTTP proxy tools in
//! `env_tools.rs` (remote code execution, not just an authenticated fetch),
//! so three independent safety gates run before the private key is ever
//! used to authenticate to anything:
//!
//! 1. Global allowlist `OPENMEMORY_SSH_ALLOWED_HOSTS`, fail-closed (unset or
//!    empty refuses every host — the opposite default from the HTTP tools'
//!    `OPENMEMORY_HTTP_ALLOWED_HOSTS`, since this tool can run arbitrary
//!    commands rather than just fetch a URL). No secret is touched yet.
//! 2. Per-secret host binding via a `<ssh_key_key>.allowed_hosts` env param.
//!    Still no secret touched (this param is metadata, not the key).
//! 3. Host key pinning via a `<ssh_key_key>.host_key_fingerprint` env param,
//!    enforced inside the SSH handshake's `check_server_key` — so a
//!    compromised or unpinned host is rejected before the private key is
//!    ever used to authenticate. (The key material *is* decrypted server-side
//!    just before this step, so a bad `ssh_key_key` fails immediately without
//!    a network attempt — but nothing derived from it leaves the process
//!    until `authenticate_publickey`, which only runs once this gate has
//!    already passed.)
//!
//! Logging discipline: never log the command, username, or key material —
//! only `host:port`.

use super::*;

use russh::client;
use russh::keys::{decode_secret_key, HashAlg, PrivateKeyWithHashAlg};
use russh::{ChannelMsg, Disconnect};
use std::sync::Arc;
use std::time::Duration;

const DEFAULT_TIMEOUT_SECS: u64 = 30;
const MAX_TIMEOUT_SECS: u64 = 300;
const MAX_OUTPUT_BYTES: usize = 100 * 1024;

/// Parse a comma-separated allowlist (`OPENMEMORY_SSH_ALLOWED_HOSTS` or a
/// `.allowed_hosts` env param) into normalized `(host, Some(port))` /
/// `(host, None)` entries. `None` for the port means "any port matches".
fn parse_allowlist(raw: &str) -> Vec<(String, Option<u16>)> {
    raw.split(',')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|entry| {
            let lower = entry.to_lowercase();
            if let Some((h, p)) = lower.rsplit_once(':') {
                if let Ok(port) = p.parse::<u16>() {
                    return (h.to_string(), Some(port));
                }
            }
            (lower, None)
        })
        .collect()
}

/// Whether `host:port` matches any entry in an already-parsed allowlist.
fn host_in_allowlist(entries: &[(String, Option<u16>)], host: &str, port: u16) -> bool {
    let host = host.to_lowercase();
    entries
        .iter()
        .any(|(h, p)| *h == host && p.is_none_or(|p| p == port))
}

/// PEM-formatted keys are used as-is; anything else is assumed to be the
/// base64 wrapping `env_set_file` applies so binary/text uploads round-trip
/// safely (mirrors the same convention `sign_jwt_from_args` uses for
/// `key_from_file`).
fn is_pem_key(raw: &str) -> bool {
    raw.trim_start().starts_with("-----BEGIN")
}

/// Auto-detect and normalize stored key material to raw PEM text.
fn decode_key_material(raw: &str) -> Result<String> {
    let trimmed = raw.trim();
    if is_pem_key(trimmed) {
        Ok(trimmed.to_string())
    } else {
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        let decoded = STANDARD.decode(trimmed).context(
            "ssh_key_key value is neither a PEM-formatted key nor valid base64",
        )?;
        String::from_utf8(decoded).context("decoded key material is not valid UTF-8 text")
    }
}

/// Accumulates output up to `cap` bytes, dropping (and flagging) anything
/// beyond that instead of growing unbounded for a chatty/misbehaving remote.
struct CappedBuffer {
    data: Vec<u8>,
    truncated: bool,
    cap: usize,
}

impl CappedBuffer {
    fn new(cap: usize) -> Self {
        Self {
            data: Vec::new(),
            truncated: false,
            cap,
        }
    }

    fn push(&mut self, chunk: &[u8]) {
        if self.data.len() >= self.cap {
            if !chunk.is_empty() {
                self.truncated = true;
            }
            return;
        }
        let remaining = self.cap - self.data.len();
        if chunk.len() > remaining {
            self.data.extend_from_slice(&chunk[..remaining]);
            self.truncated = true;
        } else {
            self.data.extend_from_slice(chunk);
        }
    }

    fn into_text(self) -> String {
        let mut text = String::from_utf8_lossy(&self.data).into_owned();
        if self.truncated {
            text.push_str(&format!(
                "\n... [truncated, output exceeded {} bytes]",
                self.cap
            ));
        }
        text
    }
}

/// Compares the server's SHA256 host key fingerprint against the pinned
/// value. No secret is in scope here — only the connection's host key.
fn fingerprints_match(expected: &str, actual: &str) -> bool {
    expected.trim() == actual.trim()
}

/// SSH client handler. Enforces host key pinning (gate 3) inside the
/// handshake itself, before `env_ssh_execute` ever decrypts the private key.
struct SshHandler {
    expected_fingerprint: Option<String>,
    allow_unknown: bool,
}

impl client::Handler for SshHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        let actual = server_public_key.fingerprint(HashAlg::Sha256).to_string();
        let ok = match &self.expected_fingerprint {
            Some(expected) => fingerprints_match(expected, &actual),
            None => self.allow_unknown,
        };
        Ok(ok)
    }
}

impl McpServer {
    /// Look up an env param by key and decrypt it, without failing when the
    /// param doesn't exist. Used for the optional `.allowed_hosts` /
    /// `.host_key_fingerprint` metadata params, as opposed to
    /// `resolve_env_secret` (env_tools.rs) which bails when the key it's
    /// asked for is missing — appropriate for the actual credential, not for
    /// this optional per-key configuration.
    async fn lookup_optional_param(&self, key: &str) -> Result<Option<String>> {
        let row: Option<(Vec<u8>, bool)> =
            sqlx::query_as("SELECT value_encrypted, is_secret FROM env_params WHERE key = $1")
                .bind(key)
                .fetch_optional(&self.db)
                .await
                .context("failed to query env param")?;

        match row {
            None => Ok(None),
            Some((encrypted, _)) => {
                let value = decrypt_value(&self.encryption_key, &encrypted)
                    .context("failed to decrypt env param")?;
                Ok(Some(value))
            }
        }
    }

    pub(super) async fn env_ssh_execute(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let host = args["host"].as_str().context("missing host")?.to_string();
        let port = args["port"].as_u64().unwrap_or(22).clamp(1, 65535) as u16;
        let ssh_key_key = args["ssh_key_key"]
            .as_str()
            .context("missing ssh_key_key")?
            .to_string();
        let username_key = args["username_key"].as_str();
        let username_literal = args["username"].as_str();
        let command = args["command"]
            .as_str()
            .context("missing command")?
            .to_string();
        let passphrase_key = args["passphrase_key"].as_str();
        let timeout_secs = args["timeout_seconds"]
            .as_u64()
            .unwrap_or(DEFAULT_TIMEOUT_SECS)
            .clamp(1, MAX_TIMEOUT_SECS);

        match (username_key, username_literal) {
            (Some(_), Some(_)) => {
                anyhow::bail!("provide exactly one of username_key or username, not both")
            }
            (None, None) => {
                anyhow::bail!("missing username — provide exactly one of username_key or username")
            }
            _ => {}
        }

        // --- Gate 1: global allowlist, fail-closed. -------------------------
        let global_allowed = std::env::var("OPENMEMORY_SSH_ALLOWED_HOSTS").unwrap_or_default();
        let global_entries = parse_allowlist(&global_allowed);
        if global_entries.is_empty() {
            anyhow::bail!(
                "OPENMEMORY_SSH_ALLOWED_HOSTS is not set (or empty) on the openmemory-mcp \
                 process — env_ssh_execute refuses every host by default. Set it to a \
                 comma-separated allowlist (e.g. \"dev-01.example.com\" or \
                 \"dev-01.example.com:22\") and restart the process to enable this tool."
            );
        }
        if !host_in_allowlist(&global_entries, &host, port) {
            anyhow::bail!(
                "Host '{}:{}' is not in OPENMEMORY_SSH_ALLOWED_HOSTS — refused before any secret was touched",
                host,
                port
            );
        }

        // --- Gate 2: per-secret host binding. --------------------------------
        let allowed_hosts_key = format!("{}.allowed_hosts", ssh_key_key);
        if let Some(raw) = self.lookup_optional_param(&allowed_hosts_key).await? {
            let entries = parse_allowlist(&raw);
            if !entries.is_empty() && !host_in_allowlist(&entries, &host, port) {
                anyhow::bail!(
                    "Host '{}:{}' is not in '{}' — this key is restricted to a different host set",
                    host,
                    port,
                    allowed_hosts_key
                );
            }
        }

        // --- Gate 3 (prep): host key pinning, enforced during the handshake
        // below via check_server_key — before the private key is decrypted. --
        let fingerprint_key = format!("{}.host_key_fingerprint", ssh_key_key);
        let expected_fingerprint = self.lookup_optional_param(&fingerprint_key).await?;
        let allow_unknown =
            std::env::var("OPENMEMORY_SSH_ALLOW_UNKNOWN_HOST_KEY").as_deref() == Ok("1");
        if expected_fingerprint.is_none() && !allow_unknown {
            anyhow::bail!(
                "No pinned host key for '{}' — set '{}' via env_set to the output of \
                 `ssh-keyscan -t ed25519,rsa {} | ssh-keygen -lf -` (or set \
                 OPENMEMORY_SSH_ALLOW_UNKNOWN_HOST_KEY=1 on the openmemory-mcp process to \
                 bypass this for first-time setup — not recommended once the host is trusted)",
                ssh_key_key,
                fingerprint_key,
                host
            );
        }

        tracing::info!("env_ssh_execute: connecting to {}:{}", host, port);

        let result = tokio::time::timeout(
            Duration::from_secs(timeout_secs),
            self.run_ssh_command(
                &host,
                port,
                username_key,
                username_literal,
                &ssh_key_key,
                passphrase_key,
                &command,
                expected_fingerprint,
                allow_unknown,
            ),
        )
        .await;

        // Propagate the inner error as-is (rather than wrapping it in an
        // outer .context()) — the error surfaces to the agent via
        // anyhow::Error::to_string(), which only prints the outermost
        // frame, and the inner errors (e.g. "Secret '...' not found in env
        // params", "ssh authentication failed") are already specific enough
        // to act on.
        let (exit_code, stdout, stderr) = match result {
            Ok(inner) => inner?,
            Err(_) => anyhow::bail!(
                "env_ssh_execute timed out after {}s against {}:{}",
                timeout_secs,
                host,
                port
            ),
        };

        tracing::info!(
            "env_ssh_execute: {}:{} exited {}",
            host,
            port,
            exit_code
        );

        Ok(json!({
            "content": [{
                "type": "text",
                "text": format!(
                    "SSH exec on {}:{} — exit code {}\n\n--- stdout ---\n{}\n--- stderr ---\n{}",
                    host, port, exit_code, stdout, stderr
                )
            }],
            "isError": exit_code != 0
        }))
    }

    /// Resolves the credential and runs the command. Only called after gates
    /// 1 and 2 (host allowlists) have passed. The private key, username, and
    /// passphrase are decrypted here, *before* connecting — that's safe
    /// because nothing derived from the key is sent anywhere until
    /// `authenticate_publickey` below, which only runs after `connect()`
    /// (and thus gate 3's `check_server_key` pinning check) has already
    /// succeeded. Resolving credentials first (rather than after connecting)
    /// means a bad `ssh_key_key` fails immediately, with no network attempt,
    /// same as the other three gates.
    #[allow(clippy::too_many_arguments)]
    async fn run_ssh_command(
        &self,
        host: &str,
        port: u16,
        username_key: Option<&str>,
        username_literal: Option<&str>,
        ssh_key_key: &str,
        passphrase_key: Option<&str>,
        command: &str,
        expected_fingerprint: Option<String>,
        allow_unknown: bool,
    ) -> Result<(u32, String, String)> {
        let username = match username_key {
            Some(key) => self.resolve_env_secret(key).await?,
            None => username_literal
                .context("missing username")?
                .to_string(),
        };

        let key_material = self.resolve_env_secret(ssh_key_key).await?;
        let key_pem = decode_key_material(&key_material)?;

        let passphrase = match passphrase_key {
            Some(key) => Some(self.resolve_env_secret(key).await?),
            None => None,
        };

        let key_pair = decode_secret_key(&key_pem, passphrase.as_deref())
            .context("failed to parse private key material")?;

        let config = Arc::new(client::Config {
            inactivity_timeout: Some(Duration::from_secs(MAX_TIMEOUT_SECS)),
            ..<_>::default()
        });
        let handler = SshHandler {
            expected_fingerprint,
            allow_unknown,
        };

        // Host key is verified as part of connect() (via check_server_key,
        // gate 3) before the key material above is ever used to
        // authenticate — authenticate_publickey below only runs once this
        // has already succeeded.
        let mut handle = client::connect(config, (host, port), handler)
            .await
            .context("ssh connect / handshake failed")?;

        let hash_alg = handle
            .best_supported_rsa_hash()
            .await
            .context("failed to negotiate rsa signature hash algorithm")?
            .flatten();

        let auth_result = handle
            .authenticate_publickey(
                username,
                PrivateKeyWithHashAlg::new(Arc::new(key_pair), hash_alg),
            )
            .await
            .context("ssh authentication failed")?;

        if !auth_result.success() {
            anyhow::bail!("ssh authentication rejected by server");
        }

        // No PTY, no forwarding — a single non-interactive exec.
        let mut channel = handle
            .channel_open_session()
            .await
            .context("failed to open ssh channel")?;
        channel
            .exec(true, command)
            .await
            .context("failed to exec command")?;

        let mut stdout = CappedBuffer::new(MAX_OUTPUT_BYTES);
        let mut stderr = CappedBuffer::new(MAX_OUTPUT_BYTES);
        let mut exit_code: Option<u32> = None;

        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { data } => stdout.push(&data),
                ChannelMsg::ExtendedData { data, ext } if ext == 1 => stderr.push(&data),
                ChannelMsg::ExitStatus { exit_status } => exit_code = Some(exit_status),
                _ => {}
            }
        }

        handle
            .disconnect(Disconnect::ByApplication, "", "English")
            .await
            .ok();

        let code = exit_code.context("remote command did not report an exit status")?;
        Ok((code, stdout.into_text(), stderr.into_text()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_allowlist_handles_host_and_host_port_entries() {
        let entries = parse_allowlist(" Dev-01.example.com , 10.0.0.5:2222 ,, 192.168.1.1 ");
        assert_eq!(
            entries,
            vec![
                ("dev-01.example.com".to_string(), None),
                ("10.0.0.5".to_string(), Some(2222)),
                ("192.168.1.1".to_string(), None),
            ]
        );
    }

    #[test]
    fn parse_allowlist_empty_or_unset_yields_no_entries() {
        assert!(parse_allowlist("").is_empty());
        assert!(parse_allowlist("   ,  ,").is_empty());
    }

    #[test]
    fn host_in_allowlist_matches_bare_host_at_any_port() {
        let entries = parse_allowlist("dev-01.example.com");
        assert!(host_in_allowlist(&entries, "dev-01.example.com", 22));
        assert!(host_in_allowlist(&entries, "DEV-01.example.com", 2222));
        assert!(!host_in_allowlist(&entries, "other.example.com", 22));
    }

    #[test]
    fn host_in_allowlist_enforces_pinned_port() {
        let entries = parse_allowlist("dev-01.example.com:2222");
        assert!(host_in_allowlist(&entries, "dev-01.example.com", 2222));
        assert!(!host_in_allowlist(&entries, "dev-01.example.com", 22));
    }

    #[test]
    fn fingerprints_match_ignores_surrounding_whitespace_only() {
        assert!(fingerprints_match(
            " SHA256:abc123 \n",
            "SHA256:abc123"
        ));
        assert!(!fingerprints_match("SHA256:abc123", "SHA256:ABC123"));
        assert!(!fingerprints_match("SHA256:abc123", "SHA256:abc124"));
    }

    #[test]
    fn is_pem_key_detects_pem_header() {
        assert!(is_pem_key("-----BEGIN OPENSSH PRIVATE KEY-----\n..."));
        assert!(is_pem_key("  \n-----BEGIN RSA PRIVATE KEY-----\n..."));
        assert!(!is_pem_key("bm90IGEgcGVtIGtleQ=="));
    }

    #[test]
    fn decode_key_material_passes_pem_through_unchanged() {
        let pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----";
        assert_eq!(decode_key_material(pem).unwrap(), pem);
    }

    #[test]
    fn decode_key_material_decodes_base64_wrapped_key() {
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        let pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----";
        let wrapped = STANDARD.encode(pem);
        assert_eq!(decode_key_material(&wrapped).unwrap(), pem);
    }

    #[test]
    fn decode_key_material_rejects_garbage() {
        assert!(decode_key_material("not base64 or pem!!!").is_err());
    }

    #[test]
    fn capped_buffer_passes_through_short_output_untruncated() {
        let mut buf = CappedBuffer::new(10);
        buf.push(b"hello");
        assert_eq!(buf.into_text(), "hello");
    }

    #[test]
    fn capped_buffer_truncates_and_marks_output_over_cap() {
        let mut buf = CappedBuffer::new(5);
        buf.push(b"hello world");
        let text = buf.into_text();
        assert!(text.starts_with("hello"));
        assert!(text.contains("truncated"));
        assert!(text.contains("5 bytes"));
    }

    #[test]
    fn capped_buffer_truncates_across_multiple_chunks() {
        let mut buf = CappedBuffer::new(5);
        buf.push(b"he");
        buf.push(b"llo world");
        buf.push(b"more");
        let text = buf.into_text();
        assert!(text.starts_with("hello"));
        assert!(text.contains("truncated"));
    }
}
