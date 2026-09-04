//! Global library: visual/media/code candidate references (image/video file
//! paths or uploaded blobs, or self-contained HTML/CSS/JS snippets to preview
//! live) + label/description/tags. CRUD-only — no review-state workflow,
//! entries are just stored and listed.
//!
//! Mirrors `resources.rs` in shape (manual rows, soft path-existence
//! warnings, no project nesting) — entries are global like `resources`,
//! with an optional `project_id` for loose association rather than
//! required scoping (unlike `project_tasks`).

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

use crate::resources::path_warning;

/// Upper bound on a single uploaded library blob (image/video/html), matching
/// `design_blobs::MAX_DESIGN_BLOB_BYTES` — real `.fig` files reach ~82 MB, and
/// there's no reason library uploads should be capped tighter.
pub const MAX_LIBRARY_BLOB_BYTES: usize = 128 * 1024 * 1024;

/// Directory holding uploaded library blobs, overridable for tests and local runs.
pub fn blob_root() -> PathBuf {
    std::env::var("OPENMEMORY_LIBRARY_BLOB_DIR")
        .unwrap_or_else(|_| "/data/library-blobs".to_string())
        .into()
}

/// A `Uuid` renders only as hex and dashes, so the filename can never contain a
/// path separator or `..` — traversal is structurally impossible rather than filtered.
/// `ext` comes from a query param (raw-bytes uploads carry no filename) and is
/// sanitized to alphanumerics only before being used in a path.
pub fn blob_path(root: &Path, blob_id: Uuid, ext: &str) -> PathBuf {
    root.join(format!("{blob_id}.{ext}"))
}

/// Temp path for a single in-flight write. Includes a fresh UUID (not just
/// `blob_id`) so two concurrent uploads never share a path — sharing one would
/// let their writes interleave and let the eventual rename land a corrupted,
/// mixed-content file.
pub fn temp_blob_path(root: &Path, blob_id: Uuid, ext: &str) -> PathBuf {
    root.join(format!("{blob_id}.{}.{ext}.tmp", Uuid::new_v4()))
}

/// Keeps only alphanumeric characters from a query-supplied extension, so it
/// can never be used to escape `blob_root()` or inject a bogus filename shape.
pub fn sanitize_ext(ext: &str) -> String {
    let cleaned: String = ext.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    if cleaned.is_empty() {
        "bin".to_string()
    } else {
        cleaned.to_ascii_lowercase()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct LibraryEntryView {
    pub id: Uuid,
    pub project_id: Option<Uuid>,
    pub label: String,
    pub kind: String,
    pub category: String,
    pub location: Option<String>,
    pub code: Option<String>,
    pub description: Option<String>,
    pub tags: Vec<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

pub async fn ensure_library_table(db: &PgPool) -> Result<()> {
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS library_entries (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            project_id UUID NOT NULL REFERENCES project_graphs(id) ON DELETE CASCADE,
            label TEXT NOT NULL,
            kind TEXT NOT NULL CHECK (kind IN ('image','video')),
            location TEXT NOT NULL,
            description TEXT,
            tags TEXT[] NOT NULL DEFAULT '{}',
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
        "#,
    )
    .execute(db)
    .await
    .context("failed to create library_entries table")?;

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_library_entries_project_id ON library_entries(project_id)",
    )
    .execute(db)
    .await
    .ok();
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_library_entries_tags ON library_entries USING gin(tags)",
    )
    .execute(db)
    .await
    .ok();

    // Revision to GLOBAL scoping + live code-preview entries (table confirmed
    // empty in production at revision time, so no backfill is needed — just
    // relax the constraints that assumed project-scoped, path-only rows).
    sqlx::query("ALTER TABLE library_entries ALTER COLUMN project_id DROP NOT NULL")
        .execute(db)
        .await
        .ok();
    sqlx::query("ALTER TABLE library_entries ALTER COLUMN location DROP NOT NULL")
        .execute(db)
        .await
        .ok();
    sqlx::query("ALTER TABLE library_entries ADD COLUMN IF NOT EXISTS code TEXT")
        .execute(db)
        .await
        .ok();
    sqlx::query("ALTER TABLE library_entries DROP CONSTRAINT IF EXISTS library_entries_kind_check")
        .execute(db)
        .await
        .ok();
    sqlx::query("ALTER TABLE library_entries ADD CONSTRAINT library_entries_kind_check CHECK (kind IN ('image','video','code'))")
        .execute(db).await.ok();

    // Fixed category menu (replaces project_id as the primary browse filter;
    // project_id stays in the schema as optional secondary metadata).
    sqlx::query("ALTER TABLE library_entries ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'other'")
        .execute(db).await.ok();
    sqlx::query(
        "ALTER TABLE library_entries DROP CONSTRAINT IF EXISTS library_entries_category_check",
    )
    .execute(db)
    .await
    .ok();
    sqlx::query("ALTER TABLE library_entries ADD CONSTRAINT library_entries_category_check CHECK (category IN ('ui','design-system','effects','animation','other'))")
        .execute(db).await.ok();

    Ok(())
}

fn validate_kind(kind: &str) -> Result<()> {
    if kind != "image" && kind != "video" && kind != "code" {
        anyhow::bail!("kind must be 'image', 'video', or 'code'");
    }
    Ok(())
}

const CATEGORIES: [&str; 5] = ["ui", "design-system", "effects", "animation", "other"];

fn validate_category(category: &str) -> Result<()> {
    if !CATEGORIES.contains(&category) {
        anyhow::bail!("category must be one of: ui, design-system, effects, animation, other");
    }
    Ok(())
}

pub async fn add_entry(
    db: &PgPool,
    project_id: Option<Uuid>,
    label: &str,
    kind: &str,
    category: &str,
    location: Option<&str>,
    code: Option<&str>,
    description: Option<&str>,
    tags: &[String],
) -> Result<(Uuid, Option<String>)> {
    validate_kind(kind)?;
    validate_category(category)?;
    if label.trim().is_empty() {
        anyhow::bail!("label must not be empty");
    }
    let location = location.filter(|l| !l.trim().is_empty());
    let code = code.filter(|c| !c.trim().is_empty());
    if location.is_none() && code.is_none() {
        anyhow::bail!("either location or code must be provided");
    }

    // `location` is normally a local file path; skip the filesystem check for URLs
    // (mirrors resources.rs's path_warning, which only applies to kind == "path"),
    // and skip it entirely for code-only entries (no location to check).
    let warning = match location {
        Some(loc) if !(loc.starts_with("http://") || loc.starts_with("https://")) => {
            path_warning(loc).await
        }
        _ => None,
    };

    let id = Uuid::new_v4();
    let now = Utc::now();
    let tags = tags.to_vec();

    sqlx::query(
        r#"
        INSERT INTO library_entries (id, project_id, label, kind, category, location, code, description, tags, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
        "#,
    )
    .bind(id)
    .bind(project_id)
    .bind(label)
    .bind(kind)
    .bind(category)
    .bind(location)
    .bind(code)
    .bind(description)
    .bind(&tags)
    .bind(now)
    .execute(db)
    .await
    .with_context(|| format!("failed to insert library entry '{}'", label))?;

    Ok((id, warning))
}

pub async fn list_entries(
    db: &PgPool,
    project_id: Option<Uuid>,
    tag: Option<&str>,
    category: Option<&str>,
) -> Result<Vec<LibraryEntryView>> {
    let rows: Vec<LibraryEntryView> = sqlx::query_as(
        r#"
        SELECT id, project_id, label, kind, category, location, code, description, tags, created_at, updated_at
        FROM library_entries
        WHERE ($1::uuid IS NULL OR project_id = $1) AND ($2::text IS NULL OR tags @> ARRAY[$2::text])
          AND ($3::text IS NULL OR category = $3)
        ORDER BY created_at DESC
        "#,
    )
    .bind(project_id)
    .bind(tag)
    .bind(category)
    .fetch_all(db)
    .await
    .context("failed to list library entries")?;
    Ok(rows)
}

pub async fn get_entry(db: &PgPool, id: Uuid) -> Result<Option<LibraryEntryView>> {
    let row: Option<LibraryEntryView> = sqlx::query_as(
        r#"
        SELECT id, project_id, label, kind, category, location, code, description, tags, created_at, updated_at
        FROM library_entries WHERE id = $1
        "#,
    )
    .bind(id)
    .fetch_optional(db)
    .await
    .context("failed to fetch library entry")?;
    Ok(row)
}

pub async fn delete_entry(db: &PgPool, id: Uuid) -> Result<()> {
    let result = sqlx::query("DELETE FROM library_entries WHERE id = $1")
        .bind(id)
        .execute(db)
        .await?;
    if result.rows_affected() == 0 {
        anyhow::bail!("library entry not found: {}", id);
    }
    Ok(())
}

/// Format a library entry list for MCP text responses.
pub fn format_list_text(entries: &[LibraryEntryView]) -> String {
    let mut lines = Vec::new();
    if entries.is_empty() {
        lines.push("No library entries.".to_string());
        lines.push("Add with library_add.".to_string());
    } else {
        lines.push(format!("Library entries ({}):", entries.len()));
        for e in entries {
            let desc = e
                .description
                .as_deref()
                .map(|d| format!(" — {}", d))
                .unwrap_or_default();
            let tags = if e.tags.is_empty() {
                String::new()
            } else {
                format!(" tags=[{}]", e.tags.join(","))
            };
            let where_ = e
                .location
                .as_deref()
                .map(|l| l.to_string())
                .unwrap_or_else(|| "<inline code>".to_string());
            lines.push(format!(
                "• {} ({}/{}) {} [{}]{}{}",
                e.label, e.kind, e.category, where_, e.id, tags, desc
            ));
        }
    }
    lines.join("\n")
}
