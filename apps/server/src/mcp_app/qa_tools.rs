use super::*;

/// Same precedence as `resolve_user_path` in `main.rs`: `OPENMEMORY_HOME_DIR`
/// first, falling back to `HOME`. Used only to resolve `file_path` — the token
/// file keeps using plain `HOME` in `qa_api_token()` below, matching
/// `resolve_api_token()`'s own token-file path, which intentionally never
/// consults `OPENMEMORY_HOME_DIR`.
fn expand_home_path(p: &str) -> std::path::PathBuf {
    if let Some(rest) = p.strip_prefix("~/") {
        let home = std::env::var("OPENMEMORY_HOME_DIR")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_else(|_| "/".to_string());
        std::path::PathBuf::from(home).join(rest)
    } else if p == "~" {
        let home = std::env::var("OPENMEMORY_HOME_DIR")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_else(|_| "/".to_string());
        std::path::PathBuf::from(home)
    } else {
        std::path::PathBuf::from(p)
    }
}

fn qa_api_base() -> String {
    std::env::var("OPENMEMORY_URL").unwrap_or_else(|_| "http://localhost:18080".to_string())
}

/// Same order as `resolve_api_token()` (`main.rs`) and `scripts/mem`: explicit
/// env var first, then the persisted token file at `~/.openmemory/api_token`.
fn qa_api_token() -> Result<String> {
    if let Ok(token) = std::env::var("OPENMEMORY_API_TOKEN") {
        let token = token.trim().to_string();
        if !token.is_empty() {
            return Ok(token);
        }
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    let path = std::path::PathBuf::from(home).join(".openmemory").join("api_token");
    let token = std::fs::read_to_string(&path)
        .with_context(|| format!("failed to read API token from {}", path.display()))?
        .trim()
        .to_string();
    if token.is_empty() {
        anyhow::bail!("API token file at {} is empty", path.display());
    }
    Ok(token)
}

/// The host-side half of `qa_evidence_add` (Finding 1): `openmemory-mcp` has no
/// `/data` mount and cannot write to the blob volume directly, so it resolves
/// and reads `file_path` here — where the path actually means something — then
/// `PUT`s the bytes to the same endpoint the browser uses. Every safety
/// property stays server-side (size, mime sniffing, atomic write); this step
/// only decides whose `read()` call supplies the bytes.
///
/// `canonicalize` + `starts_with` (rather than a prefix check on the
/// unresolved string) is what rejects a symlink pointing outside the home root.
async fn upload_qa_evidence_file(project_id: Uuid, evidence_id: Uuid, file_path: &str) -> Result<()> {
    let home_root = std::env::var("OPENMEMORY_HOME_DIR")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| "/".to_string());
    let canonical_home = std::fs::canonicalize(&home_root)
        .with_context(|| format!("cannot resolve home root '{}'", home_root))?;

    let expanded = expand_home_path(file_path);
    let canonical_path = std::fs::canonicalize(&expanded)
        .with_context(|| format!("file_path does not exist or cannot be resolved: {}", expanded.display()))?;
    if !canonical_path.starts_with(&canonical_home) {
        anyhow::bail!(
            "file_path must resolve inside the home directory ({}), got: {}",
            canonical_home.display(),
            canonical_path.display()
        );
    }

    let bytes = std::fs::read(&canonical_path)
        .with_context(|| format!("failed to read {}", canonical_path.display()))?;

    let url = format!("{}/projects/{}/qa/evidence/{}/blob", qa_api_base(), project_id, evidence_id);
    let response = HttpClient::new()
        .put(&url)
        .header("Authorization", format!("Bearer {}", qa_api_token()?))
        .body(bytes)
        .send()
        .await
        .context("HTTP PUT to blob endpoint failed")?;

    let status = response.status();
    if !status.is_success() {
        let body_text = response.text().await.unwrap_or_default();
        anyhow::bail!("blob upload rejected ({status}): {body_text}");
    }
    Ok(())
}

/// Read an ingest envelope from the host side of the MCP process. The
/// canonicalize plus starts_with check is intentionally the same boundary as
/// upload_qa_evidence_file: a symlink may not escape the home root.
fn read_qa_ingest_file(file_path: &str) -> Result<Vec<u8>> {
    let home_root = std::env::var("OPENMEMORY_HOME_DIR")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| "/".to_string());
    let canonical_home = std::fs::canonicalize(&home_root)
        .with_context(|| format!("cannot resolve home root '{}'", home_root))?;

    let expanded = expand_home_path(file_path);
    let canonical_path = std::fs::canonicalize(&expanded)
        .with_context(|| format!("file_path does not exist or cannot be resolved: {}", expanded.display()))?;
    if !canonical_path.starts_with(&canonical_home) {
        anyhow::bail!(
            "file_path must resolve inside the home directory ({}), got: {}",
            canonical_home.display(),
            canonical_path.display()
        );
    }

    std::fs::read(&canonical_path)
        .with_context(|| format!("failed to read {}", canonical_path.display()))
}

/// The delete-side counterpart to `upload_qa_evidence_file`'s rationale:
/// `openmemory-mcp` has no `/data` mount, so deleting a run's row directly in
/// Postgres would leave its evidence blobs orphaned on disk with nothing left
/// to unlink them. Routing through `DELETE .../qa/runs/{id}` keeps blob
/// cleanup on the one code path that does it (`delete_project_qa_run` in
/// `main.rs`).
async fn delete_qa_run_via_api(project_id: Uuid, run_id: Uuid) -> Result<()> {
    let url = format!("{}/projects/{}/qa/runs/{}", qa_api_base(), project_id, run_id);
    let response = HttpClient::new()
        .delete(&url)
        .header("Authorization", format!("Bearer {}", qa_api_token()?))
        .send()
        .await
        .context("HTTP DELETE to QA run endpoint failed")?;

    let status = response.status();
    if !status.is_success() {
        let body_text = response.text().await.unwrap_or_default();
        anyhow::bail!("QA run delete rejected ({status}): {body_text}");
    }
    Ok(())
}

/// Same rationale as `delete_qa_run_via_api`, for a single evidence item.
async fn delete_qa_evidence_via_api(project_id: Uuid, evidence_id: Uuid) -> Result<()> {
    let url = format!("{}/projects/{}/qa/evidence/{}", qa_api_base(), project_id, evidence_id);
    let response = HttpClient::new()
        .delete(&url)
        .header("Authorization", format!("Bearer {}", qa_api_token()?))
        .send()
        .await
        .context("HTTP DELETE to QA evidence endpoint failed")?;

    let status = response.status();
    if !status.is_success() {
        let body_text = response.text().await.unwrap_or_default();
        anyhow::bail!("QA evidence delete rejected ({status}): {body_text}");
    }
    Ok(())
}

impl McpServer {
    pub(super) async fn qa_event_create(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let project_id: Uuid = args["project_id"]
            .as_str()
            .context("missing project_id")?
            .parse()
            .context("invalid project_id UUID")?;
        let name = args["name"].as_str().context("missing name")?;
        let event = qa::create_event(&self.db, project_id, name).await?;
        Ok(json!({
            "content": [{
                "type": "text",
                "text": format!("Created QA event '{}' [{}] for project {}", event.name, event.id, event.project_id)
            }]
        }))
    }

    pub(super) async fn qa_event_list(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let project_id: Uuid = args["project_id"]
            .as_str()
            .context("missing project_id")?
            .parse()
            .context("invalid project_id UUID")?;
        let events = qa::list_events(&self.db, project_id).await?;
        let text = if events.is_empty() {
            "No QA events.".to_string()
        } else {
            let mut lines = vec![format!("QA events ({}):", events.len())];
            for event in &events {
                lines.push(format!("• {} — {}", event.name, event.id));
            }
            lines.join("\n")
        };
        Ok(json!({ "content": [{ "type": "text", "text": text }] }))
    }

    pub(super) async fn qa_event_update(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let event_id: Uuid = args["event_id"]
            .as_str()
            .context("missing event_id")?
            .parse()
            .context("invalid event_id UUID")?;
        let name = args["name"].as_str().context("missing name")?;
        match qa::update_event(&self.db, event_id, None, Some(name)).await? {
            Some(event) => Ok(json!({
                "content": [{ "type": "text", "text": format!("Updated QA event '{}' [{}].", event.name, event.id) }]
            })),
            None => anyhow::bail!("QA event '{}' not found", event_id),
        }
    }

    pub(super) async fn qa_event_delete(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let event_id: Uuid = args["event_id"]
            .as_str()
            .context("missing event_id")?
            .parse()
            .context("invalid event_id UUID")?;
        let run_count: i64 = sqlx::query_scalar("SELECT count(*) FROM project_qa_runs WHERE event_id = $1")
            .bind(event_id)
            .fetch_one(&self.db)
            .await
            .context("failed to count QA event runs")?;
        if !qa::delete_event(&self.db, event_id, None).await? {
            anyhow::bail!("QA event '{}' not found", event_id);
        }
        Ok(json!({
            "content": [{
                "type": "text",
                "text": format!("Deleted QA event {}. {} run(s) are now ungrouped.", event_id, run_count)
            }]
        }))
    }

    pub(super) async fn qa_run_create(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let project_id: Uuid = args["project_id"]
            .as_str()
            .context("missing project_id")?
            .parse()
            .context("invalid project_id UUID")?;
        let title = args["title"].as_str().context("missing title")?;
        let event_id: Option<Uuid> = match args["event_id"].as_str() {
            Some(s) => Some(s.parse().context("invalid event_id UUID")?),
            None => None,
        };
        let task_id: Option<Uuid> = match args["task_id"].as_str() {
            Some(s) => Some(s.parse().context("invalid task_id UUID")?),
            None => None,
        };
        let status = args["status"].as_str();
        let kind = args["kind"].as_str();
        let summary = args["summary"].as_str();
        let target = args["target"].as_str();
        let external_ref = args["external_ref"].as_str();
        let created_by = args["created_by"].as_str();

        let run = qa::create_run(
            &self.db, project_id, event_id, task_id, title, kind, status, summary, target, external_ref, created_by,
        )
        .await?;

        let text = format!(
            "Created QA run '{}' [{}] status={} for project {}",
            run.title, run.id, run.status, run.project_id
        );
        Ok(json!({ "content": [{ "type": "text", "text": text }] }))
    }

    pub(super) async fn qa_run_list(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let project_id: Uuid = args["project_id"]
            .as_str()
            .context("missing project_id")?
            .parse()
            .context("invalid project_id UUID")?;
        let status = args["status"].as_str();
        let kind = args["kind"].as_str();
        let task_id: Option<Uuid> = match args["task_id"].as_str() {
            Some(s) => Some(s.parse().context("invalid task_id UUID")?),
            None => None,
        };
        let event_id: Option<Uuid> = match args["event_id"].as_str() {
            Some(s) => Some(s.parse().context("invalid event_id UUID")?),
            None => None,
        };
        let limit = args["limit"].as_i64();
        let offset = args["offset"].as_i64().unwrap_or(0);

        let runs = qa::list_runs(&self.db, project_id, status, task_id, event_id, kind, limit, offset).await?;
        let text = if runs.is_empty() {
            "No QA runs.".to_string()
        } else {
            let mut lines = vec![format!("QA runs ({}):", runs.len())];
            for r in &runs {
                let task_note = r.task_id.map(|t| format!(" task={t}")).unwrap_or_default();
                lines.push(format!(
                    "• [{}] {} — {} (target={}){}",
                    r.status,
                    r.title,
                    r.id,
                    r.target.as_deref().unwrap_or("-"),
                    task_note
                ));
            }
            lines.join("\n")
        };
        Ok(json!({ "content": [{ "type": "text", "text": text }] }))
    }

    pub(super) async fn qa_run_update(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let run_id: Uuid = args["run_id"].as_str().context("missing run_id")?.parse().context("invalid run_id UUID")?;
        let title = args["title"].as_str();
        let status = args["status"].as_str();
        let kind = args["kind"].as_str();
        // `args.get(key)` distinguishes "key absent" (None: leave untouched) from
        // "key present" (Some(...), whether null — clear — or a string — set),
        // matching the `Option<Option<T>>` tri-state the HTTP PATCH payloads use.
        let summary: Option<Option<&str>> = args.get("summary").map(|v| v.as_str());
        let target: Option<Option<&str>> = args.get("target").map(|v| v.as_str());
        let external_ref: Option<Option<&str>> = args.get("external_ref").map(|v| v.as_str());
        let event_id: Option<Option<Uuid>> = match args.get("event_id") {
            None => None,
            Some(v) if v.is_null() => Some(None),
            Some(v) => Some(Some(
                v.as_str().context("event_id must be a string")?.parse().context("invalid event_id UUID")?,
            )),
        };
        let task_id: Option<Option<Uuid>> = match args.get("task_id") {
            None => None,
            Some(v) if v.is_null() => Some(None),
            Some(v) => Some(Some(
                v.as_str().context("task_id must be a string")?.parse().context("invalid task_id UUID")?,
            )),
        };

        match qa::update_run(&self.db, run_id, None, title, status, kind, event_id, summary, target, task_id, external_ref).await? {
            Some(run) => {
                let text = format!("Updated QA run '{}' [{}] — status={}", run.title, run.id, run.status);
                Ok(json!({ "content": [{ "type": "text", "text": text }] }))
            }
            None => anyhow::bail!("QA run '{}' not found", run_id),
        }
    }

    pub(super) async fn qa_results_import(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let project_id: Uuid = args["project_id"]
            .as_str()
            .context("missing project_id")?
            .parse()
            .context("invalid project_id UUID")?;
        let file_path = args["file_path"].as_str().context("missing file_path")?;
        let kind = args["kind"].as_str().context("missing kind")?;
        if !qa::RUN_KINDS.contains(&kind) {
            anyhow::bail!("kind must be one of: manual, unit, integration, api, e2e, load, other");
        }

        let bytes = read_qa_ingest_file(file_path)?;
        let mut envelope: serde_json::Value =
            serde_json::from_slice(&bytes).context("file_path does not contain a valid JSON envelope")?;
        let object = envelope
            .as_object_mut()
            .context("QA ingest envelope must be a JSON object")?;
        object.insert("kind".to_string(), json!(kind));
        if let Some(title) = args["title"].as_str() {
            object.insert("title".to_string(), json!(title));
        }
        if let Some(runner) = args["runner"].as_str() {
            object.insert("runner".to_string(), json!(runner));
        }

        for field in ["task_id", "event_id", "plan_id"] {
            let Some(value) = args.get(field) else {
                continue;
            };
            if value.is_null() {
                continue;
            }
            let parsed: Uuid = value
                .as_str()
                .with_context(|| format!("{field} must be a string"))?
                .parse()
                .with_context(|| format!("invalid {field} UUID"))?;
            object.insert(field.to_string(), json!(parsed));
        }
        if let Some(value) = args.get("plan_revision_num") {
            if !value.is_null() {
                let revision_num = value
                    .as_i64()
                    .context("plan_revision_num must be an integer")?;
                let revision_num = i32::try_from(revision_num)
                    .context("plan_revision_num must be a 32-bit integer")?;
                object.insert("plan_revision_num".to_string(), json!(revision_num));
            }
        }

        let url = format!("{}/projects/{}/qa/ingest", qa_api_base(), project_id);
        let response = HttpClient::new()
            .post(&url)
            .header("Authorization", format!("Bearer {}", qa_api_token()?))
            .json(&envelope)
            .send()
            .await
            .context("HTTP POST to QA ingest endpoint failed")?;
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        if !status.is_success() {
            anyhow::bail!("QA ingest rejected ({status}): {body}");
        }
        let run: qa::QaRunView =
            serde_json::from_str(&body).context("QA ingest returned an invalid run")?;

        Ok(json!({
            "content": [{
                "type": "text",
                "text": format!(
                    "Imported QA results '{}' [{}] status={} cases={} passed={} failed={} skipped={}",
                    run.title,
                    run.id,
                    run.status,
                    run.total_cases,
                    run.passed_cases,
                    run.failed_cases,
                    run.skipped_cases
                )
            }]
        }))
    }

    pub(super) async fn qa_case_history(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let project_id: Uuid = args["project_id"]
            .as_str()
            .context("missing project_id")?
            .parse()
            .context("invalid project_id UUID")?;
        let case_key = args["case_key"].as_str().context("missing case_key")?;
        if case_key.trim().is_empty() {
            anyhow::bail!("case_key must not be empty");
        }
        let history = qa::case_history(&self.db, project_id, case_key, args["limit"].as_i64()).await?;

        let text = if history.is_empty() {
            format!("No QA history for case '{}'.", case_key)
        } else {
            let mut lines = vec![format!("QA case history ({}):", history.len())];
            for entry in &history {
                // `case_ms` is this test's own time and `run_ms` the whole
                // suite's. They are labelled distinctly because they differ by
                // orders of magnitude, and an agent reading a bare `duration_ms`
                // on a single-test history would reasonably take it for the
                // test's own.
                lines.push(format!(
                    "• [{}] run={} started_at={} case_ms={} run_ms={} source_sha={}",
                    entry.status,
                    entry.run_id,
                    entry.started_at,
                    entry
                        .case_duration_ms
                        .map(|duration| duration.to_string())
                        .unwrap_or_else(|| "-".to_string()),
                    entry
                        .run_duration_ms
                        .map(|duration| duration.to_string())
                        .unwrap_or_else(|| "-".to_string()),
                    entry.source_sha.as_deref().unwrap_or("-")
                ));
            }
            lines.join("\n")
        };
        Ok(json!({ "content": [{ "type": "text", "text": text }] }))
    }

    pub(super) async fn qa_run_delete(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let run_id: Uuid = args["run_id"].as_str().context("missing run_id")?.parse().context("invalid run_id UUID")?;

        // Resolved up front, before the delete: the HTTP endpoint needs
        // project_id and this tool's arguments carry only run_id (per the
        // approved spec) — same up-front-resolution shape as qa_evidence_add.
        let project_id = qa::run_project_id(&self.db, run_id)
            .await?
            .with_context(|| format!("QA run '{}' not found", run_id))?;
        let evidence_count = qa::list_evidence(&self.db, run_id).await?.len();

        delete_qa_run_via_api(project_id, run_id).await?;

        Ok(json!({
            "content": [{
                "type": "text",
                "text": format!("Deleted QA run {} ({} evidence item(s) removed).", run_id, evidence_count)
            }]
        }))
    }

    pub(super) async fn qa_evidence_add(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let run_id: Uuid = args["run_id"].as_str().context("missing run_id")?.parse().context("invalid run_id UUID")?;
        let kind = args["kind"].as_str().context("missing kind")?;
        let caption = args["caption"].as_str();
        let body = args["body"].as_str();
        let sort_order = args["sort_order"].as_i64().map(|n| n as i32);
        let captured_at: Option<DateTime<Utc>> = match args["captured_at"].as_str() {
            Some(s) => Some(s.parse().context("invalid captured_at timestamp (expected RFC3339)")?),
            None => None,
        };
        let file_path = args["file_path"].as_str();
        if kind == "image" && file_path.is_none() {
            anyhow::bail!("image evidence requires file_path");
        }

        // Resolved up front, before the insert: the blob upload needs project_id
        // and this tool's arguments carry only run_id (per the approved spec), so
        // it must be looked up here — and doing it before add_evidence means a
        // nonexistent run fails fast with a clear message rather than a raw FK
        // violation, with no row ever inserted.
        let project_id = if kind == "image" {
            Some(
                qa::run_project_id(&self.db, run_id)
                    .await?
                    .with_context(|| format!("QA run '{}' not found", run_id))?,
            )
        } else {
            None
        };

        let evidence = qa::add_evidence(&self.db, run_id, kind, caption, body, captured_at, sort_order).await?;

        if let Some(project_id) = project_id {
            let path = file_path.expect("checked above: kind == \"image\" implies file_path is Some");
            if let Err(e) = upload_qa_evidence_file(project_id, evidence.id, path).await {
                // Don't leave an image row permanently without a blob.
                let _ = qa::delete_evidence(&self.db, evidence.id, None).await;
                return Err(e);
            }
        }

        let text = format!("Added {} evidence [{}] to QA run {}", kind, evidence.id, run_id);
        Ok(json!({ "content": [{ "type": "text", "text": text }] }))
    }

    pub(super) async fn qa_evidence_update(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let evidence_id: Uuid = args["evidence_id"]
            .as_str()
            .context("missing evidence_id")?
            .parse()
            .context("invalid evidence_id UUID")?;
        let caption: Option<Option<&str>> = args.get("caption").map(|v| v.as_str());
        let body: Option<Option<&str>> = args.get("body").map(|v| v.as_str());
        let sort_order = args["sort_order"].as_i64().map(|n| n as i32);
        let captured_at: Option<DateTime<Utc>> = match args["captured_at"].as_str() {
            Some(s) => Some(s.parse().context("invalid captured_at timestamp (expected RFC3339)")?),
            None => None,
        };

        match qa::update_evidence(&self.db, evidence_id, None, caption, body, sort_order, captured_at).await? {
            Some(evidence) => {
                let text = format!("Updated QA evidence [{}] (kind={})", evidence.id, evidence.kind);
                Ok(json!({ "content": [{ "type": "text", "text": text }] }))
            }
            None => anyhow::bail!("QA evidence '{}' not found", evidence_id),
        }
    }

    pub(super) async fn qa_evidence_delete(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let evidence_id: Uuid = args["evidence_id"]
            .as_str()
            .context("missing evidence_id")?
            .parse()
            .context("invalid evidence_id UUID")?;

        // Resolved up front, walking evidence → run → project: the HTTP
        // endpoint needs project_id and this tool's arguments carry only
        // evidence_id (per the approved spec) — same shape as qa_run_delete.
        let evidence = qa::get_evidence(&self.db, evidence_id)
            .await?
            .with_context(|| format!("QA evidence '{}' not found", evidence_id))?;
        let project_id = qa::run_project_id(&self.db, evidence.run_id)
            .await?
            .with_context(|| format!("QA run for evidence '{}' not found", evidence_id))?;

        delete_qa_evidence_via_api(project_id, evidence_id).await?;

        Ok(json!({ "content": [{ "type": "text", "text": format!("Deleted QA evidence {}", evidence_id) }] }))
    }

    pub(super) async fn qa_plan_create(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let project_id: Uuid = args["project_id"]
            .as_str()
            .context("missing project_id")?
            .parse()
            .context("invalid project_id UUID")?;
        let name = args["name"].as_str().context("missing name")?;
        let kind = args["kind"].as_str();
        let language = args["language"].as_str();
        let description = args["description"].as_str();
        let body = args["body"].as_str();
        let created_by = args["created_by"].as_str();

        let plan = qa::create_plan(&self.db, project_id, name, kind, language, description, body, created_by).await?;

        let text = format!(
            "Created QA plan '{}' [{}] kind={} language={} for project {}",
            plan.name, plan.id, plan.kind, plan.language, plan.project_id
        );
        Ok(json!({ "content": [{ "type": "text", "text": text }] }))
    }

    pub(super) async fn qa_plan_list(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let project_id: Uuid = args["project_id"]
            .as_str()
            .context("missing project_id")?
            .parse()
            .context("invalid project_id UUID")?;
        let kind = args["kind"].as_str();

        let plans = qa::list_plans(&self.db, project_id, kind).await?;
        let text = qa::format_plan_list_text(&plans);
        Ok(json!({ "content": [{ "type": "text", "text": text }] }))
    }

    pub(super) async fn qa_plan_revision_list(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let plan_id: Uuid = args["plan_id"]
            .as_str()
            .context("missing plan_id")?
            .parse()
            .context("invalid plan_id UUID")?;
        let revisions = qa_plan_revisions::list(&self.db, plan_id).await?;
        let text = if revisions.is_empty() {
            format!("No revisions for QA plan {}.", plan_id)
        } else {
            let mut lines = vec![format!("QA plan revisions ({}):", revisions.len())];
            for revision in &revisions {
                let label = revision
                    .label
                    .as_deref()
                    .map(|value| format!(" — {}", value))
                    .unwrap_or_default();
                lines.push(format!(
                    "• v{}{} ({}/{}) [{}] created_by={}",
                    revision.revision_num,
                    label,
                    revision.kind,
                    revision.language,
                    revision.id,
                    revision.created_by
                ));
            }
            lines.join("\n")
        };
        Ok(json!({ "content": [{ "type": "text", "text": text }] }))
    }

    pub(super) async fn qa_plan_revision_get(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let plan_id: Uuid = args["plan_id"]
            .as_str()
            .context("missing plan_id")?
            .parse()
            .context("invalid plan_id UUID")?;
        let revision_num = i32::try_from(
            args["revision_num"]
                .as_i64()
                .context("missing revision_num")?,
        )
        .context("revision_num must be a 32-bit integer")?;
        let revision = qa_plan_revisions::get(&self.db, plan_id, revision_num)
            .await?
            .with_context(|| format!("QA plan revision v{} not found", revision_num))?;
        let text = format!(
            "QA plan revision v{} — {}\nkind={} language={} label={} created_by={}\n\n{}",
            revision.revision_num,
            revision.name,
            revision.kind,
            revision.language,
            revision.label.as_deref().unwrap_or("-"),
            revision.created_by,
            revision.body
        );
        Ok(json!({ "content": [{ "type": "text", "text": text }] }))
    }

    pub(super) async fn qa_plan_revision_cut(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let plan_id: Uuid = args["plan_id"]
            .as_str()
            .context("missing plan_id")?
            .parse()
            .context("invalid plan_id UUID")?;
        let label = args.get("label").and_then(|value| value.as_str());
        let created_by = args["created_by"].as_str().unwrap_or("agent");
        let revision = qa_plan_revisions::cut_as(&self.db, plan_id, label, created_by)
            .await?
            .with_context(|| format!("QA plan '{}' not found", plan_id))?;
        let label = revision
            .label
            .as_deref()
            .map(|value| format!(" — {}", value))
            .unwrap_or_default();
        Ok(json!({
            "content": [{
                "type": "text",
                "text": format!("Cut QA plan revision v{}{} [{}]", revision.revision_num, label, revision.id)
            }]
        }))
    }

    pub(super) async fn qa_plan_update(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let plan_id: Uuid = args["plan_id"].as_str().context("missing plan_id")?.parse().context("invalid plan_id UUID")?;
        let name = args["name"].as_str();
        let kind = args["kind"].as_str();
        let language = args["language"].as_str();
        let body = args["body"].as_str();
        // `args.get(key)` distinguishes "key absent" (None: leave untouched) from
        // "key present" (Some(...), whether null — clear — or a string — set),
        // matching the `Option<Option<T>>` tri-state the HTTP PATCH payloads use.
        let description: Option<Option<&str>> = args.get("description").map(|v| v.as_str());

        // MCP agents edit the same live parent row as the HTTP editor. Preserve
        // its current source before applying a destructive update; unlabelled
        // identical cuts are deduplicated by the revision module.
        qa_plan_revisions::cut(&self.db, plan_id, None).await?;

        match qa::update_plan(&self.db, plan_id, None, name, kind, language, description, body).await? {
            Some(plan) => {
                let text = format!(
                    "Updated QA plan '{}' [{}] kind={} language={}",
                    plan.name, plan.id, plan.kind, plan.language
                );
                Ok(json!({ "content": [{ "type": "text", "text": text }] }))
            }
            None => anyhow::bail!("QA plan '{}' not found", plan_id),
        }
    }

    pub(super) async fn qa_plan_delete(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let plan_id: Uuid = args["plan_id"].as_str().context("missing plan_id")?.parse().context("invalid plan_id UUID")?;
        if !qa::delete_plan(&self.db, plan_id, None).await? {
            anyhow::bail!("QA plan '{}' not found", plan_id);
        }
        Ok(json!({ "content": [{ "type": "text", "text": format!("Deleted QA plan {}", plan_id) }] }))
    }
}
