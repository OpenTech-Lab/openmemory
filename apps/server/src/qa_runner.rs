//! Execute a stored QA plan with a fixed, argv-only runner invocation.
//!
//! The plan body is database-controlled source text. It is written to a
//! project-relative file, but it is never passed to a shell. The only values
//! that become process arguments are selected by the runner table below and
//! the guarded paths derived from the plan metadata.

use std::{
    fmt, io,
    path::{Component, Path, PathBuf},
    process::{ExitStatus, Stdio},
    time::{Duration, Instant},
};

use anyhow::{Context, Result};
use chrono::Utc;
use sha2::{Digest, Sha256};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
    task::JoinHandle,
};
use tracing::warn;
use uuid::Uuid;

use crate::{qa, qa_ingest};

pub const MAX_CAPTURE_BYTES: usize = 1024 * 1024;
const DEFAULT_TIMEOUT_SECONDS: u64 = 300;
const OUTPUT_JOIN_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug)]
pub enum RunPlanError {
    Unsupported(String),
    InvalidTarget(String),
    RunnerUnavailable {
        binary: String,
        env_var: &'static str,
        run_id: Option<Uuid>,
    },
    Internal(anyhow::Error),
}

impl fmt::Display for RunPlanError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unsupported(message) | Self::InvalidTarget(message) => formatter.write_str(message),
            Self::RunnerUnavailable { binary, env_var, .. } => write!(
                formatter,
                "runner {binary:?} is unavailable or not executable; set {env_var} to an executable path"
            ),
            Self::Internal(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for RunPlanError {}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RunnerInvocation {
    binary: String,
    env_var: &'static str,
    runner: &'static str,
    ingest_kind: &'static str,
    args: Vec<String>,
    env: Vec<(String, String)>,
}

#[derive(Debug)]
struct ProcessResult {
    status: Option<ExitStatus>,
    wait_error: Option<String>,
    timed_out: bool,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

#[derive(Debug)]
struct ParsedCase {
    suite: Option<String>,
    name: String,
    file: Option<String>,
    duration_ms: Option<f64>,
    skipped: bool,
    failure: Option<Diagnostic>,
    error: Option<Diagnostic>,
}

#[derive(Debug)]
struct CaseBuilder {
    suite: Option<String>,
    name: String,
    file: Option<String>,
    duration_ms: Option<f64>,
    skipped: bool,
    failure: Option<Diagnostic>,
    error: Option<Diagnostic>,
}

#[derive(Debug)]
struct Diagnostic {
    message: Option<String>,
    detail: String,
}

#[derive(Debug)]
struct DiagnosticFrame {
    kind: &'static str,
    message: Option<String>,
    text: String,
}

#[derive(Debug)]
struct XmlFrame {
    name: String,
    attrs: Vec<(String, String)>,
}

/// Compute the filename extension using the same kind-first rules as the
/// web qa-run-command helper.
pub fn plan_file_extension(kind: &str, language: &str) -> &'static str {
    match kind {
        "jest" => {
            if language == "javascript" {
                "test.js"
            } else {
                "test.ts"
            }
        }
        "playwright" => match language {
            "javascript" => "spec.js",
            "python" => "spec.py",
            _ => "spec.ts",
        },
        "maestro" => "yaml",
        _ => match language {
            "javascript" => "test.js",
            "typescript" => "test.ts",
            "python" => "test.py",
            "yaml" => "yaml",
            _ => "txt",
        },
    }
}

/// Extract the directory from the provenance line written by the duplicate
/// flow. Only a plain repository-relative path is accepted, matching the
/// frontend helper's conservative parser.
pub fn origin_dir_from_description(description: Option<&str>) -> Option<String> {
    let description = description?;
    for line in description.lines() {
        let Some(raw_file) = line.strip_prefix("file:") else {
            continue;
        };
        if raw_file.trim_start().len() == raw_file.len() {
            continue;
        }
        let file = raw_file.trim();
        if file.is_empty()
            || file == "—"
            || file.starts_with('/')
            || file.contains("..")
            || file.chars().any(|character| {
                !character.is_ascii_alphanumeric() && !matches!(character, '.' | '_' | '-' | '/')
            })
        {
            return None;
        }

        let slash = file.rfind('/')?;
        return (slash > 0).then(|| file[..slash].to_string());
    }
    None
}

/// Sanitize a plan name with the same ASCII-safe replacement rules as the UI.
pub fn plan_slug(name: &str) -> String {
    let mut slug = String::new();
    let mut in_invalid_run = false;
    for character in name.trim().chars() {
        if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
            slug.push(character);
            in_invalid_run = false;
        } else if !in_invalid_run {
            slug.push('_');
            in_invalid_run = true;
        }
    }

    let slug = slug.trim_matches('_').to_string();
    if slug.is_empty() {
        "plan".to_string()
    } else {
        slug
    }
}

pub fn target_relative_path(
    name: &str,
    kind: &str,
    language: &str,
    description: Option<&str>,
) -> PathBuf {
    let directory = origin_dir_from_description(description)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(".qa-plans"));
    directory.join(format!(
        "{}.{}",
        plan_slug(name),
        plan_file_extension(kind, language)
    ))
}

/// Resolve a target beneath the project root and create missing directories.
///
/// The lexical ParentDir check happens before directory creation, and each
/// existing directory is canonicalized as it is traversed. That prevents a
/// symlinked component from making create_dir create directories outside the
/// project before the final starts_with check can run.
pub fn resolve_target_path(project_root: &Path, relative: &Path) -> Result<PathBuf> {
    if relative.is_absolute() {
        anyhow::bail!("target path must be relative to the project root");
    }
    if relative.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        anyhow::bail!("target path escapes the project root");
    }

    let root = std::fs::canonicalize(project_root)
        .with_context(|| format!("project root does not exist: {}", project_root.display()))?;
    if !root.is_dir() {
        anyhow::bail!("project root is not a directory: {}", root.display());
    }

    let mut current = root.clone();
    let mut components = relative.components();
    let Some(file_name) = components.next_back() else {
        anyhow::bail!("target path must name a file");
    };
    let Component::Normal(file_name) = file_name else {
        anyhow::bail!("target path must name a file");
    };

    for component in components {
        let Component::Normal(name) = component else {
            continue;
        };
        let next = current.join(name);
        match std::fs::symlink_metadata(&next) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() {
                    let resolved = std::fs::canonicalize(&next).with_context(|| {
                        format!("target directory is an invalid symlink: {}", next.display())
                    })?;
                    ensure_inside(&root, &resolved)?;
                    if !resolved.is_dir() {
                        anyhow::bail!(
                            "target path component is not a directory: {}",
                            next.display()
                        );
                    }
                    current = resolved;
                } else {
                    if !metadata.is_dir() {
                        anyhow::bail!(
                            "target path component is not a directory: {}",
                            next.display()
                        );
                    }
                    current = next;
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                std::fs::create_dir(&next).with_context(|| {
                    format!("failed to create target directory: {}", next.display())
                })?;
                current = next;
            }
            Err(error) => {
                return Err(error).with_context(|| {
                    format!("failed to inspect target directory: {}", next.display())
                });
            }
        }
    }

    ensure_inside(&root, &current)?;
    let target = current.join(file_name);
    match std::fs::symlink_metadata(&target) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            let resolved = std::fs::canonicalize(&target).with_context(|| {
                format!("target file is an invalid symlink: {}", target.display())
            })?;
            ensure_inside(&root, &resolved)?;
            if !resolved.is_file() {
                anyhow::bail!("target path is not a file: {}", target.display());
            }
        }
        Ok(metadata) if metadata.is_dir() => {
            anyhow::bail!("target path is a directory: {}", target.display())
        }
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(error)
                .with_context(|| format!("failed to inspect target file: {}", target.display()));
        }
    }

    ensure_inside(&root, &target)?;
    Ok(target)
}

fn ensure_inside(root: &Path, candidate: &Path) -> Result<()> {
    if !candidate.starts_with(root) {
        anyhow::bail!("target path escapes the project root");
    }
    Ok(())
}

fn configured_binary(env_var: &'static str, default: &'static str) -> String {
    std::env::var(env_var)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| default.to_string())
}

fn runner_for(kind: &str, language: &str, file: &str, junit: &str) -> Option<RunnerInvocation> {
    // Keep this precedence in lockstep with the TypeScript copy-command helper:
    // yaml/maestro first, then Python (including Playwright Python), then
    // Playwright, then the Node test runner.
    if kind == "maestro" || language == "yaml" {
        return Some(RunnerInvocation {
            binary: configured_binary("OPENMEMORY_QA_MAESTRO_BIN", "maestro"),
            env_var: "OPENMEMORY_QA_MAESTRO_BIN",
            runner: "maestro",
            ingest_kind: "e2e",
            args: vec![
                "test".to_string(),
                file.to_string(),
                "--format".to_string(),
                "junit".to_string(),
                "--output".to_string(),
                junit.to_string(),
            ],
            env: Vec::new(),
        });
    }

    if language == "python" {
        return Some(RunnerInvocation {
            binary: configured_binary("OPENMEMORY_QA_PYTEST_BIN", "pytest"),
            env_var: "OPENMEMORY_QA_PYTEST_BIN",
            runner: "pytest",
            ingest_kind: if kind == "playwright" { "e2e" } else { "unit" },
            args: vec![file.to_string(), format!("--junitxml={junit}")],
            env: Vec::new(),
        });
    }

    if kind == "playwright" {
        return Some(RunnerInvocation {
            binary: configured_binary("OPENMEMORY_QA_PLAYWRIGHT_BIN", "npx"),
            env_var: "OPENMEMORY_QA_PLAYWRIGHT_BIN",
            runner: "playwright",
            ingest_kind: "e2e",
            args: vec![
                "playwright".to_string(),
                "test".to_string(),
                file.to_string(),
                "--reporter=junit".to_string(),
            ],
            env: vec![(
                "PLAYWRIGHT_JUNIT_OUTPUT_NAME".to_string(),
                junit.to_string(),
            )],
        });
    }

    if matches!(language, "typescript" | "javascript") {
        return Some(RunnerInvocation {
            binary: configured_binary("OPENMEMORY_QA_NODE_BIN", "node"),
            env_var: "OPENMEMORY_QA_NODE_BIN",
            runner: "node:test",
            ingest_kind: "unit",
            args: vec![
                "--test".to_string(),
                "--test-reporter=junit".to_string(),
                format!("--test-reporter-destination={junit}"),
                // A second reporter on stdout. Without it a file that fails to
                // *load* produces a JUnit case whose entire message is "test
                // failed", with the real cause (ERR_MODULE_NOT_FOUND and the
                // like) written nowhere at all — not stdout, not stderr, not the
                // report. Verified against Node 26.
                "--test-reporter=spec".to_string(),
                "--test-reporter-destination=stdout".to_string(),
                file.to_string(),
            ],
            env: Vec::new(),
        });
    }

    None
}

fn qa_run_timeout() -> Duration {
    std::env::var("OPENMEMORY_QA_RUN_TIMEOUT_SECS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|seconds| *seconds > 0)
        .map(Duration::from_secs)
        .unwrap_or_else(|| Duration::from_secs(DEFAULT_TIMEOUT_SECONDS))
}

pub async fn execute_plan(
    db: &sqlx::PgPool,
    plan: &qa::QaPlanView,
    project_root: &Path,
) -> std::result::Result<qa::QaRunView, RunPlanError> {
    let target_relative = target_relative_path(
        &plan.name,
        &plan.kind,
        &plan.language,
        plan.description.as_deref(),
    );
    let target_path = resolve_target_path(project_root, &target_relative)
        .map_err(|error| RunPlanError::InvalidTarget(error.to_string()))?;
    let root = std::fs::canonicalize(project_root).map_err(|error| {
        RunPlanError::InvalidTarget(format!("failed to resolve project root: {error}"))
    })?;
    let target_for_command = relative_path_string(&root, &target_path)?;

    let report_name = format!(".openmemory-qa-{}.junit.xml", Uuid::new_v4());
    let report_path = target_path
        .parent()
        .ok_or_else(|| {
            RunPlanError::InvalidTarget("target path has no parent directory".to_string())
        })?
        .join(report_name);
    let report_for_command = relative_path_string(&root, &report_path)?;

    let invocation = runner_for(
        &plan.kind,
        &plan.language,
        &target_for_command,
        &report_for_command,
    )
    .ok_or_else(|| {
        RunPlanError::Unsupported(format!(
            "no runner fits kind {:?} with language {:?}; use typescript, javascript, python or yaml",
            plan.kind, plan.language
        ))
    })?;

    tokio::fs::write(&target_path, plan.body.as_bytes())
        .await
        .map_err(|error| RunPlanError::Internal(error.into()))?;

    let started_at = Utc::now();
    let started = Instant::now();
    let (process, unavailable_runner) = match run_process(&invocation, &root).await {
        Ok(process) => (process, None),
        Err(RunPlanError::RunnerUnavailable {
            binary,
            env_var,
            run_id: _,
        }) => {
            let process = ProcessResult {
                status: None,
                wait_error: Some(format!(
                    "runner {binary:?} is unavailable or not executable; set {env_var} to an executable path"
                )),
                timed_out: false,
                stdout: Vec::new(),
                stderr: Vec::new(),
            };
            (process, Some((binary, env_var)))
        }
        Err(error) => return Err(error),
    };
    let duration_ms = started.elapsed().as_millis().min(i64::MAX as u128) as i64;
    let report = tokio::fs::read_to_string(&report_path).await;

    let source_sha = format!("{:x}", Sha256::digest(plan.body.as_bytes()));
    let source_byte_size = i32::try_from(plan.body.len()).unwrap_or(i32::MAX);
    let mut cases = match report {
        Ok(xml) => match parse_junit(&xml) {
            Ok(parsed) if !parsed.is_empty() => parsed
                .into_iter()
                .map(|case| {
                    let status = case_status(&case);
                    let file = case.file.or_else(|| Some(target_for_command.clone()));
                    qa_ingest::IngestCase {
                        suite: case.suite,
                        name: case.name,
                        file,
                        status,
                        duration_ms: case.duration_ms,
                        failure_message: case
                            .error
                            .as_ref()
                            .or(case.failure.as_ref())
                            .and_then(|diagnostic| diagnostic.message.clone()),
                        failure_detail: case
                            .error
                            .as_ref()
                            .or(case.failure.as_ref())
                            .map(|diagnostic| diagnostic.detail.clone()),
                        source_sha: Some(source_sha.clone()),
                        external_ref: None,
                    }
                })
                .collect(),
            Ok(_) => vec![synthetic_failure_case(
                &target_for_command,
                "runner produced no JUnit test cases",
                &process,
                None,
            )],
            Err(error) => vec![synthetic_failure_case(
                &target_for_command,
                "runner produced an invalid JUnit report",
                &process,
                Some(error.to_string()),
            )],
        },
        Err(error) => vec![synthetic_failure_case(
            &target_for_command,
            "runner did not produce a JUnit report",
            &process,
            Some(error.to_string()),
        )],
    };
    for case in &mut cases {
        if case.source_sha.is_none() {
            case.source_sha = Some(source_sha.clone());
        }
    }

    let finished_at = Utc::now();
    let envelope = qa_ingest::IngestEnvelope {
        title: plan.name.clone(),
        kind: invocation.ingest_kind.to_string(),
        runner: Some(invocation.runner.to_string()),
        started_at: Some(started_at),
        finished_at: Some(finished_at),
        duration_ms: Some(duration_ms),
        commit_sha: None,
        branch: None,
        event_id: None,
        task_id: None,
        external_ref: None,
        cases,
        metrics: Vec::new(),
        sources: vec![qa_ingest::IngestSource {
            source_sha,
            file: target_for_command,
            language: Some(plan.language.clone()),
            body: plan.body.clone(),
            byte_size: source_byte_size,
        }],
    };

    let ingest_result = qa_ingest::ingest_run(db, plan.project_id, envelope)
        .await
        .map_err(RunPlanError::Internal);

    if let Err(error) = tokio::fs::remove_file(&report_path).await {
        if error.kind() != io::ErrorKind::NotFound {
            warn!(
                path = %report_path.display(),
                error = %error,
                "failed to remove QA runner JUnit report"
            );
        }
    }

    // node's JUnit reporter collapses a file that fails to *load* into a single
    // case whose message is the bare string "test failed" — the actual cause
    // (ERR_MODULE_NOT_FOUND and friends) exists only on stderr. Without this the
    // most common failure mode records a run that says nothing useful.
    if let Ok(run) = ingest_result.as_ref() {
        if run.status != "passed" {
            // Which stream carries the diagnostic depends on the runner, so
            // take both rather than guess: node writes load failures to its
            // stdout reporter, while a crashing binary writes to stderr.
            let stderr = String::from_utf8_lossy(&process.stderr);
            let stdout = String::from_utf8_lossy(&process.stdout);
            let mut captured = String::new();
            if !stderr.trim().is_empty() {
                captured.push_str("stderr:\n");
                captured.push_str(stderr.trim());
            }
            if !stdout.trim().is_empty() {
                if !captured.is_empty() {
                    captured.push_str("\n\n");
                }
                captured.push_str("stdout:\n");
                captured.push_str(stdout.trim());
            }
            if !captured.is_empty() {
                let body = truncate_utf8(&captured, MAX_STDERR_EVIDENCE_BYTES);
                if let Err(error) = qa::add_evidence(
                    db,
                    run.id,
                    "text",
                    Some("runner output"),
                    Some(&body),
                    None,
                    Some(0),
                )
                .await
                {
                    // Evidence is diagnostic garnish; losing it must not fail a
                    // run that was otherwise recorded correctly.
                    warn!(run_id = %run.id, error = %error, "failed to attach runner output evidence");
                }
            }
        }
    }

    match ingest_result {
        Ok(run) => match unavailable_runner {
            Some((binary, env_var)) => Err(RunPlanError::RunnerUnavailable {
                binary,
                env_var,
                run_id: Some(run.id),
            }),
            None => Ok(run),
        },
        Err(error) => Err(error),
    }
}

fn relative_path_string(root: &Path, path: &Path) -> std::result::Result<String, RunPlanError> {
    path.strip_prefix(root)
        .map(|relative| relative.to_string_lossy().replace('\\', "/"))
        .map_err(|_| {
            RunPlanError::InvalidTarget("target path escapes the project root".to_string())
        })
}

fn case_status(case: &ParsedCase) -> String {
    if case.error.is_some() {
        "error".to_string()
    } else if case.failure.is_some() {
        "failed".to_string()
    } else if case.skipped {
        "skipped".to_string()
    } else {
        "passed".to_string()
    }
}

fn synthetic_failure_case(
    target: &str,
    reason: &str,
    process: &ProcessResult,
    report_error: Option<String>,
) -> qa_ingest::IngestCase {
    let mut detail = String::new();
    if process.timed_out {
        detail.push_str(&format!(
            "runner timed out after {} seconds",
            qa_run_timeout().as_secs()
        ));
    } else if let Some(error) = &process.wait_error {
        detail.push_str(error);
    } else if let Some(status) = process.status {
        detail.push_str(&format!("runner exited with {status}"));
    }
    if !detail.is_empty() {
        detail.push('\n');
    }
    detail.push_str(reason);
    if let Some(report_error) = report_error {
        detail.push('\n');
        detail.push_str(&report_error);
    }

    let stderr = String::from_utf8_lossy(&process.stderr);
    if !stderr.is_empty() {
        detail.push_str("\nstderr:\n");
        detail.push_str(&stderr);
    }
    let stdout = String::from_utf8_lossy(&process.stdout);
    if !stdout.is_empty() {
        detail.push_str("\nstdout:\n");
        detail.push_str(&stdout);
    }

    qa_ingest::IngestCase {
        suite: Some("qa-runner".to_string()),
        name: "runner".to_string(),
        file: Some(target.to_string()),
        status: "failed".to_string(),
        duration_ms: None,
        failure_message: Some(reason.to_string()),
        failure_detail: Some(detail),
        source_sha: None,
        external_ref: None,
    }
}

async fn run_process(
    invocation: &RunnerInvocation,
    cwd: &Path,
) -> std::result::Result<ProcessResult, RunPlanError> {
    // This is intentionally an argv invocation. There is no shell command
    // string and the database-backed plan body is not passed to the process.
    let mut command = Command::new(&invocation.binary);
    command
        .args(&invocation.args)
        .envs(invocation.env.iter().map(|(key, value)| (key, value)))
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::NotFound | io::ErrorKind::PermissionDenied
            ) =>
        {
            return Err(RunPlanError::RunnerUnavailable {
                binary: invocation.binary.clone(),
                env_var: invocation.env_var,
                run_id: None,
            });
        }
        Err(error) => {
            return Ok(ProcessResult {
                status: None,
                wait_error: Some(format!(
                    "failed to start runner {:?}: {error}",
                    invocation.binary
                )),
                timed_out: false,
                stdout: Vec::new(),
                stderr: Vec::new(),
            });
        }
    };

    let stdout = child
        .stdout
        .take()
        .context("runner stdout was not piped")
        .map_err(RunPlanError::Internal)?;
    let stderr = child
        .stderr
        .take()
        .context("runner stderr was not piped")
        .map_err(RunPlanError::Internal)?;
    let stdout_task = tokio::spawn(read_capped(stdout));
    let stderr_task = tokio::spawn(read_capped(stderr));

    let wait_result = tokio::time::timeout(qa_run_timeout(), child.wait()).await;
    let (status, wait_error, timed_out) = match wait_result {
        Ok(Ok(status)) => (Some(status), None, false),
        Ok(Err(error)) => (None, Some(error.to_string()), false),
        Err(_) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            (None, None, true)
        }
    };

    let stdout = finish_capture(stdout_task).await;
    let stderr = finish_capture(stderr_task).await;
    Ok(ProcessResult {
        status,
        wait_error,
        timed_out,
        stdout,
        stderr,
    })
}

async fn read_capped<R: AsyncRead + Unpin>(mut reader: R) -> Vec<u8> {
    let mut captured = Vec::with_capacity(MAX_CAPTURE_BYTES.min(16 * 1024));
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        match reader.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                let remaining = MAX_CAPTURE_BYTES.saturating_sub(captured.len());
                if remaining > 0 {
                    captured.extend_from_slice(&buffer[..read.min(remaining)]);
                }
            }
        }
    }
    captured
}

async fn finish_capture(mut task: JoinHandle<Vec<u8>>) -> Vec<u8> {
    match tokio::time::timeout(OUTPUT_JOIN_TIMEOUT, &mut task).await {
        Ok(Ok(output)) => output,
        Ok(Err(_)) | Err(_) => {
            task.abort();
            Vec::new()
        }
    }
}

const MAX_STDERR_EVIDENCE_BYTES: usize = 8 * 1024;

/// Truncate on a char boundary so the captured bytes stay valid UTF-8.
fn truncate_utf8(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    let mut end = max_bytes;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n… truncated", &value[..end])
}

fn parse_junit(xml: &str) -> Result<Vec<ParsedCase>> {
    if xml.trim().is_empty() {
        anyhow::bail!("JUnit XML is empty");
    }

    let mut stack = Vec::<XmlFrame>::new();
    let mut cases = Vec::new();
    let mut current_case: Option<CaseBuilder> = None;
    let mut diagnostic: Option<DiagnosticFrame> = None;
    let mut root_seen = false;
    let mut root_closed = false;
    let mut cursor = 0;

    while cursor < xml.len() {
        let text_end = xml[cursor..]
            .find('<')
            .map(|offset| cursor + offset)
            .unwrap_or(xml.len());
        if text_end > cursor {
            let text = &xml[cursor..text_end];
            if stack.is_empty() {
                if !text.trim().is_empty() {
                    anyhow::bail!("non-whitespace text outside the JUnit root");
                }
            } else if let Some(frame) = diagnostic.as_mut() {
                frame.text.push_str(&decode_xml_entities(text));
            }
            cursor = text_end;
            if cursor == xml.len() {
                break;
            }
        }

        if xml[cursor..].starts_with("<!--") {
            let end = xml[cursor + 4..]
                .find("-->")
                .map(|offset| cursor + 4 + offset)
                .ok_or_else(|| anyhow::anyhow!("unterminated XML comment"))?;
            cursor = end + 3;
            continue;
        }
        if xml[cursor..].starts_with("<![CDATA[") {
            let start = cursor + "<![CDATA[".len();
            let end = xml[start..]
                .find("]]>")
                .map(|offset| start + offset)
                .ok_or_else(|| anyhow::anyhow!("unterminated XML CDATA section"))?;
            if stack.is_empty() {
                anyhow::bail!("CDATA outside the JUnit root");
            }
            if let Some(frame) = diagnostic.as_mut() {
                frame.text.push_str(&xml[start..end]);
            }
            cursor = end + 3;
            continue;
        }
        if xml[cursor..].starts_with("<?") {
            let end = xml[cursor + 2..]
                .find("?>")
                .map(|offset| cursor + 2 + offset)
                .ok_or_else(|| anyhow::anyhow!("unterminated XML processing instruction"))?;
            cursor = end + 2;
            continue;
        }
        if xml[cursor..].starts_with("<!") {
            let end = find_declaration_end(xml, cursor)
                .ok_or_else(|| anyhow::anyhow!("unterminated XML declaration"))?;
            cursor = end + 1;
            continue;
        }

        let tag_end =
            find_tag_end(xml, cursor).ok_or_else(|| anyhow::anyhow!("unterminated XML tag"))?;
        if xml[cursor..].starts_with("</") {
            let name = parse_close_name(&xml[cursor + 2..tag_end])?;
            let frame = stack
                .pop()
                .ok_or_else(|| anyhow::anyhow!("unexpected closing tag: {name}"))?;
            if frame.name != name {
                anyhow::bail!("mismatched closing tag: expected </{}>", frame.name);
            }
            match frame.name.as_str() {
                "failure" | "error" => {
                    let diagnostic_frame = diagnostic
                        .take()
                        .ok_or_else(|| anyhow::anyhow!("malformed <{}> element", frame.name))?;
                    let value = Diagnostic {
                        message: diagnostic_frame.message,
                        detail: diagnostic_frame.text.trim().to_string(),
                    };
                    if let Some(case) = current_case.as_mut() {
                        if diagnostic_frame.kind == "error" {
                            if case.error.is_none() {
                                case.error = Some(value);
                            }
                        } else if case.failure.is_none() {
                            case.failure = Some(value);
                        }
                    } else {
                        anyhow::bail!("<{}> must be inside <testcase>", frame.name);
                    }
                }
                "testcase" => {
                    let builder = current_case
                        .take()
                        .ok_or_else(|| anyhow::anyhow!("malformed <testcase> element"))?;
                    cases.push(ParsedCase {
                        suite: builder.suite,
                        name: builder.name,
                        file: builder.file,
                        duration_ms: builder.duration_ms,
                        skipped: builder.skipped,
                        failure: builder.failure,
                        error: builder.error,
                    });
                }
                _ => {}
            }
            cursor = tag_end + 1;
            if stack.is_empty() {
                root_closed = true;
            }
            continue;
        }

        let (name, attrs, self_closing) = parse_open_tag(&xml[cursor + 1..tag_end])?;
        if !root_seen {
            if !matches!(name.as_str(), "testsuites" | "testsuite") {
                anyhow::bail!("JUnit root must be <testsuites> or <testsuite>, got <{name}>");
            }
            root_seen = true;
        } else if root_closed {
            anyhow::bail!("multiple XML roots; found <{name}> after the JUnit root");
        }

        match name.as_str() {
            "testcase" => {
                let parent = stack.last().map(|frame| frame.name.as_str());
                if !matches!(parent, Some("testsuites") | Some("testsuite")) {
                    anyhow::bail!("<testcase> must be inside <testsuites> or <testsuite>");
                }
                if current_case.is_some() {
                    anyhow::bail!("nested <testcase> elements are not valid JUnit");
                }
                current_case = Some(make_case_builder(&attrs, &stack)?);
                if self_closing {
                    let builder = current_case.take().expect("case was just created");
                    cases.push(ParsedCase {
                        suite: builder.suite,
                        name: builder.name,
                        file: builder.file,
                        duration_ms: builder.duration_ms,
                        skipped: builder.skipped,
                        failure: builder.failure,
                        error: builder.error,
                    });
                }
            }
            "failure" | "error" => {
                if current_case.is_none() {
                    anyhow::bail!("<{name}> must be inside <testcase>");
                }
                let diagnostic_frame = DiagnosticFrame {
                    kind: if name == "error" { "error" } else { "failure" },
                    message: attr_text(&attrs, "message"),
                    text: String::new(),
                };
                if self_closing {
                    if let Some(case) = current_case.as_mut() {
                        let value = Diagnostic {
                            message: diagnostic_frame.message,
                            detail: String::new(),
                        };
                        if name == "error" {
                            if case.error.is_none() {
                                case.error = Some(value);
                            }
                        } else if case.failure.is_none() {
                            case.failure = Some(value);
                        }
                    }
                } else {
                    diagnostic = Some(diagnostic_frame);
                }
            }
            "skipped" => {
                if let Some(case) = current_case.as_mut() {
                    case.skipped = true;
                } else {
                    anyhow::bail!("<skipped> must be inside <testcase>");
                }
            }
            _ => {}
        }

        if !self_closing {
            stack.push(XmlFrame { name, attrs });
        }
        if self_closing && stack.is_empty() {
            root_closed = true;
        }
        cursor = tag_end + 1;
    }

    if !root_seen {
        anyhow::bail!("JUnit XML has no root element");
    }
    if !stack.is_empty() {
        anyhow::bail!(
            "truncated XML: unclosed <{}>",
            stack
                .last()
                .map(|frame| frame.name.as_str())
                .unwrap_or("root")
        );
    }
    if !root_closed {
        anyhow::bail!("truncated XML: JUnit root is not closed");
    }
    Ok(cases)
}

fn find_tag_end(xml: &str, start: usize) -> Option<usize> {
    let mut quote = None;
    for (offset, character) in xml[start + 1..].char_indices() {
        match quote {
            Some(expected) if character == expected => quote = None,
            Some(_) => {}
            None if matches!(character, '\'' | '"') => quote = Some(character),
            None if character == '>' => return Some(start + 1 + offset),
            None => {}
        }
    }
    None
}

fn find_declaration_end(xml: &str, start: usize) -> Option<usize> {
    let mut quote = None;
    let mut subset_depth = 0;
    for (offset, character) in xml[start + 2..].char_indices() {
        match quote {
            Some(expected) if character == expected => quote = None,
            Some(_) => {}
            None if matches!(character, '\'' | '"') => quote = Some(character),
            None if character == '[' => subset_depth += 1,
            None if character == ']' && subset_depth > 0 => subset_depth -= 1,
            None if character == '>' && subset_depth == 0 => return Some(start + 2 + offset),
            None => {}
        }
    }
    None
}

fn parse_close_name(raw: &str) -> Result<String> {
    let name = raw.trim();
    if name.is_empty()
        || name
            .chars()
            .any(|character| character.is_whitespace() || character == '/')
    {
        anyhow::bail!("malformed XML closing tag");
    }
    Ok(name.to_string())
}

fn parse_open_tag(raw: &str) -> Result<(String, Vec<(String, String)>, bool)> {
    let mut raw = raw.trim();
    let self_closing = raw.ends_with('/');
    if self_closing {
        raw = raw[..raw.len() - 1].trim_end();
    }
    let name_end = raw.find(char::is_whitespace).unwrap_or(raw.len());
    let name = &raw[..name_end];
    if name.is_empty() || !valid_xml_name(name) {
        anyhow::bail!("malformed XML opening tag");
    }
    let attrs = parse_attributes(&raw[name_end..])?;
    Ok((name.to_string(), attrs, self_closing))
}

fn parse_attributes(raw: &str) -> Result<Vec<(String, String)>> {
    let mut attributes = Vec::new();
    let mut cursor = 0;
    let bytes = raw.as_bytes();
    while cursor < bytes.len() {
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        if cursor == bytes.len() {
            break;
        }

        let name_start = cursor;
        while cursor < bytes.len()
            && (bytes[cursor].is_ascii_alphanumeric()
                || matches!(bytes[cursor], b'_' | b'.' | b':' | b'-'))
        {
            cursor += 1;
        }
        let name = &raw[name_start..cursor];
        if name.is_empty() || !valid_xml_name(name) {
            anyhow::bail!("malformed XML attribute list");
        }
        if attributes.iter().any(|(existing, _)| existing == name) {
            anyhow::bail!("duplicate XML attribute: {name}");
        }
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        if bytes.get(cursor) != Some(&b'=') {
            anyhow::bail!("XML attribute {name} is missing '='");
        }
        cursor += 1;
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        let quote = *bytes
            .get(cursor)
            .ok_or_else(|| anyhow::anyhow!("XML attribute {name} is not quoted"))?;
        if !matches!(quote, b'\'' | b'"') {
            anyhow::bail!("XML attribute {name} is not quoted");
        }
        cursor += 1;
        let value_start = cursor;
        while cursor < bytes.len() && bytes[cursor] != quote {
            cursor += 1;
        }
        if cursor == bytes.len() {
            anyhow::bail!("XML attribute {name} is unterminated");
        }
        let value = decode_xml_entities(&raw[value_start..cursor]);
        cursor += 1;
        attributes.push((name.to_string(), value));
    }
    Ok(attributes)
}

fn valid_xml_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(
        chars.next(),
        Some(character) if character.is_ascii_alphabetic() || character == '_'
    ) && chars.all(|character| {
        character.is_ascii_alphanumeric() || matches!(character, '_' | '.' | ':' | '-')
    })
}

fn attr_text(attrs: &[(String, String)], name: &str) -> Option<String> {
    attrs
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.clone())
        .filter(|value| !value.trim().is_empty())
}

fn make_case_builder(attrs: &[(String, String)], stack: &[XmlFrame]) -> Result<CaseBuilder> {
    let name =
        attr_text(attrs, "name").ok_or_else(|| anyhow::anyhow!("testcase is missing a name"))?;
    let duration_ms = match attr_text(attrs, "time") {
        None => None,
        Some(value) => {
            let seconds: f64 = value
                .parse()
                .with_context(|| format!("invalid testcase time: {value}"))?;
            if !seconds.is_finite() || seconds < 0.0 {
                anyhow::bail!("invalid testcase time: {value}");
            }
            Some(seconds * 1000.0)
        }
    };
    let classname = attr_text(attrs, "classname").filter(|value| value != "test");
    let suite = classname.or_else(|| {
        let suites: Vec<String> = stack
            .iter()
            .filter(|frame| frame.name == "testsuite")
            .filter_map(|frame| attr_text(&frame.attrs, "name"))
            .collect();
        (!suites.is_empty()).then(|| suites.join("::"))
    });

    Ok(CaseBuilder {
        suite,
        name,
        file: attr_text(attrs, "file"),
        duration_ms,
        skipped: false,
        failure: None,
        error: None,
    })
}

fn decode_xml_entities(text: &str) -> String {
    let mut decoded = String::with_capacity(text.len());
    let mut cursor = 0;
    while let Some(relative_start) = text[cursor..].find('&') {
        let start = cursor + relative_start;
        decoded.push_str(&text[cursor..start]);
        let Some(relative_end) = text[start..].find(';') else {
            decoded.push('&');
            cursor = start + 1;
            continue;
        };
        let end = start + relative_end;
        let entity = &text[start + 1..end];
        match entity {
            "lt" => decoded.push('<'),
            "gt" => decoded.push('>'),
            "quot" => decoded.push('"'),
            "apos" => decoded.push('\''),
            "amp" => decoded.push('&'),
            value
                if value
                    .strip_prefix("#x")
                    .or_else(|| value.strip_prefix("#X"))
                    .is_some() =>
            {
                let value = value
                    .strip_prefix("#x")
                    .or_else(|| value.strip_prefix("#X"))
                    .and_then(|hex| u32::from_str_radix(hex, 16).ok())
                    .and_then(char::from_u32);
                if let Some(value) = value {
                    decoded.push(value);
                } else {
                    decoded.push_str(&text[start..=end]);
                }
            }
            value if value.strip_prefix('#').is_some() => {
                let value = value
                    .strip_prefix('#')
                    .and_then(|decimal| decimal.parse::<u32>().ok())
                    .and_then(char::from_u32);
                if let Some(value) = value {
                    decoded.push(value);
                } else {
                    decoded.push_str(&text[start..=end]);
                }
            }
            _ => decoded.push_str(&text[start..=end]),
        }
        cursor = end + 1;
    }
    decoded.push_str(&text[cursor..]);
    decoded
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::Path};

    fn temp_root(label: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("openmemory-qa-runner-{label}-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("temporary root");
        root
    }

    #[test]
    fn origin_directory_matches_duplicate_provenance() {
        let description =
            "Duplicated test\nfile:       apps/web/lib/qa-cases.test.ts\nstatus: failed";
        assert_eq!(
            origin_dir_from_description(Some(description)),
            Some("apps/web/lib".to_string())
        );
        assert_eq!(
            origin_dir_from_description(Some("file:       top-level.test.ts")),
            None
        );
        assert_eq!(
            origin_dir_from_description(Some("file:       ../../outside.test.ts")),
            None
        );
        assert_eq!(
            origin_dir_from_description(Some("file:       a/$(whoami).test.ts")),
            None
        );
    }

    #[test]
    fn slug_and_extension_match_the_ui() {
        assert_eq!(plan_slug(" Checkout smoke "), "Checkout_smoke");
        assert_eq!(plan_slug("$(rm -rf /)"), "rm_-rf");
        assert_eq!(plan_slug("日本語"), "plan");
        assert_eq!(plan_file_extension("jest", "javascript"), "test.js");
        assert_eq!(plan_file_extension("playwright", "python"), "spec.py");
        assert_eq!(plan_file_extension("maestro", "yaml"), "yaml");
        assert_eq!(plan_file_extension("other", "python"), "test.py");
        assert_eq!(
            target_relative_path("Smoke", "jest", "typescript", None),
            Path::new(".qa-plans/Smoke.test.ts")
        );
    }

    #[test]
    fn target_guard_rejects_parent_absolute_and_symlink_out() {
        let root = temp_root("escape");
        let outside = temp_root("outside");
        fs::write(outside.join("outside.ts"), "outside").expect("outside file");

        assert!(resolve_target_path(&root, Path::new("../outside.ts")).is_err());
        assert!(resolve_target_path(&root, &outside.join("outside.ts")).is_err());

        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, root.join("linked")).expect("symlink");
        #[cfg(unix)]
        assert!(resolve_target_path(&root, Path::new("linked/plan.test.ts")).is_err());
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.join("outside.ts"), root.join("linked-file.ts"))
            .expect("file symlink");
        #[cfg(unix)]
        assert!(resolve_target_path(&root, Path::new("linked-file.ts")).is_err());

        fs::remove_dir_all(root).expect("remove root");
        fs::remove_dir_all(outside).expect("remove outside");
    }

    #[test]
    fn runner_table_builds_exact_argv_shapes() {
        let node =
            runner_for("jest", "typescript", "plan.test.ts", ".junit.xml").expect("node runner");
        assert_eq!(node.runner, "node:test");
        assert_eq!(node.ingest_kind, "unit");
        assert_eq!(
            node.args,
            vec![
                "--test",
                "--test-reporter=junit",
                "--test-reporter-destination=.junit.xml",
                "--test-reporter=spec",
                "--test-reporter-destination=stdout",
                "plan.test.ts"
            ]
        );

        let playwright = runner_for("playwright", "typescript", "plan.spec.ts", ".junit.xml")
            .expect("playwright runner");
        assert_eq!(
            playwright.args,
            vec!["playwright", "test", "plan.spec.ts", "--reporter=junit"]
        );
        assert_eq!(
            playwright.env,
            vec![(
                "PLAYWRIGHT_JUNIT_OUTPUT_NAME".to_string(),
                ".junit.xml".to_string()
            )]
        );

        let python =
            runner_for("other", "python", "plan.test.py", ".junit.xml").expect("pytest runner");
        assert_eq!(python.args, vec!["plan.test.py", "--junitxml=.junit.xml"]);

        let maestro =
            runner_for("maestro", "yaml", "flow.yaml", ".junit.xml").expect("maestro runner");
        assert_eq!(
            maestro.args,
            vec![
                "test",
                "flow.yaml",
                "--format",
                "junit",
                "--output",
                ".junit.xml"
            ]
        );

        assert!(runner_for("other", "other", "plan.txt", ".junit.xml").is_none());
    }

    #[test]
    fn junit_parser_handles_direct_cases_failures_and_skips() {
        let xml = r#"<?xml version="1.0"?><testsuites>
          <testcase name="pass &amp; case" classname="test" file="tests/example.test.ts" time="0.0015"/>
          <testcase name="failed"><failure message="assertion"><![CDATA[expected output]]></failure></testcase>
          <testcase name="errored"><error message="import failed">stack</error></testcase>
          <testcase name="skipped"><skipped/></testcase>
        </testsuites>"#;
        let cases = parse_junit(xml).expect("JUnit");
        assert_eq!(cases.len(), 4);
        assert_eq!(cases[0].name, "pass & case");
        assert_eq!(cases[0].duration_ms, Some(1.5));
        assert_eq!(
            cases[1]
                .failure
                .as_ref()
                .and_then(|diagnostic| diagnostic.message.as_deref()),
            Some("assertion")
        );
        assert_eq!(
            cases[1]
                .failure
                .as_ref()
                .map(|diagnostic| diagnostic.detail.as_str()),
            Some("expected output")
        );
        assert!(cases[2].error.is_some());
        assert!(cases[3].skipped);
    }
}
