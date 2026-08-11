use super::*;

impl McpServer {
    pub(super) async fn env_set(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let key = args["key"].as_str().context("missing key")?.to_string();
        let value = args["value"].as_str().context("missing value")?.to_string();
        let is_secret = args["is_secret"].as_bool().unwrap_or(false);
        let description = args["description"].as_str().map(|s| s.to_string());

        let encrypted = encrypt_value(&self.encryption_key, &value);
        let now = Utc::now();

        sqlx::query(
            r#"
            INSERT INTO env_params (key, value_encrypted, is_secret, description, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $5)
            ON CONFLICT (key) DO UPDATE SET
                value_encrypted = EXCLUDED.value_encrypted,
                description = COALESCE(EXCLUDED.description, env_params.description),
                updated_at = EXCLUDED.updated_at
            "#,
        )
        .bind(&key)
        .bind(&encrypted)
        .bind(is_secret)
        .bind(&description)
        .bind(now)
        .execute(&self.db)
        .await
        .context("failed to set env param")?;

        let type_label = if is_secret { "secret" } else { "normal" };
        Ok(json!({
            "content": [{
                "type": "text",
                "text": format!("Set {} parameter '{}'{}", type_label, key,
                    description.as_deref().map(|d| format!(" ({})", d)).unwrap_or_default())
            }]
        }))
    }

    pub(super) async fn env_rename(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let old_key = args["old_key"]
            .as_str()
            .context("missing old_key")?
            .trim()
            .to_string();
        let new_key = args["new_key"]
            .as_str()
            .context("missing new_key")?
            .trim()
            .to_string();
        let value = args.get("value").and_then(|value| value.as_str());
        let is_secret = args.get("is_secret").and_then(|value| value.as_bool());
        let description = args.get("description").map(|value| value.as_str());

        openmemory_server::env_params::rename_env_param(
            &self.db,
            &self.encryption_key,
            &old_key,
            &new_key,
            value,
            is_secret,
            description,
        )
        .await?;

        Ok(json!({
            "content": [{
                "type": "text",
                "text": format!("Renamed environment parameter '{}' to '{}'", old_key, new_key)
            }]
        }))
    }

    pub(super) async fn env_get(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let key = args["key"].as_str().context("missing key")?.to_string();

        let row: Option<(Vec<u8>, bool)> =
            sqlx::query_as("SELECT value_encrypted, is_secret FROM env_params WHERE key = $1")
                .bind(&key)
                .fetch_optional(&self.db)
                .await
                .context("failed to query env param")?;

        match row {
            None => anyhow::bail!("Parameter '{}' not found", key),
            Some((_, true)) => {
                // Secret params are blocked from agent reads — agents must call env_list
                // to confirm the key exists, then use it indirectly (e.g. pass to a tool)
                Ok(json!({
                    "content": [{
                        "type": "text",
                        "text": format!("'{}' is a secret parameter — its value cannot be read by agents. Use env_list to confirm it exists.", key)
                    }],
                    "isError": true
                }))
            }
            Some((encrypted, false)) => {
                let value = decrypt_value(&self.encryption_key, &encrypted)
                    .context("failed to decrypt parameter")?;
                Ok(json!({
                    "content": [{
                        "type": "text",
                        "text": format!("{}={}", key, value)
                    }]
                }))
            }
        }
    }

    pub(super) async fn env_list(
        &mut self,
        _args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let params: Vec<EnvParamRow> = sqlx::query_as(
            "SELECT id, key, is_secret, description, created_at, updated_at FROM env_params ORDER BY key ASC",
        )
        .fetch_all(&self.db)
        .await
        .context("failed to list env params")?;

        if params.is_empty() {
            return Ok(json!({
                "content": [{ "type": "text", "text": "No environment parameters configured." }]
            }));
        }

        let mut text = format!("Environment parameters ({}):\n\n", params.len());
        for p in &params {
            text.push_str(&format!(
                "• {} [{}]{}\n",
                p.key,
                if p.is_secret { "secret" } else { "normal" },
                p.description
                    .as_deref()
                    .map(|d| format!(" — {}", d))
                    .unwrap_or_default()
            ));
        }

        Ok(json!({ "content": [{ "type": "text", "text": text }] }))
    }

    pub(super) async fn env_delete(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let key = args["key"].as_str().context("missing key")?.to_string();

        let result = sqlx::query("DELETE FROM env_params WHERE key = $1")
            .bind(&key)
            .execute(&self.db)
            .await
            .context("failed to delete env param")?;

        if result.rows_affected() == 0 {
            anyhow::bail!("Parameter '{}' not found", key);
        }

        Ok(json!({
            "content": [{
                "type": "text",
                "text": format!("Deleted parameter '{}'", key)
            }]
        }))
    }

    pub(super) async fn env_http_request(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let method = args["method"]
            .as_str()
            .context("missing method")?
            .to_uppercase();
        let auth_key = args["auth_key"]
            .as_str()
            .context("missing auth_key")?
            .to_string();
        let auth_header = args["auth_header"]
            .as_str()
            .unwrap_or("Authorization")
            .to_string();
        let auth_prefix = args["auth_prefix"]
            .as_str()
            .unwrap_or("Bearer ")
            .to_string();
        // "header" (default): secret goes in an auth header, url comes from the
        // "url" arg. "url": the secret itself IS the full request URL (for
        // self-authenticating URLs like incoming webhooks) — no auth header is
        // sent, and the "url" arg is ignored/not required. "query": secret is
        // appended as a query string parameter (name from secret_query_param,
        // default "key") onto the "url" arg — for APIs like Pixabay that only
        // accept the API key as ?key=... and reject header-based auth.
        let secret_target = args["secret_target"]
            .as_str()
            .unwrap_or("header")
            .to_string();
        let secret_query_param = args["secret_query_param"]
            .as_str()
            .unwrap_or("key")
            .to_string();

        // Resolve the secret from the DB — never returned to the agent
        let row: Option<(Vec<u8>, bool)> =
            sqlx::query_as("SELECT value_encrypted, is_secret FROM env_params WHERE key = $1")
                .bind(&auth_key)
                .fetch_optional(&self.db)
                .await
                .context("failed to query auth secret")?;

        let secret_value = match row {
            None => anyhow::bail!("Secret '{}' not found in env params", auth_key),
            Some((encrypted, _)) => decrypt_value(&self.encryption_key, &encrypted)
                .context("failed to decrypt secret")?,
        };

        let url = if secret_target == "url" {
            secret_value.trim().to_string()
        } else if secret_target == "query" {
            let base = args["url"].as_str().context("missing url")?;
            let mut parsed = reqwest::Url::parse(base).context("invalid url")?;
            parsed
                .query_pairs_mut()
                .append_pair(&secret_query_param, secret_value.trim());
            parsed.to_string()
        } else {
            args["url"].as_str().context("missing url")?.to_string()
        };

        // Optional host allowlist (OPENMEMORY_HTTP_ALLOWED_HOSTS): if set, refuse to
        // resolve or attach the secret unless the destination host is on the list.
        if let Ok(allowed) = std::env::var("OPENMEMORY_HTTP_ALLOWED_HOSTS") {
            let allowed_hosts: Vec<String> = allowed
                .split(',')
                .map(|h| h.trim().to_lowercase())
                .filter(|h| !h.is_empty())
                .collect();
            let parsed = reqwest::Url::parse(&url).context("invalid url")?;
            let host = parsed.host_str().unwrap_or("").to_lowercase();
            if !allowed_hosts.iter().any(|h| h == &host) {
                anyhow::bail!(
                    "Host '{}' is not in OPENMEMORY_HTTP_ALLOWED_HOSTS — request blocked",
                    host
                );
            }
        }

        let client = HttpClient::new();

        let mut req = match method.as_str() {
            "GET" => client.get(&url),
            "POST" => client.post(&url),
            "PUT" => client.put(&url),
            "PATCH" => client.patch(&url),
            "DELETE" => client.delete(&url),
            other => anyhow::bail!("Unsupported HTTP method: {}", other),
        }
        .header("Content-Type", "application/json");

        if secret_target != "url" && secret_target != "query" {
            let auth_value = format!("{}{}", auth_prefix, secret_value);
            req = req.header(&auth_header, &auth_value);
        }

        // Inject any extra headers
        if let Some(headers) = args["headers"].as_object() {
            for (k, v) in headers {
                if let Some(v_str) = v.as_str() {
                    req = req.header(k.as_str(), v_str);
                }
            }
        }

        // Attach body for mutating methods
        // Always set a body (even empty) — some APIs (e.g. Google's) require
        // Content-Length on POST/PUT/PATCH and reject requests with none set.
        // reqwest doesn't auto-emit Content-Length for a zero-length body, so
        // set it explicitly in that case.
        req = match args.get("body") {
            Some(body) if !body.is_null() => req.body(body.to_string()),
            _ => req.header("Content-Length", "0").body(""),
        };

        let response = req.send().await.context("HTTP request failed")?;
        let status = response.status().as_u16();
        let body_text = response.text().await.unwrap_or_default();

        // Try to pretty-print JSON responses, fall back to raw text
        let display = serde_json::from_str::<serde_json::Value>(&body_text)
            .map(|v| serde_json::to_string_pretty(&v).unwrap_or(body_text.clone()))
            .unwrap_or(body_text);

        Ok(json!({
            "content": [{
                "type": "text",
                "text": format!("HTTP {} — status {}\n\n{}", method, status, display)
            }],
            "isError": status >= 400
        }))
    }

    pub(super) async fn env_http_download(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let method = args["method"]
            .as_str()
            .context("missing method")?
            .to_uppercase();
        let auth_key = args["auth_key"]
            .as_str()
            .context("missing auth_key")?
            .to_string();
        let auth_header = args["auth_header"]
            .as_str()
            .unwrap_or("Authorization")
            .to_string();
        let auth_prefix = args["auth_prefix"]
            .as_str()
            .unwrap_or("Bearer ")
            .to_string();
        let secret_target = args["secret_target"]
            .as_str()
            .unwrap_or("header")
            .to_string();
        let secret_query_param = args["secret_query_param"]
            .as_str()
            .unwrap_or("key")
            .to_string();
        let save_path = args["save_path"]
            .as_str()
            .context("missing save_path")?
            .to_string();

        if !std::path::Path::new(&save_path).is_absolute() {
            anyhow::bail!("save_path must be an absolute path");
        }

        // Resolve the secret from the DB — never returned to the agent
        let row: Option<(Vec<u8>, bool)> =
            sqlx::query_as("SELECT value_encrypted, is_secret FROM env_params WHERE key = $1")
                .bind(&auth_key)
                .fetch_optional(&self.db)
                .await
                .context("failed to query auth secret")?;

        let secret_value = match row {
            None => anyhow::bail!("Secret '{}' not found in env params", auth_key),
            Some((encrypted, _)) => decrypt_value(&self.encryption_key, &encrypted)
                .context("failed to decrypt secret")?,
        };

        let url = if secret_target == "url" {
            secret_value.trim().to_string()
        } else if secret_target == "query" {
            let base = args["url"].as_str().context("missing url")?;
            let mut parsed = reqwest::Url::parse(base).context("invalid url")?;
            parsed
                .query_pairs_mut()
                .append_pair(&secret_query_param, secret_value.trim());
            parsed.to_string()
        } else {
            args["url"].as_str().context("missing url")?.to_string()
        };

        if let Ok(allowed) = std::env::var("OPENMEMORY_HTTP_ALLOWED_HOSTS") {
            let allowed_hosts: Vec<String> = allowed
                .split(',')
                .map(|h| h.trim().to_lowercase())
                .filter(|h| !h.is_empty())
                .collect();
            let parsed = reqwest::Url::parse(&url).context("invalid url")?;
            let host = parsed.host_str().unwrap_or("").to_lowercase();
            if !allowed_hosts.iter().any(|h| h == &host) {
                anyhow::bail!(
                    "Host '{}' is not in OPENMEMORY_HTTP_ALLOWED_HOSTS — request blocked",
                    host
                );
            }
        }

        let client = HttpClient::new();

        let mut req = match method.as_str() {
            "GET" => client.get(&url),
            "POST" => client.post(&url),
            "PUT" => client.put(&url),
            "PATCH" => client.patch(&url),
            "DELETE" => client.delete(&url),
            other => anyhow::bail!("Unsupported HTTP method: {}", other),
        };

        if secret_target != "url" && secret_target != "query" {
            let auth_value = format!("{}{}", auth_prefix, secret_value);
            req = req.header(&auth_header, &auth_value);
        }

        if let Some(headers) = args["headers"].as_object() {
            for (k, v) in headers {
                if let Some(v_str) = v.as_str() {
                    req = req.header(k.as_str(), v_str);
                }
            }
        }

        let response = req.send().await.context("HTTP request failed")?;
        let status = response.status().as_u16();
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();

        // Bytes, not text — this is the whole point: no UTF-8 lossy conversion.
        let bytes = response
            .bytes()
            .await
            .context("failed to read response body")?;

        if status >= 400 {
            // Error bodies are almost always text (JSON error payloads) — safe to
            // surface directly rather than writing an error page to save_path.
            let text = String::from_utf8_lossy(&bytes).to_string();
            return Ok(json!({
                "content": [{
                    "type": "text",
                    "text": format!("HTTP {} — status {}\n\n{}", method, status, text)
                }],
                "isError": true
            }));
        }

        if let Some(parent) = std::path::Path::new(&save_path).parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .context("failed to create parent directories for save_path")?;
        }
        tokio::fs::write(&save_path, &bytes)
            .await
            .context("failed to write downloaded bytes to save_path")?;

        Ok(json!({
            "content": [{
                "type": "text",
                "text": format!(
                    "HTTP {} — status {}\nSaved {} bytes to {}\nContent-Type: {}",
                    method, status, bytes.len(), save_path, content_type
                )
            }],
            "isError": false
        }))
    }

    // Shared by env_sign_jwt (returns the token to the agent) and
    // env_http_request_jwt (uses the token internally, never returns it).
    pub(super) async fn sign_jwt_from_args(&self, args: &serde_json::Value) -> Result<String> {
        use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};

        let key_name = args["key"].as_str().context("missing key")?.to_string();
        let algorithm = args["algorithm"]
            .as_str()
            .context("missing algorithm")?
            .to_string();
        let claims_in = args["claims"]
            .as_object()
            .context("missing claims")?
            .clone();
        let ttl_seconds = args["ttl_seconds"].as_i64().unwrap_or(1200).clamp(1, 1200);

        // Resolve the signing key from the DB — never returned to the agent
        let row: Option<(Vec<u8>, bool)> =
            sqlx::query_as("SELECT value_encrypted, is_secret FROM env_params WHERE key = $1")
                .bind(&key_name)
                .fetch_optional(&self.db)
                .await
                .context("failed to query signing key")?;

        let mut key_value = match row {
            None => anyhow::bail!("Parameter '{}' not found in env params", key_name),
            Some((encrypted, _)) => decrypt_value(&self.encryption_key, &encrypted)
                .context("failed to decrypt signing key")?,
        };

        // Keys uploaded via env_set_file are stored base64-encoded (so binary
        // files round-trip safely) — decode back to the raw PEM/secret bytes.
        if args["key_from_file"].as_bool().unwrap_or(false) {
            use base64::{engine::general_purpose::STANDARD, Engine as _};
            let decoded = STANDARD
                .decode(key_value.trim())
                .context("key_from_file was set but the stored value isn't valid base64")?;
            key_value = String::from_utf8(decoded)
                .context("decoded file key is not valid UTF-8 text (binary keys aren't supported by jsonwebtoken)")?;
        }

        let alg = match algorithm.as_str() {
            "ES256" => Algorithm::ES256,
            "RS256" => Algorithm::RS256,
            "HS256" => Algorithm::HS256,
            other => anyhow::bail!(
                "Unsupported algorithm: {} (use ES256, RS256, or HS256)",
                other
            ),
        };

        let encoding_key = match alg {
            Algorithm::ES256 => EncodingKey::from_ec_pem(key_value.as_bytes())
                .context("failed to parse EC private key (expected PEM)")?,
            Algorithm::RS256 => EncodingKey::from_rsa_pem(key_value.as_bytes())
                .context("failed to parse RSA private key (expected PEM)")?,
            Algorithm::HS256 => EncodingKey::from_secret(key_value.as_bytes()),
            _ => unreachable!(),
        };

        let mut header = Header::new(alg);
        if let Some(extra) = args["header_extra"].as_object() {
            for (k, v) in extra {
                match k.as_str() {
                    "kid" => header.kid = v.as_str().map(|s| s.to_string()),
                    _ => {} // other header fields aren't exposed by jsonwebtoken::Header; extend here if needed
                }
            }
        }

        let now = Utc::now().timestamp();
        let mut claims: serde_json::Map<String, serde_json::Value> = claims_in;
        claims.insert("iat".to_string(), json!(now));
        claims.insert("exp".to_string(), json!(now + ttl_seconds));

        encode(&header, &serde_json::Value::Object(claims), &encoding_key)
            .context("failed to sign JWT")
    }

    pub(super) async fn env_sign_jwt(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let token = self.sign_jwt_from_args(args).await?;

        Ok(json!({
            "content": [{
                "type": "text",
                "text": token
            }]
        }))
    }

    pub(super) async fn env_http_request_jwt(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let method = args["method"]
            .as_str()
            .context("missing method")?
            .to_uppercase();
        let url = args["url"].as_str().context("missing url")?.to_string();

        if let Ok(allowed) = std::env::var("OPENMEMORY_HTTP_ALLOWED_HOSTS") {
            let allowed_hosts: Vec<String> = allowed
                .split(',')
                .map(|h| h.trim().to_lowercase())
                .filter(|h| !h.is_empty())
                .collect();
            let parsed = reqwest::Url::parse(&url).context("invalid url")?;
            let host = parsed.host_str().unwrap_or("").to_lowercase();
            if !allowed_hosts.iter().any(|h| h == &host) {
                anyhow::bail!(
                    "Host '{}' is not in OPENMEMORY_HTTP_ALLOWED_HOSTS — request blocked",
                    host
                );
            }
        }

        // Signed internally; the token never leaves this function.
        let token = self.sign_jwt_from_args(args).await?;

        let client = HttpClient::new();
        let mut req = match method.as_str() {
            "GET" => client.get(&url),
            "POST" => client.post(&url),
            "PUT" => client.put(&url),
            "PATCH" => client.patch(&url),
            "DELETE" => client.delete(&url),
            other => anyhow::bail!("Unsupported HTTP method: {}", other),
        }
        .header("Authorization", format!("Bearer {}", token))
        .header("Content-Type", "application/json");

        if let Some(headers) = args["headers"].as_object() {
            for (k, v) in headers {
                if let Some(v_str) = v.as_str() {
                    req = req.header(k.as_str(), v_str);
                }
            }
        }

        // Always set a body (even empty) — some APIs (e.g. Google's) require
        // Content-Length on POST/PUT/PATCH and reject requests with none set.
        // reqwest doesn't auto-emit Content-Length for a zero-length body, so
        // set it explicitly in that case.
        req = match args.get("body") {
            Some(body) if !body.is_null() => req.body(body.to_string()),
            _ => req.header("Content-Length", "0").body(""),
        };

        let response = req.send().await.context("HTTP request failed")?;
        let status = response.status().as_u16();
        let body_text = response.text().await.unwrap_or_default();

        let display = serde_json::from_str::<serde_json::Value>(&body_text)
            .map(|v| serde_json::to_string_pretty(&v).unwrap_or(body_text.clone()))
            .unwrap_or(body_text);

        Ok(json!({
            "content": [{
                "type": "text",
                "text": format!("HTTP {} — status {}\n\n{}", method, status, display)
            }],
            "isError": status >= 400
        }))
    }

    pub(super) async fn env_set_file(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        use base64::{engine::general_purpose::STANDARD, Engine as _};

        let key = args["key"].as_str().context("missing key")?.to_string();
        let file_path = args["file_path"]
            .as_str()
            .context("missing file_path")?
            .to_string();
        let description = args["description"].as_str().map(|s| s.to_string());

        // Read on the server side — the file's bytes never pass through the
        // agent's own tool-call arguments or response text.
        let bytes = tokio::fs::read(&file_path)
            .await
            .with_context(|| format!("failed to read file '{}'", file_path))?;
        let encoded = STANDARD.encode(&bytes);

        let encrypted = encrypt_value(&self.encryption_key, &encoded);
        let now = Utc::now();
        let file_desc = description.unwrap_or_else(|| format!("uploaded from {}", file_path));

        sqlx::query(
            r#"
            INSERT INTO env_params (key, value_encrypted, is_secret, description, created_at, updated_at)
            VALUES ($1, $2, TRUE, $3, $4, $4)
            ON CONFLICT (key) DO UPDATE SET
                value_encrypted = EXCLUDED.value_encrypted,
                description = COALESCE(EXCLUDED.description, env_params.description),
                updated_at = EXCLUDED.updated_at
            "#,
        )
        .bind(&key)
        .bind(&encrypted)
        .bind(&file_desc)
        .bind(now)
        .execute(&self.db)
        .await
        .context("failed to store file as env param")?;

        Ok(json!({
            "content": [{
                "type": "text",
                "text": format!(
                    "Stored {} bytes from '{}' as secret parameter '{}'",
                    bytes.len(), file_path, key
                )
            }]
        }))
    }

    pub(super) async fn env_google_service_account_request(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};

        let key_name = args["key"].as_str().context("missing key")?.to_string();
        let scopes: Vec<String> = args["scopes"]
            .as_array()
            .context("missing scopes")?
            .iter()
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .collect();
        let method = args["method"]
            .as_str()
            .context("missing method")?
            .to_uppercase();
        let url = args["url"].as_str().context("missing url")?.to_string();

        if let Ok(allowed) = std::env::var("OPENMEMORY_HTTP_ALLOWED_HOSTS") {
            let allowed_hosts: Vec<String> = allowed
                .split(',')
                .map(|h| h.trim().to_lowercase())
                .filter(|h| !h.is_empty())
                .collect();
            let parsed = reqwest::Url::parse(&url).context("invalid url")?;
            let host = parsed.host_str().unwrap_or("").to_lowercase();
            if !allowed_hosts.iter().any(|h| h == &host) {
                anyhow::bail!(
                    "Host '{}' is not in OPENMEMORY_HTTP_ALLOWED_HOSTS — request blocked",
                    host
                );
            }
        }

        // Resolve the service account JSON — never returned to the agent
        let row: Option<(Vec<u8>, bool)> =
            sqlx::query_as("SELECT value_encrypted, is_secret FROM env_params WHERE key = $1")
                .bind(&key_name)
                .fetch_optional(&self.db)
                .await
                .context("failed to query service account secret")?;

        let stored = match row {
            None => anyhow::bail!("Parameter '{}' not found in env params", key_name),
            Some((encrypted, _)) => decrypt_value(&self.encryption_key, &encrypted)
                .context("failed to decrypt service account secret")?,
        };

        let decoded = STANDARD.decode(stored.trim()).context(
            "stored value isn't valid base64 (expected a file uploaded via env_set_file)",
        )?;
        let sa_json: serde_json::Value = serde_json::from_slice(&decoded)
            .context("decoded file isn't valid JSON (expected a GCP service account key file)")?;

        let client_email = sa_json["client_email"]
            .as_str()
            .context("service account JSON missing client_email")?
            .to_string();
        let private_key_pem = sa_json["private_key"]
            .as_str()
            .context("service account JSON missing private_key")?
            .to_string();
        let token_uri = sa_json["token_uri"]
            .as_str()
            .unwrap_or("https://oauth2.googleapis.com/token")
            .to_string();

        // Step 1: sign the JWT-bearer assertion (RS256, per Google's
        // server-to-server OAuth2 flow). Never returned to the agent.
        let now = Utc::now().timestamp();
        let claims = json!({
            "iss": client_email,
            "scope": scopes.join(" "),
            "aud": token_uri,
            "iat": now,
            "exp": now + 3600,
        });
        let encoding_key = EncodingKey::from_rsa_pem(private_key_pem.as_bytes())
            .context("failed to parse service account private key (expected PEM)")?;
        let assertion = encode(&Header::new(Algorithm::RS256), &claims, &encoding_key)
            .context("failed to sign service account JWT assertion")?;

        // Step 2: exchange the assertion for a short-lived access token.
        // Never returned to the agent.
        let client = HttpClient::new();
        let token_response = client
            .post(&token_uri)
            .form(&[
                ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
                ("assertion", assertion.as_str()),
            ])
            .send()
            .await
            .context("token exchange request failed")?;
        let token_status = token_response.status();
        let token_body: serde_json::Value = token_response
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

        let access_token = token_body["access_token"]
            .as_str()
            .context("token endpoint response missing access_token")?
            .to_string();

        // Step 3: the actual API call, authenticated with the access token.
        let mut req = match method.as_str() {
            "GET" => client.get(&url),
            "POST" => client.post(&url),
            "PUT" => client.put(&url),
            "PATCH" => client.patch(&url),
            "DELETE" => client.delete(&url),
            other => anyhow::bail!("Unsupported HTTP method: {}", other),
        }
        .header("Authorization", format!("Bearer {}", access_token))
        .header("Content-Type", "application/json");

        if let Some(headers) = args["headers"].as_object() {
            for (k, v) in headers {
                if let Some(v_str) = v.as_str() {
                    req = req.header(k.as_str(), v_str);
                }
            }
        }

        // Always set a body (even empty) — some APIs (e.g. Google's) require
        // Content-Length on POST/PUT/PATCH and reject requests with none set.
        // reqwest doesn't auto-emit Content-Length for a zero-length body, so
        // set it explicitly in that case.
        req = match args.get("body") {
            Some(body) if !body.is_null() => req.body(body.to_string()),
            _ => req.header("Content-Length", "0").body(""),
        };

        let response = req.send().await.context("HTTP request failed")?;
        let status = response.status().as_u16();
        let body_text = response.text().await.unwrap_or_default();

        let display = serde_json::from_str::<serde_json::Value>(&body_text)
            .map(|v| serde_json::to_string_pretty(&v).unwrap_or(body_text.clone()))
            .unwrap_or(body_text);

        Ok(json!({
            "content": [{
                "type": "text",
                "text": format!("HTTP {} — status {}\n\n{}", method, status, display)
            }],
            "isError": status >= 400
        }))
    }
}
