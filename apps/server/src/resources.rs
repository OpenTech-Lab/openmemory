//! Resource catalog: local paths and website URLs agents can discover.
//!
//! Manual rows live in the `resources` table. Environment-declared roots
//! (`RESOURCE_PATH.*`, `RESOURCE_URL.*`, optional `RESOURCE_AUTH.*`) are
//! merged at list/get time — no DB copy required.

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

use crate::crypto::decrypt_value;

pub const PREFIX_PATH: &str = "RESOURCE_PATH.";
pub const PREFIX_URL: &str = "RESOURCE_URL.";
pub const PREFIX_AUTH: &str = "RESOURCE_AUTH.";

/// Unified resource view returned to agents / UI (manual + env-sourced).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResourceView {
    /// Present for manual rows; absent for virtual env-sourced resources.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<Uuid>,
    pub name: String,
    pub kind: String,
    pub location: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub tags: Vec<String>,
    /// Env param keys for credentials/config (often secrets — names only).
    /// A resource can bundle several (e.g. api_key + team_id + token for one account).
    pub env_param_keys: Vec<String>,
    /// `manual` or `env`
    pub source: String,
    /// Env key that declared this resource (env-sourced only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<DateTime<Utc>>,
}

#[derive(Debug, FromRow)]
struct ManualRow {
    id: Uuid,
    name: String,
    kind: String,
    location: String,
    description: Option<String>,
    tags: Vec<String>,
    env_param_keys: Vec<String>,
    source: String,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

impl From<ManualRow> for ResourceView {
    fn from(r: ManualRow) -> Self {
        ResourceView {
            id: Some(r.id),
            name: r.name,
            kind: r.kind,
            location: r.location,
            description: r.description,
            tags: r.tags,
            env_param_keys: r.env_param_keys,
            source: r.source,
            env_key: None,
            created_at: Some(r.created_at),
            updated_at: Some(r.updated_at),
        }
    }
}

pub async fn ensure_resources_table(db: &PgPool) -> Result<()> {
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS resources (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            name TEXT NOT NULL UNIQUE,
            kind TEXT NOT NULL CHECK (kind IN ('path', 'url')),
            location TEXT NOT NULL,
            description TEXT,
            tags TEXT[] NOT NULL DEFAULT '{}',
            env_param_keys TEXT[] NOT NULL DEFAULT '{}',
            source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'env')),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (kind, location)
        )
        "#,
    )
    .execute(db)
    .await
    .context("failed to create resources table")?;

    // Migrate legacy single-key `env_param_key` column (pre-multi-credential) to
    // `env_param_keys`, then drop it. Idempotent: no-op once the column is gone.
    sqlx::query(
        r#"
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name = 'resources' AND column_name = 'env_param_key'
            ) THEN
                ALTER TABLE resources ADD COLUMN IF NOT EXISTS env_param_keys TEXT[] NOT NULL DEFAULT '{}';
                UPDATE resources SET env_param_keys = ARRAY[env_param_key]
                    WHERE env_param_key IS NOT NULL AND cardinality(env_param_keys) = 0;
                ALTER TABLE resources DROP COLUMN env_param_key;
            END IF;
        END $$;
        "#,
    )
    .execute(db)
    .await
    .context("failed to migrate resources.env_param_key to env_param_keys")?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_resources_kind ON resources(kind)")
        .execute(db)
        .await
        .ok();
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_resources_name ON resources(name)")
        .execute(db)
        .await
        .ok();
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_resources_env_param_keys ON resources USING gin(env_param_keys)")
        .execute(db)
        .await
        .ok();
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_resources_tags ON resources USING gin(tags)")
        .execute(db)
        .await
        .ok();

    Ok(())
}

fn validate_kind(kind: &str) -> Result<()> {
    if kind != "path" && kind != "url" {
        anyhow::bail!("kind must be 'path' or 'url'");
    }
    Ok(())
}

async fn validate_env_param_key(db: &PgPool, key: &str) -> Result<()> {
    let exists: Option<(bool,)> =
        sqlx::query_as("SELECT true FROM env_params WHERE key = $1")
            .bind(key)
            .fetch_optional(db)
            .await?;
    if exists.is_none() {
        anyhow::bail!("env_param_key '{}' does not exist — create it with env_set first", key);
    }
    Ok(())
}

async fn validate_env_param_keys(db: &PgPool, keys: &[String]) -> Result<()> {
    for key in keys {
        validate_env_param_key(db, key).await?;
    }
    Ok(())
}

/// Soft path existence check — returns a warning string if missing, never errors.
pub async fn path_warning(location: &str) -> Option<String> {
    match tokio::fs::metadata(location).await {
        Ok(_) => None,
        Err(_) => Some(format!(
            "warning: path '{}' does not exist (or is not accessible) on this machine",
            location
        )),
    }
}

pub async fn add_resource(
    db: &PgPool,
    name: &str,
    kind: &str,
    location: &str,
    description: Option<&str>,
    tags: &[String],
    env_param_keys: &[String],
) -> Result<(Uuid, Option<String>)> {
    validate_kind(kind)?;
    if name.trim().is_empty() {
        anyhow::bail!("name must not be empty");
    }
    if location.trim().is_empty() {
        anyhow::bail!("location must not be empty");
    }
    validate_env_param_keys(db, env_param_keys).await?;

    let warning = if kind == "path" {
        path_warning(location).await
    } else {
        None
    };

    let id = Uuid::new_v4();
    let now = Utc::now();
    let tags = tags.to_vec();
    let env_param_keys = env_param_keys.to_vec();

    sqlx::query(
        r#"
        INSERT INTO resources (id, name, kind, location, description, tags, env_param_keys, source, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'manual', $8, $8)
        "#,
    )
    .bind(id)
    .bind(name)
    .bind(kind)
    .bind(location)
    .bind(description)
    .bind(&tags)
    .bind(&env_param_keys)
    .bind(now)
    .execute(db)
    .await
    .with_context(|| format!("failed to insert resource '{}'", name))?;

    Ok((id, warning))
}

pub async fn update_resource(
    db: &PgPool,
    id: Uuid,
    name: Option<&str>,
    kind: Option<&str>,
    location: Option<&str>,
    description: Option<Option<&str>>,
    tags: Option<&[String]>,
    env_param_keys: Option<&[String]>,
) -> Result<Option<String>> {
    let existing: Option<ManualRow> = sqlx::query_as(
        r#"
        SELECT id, name, kind, location, description, tags, env_param_keys, source, created_at, updated_at
        FROM resources WHERE id = $1
        "#,
    )
    .bind(id)
    .fetch_optional(db)
    .await?;

    let Some(row) = existing else {
        anyhow::bail!("resource not found: {}", id);
    };
    if row.source != "manual" {
        anyhow::bail!("only manual resources can be updated");
    }

    let new_name = name.unwrap_or(&row.name);
    let new_kind = kind.unwrap_or(&row.kind);
    validate_kind(new_kind)?;
    let new_location = location.unwrap_or(&row.location);
    let new_description = match description {
        Some(d) => d.map(|s| s.to_string()),
        None => row.description.clone(),
    };
    let new_tags: Vec<String> = match tags {
        Some(t) => t.to_vec(),
        None => row.tags.clone(),
    };
    let new_env_keys: Vec<String> = match env_param_keys {
        Some(keys) => {
            validate_env_param_keys(db, keys).await?;
            keys.to_vec()
        }
        None => row.env_param_keys.clone(),
    };

    let warning = if new_kind == "path" {
        path_warning(new_location).await
    } else {
        None
    };

    let now = Utc::now();
    sqlx::query(
        r#"
        UPDATE resources SET
            name = $2,
            kind = $3,
            location = $4,
            description = $5,
            tags = $6,
            env_param_keys = $7,
            updated_at = $8
        WHERE id = $1
        "#,
    )
    .bind(id)
    .bind(new_name)
    .bind(new_kind)
    .bind(new_location)
    .bind(&new_description)
    .bind(&new_tags)
    .bind(&new_env_keys)
    .bind(now)
    .execute(db)
    .await
    .context("failed to update resource")?;

    Ok(warning)
}

pub async fn delete_resource(db: &PgPool, id: Uuid) -> Result<()> {
    let result = sqlx::query("DELETE FROM resources WHERE id = $1 AND source = 'manual'")
        .bind(id)
        .execute(db)
        .await?;
    if result.rows_affected() == 0 {
        anyhow::bail!("manual resource not found: {}", id);
    }
    Ok(())
}

async fn list_manual(db: &PgPool, tags: Option<&[String]>) -> Result<Vec<ResourceView>> {
    let rows: Vec<ManualRow> = sqlx::query_as(
        r#"
        SELECT id, name, kind, location, description, tags, env_param_keys, source, created_at, updated_at
        FROM resources
        WHERE $1::text[] IS NULL OR tags && $1::text[]
        ORDER BY name ASC
        "#,
    )
    .bind(tags)
    .fetch_all(db)
    .await
    .context("failed to list resources")?;
    Ok(rows.into_iter().map(ResourceView::from).collect())
}

/// Distinct tags across manual resources with usage counts, most-used first.
pub async fn list_distinct_tags(db: &PgPool) -> Result<Vec<(String, i64)>> {
    let rows: Vec<(String, i64)> = sqlx::query_as(
        r#"
        SELECT tag, count(*) AS count
        FROM (SELECT unnest(tags) AS tag FROM resources) t
        GROUP BY tag
        ORDER BY count DESC, tag ASC
        "#,
    )
    .fetch_all(db)
    .await
    .context("failed to list distinct resource tags")?;
    Ok(rows)
}

/// Scan env_params for RESOURCE_PATH.* / RESOURCE_URL.* (and RESOURCE_AUTH.* links).
pub async fn list_env_resources(
    db: &PgPool,
    encryption_key: &[u8; 32],
) -> Result<(Vec<ResourceView>, Vec<String>)> {
    let rows: Vec<(String, Vec<u8>, bool, Option<String>)> = sqlx::query_as(
        r#"
        SELECT key, value_encrypted, is_secret, description
        FROM env_params
        WHERE key LIKE 'RESOURCE_PATH.%'
           OR key LIKE 'RESOURCE_URL.%'
           OR key LIKE 'RESOURCE_AUTH.%'
        ORDER BY key ASC
        "#,
    )
    .fetch_all(db)
    .await
    .context("failed to scan env resource keys")?;

    let mut warnings = Vec::new();
    let mut auth_map: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut pending: Vec<(String, String, String, Option<String>, String)> = Vec::new();
    // (kind, slug, location, description, env_key)

    for (key, encrypted, is_secret, description) in rows {
        if let Some(slug) = key.strip_prefix(PREFIX_AUTH) {
            if is_secret {
                warnings.push(format!(
                    "skipped {}: RESOURCE_AUTH.* must be a normal param whose value is the credential key name",
                    key
                ));
                continue;
            }
            match decrypt_value(encryption_key, &encrypted) {
                Ok(cred_key) => {
                    auth_map.insert(slug.to_string(), cred_key);
                }
                Err(e) => warnings.push(format!("failed to decrypt {}: {}", key, e)),
            }
            continue;
        }

        let (kind, slug) = if let Some(slug) = key.strip_prefix(PREFIX_PATH) {
            ("path", slug)
        } else if let Some(slug) = key.strip_prefix(PREFIX_URL) {
            ("url", slug)
        } else {
            continue;
        };

        if slug.is_empty() {
            warnings.push(format!("skipped {}: empty slug", key));
            continue;
        }

        if is_secret {
            warnings.push(format!(
                "skipped {}: location keys must be normal (non-secret) so agents can read them",
                key
            ));
            continue;
        }

        match decrypt_value(encryption_key, &encrypted) {
            Ok(location) => {
                pending.push((
                    kind.to_string(),
                    slug.to_string(),
                    location,
                    description,
                    key,
                ));
            }
            Err(e) => warnings.push(format!("failed to decrypt {}: {}", key, e)),
        }
    }

    let views: Vec<ResourceView> = pending
        .into_iter()
        .map(|(kind, slug, location, description, env_key)| {
            let env_param_keys = auth_map.get(&slug).cloned().into_iter().collect();
            ResourceView {
                id: None,
                name: slug,
                kind,
                location,
                description,
                tags: vec![],
                env_param_keys,
                source: "env".to_string(),
                env_key: Some(env_key),
                created_at: None,
                updated_at: None,
            }
        })
        .collect();

    Ok((views, warnings))
}

fn matches_filters(
    r: &ResourceView,
    kind: Option<&str>,
    tags: Option<&[String]>,
    query: Option<&str>,
) -> bool {
    if let Some(k) = kind {
        if r.kind != k {
            return false;
        }
    }
    if let Some(ts) = tags {
        if !ts.is_empty() && !r.tags.iter().any(|x| ts.iter().any(|t| t == x)) {
            return false;
        }
    }
    if let Some(q) = query {
        let q = q.to_lowercase();
        let hay = format!(
            "{} {} {} {}",
            r.name,
            r.location,
            r.description.as_deref().unwrap_or(""),
            r.tags.join(" ")
        )
        .to_lowercase();
        if !hay.contains(&q) {
            return false;
        }
    }
    true
}

/// Merge manual + env-declared resources. Env entries whose (kind, location)
/// already exist as manual rows are omitted (manual wins).
pub async fn list_resources(
    db: &PgPool,
    encryption_key: &[u8; 32],
    kind: Option<&str>,
    tags: Option<&[String]>,
    query: Option<&str>,
) -> Result<(Vec<ResourceView>, Vec<String>)> {
    if let Some(k) = kind {
        validate_kind(k)?;
    }

    let manual = list_manual(db, tags).await?;
    let (env_views, warnings) = list_env_resources(db, encryption_key).await?;

    let manual_keys: std::collections::HashSet<(String, String)> = manual
        .iter()
        .map(|r| (r.kind.clone(), r.location.clone()))
        .collect();
    let manual_names: std::collections::HashSet<String> =
        manual.iter().map(|r| r.name.clone()).collect();

    let mut merged = manual;
    for ev in env_views {
        if manual_keys.contains(&(ev.kind.clone(), ev.location.clone())) {
            continue;
        }
        if manual_names.contains(&ev.name) {
            continue;
        }
        merged.push(ev);
    }

    merged.retain(|r| matches_filters(r, kind, tags, query));
    merged.sort_by(|a, b| a.name.cmp(&b.name));

    Ok((merged, warnings))
}

pub async fn get_resource(
    db: &PgPool,
    encryption_key: &[u8; 32],
    id_or_name: &str,
) -> Result<Option<ResourceView>> {
    // Try UUID first
    if let Ok(id) = Uuid::parse_str(id_or_name) {
        let row: Option<ManualRow> = sqlx::query_as(
            r#"
            SELECT id, name, kind, location, description, tags, env_param_keys, source, created_at, updated_at
            FROM resources WHERE id = $1
            "#,
        )
        .bind(id)
        .fetch_optional(db)
        .await?;
        if let Some(r) = row {
            return Ok(Some(r.into()));
        }
    }

    // Manual by name
    let row: Option<ManualRow> = sqlx::query_as(
        r#"
        SELECT id, name, kind, location, description, tags, env_param_keys, source, created_at, updated_at
        FROM resources WHERE name = $1
        "#,
    )
    .bind(id_or_name)
    .fetch_optional(db)
    .await?;
    if let Some(r) = row {
        return Ok(Some(r.into()));
    }

    // Env-sourced by slug name
    let (env_views, _) = list_env_resources(db, encryption_key).await?;
    Ok(env_views.into_iter().find(|r| r.name == id_or_name))
}

/// Format a resource list for MCP text responses.
pub fn format_list_text(resources: &[ResourceView], warnings: &[String]) -> String {
    let mut lines = Vec::new();
    if resources.is_empty() {
        lines.push("No resources registered.".to_string());
        lines.push(
            "Add with resource_add, or declare via env: RESOURCE_PATH.<slug> / RESOURCE_URL.<slug>."
                .to_string(),
        );
    } else {
        lines.push(format!("Resources ({}):", resources.len()));
        for r in resources {
            let env_link = if r.env_param_keys.is_empty() {
                String::new()
            } else {
                format!(" env_keys=[{}]", r.env_param_keys.join(","))
            };
            let desc = r
                .description
                .as_deref()
                .map(|d| format!(" — {}", d))
                .unwrap_or_default();
            let id_part = r
                .id
                .map(|id| format!(" [{}]", id))
                .unwrap_or_else(|| {
                    r.env_key
                        .as_ref()
                        .map(|k| format!(" [{}]", k))
                        .unwrap_or_default()
                });
            let tags = if r.tags.is_empty() {
                String::new()
            } else {
                format!(" tags=[{}]", r.tags.join(","))
            };
            lines.push(format!(
                "• {} ({}) [{}] {}{}{}{}{}",
                r.name, r.kind, r.source, r.location, id_part, env_link, tags, desc
            ));
        }
    }
    for w in warnings {
        lines.push(format!("⚠ {}", w));
    }
    lines.join("\n")
}
