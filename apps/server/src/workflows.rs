//! Reusable HTTP and agent-assisted workflows.
//!
//! HTTP steps execute server-side. Agent steps pause a run and return a typed
//! action to the MCP host, which performs the privileged capability and resumes
//! the run with its artifact/result. OpenMemory never becomes a remote shell.

use std::{collections::HashMap, path::Path, time::Duration};

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

use crate::crypto::decrypt_value;

const MAX_STEPS: usize = 20;
const MAX_RESPONSE_BYTES: usize = 1_000_000;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Workflow {
    pub id: Uuid,
    pub name: String,
    pub description: Option<String>,
    pub input_schema: Value,
    pub steps: Value,
    pub enabled: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowStep {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default = "default_step_kind")]
    pub kind: String,
    #[serde(default)]
    pub method: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub auth_key: Option<String>,
    #[serde(default)]
    pub secret_target: Option<String>,
    #[serde(default)]
    pub auth_header: Option<String>,
    #[serde(default)]
    pub auth_prefix: Option<String>,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub body: Option<Value>,
    #[serde(default)]
    pub capability: Option<String>,
    #[serde(default)]
    pub instruction: Option<String>,
    #[serde(default)]
    pub skill: Option<String>,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub working_directory: Option<String>,
    #[serde(default)]
    pub required_inputs: Vec<String>,
    #[serde(default)]
    pub required_files: Vec<String>,
    #[serde(default)]
    pub expected_output: Option<String>,
}

fn default_step_kind() -> String {
    "http".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepResult {
    pub id: String,
    pub name: Option<String>,
    pub status: u16,
    pub body: Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkflowRunResult {
    pub run_id: Option<Uuid>,
    pub workflow_id: Uuid,
    pub workflow_name: String,
    pub status: String,
    pub success: bool,
    pub steps: Vec<StepResult>,
    pub result: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action_required: Option<AgentAction>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentAction {
    pub step_id: String,
    pub name: Option<String>,
    pub capability: String,
    pub instruction: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skill: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub working_directory: Option<String>,
    pub expected_output: String,
}

#[derive(Debug, FromRow)]
struct WorkflowRun {
    id: Uuid,
    workflow_id: Uuid,
    input: Value,
    current_step: i32,
    step_results: Value,
    status: String,
}

pub async fn ensure_table(db: &PgPool) -> Result<()> {
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS workflows (
            id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
            name         TEXT        NOT NULL UNIQUE,
            description  TEXT,
            input_schema JSONB       NOT NULL DEFAULT '{}',
            steps        JSONB       NOT NULL DEFAULT '[]',
            enabled      BOOLEAN     NOT NULL DEFAULT TRUE,
            created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        "#,
    )
    .execute(db)
    .await
    .context("failed to create workflows table")?;
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS workflow_runs (
            id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
            workflow_id  UUID        NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
            input        JSONB       NOT NULL DEFAULT '{}',
            current_step INTEGER     NOT NULL DEFAULT 0,
            step_results JSONB       NOT NULL DEFAULT '[]',
            status       TEXT        NOT NULL DEFAULT 'running',
            created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        "#,
    )
    .execute(db)
    .await
    .context("failed to create workflow_runs table")?;
    Ok(())
}

pub fn validate_definition(
    name: &str,
    input_schema: &Value,
    steps: &Value,
) -> Result<Vec<WorkflowStep>> {
    let name = name.trim();
    if name.is_empty() || name.len() > 80 {
        anyhow::bail!("name must be between 1 and 80 characters");
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        anyhow::bail!("name may contain only letters, numbers, '-' and '_'");
    }
    if !input_schema.is_object() {
        anyhow::bail!("input_schema must be a JSON object");
    }
    let parsed: Vec<WorkflowStep> = serde_json::from_value(steps.clone())
        .context("steps must be an array of valid workflow steps")?;
    if parsed.is_empty() || parsed.len() > MAX_STEPS {
        anyhow::bail!("a workflow must contain between 1 and {MAX_STEPS} steps");
    }
    let mut ids = std::collections::HashSet::new();
    for step in &parsed {
        if step.id.trim().is_empty()
            || !step
                .id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            anyhow::bail!("step ids must contain only letters, numbers, '-' and '_'");
        }
        if !ids.insert(step.id.clone()) {
            anyhow::bail!("duplicate step id: {}", step.id);
        }
        match step.kind.as_str() {
            "http" => {
                match step.method.to_uppercase().as_str() {
                    "GET" | "POST" | "PUT" | "PATCH" | "DELETE" => {}
                    _ => anyhow::bail!("unsupported method in step '{}': {}", step.id, step.method),
                }
                if step.secret_target.as_deref().unwrap_or("header") == "url" {
                    if step.auth_key.as_deref().unwrap_or("").is_empty() {
                        anyhow::bail!(
                            "step '{}' requires auth_key when secret_target is 'url'",
                            step.id
                        );
                    }
                } else if step.url.trim().is_empty() {
                    anyhow::bail!("step '{}' requires a URL", step.id);
                }
            }
            "agent" => {
                let capability = step.capability.as_deref().unwrap_or("");
                if !matches!(capability, "image_generation" | "skill" | "command") {
                    anyhow::bail!("step '{}' has unsupported agent capability", step.id);
                }
                if step.instruction.as_deref().unwrap_or("").trim().is_empty() {
                    anyhow::bail!("agent step '{}' requires an instruction", step.id);
                }
                if capability == "skill" && step.skill.as_deref().unwrap_or("").trim().is_empty() {
                    anyhow::bail!("agent skill step '{}' requires a skill name", step.id);
                }
                if capability == "command"
                    && step.command.as_deref().unwrap_or("").trim().is_empty()
                {
                    anyhow::bail!("agent command step '{}' requires a command", step.id);
                }
            }
            _ => anyhow::bail!("unsupported step kind in '{}': {}", step.id, step.kind),
        }
    }
    Ok(parsed)
}

fn file_path(value: &Value) -> Option<&str> {
    value
        .as_str()
        .or_else(|| value.get("path").and_then(Value::as_str))
}

fn validate_input(input_schema: &Value, input: &Value) -> Result<()> {
    let schema = input_schema
        .as_object()
        .context("input_schema must be a JSON object")?;
    let values = input.as_object().context("input must be a JSON object")?;
    for (name, definition) in schema {
        let kind = definition
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("any");
        let required = definition
            .get("required")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let Some(value) = values.get(name) else {
            if required {
                anyhow::bail!("missing required workflow input: {name}");
            }
            continue;
        };
        if value.is_null() {
            if required {
                anyhow::bail!("required workflow input '{name}' cannot be null");
            }
            continue;
        }
        match kind {
            "any" => {}
            "text" | "string" if value.is_string() => {}
            "json" if value.is_object() || value.is_array() => {}
            "object" if value.is_object() => {}
            "number" if value.is_number() => {}
            "boolean" if value.is_boolean() => {}
            "image" | "pdf" | "file" => {
                let path = file_path(value).with_context(|| {
                    format!(
                        "workflow input '{name}' must be a file path or an object containing path"
                    )
                })?;
                if !Path::new(path).is_file() {
                    anyhow::bail!("workflow input '{name}' requires an existing file: {path}");
                }
                let extension = Path::new(path)
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .unwrap_or("")
                    .to_ascii_lowercase();
                if kind == "image"
                    && !matches!(
                        extension.as_str(),
                        "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp" | "svg" | "avif"
                    )
                {
                    anyhow::bail!("workflow input '{name}' requires a supported image file");
                }
                if kind == "pdf" && extension != "pdf" {
                    anyhow::bail!("workflow input '{name}' requires a PDF file");
                }
            }
            _ => anyhow::bail!("workflow input '{name}' must have type {kind}"),
        }
    }
    Ok(())
}

pub async fn list(db: &PgPool, limit: i64, offset: i64) -> Result<Vec<Workflow>> {
    Ok(sqlx::query_as(
        "SELECT id, name, description, input_schema, steps, enabled, created_at, updated_at FROM workflows ORDER BY name LIMIT $1 OFFSET $2",
    )
    .bind(limit)
    .bind(offset)
    .fetch_all(db)
    .await?)
}

pub async fn count(db: &PgPool) -> Result<i64> {
    let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM workflows")
        .fetch_one(db)
        .await?;
    Ok(count)
}

pub async fn get(db: &PgPool, id_or_name: &str) -> Result<Workflow> {
    let row = if let Ok(id) = Uuid::parse_str(id_or_name) {
        sqlx::query_as("SELECT id, name, description, input_schema, steps, enabled, created_at, updated_at FROM workflows WHERE id = $1")
            .bind(id).fetch_optional(db).await?
    } else {
        sqlx::query_as("SELECT id, name, description, input_schema, steps, enabled, created_at, updated_at FROM workflows WHERE name = $1")
            .bind(id_or_name).fetch_optional(db).await?
    };
    row.with_context(|| format!("workflow not found: {id_or_name}"))
}

pub async fn create(
    db: &PgPool,
    name: &str,
    description: Option<&str>,
    input_schema: &Value,
    steps: &Value,
    enabled: bool,
) -> Result<Workflow> {
    validate_definition(name, input_schema, steps)?;
    Ok(sqlx::query_as(
        r#"INSERT INTO workflows (name, description, input_schema, steps, enabled)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, name, description, input_schema, steps, enabled, created_at, updated_at"#,
    )
    .bind(name.trim())
    .bind(description)
    .bind(input_schema)
    .bind(steps)
    .bind(enabled)
    .fetch_one(db)
    .await?)
}

pub async fn update(
    db: &PgPool,
    id: Uuid,
    name: &str,
    description: Option<&str>,
    input_schema: &Value,
    steps: &Value,
    enabled: bool,
) -> Result<Workflow> {
    validate_definition(name, input_schema, steps)?;
    sqlx::query_as(
        r#"UPDATE workflows SET name=$2, description=$3, input_schema=$4, steps=$5,
           enabled=$6, updated_at=NOW() WHERE id=$1
           RETURNING id, name, description, input_schema, steps, enabled, created_at, updated_at"#,
    )
    .bind(id)
    .bind(name.trim())
    .bind(description)
    .bind(input_schema)
    .bind(steps)
    .bind(enabled)
    .fetch_optional(db)
    .await?
    .context("workflow not found")
}

pub async fn delete(db: &PgPool, id: Uuid) -> Result<()> {
    let result = sqlx::query("DELETE FROM workflows WHERE id=$1")
        .bind(id)
        .execute(db)
        .await?;
    if result.rows_affected() == 0 {
        anyhow::bail!("workflow not found");
    }
    Ok(())
}

fn lookup<'a>(root: &'a Value, path: &str) -> Option<&'a Value> {
    path.split('.').try_fold(root, |value, key| match value {
        Value::Object(map) => map.get(key),
        Value::Array(items) => key.parse::<usize>().ok().and_then(|i| items.get(i)),
        _ => None,
    })
}

fn resolve_token(token: &str, input: &Value, prior: &Value) -> Result<Value> {
    if let Some(path) = token.strip_prefix("input.") {
        return lookup(input, path)
            .cloned()
            .with_context(|| format!("missing workflow input: {path}"));
    }
    if let Some(path) = token.strip_prefix("steps.") {
        return lookup(prior, path)
            .cloned()
            .with_context(|| format!("missing previous-step value: {path}"));
    }
    anyhow::bail!("unsupported template token: {token}")
}

fn render_string(template: &str, input: &Value, prior: &Value) -> Result<Value> {
    if template.starts_with("{{") && template.ends_with("}}") && template.matches("{{").count() == 1
    {
        return resolve_token(template[2..template.len() - 2].trim(), input, prior);
    }
    let mut output = template.to_string();
    while let Some(start) = output.find("{{") {
        let end = output[start + 2..]
            .find("}}")
            .map(|i| start + 2 + i)
            .context("unclosed workflow template token")?;
        let token = output[start + 2..end].trim();
        let value = resolve_token(token, input, prior)?;
        let replacement = value
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| value.to_string());
        output.replace_range(start..end + 2, &replacement);
    }
    Ok(Value::String(output))
}

fn render(value: &Value, input: &Value, prior: &Value) -> Result<Value> {
    match value {
        Value::String(s) => render_string(s, input, prior),
        Value::Array(a) => Ok(Value::Array(
            a.iter()
                .map(|v| render(v, input, prior))
                .collect::<Result<_>>()?,
        )),
        Value::Object(o) => Ok(Value::Object(
            o.iter()
                .map(|(k, v)| Ok((k.clone(), render(v, input, prior)?)))
                .collect::<Result<_>>()?,
        )),
        _ => Ok(value.clone()),
    }
}

fn validate_allowed_host(url: &str) -> Result<()> {
    let parsed = reqwest::Url::parse(url).context("invalid workflow URL")?;
    if !matches!(parsed.scheme(), "http" | "https") {
        anyhow::bail!("workflow URL must use http or https");
    }
    if let Ok(allowed) = std::env::var("OPENMEMORY_HTTP_ALLOWED_HOSTS") {
        let host = parsed.host_str().unwrap_or("").to_lowercase();
        let permitted = allowed
            .split(',')
            .map(|h| h.trim().to_lowercase())
            .any(|h| !h.is_empty() && h == host);
        if !permitted {
            anyhow::bail!(
                "Host '{host}' is not in OPENMEMORY_HTTP_ALLOWED_HOSTS — request blocked"
            );
        }
    }
    Ok(())
}

async fn resolve_secret(db: &PgPool, encryption_key: &[u8; 32], key: &str) -> Result<String> {
    let row: Option<(Vec<u8>,)> =
        sqlx::query_as("SELECT value_encrypted FROM env_params WHERE key=$1")
            .bind(key)
            .fetch_optional(db)
            .await?;
    let encrypted = row
        .with_context(|| format!("environment parameter not found: {key}"))?
        .0;
    decrypt_value(encryption_key, &encrypted).context("failed to decrypt workflow credential")
}

fn prior_from_results(results: &[StepResult]) -> Result<Value> {
    let mut prior = json!({});
    for result in results {
        prior[&result.id] = serde_json::to_value(result)?;
    }
    Ok(prior)
}

async fn execute_http_step(
    db: &PgPool,
    encryption_key: &[u8; 32],
    step: &WorkflowStep,
    input: &Value,
    prior: &Value,
) -> Result<StepResult> {
    let client = Client::builder().timeout(Duration::from_secs(30)).build()?;
    let secret_target = step.secret_target.as_deref().unwrap_or("header");
    let secret = match step.auth_key.as_deref() {
        Some(key) if !key.is_empty() => Some(resolve_secret(db, encryption_key, key).await?),
        _ => None,
    };
    let url = if secret_target == "url" {
        secret.clone().context("secret URL requires auth_key")?
    } else {
        render_string(&step.url, input, prior)?
            .as_str()
            .context("rendered URL must be a string")?
            .to_owned()
    };
    validate_allowed_host(&url)?;
    let method = reqwest::Method::from_bytes(step.method.to_uppercase().as_bytes())?;
    let mut request = client
        .request(method, &url)
        .header("Content-Type", "application/json");
    if secret_target != "url" {
        if let Some(value) = secret {
            let header = step.auth_header.as_deref().unwrap_or("Authorization");
            let prefix = step.auth_prefix.as_deref().unwrap_or("Bearer ");
            request = request.header(header, format!("{prefix}{value}"));
        }
    }
    for (key, value) in &step.headers {
        let rendered = render_string(value, input, prior)?;
        request = request.header(
            key,
            rendered
                .as_str()
                .context("rendered header must be a string")?,
        );
    }
    if let Some(body) = &step.body {
        request = request.json(&render(body, input, prior)?);
    }
    let response = request
        .send()
        .await
        .with_context(|| format!("workflow step '{}' request failed", step.id))?;
    let status = response.status().as_u16();
    let bytes = response.bytes().await?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        anyhow::bail!("workflow step '{}' response exceeds 1 MB", step.id);
    }
    let body = serde_json::from_slice(&bytes)
        .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned()));
    Ok(StepResult {
        id: step.id.clone(),
        name: step.name.clone(),
        status,
        body,
    })
}

fn render_agent_action(step: &WorkflowStep, input: &Value, prior: &Value) -> Result<AgentAction> {
    for path in &step.required_inputs {
        if lookup(input, path).is_none() {
            anyhow::bail!("agent step '{}' requires workflow input: {path}", step.id);
        }
    }
    let rendered_string = |value: Option<&str>| -> Result<Option<String>> {
        value
            .map(|text| {
                render_string(text, input, prior).and_then(|v| {
                    v.as_str()
                        .map(str::to_owned)
                        .context("rendered agent field must be a string")
                })
            })
            .transpose()
    };
    for template in &step.required_files {
        let path = render_string(template, input, prior)?;
        let path = path
            .as_str()
            .context("rendered required file must be a string")?;
        if !Path::new(path).is_file() {
            anyhow::bail!("agent step '{}' requires an existing file: {path}", step.id);
        }
    }
    Ok(AgentAction {
        step_id: step.id.clone(),
        name: step.name.clone(),
        capability: step
            .capability
            .clone()
            .unwrap_or_else(|| "skill".to_string()),
        instruction: rendered_string(step.instruction.as_deref())?.unwrap_or_default(),
        skill: rendered_string(step.skill.as_deref())?,
        command: rendered_string(step.command.as_deref())?,
        working_directory: rendered_string(step.working_directory.as_deref())?,
        expected_output: rendered_string(step.expected_output.as_deref())?.unwrap_or_else(|| {
            "Return a JSON object containing the produced artifact paths and a concise summary."
                .to_string()
        }),
    })
}

async fn persist_run(
    db: &PgPool,
    run_id: Uuid,
    current_step: usize,
    results: &[StepResult],
    status: &str,
) -> Result<()> {
    sqlx::query("UPDATE workflow_runs SET current_step=$2, step_results=$3, status=$4, updated_at=NOW() WHERE id=$1")
        .bind(run_id).bind(current_step as i32).bind(serde_json::to_value(results)?).bind(status)
        .execute(db).await?;
    Ok(())
}

async fn advance(
    db: &PgPool,
    encryption_key: &[u8; 32],
    workflow: Workflow,
    run_id: Uuid,
    input: Value,
    mut current_step: usize,
    mut results: Vec<StepResult>,
) -> Result<WorkflowRunResult> {
    let steps = validate_definition(&workflow.name, &workflow.input_schema, &workflow.steps)?;
    while current_step < steps.len() {
        let prior = prior_from_results(&results)?;
        let step = &steps[current_step];
        if step.kind == "agent" {
            let action = render_agent_action(step, &input, &prior)?;
            persist_run(db, run_id, current_step, &results, "action_required").await?;
            return Ok(WorkflowRunResult {
                run_id: Some(run_id),
                workflow_id: workflow.id,
                workflow_name: workflow.name,
                status: "action_required".to_string(),
                success: false,
                steps: results,
                result: json!({"message":"Agent action required","step_id":step.id}),
                action_required: Some(action),
            });
        }
        let result = execute_http_step(db, encryption_key, step, &input, &prior).await?;
        let failed = result.status >= 400;
        results.push(result);
        current_step += 1;
        if failed {
            persist_run(db, run_id, current_step, &results, "failed").await?;
            return Ok(WorkflowRunResult {
                run_id: Some(run_id),
                workflow_id: workflow.id,
                workflow_name: workflow.name,
                status: "failed".to_string(),
                success: false,
                result: serde_json::to_value(results.last().unwrap())?,
                steps: results,
                action_required: None,
            });
        }
    }
    persist_run(db, run_id, current_step, &results, "completed").await?;
    Ok(WorkflowRunResult {
        run_id: Some(run_id),
        workflow_id: workflow.id,
        workflow_name: workflow.name,
        status: "completed".to_string(),
        success: true,
        result: serde_json::to_value(results.last().context("workflow has no steps")?)?,
        steps: results,
        action_required: None,
    })
}

pub async fn run(
    db: &PgPool,
    encryption_key: &[u8; 32],
    id_or_name: &str,
    input: Value,
) -> Result<WorkflowRunResult> {
    if !input.is_object() {
        anyhow::bail!("input must be a JSON object");
    }
    let workflow = get(db, id_or_name).await?;
    if !workflow.enabled {
        anyhow::bail!("workflow '{}' is disabled", workflow.name);
    }
    validate_definition(&workflow.name, &workflow.input_schema, &workflow.steps)?;
    validate_input(&workflow.input_schema, &input)?;
    let run_id: Uuid = sqlx::query_scalar(
        "INSERT INTO workflow_runs (workflow_id, input) VALUES ($1, $2) RETURNING id",
    )
    .bind(workflow.id)
    .bind(&input)
    .fetch_one(db)
    .await?;
    advance(db, encryption_key, workflow, run_id, input, 0, Vec::new()).await
}

pub async fn continue_run(
    db: &PgPool,
    encryption_key: &[u8; 32],
    run_id: Uuid,
    result: Value,
) -> Result<WorkflowRunResult> {
    let run: WorkflowRun = sqlx::query_as(
        "SELECT id, workflow_id, input, current_step, step_results, status FROM workflow_runs WHERE id=$1"
    ).bind(run_id).fetch_optional(db).await?.context("workflow run not found")?;
    if run.status != "action_required" {
        anyhow::bail!("workflow run is not waiting for an agent action");
    }
    let workflow = get(db, &run.workflow_id.to_string()).await?;
    let steps = validate_definition(&workflow.name, &workflow.input_schema, &workflow.steps)?;
    let current = run.current_step as usize;
    let step = steps
        .get(current)
        .context("workflow run points past its final step")?;
    if step.kind != "agent" {
        anyhow::bail!("current workflow step is not an agent action");
    }
    let mut results: Vec<StepResult> = serde_json::from_value(run.step_results)?;
    results.push(StepResult {
        id: step.id.clone(),
        name: step.name.clone(),
        status: 200,
        body: result,
    });
    advance(
        db,
        encryption_key,
        workflow,
        run.id,
        run.input,
        current + 1,
        results,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_typed_input_and_previous_step_values() {
        let input = json!({"id": 7});
        let prior = json!({"first": {"body": {"token": "abc"}}});
        assert_eq!(
            render(
                &json!({"id": "{{input.id}}", "token": "{{steps.first.body.token}}"}),
                &input,
                &prior
            )
            .unwrap(),
            json!({"id": 7, "token": "abc"})
        );
    }

    #[test]
    fn rejects_duplicate_step_ids() {
        let steps = json!([
            {"id":"same","method":"GET","url":"https://example.com"},
            {"id":"same","method":"GET","url":"https://example.com"}
        ]);
        assert!(validate_definition("valid", &json!({}), &steps)
            .unwrap_err()
            .to_string()
            .contains("duplicate"));
    }

    #[test]
    fn validates_typed_text_and_json_inputs() {
        let schema = json!({
            "prompt": {"type":"text", "required":true},
            "options": {"type":"json", "required":true},
            "anything": {"type":"any"}
        });
        assert!(validate_input(
            &schema,
            &json!({"prompt":"hello", "options":{"quality":"high"}})
        )
        .is_ok());
        assert!(validate_input(&schema, &json!({"prompt":{"wrong":true}, "options":[]})).is_err());
        assert!(validate_input(&schema, &json!({"prompt":"hello"}))
            .unwrap_err()
            .to_string()
            .contains("options"));
    }
}
