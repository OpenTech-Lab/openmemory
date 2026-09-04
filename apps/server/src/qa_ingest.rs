//! Of the run kinds `manual|unit|integration|api|e2e|load|other`, the sibling
//! qa-automation service can produce results for `e2e` only — it runs Playwright
//! (browser) and Maestro (native Android) and nothing else, and it has no path
//! to ingest results produced anywhere else. `unit`, `integration`, `api` and
//! `load` therefore have exactly one route into OpenMemory: this module.
//!
//! This module accepts the format-neutral JSON envelope produced by test
//! runners. XML parsing deliberately lives outside the server; the server only
//! validates and persists normalized results.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use axum::{
    extract::{Path as AxumPath, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    Json,
};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, PgPool};
use tracing::error;
use uuid::Uuid;

use crate::{is_authenticated, qa, AppState};

const CASE_STATUSES: [&str; 4] = ["passed", "failed", "skipped", "error"];
const MAX_FAILURE_DETAIL_BYTES: usize = 8 * 1024;
const DEFAULT_CASE_RETENTION_DAYS: i64 = 90;
const REPO_RELATIVE_MARKERS: [&str; 8] = [
    "apps", "packages", "crates", "src", "tests", "test", "lib", "scripts",
];

/// The normalized envelope accepted by the HTTP ingest route.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub(crate) struct IngestEnvelope {
    pub(crate) title: String,
    pub(crate) kind: String,
    pub(crate) runner: Option<String>,
    pub(crate) started_at: Option<DateTime<Utc>>,
    pub(crate) finished_at: Option<DateTime<Utc>>,
    pub(crate) duration_ms: Option<i64>,
    pub(crate) commit_sha: Option<String>,
    pub(crate) branch: Option<String>,
    pub(crate) event_id: Option<Uuid>,
    pub(crate) task_id: Option<Uuid>,
    pub(crate) external_ref: Option<String>,
    #[serde(default)]
    pub(crate) cases: Vec<IngestCase>,
    #[serde(default)]
    pub(crate) metrics: Vec<IngestMetric>,
    #[serde(default)]
    pub(crate) sources: Vec<IngestSource>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub(crate) struct IngestCase {
    pub(crate) suite: Option<String>,
    pub(crate) name: String,
    pub(crate) file: Option<String>,
    pub(crate) status: String,
    pub(crate) duration_ms: Option<f64>,
    pub(crate) failure_message: Option<String>,
    pub(crate) failure_detail: Option<String>,
    pub(crate) source_sha: Option<String>,
    pub(crate) external_ref: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub(crate) struct IngestMetric {
    pub(crate) metric_key: String,
    pub(crate) value: f64,
    pub(crate) unit: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub(crate) struct IngestSource {
    pub(crate) source_sha: String,
    pub(crate) file: String,
    pub(crate) language: Option<String>,
    pub(crate) body: String,
    pub(crate) byte_size: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CaseCounters {
    total_cases: i32,
    passed_cases: i32,
    failed_cases: i32,
    skipped_cases: i32,
}

fn derive_status_and_counters(cases: &[IngestCase]) -> (&'static str, CaseCounters) {
    let mut counters = CaseCounters {
        total_cases: cases.len() as i32,
        passed_cases: 0,
        failed_cases: 0,
        skipped_cases: 0,
    };

    for case in cases {
        match case.status.as_str() {
            "passed" => counters.passed_cases += 1,
            "failed" | "error" => counters.failed_cases += 1,
            "skipped" => counters.skipped_cases += 1,
            // Validation runs before this helper in the ingest path. Keeping
            // unknown values out of the arithmetic also makes this helper's
            // server-derived behavior explicit.
            _ => {}
        }
    }

    let status = if counters.failed_cases > 0 {
        "failed"
    } else {
        "passed"
    };
    (status, counters)
}

fn validate_envelope(envelope: &IngestEnvelope) -> Result<()> {
    if envelope.title.trim().is_empty() {
        anyhow::bail!("title must not be empty");
    }
    if !qa::RUN_KINDS.contains(&envelope.kind.as_str()) {
        anyhow::bail!("kind must be one of: manual, unit, integration, api, e2e, load, other");
    }

    for case in &envelope.cases {
        if !CASE_STATUSES.contains(&case.status.as_str()) {
            anyhow::bail!("case status must be one of: passed, failed, skipped, error");
        }
        if case.name.trim().is_empty() {
            anyhow::bail!("case name must not be empty");
        }
    }

    for metric in &envelope.metrics {
        if metric.metric_key.trim().is_empty() {
            anyhow::bail!("metric_key must not be empty");
        }
    }

    for source in &envelope.sources {
        if source.source_sha.trim().is_empty() {
            anyhow::bail!("source_sha must not be empty");
        }
        if source.file.trim().is_empty() {
            anyhow::bail!("source file must not be empty");
        }
        if source.byte_size < 0 {
            anyhow::bail!("source byte_size must not be negative");
        }
    }

    Ok(())
}

fn is_absolute_path(path: &str) -> bool {
    path.starts_with('/')
        || (path.len() >= 3
            && path.as_bytes()[0].is_ascii_alphabetic()
            && path.as_bytes()[1] == b':'
            && matches!(path.as_bytes()[2], b'/' | b'\\'))
}

/// Normalize a path against the registered project root where possible. The
/// marker fallback is for a producer on another machine whose absolute root
/// cannot equal the server's registered root; normal producers should send a
/// repo-relative path already.
fn normalize_repo_relative_path(file: &str, repo_root: Option<&Path>) -> String {
    let normalized = file.replace('\\', "/");
    let normalized = normalized.trim_start_matches("./");

    if let Some(root) = repo_root {
        let root = root.to_string_lossy().replace('\\', "/");
        let root = root.trim_end_matches('/');
        if normalized == root {
            return String::new();
        }
        if let Some(relative) = normalized.strip_prefix(&format!("{root}/")) {
            return relative.to_string();
        }
    }

    if is_absolute_path(normalized) {
        let components: Vec<&str> = normalized
            .split('/')
            .filter(|part| !part.is_empty())
            .collect();
        if let Some(index) = components
            .iter()
            .position(|component| REPO_RELATIVE_MARKERS.contains(component))
        {
            return components[index..].join("/");
        }
        return normalized.trim_start_matches('/').to_string();
    }

    normalized.to_string()
}

fn normalize_file(file: Option<&str>, repo_root: Option<&Path>) -> Option<String> {
    let file = file?.trim();
    if file.is_empty() {
        return None;
    }
    Some(normalize_repo_relative_path(file, repo_root))
}

fn build_case_key(
    file: Option<&str>,
    suite: Option<&str>,
    name: &str,
    repo_root: Option<&Path>,
) -> String {
    let file = normalize_file(file, repo_root);
    let parts = [file.as_deref(), suite, Some(name)]
        .into_iter()
        .flatten()
        .filter(|part| !part.trim().is_empty())
        .collect::<Vec<_>>();
    let full_key = parts.join("::");
    truncate_case_key(&full_key)
}

fn truncate_case_key(full_key: &str) -> String {
    if full_key.chars().count() <= 480 {
        return full_key.to_string();
    }

    let prefix: String = full_key.chars().take(480).collect();
    let digest = format!("{:x}", Sha256::digest(full_key.as_bytes()));
    format!("{prefix}#{}", &digest[..8])
}

fn truncate_utf8(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }

    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_string()
}

#[derive(Debug)]
struct PreparedCase {
    case_key: String,
    suite: Option<String>,
    name: String,
    file: Option<String>,
    status: String,
    duration_ms: Option<f64>,
    failure_message: Option<String>,
    failure_detail: Option<String>,
    source_sha: Option<String>,
    external_ref: Option<String>,
}

fn prepare_cases(cases: Vec<IngestCase>, repo_root: Option<&Path>) -> Vec<PreparedCase> {
    cases
        .into_iter()
        .map(|case| {
            let file = normalize_file(case.file.as_deref(), repo_root);
            PreparedCase {
                case_key: build_case_key(file.as_deref(), case.suite.as_deref(), &case.name, None),
                suite: case.suite,
                name: case.name,
                file,
                status: case.status,
                duration_ms: case.duration_ms,
                failure_message: case.failure_message,
                failure_detail: case
                    .failure_detail
                    .as_deref()
                    .map(|detail| truncate_utf8(detail, MAX_FAILURE_DETAIL_BYTES)),
                source_sha: case.source_sha,
                external_ref: case.external_ref,
            }
        })
        .collect()
}

fn prepare_sources(sources: Vec<IngestSource>, repo_root: Option<&Path>) -> Vec<IngestSource> {
    sources
        .into_iter()
        .map(|mut source| {
            source.file = normalize_repo_relative_path(&source.file, repo_root);
            source
        })
        .collect()
}

async fn project_repo_root(db: &PgPool, project_id: Uuid) -> Result<Option<PathBuf>> {
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT COALESCE(canonical_path, path, '') FROM project_graphs WHERE id = $1",
    )
    .bind(project_id)
    .fetch_optional(db)
    .await
    .context("failed to load project root for QA ingest")?;
    Ok(row.and_then(|(path,)| (!path.is_empty()).then(|| PathBuf::from(path))))
}

async fn validate_event_for_project(db: &PgPool, event_id: Uuid, project_id: Uuid) -> Result<()> {
    let owner: Option<Uuid> =
        sqlx::query_scalar("SELECT project_id FROM project_qa_events WHERE id = $1")
            .bind(event_id)
            .fetch_optional(db)
            .await
            .context("failed to validate QA event for ingest")?;

    match owner {
        Some(owner) if owner == project_id => Ok(()),
        Some(_) => anyhow::bail!("event must belong to the same project as the QA run"),
        None => anyhow::bail!("QA event not found"),
    }
}

/// A run/case snapshot supplied to the pure retention selector. Database
/// queries only gather these inputs; the policy itself lives in
/// cases_to_prune.
#[derive(Debug, Clone, PartialEq, Eq, FromRow)]
struct RetentionCaseCandidate {
    id: Uuid,
    created_at: DateTime<Utc>,
    case_status: String,
    run_event_id: Option<Uuid>,
    run_task_id: Option<Uuid>,
    run_has_evidence: bool,
    run_status: String,
    run_kind: String,
}

fn cases_to_prune(candidates: &[RetentionCaseCandidate], cutoff: DateTime<Utc>) -> Vec<Uuid> {
    candidates
        .iter()
        .filter(|candidate| {
            candidate.created_at < cutoff
                && matches!(candidate.case_status.as_str(), "passed" | "skipped")
                && candidate.run_event_id.is_none()
                && candidate.run_task_id.is_none()
                && !candidate.run_has_evidence
                && candidate.run_status != "failed"
                && candidate.run_kind != "manual"
        })
        .map(|candidate| candidate.id)
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq, FromRow)]
struct SourceRetentionCandidate {
    source_sha: String,
    last_seen: DateTime<Utc>,
    has_live_case: bool,
}

fn sources_to_prune(candidates: &[SourceRetentionCandidate], cutoff: DateTime<Utc>) -> Vec<String> {
    candidates
        .iter()
        .filter(|candidate| candidate.last_seen < cutoff && !candidate.has_live_case)
        .map(|candidate| candidate.source_sha.clone())
        .collect()
}

async fn prune_qa_history(db: &PgPool, project_id: Uuid) -> Result<()> {
    let retention_days = qa_case_retention_days();
    if retention_days == 0 {
        return Ok(());
    }
    let cutoff = Utc::now() - Duration::days(retention_days);

    let candidates: Vec<RetentionCaseCandidate> = sqlx::query_as(
        r#"
        SELECT c.id,
               c.created_at,
               c.status AS case_status,
               r.event_id AS run_event_id,
               r.task_id AS run_task_id,
               EXISTS (
                   SELECT 1
                   FROM project_qa_evidence e
                   WHERE e.run_id = r.id
               ) AS run_has_evidence,
               r.status AS run_status,
               r.kind AS run_kind
        FROM project_qa_test_cases c
        INNER JOIN project_qa_runs r ON r.id = c.run_id
        WHERE c.project_id = $1
          AND c.created_at < $2
          AND c.status IN ('passed', 'skipped')
        "#,
    )
    .bind(project_id)
    .bind(cutoff)
    .fetch_all(db)
    .await
    .context("failed to select QA cases for retention")?;

    let case_ids = cases_to_prune(&candidates, cutoff);
    if !case_ids.is_empty() {
        sqlx::query(
            r#"
            DELETE FROM project_qa_test_cases AS c
            USING project_qa_runs AS r
            WHERE c.id = ANY($1::uuid[])
              AND c.project_id = $2
              AND c.run_id = r.id
              AND c.created_at < $3
              AND c.status IN ('passed', 'skipped')
              AND r.event_id IS NULL
              AND r.task_id IS NULL
              AND r.status <> 'failed'
              AND r.kind <> 'manual'
              AND NOT EXISTS (
                  SELECT 1
                  FROM project_qa_evidence e
                  WHERE e.run_id = r.id
              )
            "#,
        )
        .bind(&case_ids)
        .bind(project_id)
        .bind(cutoff)
        .execute(db)
        .await
        .context("failed to delete retained QA cases")?;
    }

    let source_candidates: Vec<SourceRetentionCandidate> = sqlx::query_as(
        r#"
        SELECT s.source_sha,
               s.last_seen,
               EXISTS (
                   SELECT 1
                   FROM project_qa_test_cases c
                   WHERE c.project_id = s.project_id
                     AND c.source_sha = s.source_sha
               ) AS has_live_case
        FROM project_qa_test_sources s
        WHERE s.project_id = $1
          AND s.last_seen < $2
        "#,
    )
    .bind(project_id)
    .bind(cutoff)
    .fetch_all(db)
    .await
    .context("failed to select QA sources for retention")?;

    let source_shas = sources_to_prune(&source_candidates, cutoff);
    if !source_shas.is_empty() {
        sqlx::query(
            r#"
            DELETE FROM project_qa_test_sources AS s
            WHERE s.project_id = $1
              AND s.source_sha = ANY($2::text[])
              AND s.last_seen < $3
              AND NOT EXISTS (
                  SELECT 1
                  FROM project_qa_test_cases c
                  WHERE c.project_id = s.project_id
                    AND c.source_sha = s.source_sha
              )
            "#,
        )
        .bind(project_id)
        .bind(&source_shas)
        .bind(cutoff)
        .execute(db)
        .await
        .context("failed to delete unreferenced QA sources")?;
    }

    Ok(())
}

/// The retention window for passed/skipped case detail. Zero disables both
/// case and unreferenced-source pruning.
fn qa_case_retention_days() -> i64 {
    std::env::var("OPENMEMORY_QA_CASE_RETENTION_DAYS")
        .unwrap_or_else(|_| DEFAULT_CASE_RETENTION_DAYS.to_string())
        .parse::<i64>()
        .unwrap_or(DEFAULT_CASE_RETENTION_DAYS)
        .max(0)
}

pub(crate) async fn ingest_run(
    db: &PgPool,
    project_id: Uuid,
    envelope: IngestEnvelope,
) -> Result<qa::QaRunView> {
    // This is intentionally repeated here rather than relying on the HTTP
    // handler: MCP and future callers can invoke the persistence function
    // directly, and invalid values must be rejected before begin().
    validate_envelope(&envelope)?;

    if let Some(event_id) = envelope.event_id {
        validate_event_for_project(db, event_id, project_id).await?;
    }

    let has_absolute_paths = envelope
        .cases
        .iter()
        .filter_map(|case| case.file.as_deref())
        .chain(envelope.sources.iter().map(|source| source.file.as_str()))
        .any(is_absolute_path);
    let repo_root = if has_absolute_paths {
        project_repo_root(db, project_id).await?
    } else {
        None
    };

    let (status, counters) = derive_status_and_counters(&envelope.cases);
    let prepared_cases = prepare_cases(envelope.cases, repo_root.as_deref());
    let prepared_sources = prepare_sources(envelope.sources, repo_root.as_deref());
    let started_at = envelope.started_at.unwrap_or_else(Utc::now);
    let finished_at = envelope.finished_at.unwrap_or_else(Utc::now);

    let mut tx = db
        .begin()
        .await
        .context("failed to begin QA ingest transaction")?;

    let run: qa::QaRunView = sqlx::query_as(
        r#"
        INSERT INTO project_qa_runs
            (project_id, event_id, task_id, title, status, summary, target,
             external_ref, created_by, started_at, finished_at, kind, runner,
             total_cases, passed_cases, failed_cases, skipped_cases, duration_ms,
             commit_sha, branch)
        VALUES ($1, $2, $3, $4, $5, NULL, NULL, $6, 'agent', $7, $8, $9, $10,
                $11, $12, $13, $14, $15, $16, $17)
        RETURNING *
        "#,
    )
    .bind(project_id)
    .bind(envelope.event_id)
    .bind(envelope.task_id)
    .bind(&envelope.title)
    .bind(status)
    .bind(envelope.external_ref.as_deref())
    .bind(started_at)
    .bind(finished_at)
    .bind(&envelope.kind)
    .bind(envelope.runner.as_deref())
    .bind(counters.total_cases)
    .bind(counters.passed_cases)
    .bind(counters.failed_cases)
    .bind(counters.skipped_cases)
    .bind(envelope.duration_ms)
    .bind(envelope.commit_sha.as_deref())
    .bind(envelope.branch.as_deref())
    .fetch_one(&mut *tx)
    .await
    .context("failed to insert ingested QA run")?;

    let run_ids = vec![run.id; prepared_cases.len()];
    let project_ids = vec![project_id; prepared_cases.len()];
    let case_keys: Vec<String> = prepared_cases
        .iter()
        .map(|case| case.case_key.clone())
        .collect();
    let suites: Vec<Option<String>> = prepared_cases
        .iter()
        .map(|case| case.suite.clone())
        .collect();
    let names: Vec<String> = prepared_cases
        .iter()
        .map(|case| case.name.clone())
        .collect();
    let files: Vec<Option<String>> = prepared_cases
        .iter()
        .map(|case| case.file.clone())
        .collect();
    let statuses: Vec<String> = prepared_cases
        .iter()
        .map(|case| case.status.clone())
        .collect();
    let durations: Vec<Option<f64>> = prepared_cases.iter().map(|case| case.duration_ms).collect();
    let failure_messages: Vec<Option<String>> = prepared_cases
        .iter()
        .map(|case| case.failure_message.clone())
        .collect();
    let failure_details: Vec<Option<String>> = prepared_cases
        .iter()
        .map(|case| case.failure_detail.clone())
        .collect();
    let source_shas: Vec<Option<String>> = prepared_cases
        .iter()
        .map(|case| case.source_sha.clone())
        .collect();
    let external_refs: Vec<Option<String>> = prepared_cases
        .iter()
        .map(|case| case.external_ref.clone())
        .collect();

    // Cases are deliberately one statement. A normal web unit run contains
    // 161 cases; inserting them one at a time would make ingest latency and
    // transaction lock time scale with the runner's case count.
    sqlx::query(
        r#"
        INSERT INTO project_qa_test_cases
            (run_id, project_id, case_key, suite, name, file, status,
             duration_ms, failure_message, failure_detail, source_sha, external_ref)
        SELECT *
        FROM UNNEST(
            $1::uuid[], $2::uuid[], $3::text[], $4::text[], $5::text[],
            $6::text[], $7::text[], $8::double precision[], $9::text[],
            $10::text[], $11::text[], $12::text[]
        )
        "#,
    )
    .bind(&run_ids)
    .bind(&project_ids)
    .bind(&case_keys)
    .bind(&suites)
    .bind(&names)
    .bind(&files)
    .bind(&statuses)
    .bind(&durations)
    .bind(&failure_messages)
    .bind(&failure_details)
    .bind(&source_shas)
    .bind(&external_refs)
    .execute(&mut *tx)
    .await
    .context("failed to insert ingested QA cases")?;

    for source in prepared_sources {
        sqlx::query(
            r#"
            INSERT INTO project_qa_test_sources
                (project_id, source_sha, file, language, body, byte_size)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (project_id, source_sha)
            DO UPDATE SET last_seen = now()
            "#,
        )
        .bind(project_id)
        .bind(source.source_sha)
        .bind(source.file)
        .bind(source.language)
        .bind(source.body)
        .bind(source.byte_size)
        .execute(&mut *tx)
        .await
        .context("failed to upsert ingested QA source")?;
    }

    for metric in envelope.metrics {
        sqlx::query(
            r#"
            INSERT INTO project_qa_run_metrics
                (run_id, project_id, metric_key, value, unit)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (run_id, metric_key)
            DO UPDATE SET value = EXCLUDED.value, unit = EXCLUDED.unit
            "#,
        )
        .bind(run.id)
        .bind(project_id)
        .bind(metric.metric_key)
        .bind(metric.value)
        .bind(metric.unit)
        .execute(&mut *tx)
        .await
        .context("failed to upsert ingested QA metric")?;
    }

    tx.commit()
        .await
        .context("failed to commit QA ingest transaction")?;

    // Retention is housekeeping, not part of recording history. A failed
    // prune must never turn a committed run into an apparent ingest failure.
    if let Err(retention_error) = prune_qa_history(db, project_id).await {
        error!(
            project_id = %project_id,
            error = %retention_error,
            "QA history retention failed after successful ingest"
        );
    }

    Ok(run)
}

pub(crate) async fn ingest(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(project_id): AxumPath<Uuid>,
    Json(envelope): Json<IngestEnvelope>,
) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"error": "unauthorized"})),
        )
            .into_response();
    }

    if let Err(validation_error) = validate_envelope(&envelope) {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": validation_error.to_string()})),
        )
            .into_response();
    }

    match ingest_run(&state.db, project_id, envelope).await {
        Ok(run) => (StatusCode::CREATED, Json(run)).into_response(),
        Err(error) => {
            error!(project_id = %project_id, error = %error, "QA ingest failed");
            (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": error.to_string()})),
            )
                .into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn case(status: &str) -> IngestCase {
        IngestCase {
            suite: None,
            name: "example".to_string(),
            file: None,
            status: status.to_string(),
            duration_ms: None,
            failure_message: None,
            failure_detail: None,
            source_sha: None,
            external_ref: None,
        }
    }

    fn envelope(kind: &str, cases: Vec<IngestCase>) -> IngestEnvelope {
        IngestEnvelope {
            title: "test run".to_string(),
            kind: kind.to_string(),
            runner: None,
            started_at: None,
            finished_at: None,
            duration_ms: None,
            commit_sha: None,
            branch: None,
            event_id: None,
            task_id: None,
            external_ref: None,
            cases,
            metrics: Vec::new(),
            sources: Vec::new(),
        }
    }

    fn retention_candidate(
        id: Uuid,
        created_at: DateTime<Utc>,
        case_status: &str,
    ) -> RetentionCaseCandidate {
        RetentionCaseCandidate {
            id,
            created_at,
            case_status: case_status.to_string(),
            run_event_id: None,
            run_task_id: None,
            run_has_evidence: false,
            run_status: "passed".to_string(),
            run_kind: "unit".to_string(),
        }
    }

    #[test]
    fn derives_failed_status_when_a_case_failed_or_errored() {
        let cases = vec![case("passed"), case("failed"), case("error")];
        let (status, counters) = derive_status_and_counters(&cases);
        assert_eq!(status, "failed");
        assert_eq!(counters.failed_cases, 2);
    }

    #[test]
    fn derives_passed_status_when_all_cases_pass() {
        let (status, counters) = derive_status_and_counters(&[case("passed"), case("passed")]);
        assert_eq!(status, "passed");
        assert_eq!(
            counters,
            CaseCounters {
                total_cases: 2,
                passed_cases: 2,
                failed_cases: 0,
                skipped_cases: 0
            }
        );
    }

    #[test]
    fn empty_cases_are_passed_with_zero_total_cases() {
        let (status, counters) = derive_status_and_counters(&[]);
        assert_eq!(status, "passed");
        assert_eq!(counters.total_cases, 0);
    }

    #[test]
    fn counters_include_skipped_and_count_error_as_failed() {
        let (status, counters) = derive_status_and_counters(&[
            case("passed"),
            case("skipped"),
            case("failed"),
            case("error"),
        ]);
        assert_eq!(status, "failed");
        assert_eq!(
            counters,
            CaseCounters {
                total_cases: 4,
                passed_cases: 1,
                failed_cases: 2,
                skipped_cases: 1
            }
        );
    }

    #[test]
    fn case_key_elides_empty_file_and_suite_segments() {
        assert_eq!(build_case_key(Some(""), Some(""), "works", None), "works");
        assert_eq!(
            build_case_key(None, Some("unit"), "works", None),
            "unit::works"
        );
    }

    #[test]
    fn absolute_file_path_is_normalized_to_repo_relative() {
        let root = Path::new("/home/toyofumi/projects/openmemory");
        assert_eq!(
            build_case_key(
                Some("/home/toyofumi/projects/openmemory/apps/web/lib/x.test.ts"),
                None,
                "works",
                Some(root),
            ),
            "apps/web/lib/x.test.ts::works"
        );
    }

    #[test]
    fn long_case_key_gets_an_eight_hex_sha_suffix() {
        let name = "n".repeat(500);
        let key = build_case_key(None, None, &name, None);
        assert_eq!(key.chars().count(), 489);
        assert!(key.starts_with(&"n".repeat(480)));
        assert!(key[480..].starts_with('#'));
        assert_eq!(key[481..].len(), 8);
        assert!(key[481..]
            .chars()
            .all(|character| character.is_ascii_hexdigit()));
    }

    #[test]
    fn different_long_names_with_the_same_prefix_have_different_keys() {
        let first = format!("{}a", "n".repeat(480));
        let second = format!("{}b", "n".repeat(480));
        let first_key = build_case_key(None, None, &first, None);
        let second_key = build_case_key(None, None, &second, None);
        assert_ne!(first_key, second_key);
        assert_eq!(&first_key[..480], &second_key[..480]);
    }

    #[test]
    fn envelope_validation_rejects_an_unknown_kind() {
        let error = validate_envelope(&envelope("contract", vec![])).unwrap_err();
        assert!(error.to_string().contains("kind must be one of"));
    }

    #[test]
    fn envelope_validation_rejects_an_unknown_case_status() {
        let error = validate_envelope(&envelope("unit", vec![case("unknown")])).unwrap_err();
        assert!(error.to_string().contains("case status must be one of"));
    }

    #[test]
    fn retention_selects_old_passed_and_skipped_cases_but_never_failures() {
        let now = Utc::now();
        let old_passed = Uuid::new_v4();
        let old_skipped = Uuid::new_v4();
        let old_failed = Uuid::new_v4();
        let candidates = vec![
            retention_candidate(old_passed, now - Duration::days(91), "passed"),
            retention_candidate(old_skipped, now - Duration::days(91), "skipped"),
            retention_candidate(old_failed, now - Duration::days(91), "failed"),
        ];
        let selected = cases_to_prune(&candidates, now - Duration::days(90));
        assert_eq!(selected, vec![old_passed, old_skipped]);
    }

    #[test]
    fn retention_carveouts_keep_old_cases_for_event_task_evidence_failed_and_manual_runs() {
        let now = Utc::now();
        let mut candidates = Vec::new();
        for carveout in 0..5 {
            let mut candidate =
                retention_candidate(Uuid::new_v4(), now - Duration::days(91), "passed");
            match carveout {
                0 => candidate.run_event_id = Some(Uuid::new_v4()),
                1 => candidate.run_task_id = Some(Uuid::new_v4()),
                2 => candidate.run_has_evidence = true,
                3 => candidate.run_status = "failed".to_string(),
                4 => candidate.run_kind = "manual".to_string(),
                _ => unreachable!(),
            }
            candidates.push(candidate);
        }
        assert!(cases_to_prune(&candidates, now - Duration::days(90)).is_empty());
    }
}
