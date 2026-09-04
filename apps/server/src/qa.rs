//! Project QA log: durable record of QA runs (what was tested, what the verdict
//! was) plus their evidence (screenshots and dated notes), scoped to a project.
//!
//! `qa-automation` (a separate repository/service) supplies the *verdict* for an
//! automated run; this module owns the *record* regardless of who produced it —
//! an agent driving qa-automation, or a human doing a manual pass. There is no
//! service-to-service dependency: the QA tab works even when qa-automation is
//! stopped, or for a run that never touched it at all.
//!
//! Mirrors `library.rs` in shape: this module owns the `CREATE TABLE`, the
//! blob path/limit primitives, and the CRUD functions that both the axum
//! handlers (`main.rs`, `qa_blobs.rs`) and the MCP tools (`mcp_app/qa_tools.rs`)
//! call. `library_entries` is deliberately not reused for evidence — QA
//! evidence is run-scoped, ordered, append-mostly log data with a different
//! lifecycle, not a curated global asset library.
//!
//! Ownership chain for evidence is `evidence → run → project`; every scoped
//! query below walks that chain with a single SQL check rather than trusting
//! the caller. `project_id: Option<Uuid>` on the update/delete functions is the
//! scoping switch: `Some(id)` enforces project ownership (the HTTP routes,
//! which have a project id in the URL), `None` skips the check (the MCP tools,
//! whose arguments — per the approved spec — address a run or evidence item
//! directly by id with no redundant project_id argument).

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

/// Upper bound on a single uploaded evidence image. These are screenshots, not
/// the 128 MB video budget `library.rs` needs.
pub const MAX_QA_BLOB_BYTES: usize = 32 * 1024 * 1024;

pub const RUN_STATUSES: [&str; 4] = ["in_progress", "passed", "failed", "blocked"];
pub const RUN_KINDS: [&str; 7] = [
    "manual",
    "unit",
    "integration",
    "api",
    "e2e",
    "load",
    "other",
];
pub const EVIDENCE_KINDS: [&str; 2] = ["image", "text"];
pub const CREATED_BY_VALUES: [&str; 2] = ["agent", "human"];
pub const PLAN_KINDS: [&str; 4] = ["jest", "playwright", "maestro", "other"];
pub const PLAN_LANGUAGES: [&str; 5] = ["typescript", "javascript", "yaml", "python", "other"];

/// Directory holding uploaded evidence images, overridable for tests and local runs.
pub fn blob_root() -> PathBuf {
    std::env::var("OPENMEMORY_QA_BLOB_DIR")
        .unwrap_or_else(|_| "/data/qa-blobs".to_string())
        .into()
}

/// A `Uuid` renders only as hex and dashes, so the filename can never contain a
/// path separator or `..` — traversal is structurally impossible rather than
/// filtered. The extension is fixed (not derived from the mime type): `mime_type`
/// is already stored on the row and is what `GET .../blob` sets `Content-Type`
/// from, so encoding it in the filename too would create a second source of
/// truth that can disagree with the first.
pub fn blob_path(root: &Path, evidence_id: Uuid) -> PathBuf {
    root.join(format!("{evidence_id}.bin"))
}

/// Temp path for a single in-flight write. Includes a fresh UUID (not just
/// `evidence_id`) so two concurrent writes for the same evidence never share a
/// path — sharing one would let their writes interleave and let the eventual
/// rename land a corrupted, mixed-content file.
pub fn temp_blob_path(root: &Path, evidence_id: Uuid) -> PathBuf {
    root.join(format!("{evidence_id}.{}.bin.tmp", Uuid::new_v4()))
}

/// Magic-byte mime sniffing for the three accepted image types. This is the one
/// source both entry points (the browser's raw `PUT` and the MCP tool's
/// `file_path` read) share and that a client cannot lie about via a
/// `Content-Type` header or a query param, so `mime_type` has a single origin.
/// Anything else is rejected with 415 by the caller.
pub fn sniff_image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xFF\xD8\xFF") {
        Some("image/jpeg")
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct QaEventView {
    pub id: Uuid,
    pub project_id: Uuid,
    pub name: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct QaRunView {
    pub id: Uuid,
    pub project_id: Uuid,
    pub event_id: Option<Uuid>,
    pub task_id: Option<Uuid>,
    pub title: String,
    pub status: String,
    pub summary: Option<String>,
    pub target: Option<String>,
    pub external_ref: Option<String>,
    pub created_by: String,
    pub started_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub kind: String,
    pub runner: Option<String>,
    pub total_cases: i32,
    pub passed_cases: i32,
    pub failed_cases: i32,
    pub skipped_cases: i32,
    pub duration_ms: Option<i64>,
    pub commit_sha: Option<String>,
    pub branch: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct QaRunListItem {
    pub id: Uuid,
    pub project_id: Uuid,
    pub event_id: Option<Uuid>,
    pub task_id: Option<Uuid>,
    pub title: String,
    pub status: String,
    pub summary: Option<String>,
    pub target: Option<String>,
    pub external_ref: Option<String>,
    pub created_by: String,
    pub started_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub kind: String,
    pub runner: Option<String>,
    pub total_cases: i32,
    pub passed_cases: i32,
    pub failed_cases: i32,
    pub skipped_cases: i32,
    pub duration_ms: Option<i64>,
    pub commit_sha: Option<String>,
    pub branch: Option<String>,
    pub evidence_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct QaTestCaseView {
    pub id: Uuid,
    pub run_id: Uuid,
    pub project_id: Uuid,
    pub case_key: String,
    pub suite: Option<String>,
    pub name: String,
    pub file: Option<String>,
    pub status: String,
    pub duration_ms: Option<f64>,
    pub failure_message: Option<String>,
    pub failure_detail: Option<String>,
    pub source_sha: Option<String>,
    pub external_ref: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct QaRunMetricView {
    pub id: Uuid,
    pub run_id: Uuid,
    pub project_id: Uuid,
    pub metric_key: String,
    pub value: f64,
    pub unit: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct QaTestSourceView {
    pub project_id: Uuid,
    pub source_sha: String,
    pub file: String,
    pub language: Option<String>,
    pub body: String,
    pub byte_size: i32,
    pub first_seen: DateTime<Utc>,
    pub last_seen: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct QaCaseHistoryView {
    pub run_id: Uuid,
    pub started_at: DateTime<Utc>,
    pub status: String,
    /// This *case's* own duration, not the run's. The distinction is not
    /// cosmetic: in a one-test history strip a reader takes this number to mean
    /// "how long this test took", and the run's wall time is a different
    /// quantity by orders of magnitude — a 1.5 ms case inside a 4210 ms suite.
    /// Reporting the run's time here would misstate it ~2800x for that case and
    /// would hide the very thing this view exists to reveal: a single test
    /// getting slower over time.
    pub case_duration_ms: Option<f64>,
    /// The whole run's wall time, kept alongside so a reader can see the case's
    /// share of it without a second query. Never render this as the case's own.
    pub run_duration_ms: Option<i64>,
    pub commit_sha: Option<String>,
    pub branch: Option<String>,
    pub source_sha: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct QaEvidenceView {
    pub id: Uuid,
    pub run_id: Uuid,
    pub kind: String,
    pub caption: Option<String>,
    pub body: Option<String>,
    pub mime_type: Option<String>,
    pub byte_size: Option<i64>,
    pub sort_order: i32,
    pub captured_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
}

/// A QA plan is a named, editable test-script *template* (Jest / Playwright /
/// Maestro source text) stored per project. It is not a run and OpenMemory
/// never executes it — see the module doc comment. Not to be confused with
/// the sibling qa-automation service's `qa_create_test_plan`, which does.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct QaPlanView {
    pub id: Uuid,
    pub project_id: Uuid,
    pub name: String,
    pub kind: String,
    pub language: String,
    pub description: Option<String>,
    pub body: String,
    pub created_by: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Format a QA plan list for MCP text responses, mirroring `library::format_list_text`.
pub fn format_plan_list_text(plans: &[QaPlanView]) -> String {
    let mut lines = Vec::new();
    if plans.is_empty() {
        lines.push("No QA plans.".to_string());
        lines.push("Add with qa_plan_create.".to_string());
    } else {
        lines.push(format!("QA plans ({}):", plans.len()));
        for p in plans {
            let desc = p
                .description
                .as_deref()
                .map(|d| format!(" — {}", d))
                .unwrap_or_default();
            lines.push(format!(
                "• {} ({}/{}) [{}]{}",
                p.name, p.kind, p.language, p.id, desc
            ));
        }
    }
    lines.join("\n")
}

pub async fn ensure_qa_tables(db: &PgPool) -> Result<()> {
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS project_qa_events (
            id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
            project_id  UUID        NOT NULL REFERENCES project_graphs(id) ON DELETE CASCADE,
            name        TEXT        NOT NULL CHECK (length(btrim(name)) > 0),
            created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        )
        "#,
    )
    .execute(db)
    .await
    .context("failed to create project_qa_events table")?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_project_qa_events_project_created ON project_qa_events(project_id, created_at DESC)")
        .execute(db).await.ok();

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS project_qa_runs (
            id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
            project_id    UUID        NOT NULL REFERENCES project_graphs(id) ON DELETE CASCADE,
            event_id      UUID        REFERENCES project_qa_events(id) ON DELETE SET NULL,
            task_id       UUID        REFERENCES project_tasks(id) ON DELETE SET NULL,
            title         TEXT        NOT NULL,
            status        TEXT        NOT NULL DEFAULT 'in_progress'
                              CHECK (status IN ('in_progress','passed','failed','blocked')),
            summary       TEXT,
            target        TEXT,
            external_ref  TEXT,
            created_by    TEXT        NOT NULL DEFAULT 'agent' CHECK (created_by IN ('agent','human')),
            started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
            finished_at   TIMESTAMPTZ,
            created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
            kind          TEXT        NOT NULL DEFAULT 'manual'
                                     CHECK (kind IN ('manual','unit','integration','api','e2e','load','other')),
            runner        TEXT,
            total_cases   INT         NOT NULL DEFAULT 0,
            passed_cases  INT         NOT NULL DEFAULT 0,
            failed_cases  INT         NOT NULL DEFAULT 0,
            skipped_cases INT         NOT NULL DEFAULT 0,
            duration_ms   BIGINT,
            commit_sha    TEXT,
            branch        TEXT
        )
        "#,
    )
    .execute(db)
    .await
    .context("failed to create project_qa_runs table")?;

    // Existing installations predate QA events. Keep their runs intact and
    // make the new relationship nullable so they remain visible as ungrouped.
    sqlx::query("ALTER TABLE project_qa_runs ADD COLUMN IF NOT EXISTS event_id UUID REFERENCES project_qa_events(id) ON DELETE SET NULL")
        .execute(db).await.ok();
    sqlx::query(
        "ALTER TABLE project_qa_runs ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'manual'",
    )
    .execute(db)
    .await
    .ok();
    sqlx::query("ALTER TABLE project_qa_runs ADD COLUMN IF NOT EXISTS runner TEXT")
        .execute(db)
        .await
        .ok();
    sqlx::query(
        "ALTER TABLE project_qa_runs ADD COLUMN IF NOT EXISTS total_cases INT NOT NULL DEFAULT 0",
    )
    .execute(db)
    .await
    .ok();
    sqlx::query(
        "ALTER TABLE project_qa_runs ADD COLUMN IF NOT EXISTS passed_cases INT NOT NULL DEFAULT 0",
    )
    .execute(db)
    .await
    .ok();
    sqlx::query(
        "ALTER TABLE project_qa_runs ADD COLUMN IF NOT EXISTS failed_cases INT NOT NULL DEFAULT 0",
    )
    .execute(db)
    .await
    .ok();
    sqlx::query(
        "ALTER TABLE project_qa_runs ADD COLUMN IF NOT EXISTS skipped_cases INT NOT NULL DEFAULT 0",
    )
    .execute(db)
    .await
    .ok();
    sqlx::query("ALTER TABLE project_qa_runs ADD COLUMN IF NOT EXISTS duration_ms BIGINT")
        .execute(db)
        .await
        .ok();
    sqlx::query("ALTER TABLE project_qa_runs ADD COLUMN IF NOT EXISTS commit_sha TEXT")
        .execute(db)
        .await
        .ok();
    sqlx::query("ALTER TABLE project_qa_runs ADD COLUMN IF NOT EXISTS branch TEXT")
        .execute(db)
        .await
        .ok();
    sqlx::query(
        r#"
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conname = 'project_qa_runs_kind_check'
                  AND conrelid = 'project_qa_runs'::regclass
            ) THEN
                ALTER TABLE project_qa_runs
                    ADD CONSTRAINT project_qa_runs_kind_check
                    CHECK (kind IN ('manual','unit','integration','api','e2e','load','other'));
            END IF;
        END $$
        "#,
    )
    .execute(db)
    .await
    .ok();

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_project_qa_runs_project_id ON project_qa_runs(project_id)",
    )
    .execute(db)
    .await
    .ok();
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_project_qa_runs_event_id ON project_qa_runs(event_id)",
    )
    .execute(db)
    .await
    .ok();
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_project_qa_runs_task_id ON project_qa_runs(task_id)",
    )
    .execute(db)
    .await
    .ok();
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_project_qa_runs_project_started ON project_qa_runs(project_id, started_at DESC)")
        .execute(db).await.ok();
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_project_qa_runs_project_kind_started ON project_qa_runs(project_id, kind, started_at DESC)")
        .execute(db).await.ok();

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS project_qa_test_cases (
            id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            run_id           UUID NOT NULL REFERENCES project_qa_runs(id) ON DELETE CASCADE,
            project_id       UUID NOT NULL REFERENCES project_graphs(id) ON DELETE CASCADE,
            case_key         TEXT NOT NULL,
            suite            TEXT,
            name             TEXT NOT NULL,
            file             TEXT,
            status           TEXT NOT NULL CHECK (status IN ('passed','failed','skipped','error')),
            duration_ms      DOUBLE PRECISION,
            failure_message  TEXT,
            failure_detail   TEXT,
            source_sha       TEXT,
            external_ref     TEXT,
            created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
        )
        "#,
    )
    .execute(db)
    .await
    .context("failed to create project_qa_test_cases table")?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_qa_cases_project_key_created ON project_qa_test_cases(project_id, case_key, created_at DESC)")
        .execute(db).await.ok();
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_qa_cases_run_status ON project_qa_test_cases(run_id, status)")
        .execute(db).await.ok();
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_qa_cases_project_failed ON project_qa_test_cases(project_id, created_at DESC) WHERE status IN ('failed','error')")
        .execute(db).await.ok();

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS project_qa_run_metrics (
            id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            run_id      UUID NOT NULL REFERENCES project_qa_runs(id) ON DELETE CASCADE,
            project_id  UUID NOT NULL REFERENCES project_graphs(id) ON DELETE CASCADE,
            metric_key  TEXT NOT NULL,
            value       DOUBLE PRECISION NOT NULL,
            unit        TEXT,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (run_id, metric_key)
        )
        "#,
    )
    .execute(db)
    .await
    .context("failed to create project_qa_run_metrics table")?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_qa_metrics_project_key_created ON project_qa_run_metrics(project_id, metric_key, created_at DESC)")
        .execute(db).await.ok();

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS project_qa_test_sources (
            project_id   UUID NOT NULL REFERENCES project_graphs(id) ON DELETE CASCADE,
            source_sha   TEXT NOT NULL,
            file         TEXT NOT NULL,
            language     TEXT,
            body         TEXT NOT NULL,
            byte_size    INT NOT NULL,
            first_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
            last_seen    TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (project_id, source_sha)
        )
        "#,
    )
    .execute(db)
    .await
    .context("failed to create project_qa_test_sources table")?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_qa_sources_project_file_last ON project_qa_test_sources(project_id, file, last_seen DESC)")
        .execute(db).await.ok();

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS project_qa_evidence (
            id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
            run_id       UUID        NOT NULL REFERENCES project_qa_runs(id) ON DELETE CASCADE,
            kind         TEXT        NOT NULL CHECK (kind IN ('image','text')),
            caption      TEXT,
            body         TEXT,
            mime_type    TEXT,
            byte_size    BIGINT,
            sort_order   INT         NOT NULL DEFAULT 0,
            captured_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
            created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
        )
        "#,
    )
    .execute(db)
    .await
    .context("failed to create project_qa_evidence table")?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_project_qa_evidence_run_sort ON project_qa_evidence(run_id, sort_order)")
        .execute(db).await.ok();

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS project_qa_plans (
            id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
            project_id   UUID        NOT NULL REFERENCES project_graphs(id) ON DELETE CASCADE,
            name         TEXT        NOT NULL CHECK (length(btrim(name)) > 0),
            kind         TEXT        NOT NULL DEFAULT 'jest'
                             CHECK (kind IN ('jest','playwright','maestro','other')),
            language     TEXT        NOT NULL DEFAULT 'typescript'
                             CHECK (language IN ('typescript','javascript','yaml','python','other')),
            description  TEXT,
            body         TEXT        NOT NULL DEFAULT '',
            created_by   TEXT        NOT NULL DEFAULT 'agent' CHECK (created_by IN ('agent','human')),
            created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
        )
        "#,
    )
    .execute(db)
    .await
    .context("failed to create project_qa_plans table")?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_project_qa_plans_project_updated ON project_qa_plans(project_id, updated_at DESC)")
        .execute(db).await.ok();

    Ok(())
}

fn validate_event_name(name: &str) -> Result<()> {
    if name.trim().is_empty() {
        anyhow::bail!("event name must not be empty");
    }
    Ok(())
}

pub async fn create_event(db: &PgPool, project_id: Uuid, name: &str) -> Result<QaEventView> {
    validate_event_name(name)?;
    let row: QaEventView = sqlx::query_as(
        "INSERT INTO project_qa_events (project_id, name) VALUES ($1, $2) RETURNING *",
    )
    .bind(project_id)
    .bind(name.trim())
    .fetch_one(db)
    .await
    .context("failed to create QA event")?;
    Ok(row)
}

pub async fn list_events(db: &PgPool, project_id: Uuid) -> Result<Vec<QaEventView>> {
    sqlx::query_as("SELECT * FROM project_qa_events WHERE project_id = $1 ORDER BY created_at DESC")
        .bind(project_id)
        .fetch_all(db)
        .await
        .context("failed to list QA events")
}

pub async fn update_event(
    db: &PgPool,
    event_id: Uuid,
    project_id: Option<Uuid>,
    name: Option<&str>,
) -> Result<Option<QaEventView>> {
    if let Some(value) = name {
        validate_event_name(value)?;
    }
    sqlx::query_as(
        r#"
        UPDATE project_qa_events
        SET name = COALESCE($1, name), updated_at = now()
        WHERE id = $2 AND ($3::uuid IS NULL OR project_id = $3)
        RETURNING *
        "#,
    )
    .bind(name.map(str::trim))
    .bind(event_id)
    .bind(project_id)
    .fetch_optional(db)
    .await
    .context("failed to update QA event")
}

pub async fn delete_event(db: &PgPool, event_id: Uuid, project_id: Option<Uuid>) -> Result<bool> {
    let result = sqlx::query(
        "DELETE FROM project_qa_events WHERE id = $1 AND ($2::uuid IS NULL OR project_id = $2)",
    )
    .bind(event_id)
    .bind(project_id)
    .execute(db)
    .await
    .context("failed to delete QA event")?;
    Ok(result.rows_affected() > 0)
}

async fn validate_event_for_project(db: &PgPool, event_id: Uuid, project_id: Uuid) -> Result<()> {
    let event_project_id: Option<Uuid> =
        sqlx::query_scalar("SELECT project_id FROM project_qa_events WHERE id = $1")
            .bind(event_id)
            .fetch_optional(db)
            .await
            .context("failed to validate QA event")?;

    match event_project_id {
        Some(owner) if owner == project_id => Ok(()),
        Some(_) => anyhow::bail!("event must belong to the same project as the QA run"),
        None => anyhow::bail!("QA event not found"),
    }
}

fn validate_status(status: &str) -> Result<()> {
    if !RUN_STATUSES.contains(&status) {
        anyhow::bail!("status must be one of: in_progress, passed, failed, blocked");
    }
    Ok(())
}

fn validate_run_kind(kind: &str) -> Result<()> {
    if !RUN_KINDS.contains(&kind) {
        anyhow::bail!("kind must be one of: manual, unit, integration, api, e2e, load, other");
    }
    Ok(())
}

fn validate_created_by(created_by: &str) -> Result<()> {
    if !CREATED_BY_VALUES.contains(&created_by) {
        anyhow::bail!("created_by must be 'agent' or 'human'");
    }
    Ok(())
}

fn validate_evidence_kind(kind: &str) -> Result<()> {
    if !EVIDENCE_KINDS.contains(&kind) {
        anyhow::bail!("kind must be 'image' or 'text'");
    }
    Ok(())
}

fn validate_plan_name(name: &str) -> Result<()> {
    if name.trim().is_empty() {
        anyhow::bail!("plan name must not be empty");
    }
    Ok(())
}

fn validate_plan_kind(kind: &str) -> Result<()> {
    if !PLAN_KINDS.contains(&kind) {
        anyhow::bail!("kind must be one of: jest, playwright, maestro, other");
    }
    Ok(())
}

fn validate_plan_language(language: &str) -> Result<()> {
    if !PLAN_LANGUAGES.contains(&language) {
        anyhow::bail!("language must be one of: typescript, javascript, yaml, python, other");
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub async fn create_run(
    db: &PgPool,
    project_id: Uuid,
    event_id: Option<Uuid>,
    task_id: Option<Uuid>,
    title: &str,
    kind: Option<&str>,
    status: Option<&str>,
    summary: Option<&str>,
    target: Option<&str>,
    external_ref: Option<&str>,
    created_by: Option<&str>,
) -> Result<QaRunView> {
    if title.trim().is_empty() {
        anyhow::bail!("title must not be empty");
    }
    let kind = kind.unwrap_or("manual");
    validate_run_kind(kind)?;
    let status = status.unwrap_or("in_progress");
    validate_status(status)?;
    let created_by = created_by.unwrap_or("agent");
    validate_created_by(created_by)?;
    if let Some(event_id) = event_id {
        validate_event_for_project(db, event_id, project_id).await?;
    }

    let row: QaRunView = sqlx::query_as(
        r#"
        INSERT INTO project_qa_runs
            (project_id, event_id, task_id, title, status, kind, summary, target, external_ref, created_by, finished_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CASE WHEN $5 = 'in_progress' THEN NULL ELSE now() END)
        RETURNING *
        "#,
    )
    .bind(project_id)
    .bind(event_id)
    .bind(task_id)
    .bind(title)
    .bind(status)
    .bind(kind)
    .bind(summary)
    .bind(target)
    .bind(external_ref)
    .bind(created_by)
    .fetch_one(db)
    .await
    .context("failed to create QA run")?;
    Ok(row)
}

pub async fn list_runs(
    db: &PgPool,
    project_id: Uuid,
    status: Option<&str>,
    task_id: Option<Uuid>,
    event_id: Option<Uuid>,
    kind: Option<&str>,
    limit: Option<i64>,
    offset: i64,
) -> Result<Vec<QaRunListItem>> {
    let limit = limit.unwrap_or(200).clamp(1, 500);
    let offset = offset.max(0);
    let rows: Vec<QaRunListItem> = sqlx::query_as(
        r#"
        SELECT r.*, evidence.evidence_count
        FROM project_qa_runs r
        LEFT JOIN LATERAL (
            SELECT count(*) AS evidence_count
            FROM project_qa_evidence e
            WHERE e.run_id = r.id
        ) evidence ON TRUE
        WHERE r.project_id = $1
          AND ($2::text IS NULL OR r.status = $2)
          AND ($3::uuid IS NULL OR r.task_id = $3)
          AND ($4::uuid IS NULL OR r.event_id = $4)
          AND ($5::text IS NULL OR r.kind = $5)
        ORDER BY r.started_at DESC
        LIMIT $6 OFFSET $7
        "#,
    )
    .bind(project_id)
    .bind(status)
    .bind(task_id)
    .bind(event_id)
    .bind(kind)
    .bind(limit)
    .bind(offset)
    .fetch_all(db)
    .await
    .context("failed to list QA runs")?;
    Ok(rows)
}

pub async fn list_cases(
    db: &PgPool,
    run_id: Uuid,
    status: Option<&str>,
    limit: Option<i64>,
    offset: i64,
) -> Result<(Vec<QaTestCaseView>, i64)> {
    let limit = limit.unwrap_or(200).clamp(1, 500);
    let offset = offset.max(0);
    let total: i64 = sqlx::query_scalar(
        r#"
        SELECT count(*)
        FROM project_qa_test_cases
        WHERE run_id = $1
          AND ($2::text IS NULL OR status = $2)
        "#,
    )
    .bind(run_id)
    .bind(status)
    .fetch_one(db)
    .await
    .context("failed to count QA test cases")?;

    let cases: Vec<QaTestCaseView> = sqlx::query_as(
        r#"
        SELECT *
        FROM project_qa_test_cases
        WHERE run_id = $1
          AND ($2::text IS NULL OR status = $2)
        ORDER BY CASE WHEN status IN ('failed','error') THEN 0 ELSE 1 END, name
        LIMIT $3 OFFSET $4
        "#,
    )
    .bind(run_id)
    .bind(status)
    .bind(limit)
    .bind(offset)
    .fetch_all(db)
    .await
    .context("failed to list QA test cases")?;

    Ok((cases, total))
}

pub async fn case_history(
    db: &PgPool,
    project_id: Uuid,
    case_key: &str,
    limit: Option<i64>,
) -> Result<Vec<QaCaseHistoryView>> {
    let limit = limit.unwrap_or(50).clamp(1, 500);
    sqlx::query_as(
        r#"
        SELECT r.id AS run_id,
               r.started_at,
               c.status,
               c.duration_ms AS case_duration_ms,
               r.duration_ms AS run_duration_ms,
               r.commit_sha,
               r.branch,
               c.source_sha
        FROM project_qa_test_cases c
        INNER JOIN project_qa_runs r ON r.id = c.run_id
        WHERE c.project_id = $1
          AND c.case_key = $2
          AND r.project_id = $1
        ORDER BY c.created_at DESC
        LIMIT $3
        "#,
    )
    .bind(project_id)
    .bind(case_key)
    .bind(limit)
    .fetch_all(db)
    .await
    .context("failed to fetch QA case history")
}

pub async fn list_metrics(
    db: &PgPool,
    project_id: Uuid,
    metric_key: Option<&str>,
    run_id: Option<Uuid>,
    limit: Option<i64>,
) -> Result<Vec<QaRunMetricView>> {
    let limit = limit.unwrap_or(200).clamp(1, 500);
    sqlx::query_as(
        r#"
        SELECT *
        FROM project_qa_run_metrics
        WHERE project_id = $1
          AND ($2::text IS NULL OR metric_key = $2)
          AND ($3::uuid IS NULL OR run_id = $3)
        ORDER BY created_at DESC
        LIMIT $4
        "#,
    )
    .bind(project_id)
    .bind(metric_key)
    .bind(run_id)
    .bind(limit)
    .fetch_all(db)
    .await
    .context("failed to list QA run metrics")
}

pub async fn get_source(
    db: &PgPool,
    project_id: Uuid,
    source_sha: &str,
) -> Result<Option<QaTestSourceView>> {
    sqlx::query_as(
        "SELECT * FROM project_qa_test_sources WHERE project_id = $1 AND source_sha = $2",
    )
    .bind(project_id)
    .bind(source_sha)
    .fetch_optional(db)
    .await
    .context("failed to fetch QA test source")
}

/// `project_id: None` skips project scoping (the MCP tools address a run
/// directly by id); `Some(id)` requires the run to belong to that project (the
/// HTTP routes, which must 404 rather than leak a foreign run).
pub async fn get_run(
    db: &PgPool,
    run_id: Uuid,
    project_id: Option<Uuid>,
) -> Result<Option<QaRunView>> {
    let row: Option<QaRunView> = sqlx::query_as(
        "SELECT * FROM project_qa_runs WHERE id = $1 AND ($2::uuid IS NULL OR project_id = $2)",
    )
    .bind(run_id)
    .bind(project_id)
    .fetch_optional(db)
    .await
    .context("failed to fetch QA run")?;
    Ok(row)
}

/// Just the project id for a run, with no existence-vs-ownership distinction —
/// used by `qa_evidence_add` (Finding 1) to resolve the blob URL, since that
/// tool's arguments carry `run_id` but no `project_id`.
pub async fn run_project_id(db: &PgPool, run_id: Uuid) -> Result<Option<Uuid>> {
    let row: Option<(Uuid,)> =
        sqlx::query_as("SELECT project_id FROM project_qa_runs WHERE id = $1")
            .bind(run_id)
            .fetch_optional(db)
            .await
            .context("failed to look up QA run's project")?;
    Ok(row.map(|(pid,)| pid))
}

/// Tri-state update fields (`summary`, `target`, `task_id`, `external_ref`,
/// `event_id`) follow
/// the same `Option<Option<T>>` idiom as `UpdateTaskPayload`/`UpdateDesignPayload`
/// in `main.rs`: `None` = leave untouched, `Some(None)` = clear to NULL,
/// `Some(Some(v))` = set. `project_id` is the scoping switch described on
/// `get_run`. `finished_at` follows the spec's state machine: leaving
/// `in_progress` sets it to `now()` if not already set; returning to
/// `in_progress` clears it; not touching `status` leaves it alone.
/// `project_id` is never updated, and there is deliberately no project-
/// reassignment path: `project_qa_test_cases.project_id` is denormalized and
/// depends on each run retaining its original project.
#[allow(clippy::too_many_arguments)]
pub async fn update_run(
    db: &PgPool,
    run_id: Uuid,
    project_id: Option<Uuid>,
    title: Option<&str>,
    status: Option<&str>,
    kind: Option<&str>,
    event_id: Option<Option<Uuid>>,
    summary: Option<Option<&str>>,
    target: Option<Option<&str>>,
    task_id: Option<Option<Uuid>>,
    external_ref: Option<Option<&str>>,
) -> Result<Option<QaRunView>> {
    if let Some(s) = status {
        validate_status(s)?;
    }
    if let Some(k) = kind {
        validate_run_kind(k)?;
    }

    if let Some(Some(event_id)) = event_id {
        let run_project_id = match project_id {
            Some(project_id) => project_id,
            None => run_project_id(db, run_id)
                .await?
                .with_context(|| format!("QA run '{}' not found", run_id))?,
        };
        validate_event_for_project(db, event_id, run_project_id).await?;
    }

    let event_id_set = event_id.is_some();
    let event_id_val = event_id.flatten();
    let summary_set = summary.is_some();
    let summary_val = summary.flatten();
    let target_set = target.is_some();
    let target_val = target.flatten();
    let task_id_set = task_id.is_some();
    let task_id_val = task_id.flatten();
    let external_ref_set = external_ref.is_some();
    let external_ref_val = external_ref.flatten();

    let row: Option<QaRunView> = sqlx::query_as(
        r#"
        UPDATE project_qa_runs SET
            title = COALESCE($1, title),
            status = COALESCE($2, status),
            kind = COALESCE($3, kind),
            event_id = CASE WHEN $4 THEN $5 ELSE event_id END,
            summary = CASE WHEN $6 THEN $7 ELSE summary END,
            target = CASE WHEN $8 THEN $9 ELSE target END,
            task_id = CASE WHEN $10 THEN $11 ELSE task_id END,
            external_ref = CASE WHEN $12 THEN $13 ELSE external_ref END,
            finished_at = CASE
                WHEN $2::text IS NULL THEN finished_at
                WHEN $2 = 'in_progress' THEN NULL
                ELSE COALESCE(finished_at, now())
            END,
            updated_at = now()
        WHERE id = $14 AND ($15::uuid IS NULL OR project_id = $15)
        RETURNING *
        "#,
    )
    .bind(title)
    .bind(status)
    .bind(kind)
    .bind(event_id_set)
    .bind(event_id_val)
    .bind(summary_set)
    .bind(summary_val)
    .bind(target_set)
    .bind(target_val)
    .bind(task_id_set)
    .bind(task_id_val)
    .bind(external_ref_set)
    .bind(external_ref_val)
    .bind(run_id)
    .bind(project_id)
    .fetch_optional(db)
    .await
    .context("failed to update QA run")?;
    Ok(row)
}

/// Deletes a run (evidence rows cascade at the DB level) and returns the ids of
/// the evidence it had, so the caller can unlink their blob files — but only
/// when the delete actually happened. The evidence ids are looked up *before*
/// the delete and simply discarded if the delete affects no row (wrong project
/// scope), so a failed/rejected delete never drives a filesystem touch.
pub async fn delete_run(
    db: &PgPool,
    run_id: Uuid,
    project_id: Option<Uuid>,
) -> Result<Option<Vec<Uuid>>> {
    let evidence_ids: Vec<Uuid> =
        sqlx::query_scalar("SELECT id FROM project_qa_evidence WHERE run_id = $1")
            .bind(run_id)
            .fetch_all(db)
            .await
            .context("failed to look up QA run's evidence before delete")?;

    let result = sqlx::query(
        "DELETE FROM project_qa_runs WHERE id = $1 AND ($2::uuid IS NULL OR project_id = $2)",
    )
    .bind(run_id)
    .bind(project_id)
    .execute(db)
    .await
    .context("failed to delete QA run")?;

    if result.rows_affected() == 0 {
        Ok(None)
    } else {
        Ok(Some(evidence_ids))
    }
}

/// `kind == "text"` requires a non-empty `body`; `kind == "image"` must not
/// carry one (the row awaits its blob via a separate `PUT .../blob` call) —
/// caught here explicitly rather than silently dropped, so a caller mixing the
/// two up gets a clear error instead of quietly losing data.
pub async fn add_evidence(
    db: &PgPool,
    run_id: Uuid,
    kind: &str,
    caption: Option<&str>,
    body: Option<&str>,
    captured_at: Option<DateTime<Utc>>,
    sort_order: Option<i32>,
) -> Result<QaEvidenceView> {
    validate_evidence_kind(kind)?;
    let body = if kind == "text" {
        let b = body.filter(|b| !b.trim().is_empty());
        if b.is_none() {
            anyhow::bail!("text evidence requires a non-empty body");
        }
        b
    } else {
        if body.is_some() {
            anyhow::bail!("image evidence must not include a body");
        }
        None
    };
    let captured_at = captured_at.unwrap_or_else(Utc::now);
    let sort_order = sort_order.unwrap_or(0);

    let row: QaEvidenceView = sqlx::query_as(
        r#"
        INSERT INTO project_qa_evidence (run_id, kind, caption, body, sort_order, captured_at)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *
        "#,
    )
    .bind(run_id)
    .bind(kind)
    .bind(caption)
    .bind(body)
    .bind(sort_order)
    .bind(captured_at)
    .fetch_one(db)
    .await
    .context("failed to add QA evidence")?;
    Ok(row)
}

pub async fn list_evidence(db: &PgPool, run_id: Uuid) -> Result<Vec<QaEvidenceView>> {
    let rows: Vec<QaEvidenceView> = sqlx::query_as(
        "SELECT * FROM project_qa_evidence WHERE run_id = $1 \
         ORDER BY sort_order ASC, captured_at ASC, created_at ASC",
    )
    .bind(run_id)
    .fetch_all(db)
    .await
    .context("failed to list QA evidence")?;
    Ok(rows)
}

pub async fn get_evidence(db: &PgPool, evidence_id: Uuid) -> Result<Option<QaEvidenceView>> {
    let row: Option<QaEvidenceView> =
        sqlx::query_as("SELECT * FROM project_qa_evidence WHERE id = $1")
            .bind(evidence_id)
            .fetch_optional(db)
            .await
            .context("failed to fetch QA evidence")?;
    Ok(row)
}

/// Same `project_id` scoping switch as `get_run`/`update_run`, but evidence's
/// ownership chain is `evidence → run → project`, so the scoped branch is an
/// `EXISTS` join through `project_qa_runs` rather than a direct column match.
pub async fn update_evidence(
    db: &PgPool,
    evidence_id: Uuid,
    project_id: Option<Uuid>,
    caption: Option<Option<&str>>,
    body: Option<Option<&str>>,
    sort_order: Option<i32>,
    captured_at: Option<DateTime<Utc>>,
) -> Result<Option<QaEvidenceView>> {
    let caption_set = caption.is_some();
    let caption_val = caption.flatten();
    let body_set = body.is_some();
    let body_val = body.flatten();

    let row: Option<QaEvidenceView> = sqlx::query_as(
        r#"
        UPDATE project_qa_evidence e SET
            caption = CASE WHEN $1 THEN $2 ELSE caption END,
            body = CASE WHEN $3 THEN $4 ELSE body END,
            sort_order = COALESCE($5, sort_order),
            captured_at = COALESCE($6, captured_at)
        WHERE e.id = $7
          AND ($8::uuid IS NULL OR EXISTS (
                SELECT 1 FROM project_qa_runs r WHERE r.id = e.run_id AND r.project_id = $8
          ))
        RETURNING e.*
        "#,
    )
    .bind(caption_set)
    .bind(caption_val)
    .bind(body_set)
    .bind(body_val)
    .bind(sort_order)
    .bind(captured_at)
    .bind(evidence_id)
    .bind(project_id)
    .fetch_optional(db)
    .await
    .context("failed to update QA evidence")?;
    Ok(row)
}

pub async fn delete_evidence(
    db: &PgPool,
    evidence_id: Uuid,
    project_id: Option<Uuid>,
) -> Result<bool> {
    let result = sqlx::query(
        r#"
        DELETE FROM project_qa_evidence e
        WHERE e.id = $1
          AND ($2::uuid IS NULL OR EXISTS (
                SELECT 1 FROM project_qa_runs r WHERE r.id = e.run_id AND r.project_id = $2
          ))
        "#,
    )
    .bind(evidence_id)
    .bind(project_id)
    .execute(db)
    .await
    .context("failed to delete QA evidence")?;
    Ok(result.rows_affected() > 0)
}

#[allow(clippy::too_many_arguments)]
pub async fn create_plan(
    db: &PgPool,
    project_id: Uuid,
    name: &str,
    kind: Option<&str>,
    language: Option<&str>,
    description: Option<&str>,
    body: Option<&str>,
    created_by: Option<&str>,
) -> Result<QaPlanView> {
    validate_plan_name(name)?;
    let kind = kind.unwrap_or("jest");
    validate_plan_kind(kind)?;
    let language = language.unwrap_or("typescript");
    validate_plan_language(language)?;
    let created_by = created_by.unwrap_or("agent");
    validate_created_by(created_by)?;
    let body = body.unwrap_or("");

    let row: QaPlanView = sqlx::query_as(
        r#"
        INSERT INTO project_qa_plans (project_id, name, kind, language, description, body, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *
        "#,
    )
    .bind(project_id)
    .bind(name.trim())
    .bind(kind)
    .bind(language)
    .bind(description)
    .bind(body)
    .bind(created_by)
    .fetch_one(db)
    .await
    .context("failed to create QA plan")?;
    Ok(row)
}

pub async fn list_plans(
    db: &PgPool,
    project_id: Uuid,
    kind: Option<&str>,
) -> Result<Vec<QaPlanView>> {
    let rows: Vec<QaPlanView> = sqlx::query_as(
        r#"
        SELECT * FROM project_qa_plans
        WHERE project_id = $1
          AND ($2::text IS NULL OR kind = $2)
        ORDER BY updated_at DESC
        "#,
    )
    .bind(project_id)
    .bind(kind)
    .fetch_all(db)
    .await
    .context("failed to list QA plans")?;
    Ok(rows)
}

/// `project_id: None` skips project scoping (the MCP tools address a plan
/// directly by id); `Some(id)` requires the plan to belong to that project (the
/// HTTP routes, which must 404 rather than leak a foreign plan).
pub async fn get_plan(
    db: &PgPool,
    plan_id: Uuid,
    project_id: Option<Uuid>,
) -> Result<Option<QaPlanView>> {
    let row: Option<QaPlanView> = sqlx::query_as(
        "SELECT * FROM project_qa_plans WHERE id = $1 AND ($2::uuid IS NULL OR project_id = $2)",
    )
    .bind(plan_id)
    .bind(project_id)
    .fetch_optional(db)
    .await
    .context("failed to fetch QA plan")?;
    Ok(row)
}

/// `name`/`kind`/`language`/`body` are NOT NULL columns, so a plain
/// `Option<&str>` + `COALESCE` says everything needed: `None` = leave
/// untouched, `Some(v)` = set. `description` is nullable, so it follows the
/// `Option<Option<T>>` tri-state used elsewhere in this module (`None` = leave
/// untouched, `Some(None)` = clear to NULL, `Some(Some(v))` = set).
/// `project_id` is the scoping switch described on `get_plan`.
pub async fn update_plan(
    db: &PgPool,
    plan_id: Uuid,
    project_id: Option<Uuid>,
    name: Option<&str>,
    kind: Option<&str>,
    language: Option<&str>,
    description: Option<Option<&str>>,
    body: Option<&str>,
) -> Result<Option<QaPlanView>> {
    if let Some(value) = name {
        validate_plan_name(value)?;
    }
    if let Some(value) = kind {
        validate_plan_kind(value)?;
    }
    if let Some(value) = language {
        validate_plan_language(value)?;
    }

    let description_set = description.is_some();
    let description_val = description.flatten();

    let row: Option<QaPlanView> = sqlx::query_as(
        r#"
        UPDATE project_qa_plans SET
            name = COALESCE($1, name),
            kind = COALESCE($2, kind),
            language = COALESCE($3, language),
            description = CASE WHEN $4 THEN $5 ELSE description END,
            body = COALESCE($6, body),
            updated_at = now()
        WHERE id = $7 AND ($8::uuid IS NULL OR project_id = $8)
        RETURNING *
        "#,
    )
    .bind(name.map(str::trim))
    .bind(kind)
    .bind(language)
    .bind(description_set)
    .bind(description_val)
    .bind(body)
    .bind(plan_id)
    .bind(project_id)
    .fetch_optional(db)
    .await
    .context("failed to update QA plan")?;
    Ok(row)
}

pub async fn delete_plan(db: &PgPool, plan_id: Uuid, project_id: Option<Uuid>) -> Result<bool> {
    let result = sqlx::query(
        "DELETE FROM project_qa_plans WHERE id = $1 AND ($2::uuid IS NULL OR project_id = $2)",
    )
    .bind(plan_id)
    .bind(project_id)
    .execute(db)
    .await
    .context("failed to delete QA plan")?;
    Ok(result.rows_affected() > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blob_path_uses_evidence_id_as_filename() {
        let id = Uuid::parse_str("11111111-2222-3333-4444-555555555555").unwrap();
        let path = blob_path(Path::new("/data/qa-blobs"), id);
        assert_eq!(
            path,
            PathBuf::from("/data/qa-blobs/11111111-2222-3333-4444-555555555555.bin")
        );
    }

    #[test]
    fn blob_path_cannot_escape_root() {
        // A Uuid can only render as hex + dashes, so traversal is structurally
        // impossible. This test documents and locks that guarantee.
        let id = Uuid::new_v4();
        let root = Path::new("/data/qa-blobs");
        let path = blob_path(root, id);
        assert!(path.starts_with(root));
        assert!(!path.to_string_lossy().contains(".."));
    }

    #[test]
    fn temp_paths_for_same_evidence_id_are_unique_per_call() {
        // Regression test for the concurrent-write race: two writes for the same
        // evidence_id must never compute the same temp path, or their writes
        // could interleave and the eventual rename could land a corrupted file.
        let root = Path::new("/data/qa-blobs");
        let evidence_id = Uuid::new_v4();
        let temp_a = temp_blob_path(root, evidence_id);
        let temp_b = temp_blob_path(root, evidence_id);
        assert_ne!(temp_a, temp_b);
        assert!(temp_a.starts_with(root));
        let file_name = temp_a.file_name().unwrap().to_string_lossy().into_owned();
        assert!(file_name.starts_with(&format!("{evidence_id}.")));
        assert!(file_name.ends_with(".bin.tmp"));
    }

    #[test]
    fn sniffs_png_magic_bytes() {
        let mut bytes: Vec<u8> = vec![0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n'];
        bytes.extend_from_slice(&[0, 0, 0, 0]);
        assert_eq!(sniff_image_mime(&bytes), Some("image/png"));
    }

    #[test]
    fn sniffs_jpeg_magic_bytes() {
        let bytes: [u8; 6] = [0xFF, 0xD8, 0xFF, 0xE0, 0, 0];
        assert_eq!(sniff_image_mime(&bytes), Some("image/jpeg"));
    }

    #[test]
    fn sniffs_webp_magic_bytes() {
        let mut bytes = b"RIFF".to_vec();
        bytes.extend_from_slice(&[0, 0, 0, 0]); // container size, irrelevant to sniffing
        bytes.extend_from_slice(b"WEBP");
        assert_eq!(sniff_image_mime(&bytes), Some("image/webp"));
    }

    #[test]
    fn rejects_non_image_bytes() {
        assert_eq!(sniff_image_mime(b"not an image"), None);
        assert_eq!(sniff_image_mime(b""), None);
        assert_eq!(sniff_image_mime(b"RIFF...."), None); // too short to reach the WEBP marker
    }

    #[test]
    fn validates_run_status() {
        assert!(validate_status("passed").is_ok());
        assert!(validate_status("bogus")
            .unwrap_err()
            .to_string()
            .contains("status"));
    }

    #[test]
    fn validates_event_name() {
        assert!(validate_event_name("before deploy v1.0.0").is_ok());
        assert!(validate_event_name("  ")
            .unwrap_err()
            .to_string()
            .contains("event name"));
    }

    #[test]
    fn validates_created_by() {
        assert!(validate_created_by("human").is_ok());
        assert!(validate_created_by("robot").is_err());
    }

    #[test]
    fn validates_evidence_kind() {
        assert!(validate_evidence_kind("text").is_ok());
        assert!(validate_evidence_kind("video").is_err());
    }

    #[test]
    fn validates_plan_name() {
        assert!(validate_plan_name("Login flow").is_ok());
        assert!(validate_plan_name("  ")
            .unwrap_err()
            .to_string()
            .contains("plan name"));
    }

    #[test]
    fn validates_plan_kind() {
        assert!(validate_plan_kind("playwright").is_ok());
        assert!(validate_plan_kind("cypress").is_err());
    }

    #[test]
    fn validates_plan_language() {
        assert!(validate_plan_language("typescript").is_ok());
        assert!(validate_plan_language("rust").is_err());
    }
}
