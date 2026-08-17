//! Git-friendly project data synchronisation.
//!
//! The database remains the live source for the web UI, while this module keeps a readable,
//! versionable mirror in `<project>/.openmemory/`.  The directory is deliberately fixed and
//! server-owned: clients never provide a filesystem path, so import/export cannot be redirected
//! outside the registered git repository.

use anyhow::{anyhow, bail, Context, Result};
use axum::{
    extract::{Json, Path as AxumPath, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
};
use chrono::{DateTime, NaiveDate, Utc};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sqlx::FromRow;
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Component, Path, PathBuf},
};
use tracing::error;
use uuid::Uuid;

use crate::{
    design_blobs, is_authenticated, resolve_git_project_root, AppState,
};

const BUNDLE_DIR: &str = ".openmemory";
const BUNDLE_FORMAT: &str = "openmemory.project";
const BUNDLE_VERSION: u32 = 1;
const PENCIL_SOURCE: &str = r#"{"providerId":"openmemory"}"#;

#[derive(Debug, Deserialize)]
pub struct ProjectSyncPayload {
    action: String,
}

#[derive(Debug, Serialize)]
struct SyncResponse {
    action: &'static str,
    bundle_path: String,
    documents: usize,
    tasks: usize,
    routines: usize,
    lessons: usize,
    task_notes: usize,
    budgets: usize,
    files_written: usize,
    warnings: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct BundleManifest {
    format: String,
    version: u32,
    project_id: Uuid,
    project_name: String,
    exported_at: DateTime<Utc>,
    counts: BundleCounts,
}

#[derive(Debug, Serialize, Deserialize)]
struct BundleCounts {
    documents: usize,
    tasks: usize,
    routines: usize,
    lessons: usize,
    task_notes: usize,
    budgets: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
struct DesignRow {
    id: Uuid,
    project_id: Uuid,
    title: String,
    kind: String,
    diagram_type: String,
    source: String,
    notes: Option<String>,
    tags: Vec<String>,
    sort_order: i32,
    status: String,
    created_by: String,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
struct BudgetRow {
    id: Uuid,
    design_id: Uuid,
    forecast_profile_id: Option<Uuid>,
    name: String,
    conditions: Option<String>,
    currency: String,
    monthly_total_cents: i64,
    line_items: serde_json::Value,
    confidence: String,
    pricing_basis: Option<String>,
    created_by: String,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
struct TaskRow {
    id: Uuid,
    project_id: Uuid,
    title: String,
    description: Option<String>,
    status: String,
    priority: String,
    assigned_to: Option<String>,
    created_by: String,
    routine_id: Option<Uuid>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    labels: Vec<String>,
    parent_id: Option<Uuid>,
    start_date: Option<NaiveDate>,
    due_date: Option<NaiveDate>,
    sort_order: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TaskNoteRow {
    id: Uuid,
    task_id: Uuid,
    content: String,
    author: String,
    created_at: DateTime<Utc>,
    #[serde(default = "default_note_type")]
    note_type: String,
    #[serde(default = "default_decision_options")]
    decision_options: serde_json::Value,
    // Legacy bundles did not record whether choices were single- or multi-select; preserve the
    // behavior of those existing checkpoints when importing them.
    #[serde(default = "default_decision_selection_mode")]
    decision_selection_mode: String,
    #[serde(default = "default_decision_status")]
    decision_status: String,
    #[serde(default)]
    decision_resolved_by: Option<String>,
    #[serde(default)]
    decision_resolved_at: Option<DateTime<Utc>>,
    // Additive field — old exported bundles without it still import fine.
    #[serde(default)]
    decision_answers: Vec<TaskDecisionAnswerRow>,
}

fn default_note_type() -> String { "message".to_string() }
fn default_decision_options() -> serde_json::Value { serde_json::json!([]) }
fn default_decision_selection_mode() -> String { "multiple".to_string() }
fn default_decision_status() -> String { "open".to_string() }

/// Plain DB row shape for `project_task_notes`, used only to load the main query — the answer
/// history is attached afterward from a separate grouped query (see `export_project`).
#[derive(Debug, Clone, FromRow)]
struct DbTaskNoteRow {
    id: Uuid,
    task_id: Uuid,
    content: String,
    author: String,
    created_at: DateTime<Utc>,
    note_type: String,
    decision_options: serde_json::Value,
    decision_selection_mode: String,
    decision_status: String,
    decision_resolved_by: Option<String>,
    decision_resolved_at: Option<DateTime<Utc>>,
}

impl From<DbTaskNoteRow> for TaskNoteRow {
    fn from(row: DbTaskNoteRow) -> Self {
        TaskNoteRow {
            id: row.id,
            task_id: row.task_id,
            content: row.content,
            author: row.author,
            created_at: row.created_at,
            note_type: row.note_type,
            decision_options: row.decision_options,
            decision_selection_mode: row.decision_selection_mode,
            decision_status: row.decision_status,
            decision_resolved_by: row.decision_resolved_by,
            decision_resolved_at: row.decision_resolved_at,
            decision_answers: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
struct TaskDecisionAnswerRow {
    id: Uuid,
    note_id: Uuid,
    selected_options: serde_json::Value,
    #[serde(default)]
    reply: Option<String>,
    answered_by: String,
    answered_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
struct RoutineRow {
    id: Uuid,
    project_id: Uuid,
    title: String,
    description: Option<String>,
    frequency: String,
    priority: String,
    assigned_to: Option<String>,
    last_task_date: Option<NaiveDate>,
    enabled: bool,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    labels: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
struct LessonRow {
    id: Uuid,
    project_id: Uuid,
    title: String,
    context: Option<String>,
    rule: String,
    category: String,
    severity: String,
    status: String,
    tags: Vec<String>,
    occurrences: i32,
    created_by: String,
    last_seen_at: DateTime<Utc>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DocumentMeta {
    id: Uuid,
    project_id: Uuid,
    title: String,
    kind: String,
    diagram_type: String,
    notes: Option<String>,
    tags: Vec<String>,
    sort_order: i32,
    status: String,
    created_by: String,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    source_file: String,
    budgets: Vec<BudgetRow>,
}

#[derive(Debug, Serialize, Deserialize)]
struct DocsIndex {
    version: u32,
    documents: Vec<DocumentMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TaskFile {
    #[serde(flatten)]
    task: TaskRow,
    notes: Vec<TaskNoteRow>,
}

#[derive(Debug)]
struct ImportedDocument {
    meta: DocumentMeta,
    source: String,
    pencil_bytes: Option<Vec<u8>>,
}

#[derive(Debug)]
struct ImportSnapshot {
    documents: Vec<ImportedDocument>,
    tasks: Vec<TaskFile>,
    routines: Vec<RoutineRow>,
    lessons: Vec<LessonRow>,
    task_notes: usize,
    budgets: usize,
}

/// Import or export the current project's database-backed planning data to its checked-out repo.
pub async fn sync_project(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(project_id): AxumPath<Uuid>,
    Json(payload): Json<ProjectSyncPayload>,
) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }

    let root = match resolve_git_project_root(&state, project_id).await {
        Ok(root) => root,
        Err(response) => return response,
    };

    let result = match payload.action.trim().to_ascii_lowercase().as_str() {
        "export" => export_project(&state, project_id, root).await,
        "import" => import_project(&state, project_id, root).await,
        _ => Err(anyhow!("action must be either 'export' or 'import'")),
    };

    match result {
        Ok(summary) => Json(summary).into_response(),
        Err(error) => {
            error!(project_id = %project_id, "project sync failed: {error:#}");
            (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": error.to_string()}))).into_response()
        }
    }
}

async fn export_project(state: &AppState, project_id: Uuid, root: PathBuf) -> Result<SyncResponse> {
    let project_name: String = sqlx::query_scalar("SELECT name FROM project_graphs WHERE id = $1")
        .bind(project_id)
        .fetch_one(&state.db)
        .await
        .context("loading project name")?;

    let designs = sqlx::query_as::<_, DesignRow>(
        "SELECT id, project_id, title, kind, diagram_type, source, notes, tags, sort_order, status, created_by, created_at, updated_at \
         FROM project_designs WHERE project_id = $1 ORDER BY sort_order ASC, created_at ASC",
    )
    .bind(project_id)
    .fetch_all(&state.db)
    .await
    .context("loading project documents")?;

    let budgets = sqlx::query_as::<_, BudgetRow>(
        "SELECT b.id, b.design_id, b.forecast_profile_id, b.name, b.conditions, b.currency, \
                b.monthly_total_cents, b.line_items, b.confidence, b.pricing_basis, b.created_by, \
                b.created_at, b.updated_at \
         FROM design_budget_forecasts b \
         JOIN project_designs d ON d.id = b.design_id \
         WHERE d.project_id = $1 ORDER BY b.updated_at DESC",
    )
    .bind(project_id)
    .fetch_all(&state.db)
    .await
    .context("loading document budgets")?;

    let tasks = sqlx::query_as::<_, TaskRow>(
        "SELECT id, project_id, title, description, status, priority, assigned_to, created_by, routine_id, \
                created_at, updated_at, labels, parent_id, start_date, due_date, sort_order \
         FROM project_tasks WHERE project_id = $1 ORDER BY sort_order ASC, created_at ASC",
    )
    .bind(project_id)
    .fetch_all(&state.db)
    .await
    .context("loading project tasks")?;

    let mut task_notes: Vec<TaskNoteRow> = sqlx::query_as::<_, DbTaskNoteRow>(
        "SELECT n.id, n.task_id, n.content, n.author, n.created_at \
                , n.note_type, n.decision_options, n.decision_selection_mode, n.decision_status, \
                n.decision_resolved_by, n.decision_resolved_at \
         FROM project_task_notes n JOIN project_tasks t ON t.id = n.task_id \
         WHERE t.project_id = $1 ORDER BY n.created_at ASC, n.id ASC",
    )
    .bind(project_id)
    .fetch_all(&state.db)
    .await
    .context("loading task notes")?
    .into_iter()
    .map(TaskNoteRow::from)
    .collect();

    let decision_answers = sqlx::query_as::<_, TaskDecisionAnswerRow>(
        "SELECT a.id, a.note_id, a.selected_options, a.reply, a.answered_by, a.answered_at \
         FROM project_task_decision_answers a \
         JOIN project_task_notes n ON n.id = a.note_id \
         JOIN project_tasks t ON t.id = n.task_id \
         WHERE t.project_id = $1 ORDER BY a.answered_at ASC",
    )
    .bind(project_id)
    .fetch_all(&state.db)
    .await
    .context("loading task decision answers")?;
    let mut answers_by_note = decision_answers.into_iter().fold(
        HashMap::<Uuid, Vec<TaskDecisionAnswerRow>>::new(),
        |mut map, answer| {
            map.entry(answer.note_id).or_default().push(answer);
            map
        },
    );
    for note in &mut task_notes {
        note.decision_answers = answers_by_note.remove(&note.id).unwrap_or_default();
    }

    let routines = sqlx::query_as::<_, RoutineRow>(
        "SELECT id, project_id, title, description, frequency, priority, assigned_to, last_task_date, \
                enabled, created_at, updated_at, labels \
         FROM project_routines WHERE project_id = $1 ORDER BY created_at ASC",
    )
    .bind(project_id)
    .fetch_all(&state.db)
    .await
    .context("loading project routines")?;

    let lessons = sqlx::query_as::<_, LessonRow>(
        "SELECT id, project_id, title, context, rule, category, severity, status, tags, occurrences, \
                created_by, last_seen_at, created_at, updated_at \
         FROM project_lessons WHERE project_id = $1 ORDER BY created_at ASC",
    )
    .bind(project_id)
    .fetch_all(&state.db)
    .await
    .context("loading project lessons")?;

    let snapshot = ExportSnapshot {
        project_id,
        project_name,
        designs,
        budgets,
        tasks,
        task_notes,
        routines,
        lessons,
    };

    tokio::task::spawn_blocking(move || write_bundle(&root, snapshot))
        .await
        .context("export task failed")?
}

#[derive(Debug)]
struct ExportSnapshot {
    project_id: Uuid,
    project_name: String,
    designs: Vec<DesignRow>,
    budgets: Vec<BudgetRow>,
    tasks: Vec<TaskRow>,
    task_notes: Vec<TaskNoteRow>,
    routines: Vec<RoutineRow>,
    lessons: Vec<LessonRow>,
}

fn write_bundle(root: &Path, snapshot: ExportSnapshot) -> Result<SyncResponse> {
    let bundle = ensure_dir(&root.join(BUNDLE_DIR))?;
    let docs_dir = ensure_dir(&bundle.join("docs"))?;
    let tasks_dir = ensure_dir(&bundle.join("tasks"))?;
    let routines_dir = ensure_dir(&bundle.join("routines"))?;
    let lessons_dir = ensure_dir(&bundle.join("lessons"))?;

    clear_record_files(&docs_dir)?;
    clear_record_files(&tasks_dir)?;
    clear_record_files(&routines_dir)?;
    clear_record_files(&lessons_dir)?;

    let mut warnings = Vec::new();
    let budgets_by_design = snapshot.budgets.iter().cloned().fold(
        HashMap::<Uuid, Vec<BudgetRow>>::new(),
        |mut map, budget| {
            map.entry(budget.design_id).or_default().push(budget);
            map
        },
    );

    let mut document_meta = Vec::with_capacity(snapshot.designs.len());
    let mut files_written = 0;
    for design in &snapshot.designs {
        let extension = document_extension(&design.diagram_type);
        let file_name = record_file_name(design.id, &design.title, extension);
        let source_path = docs_dir.join(&file_name);
        if design.diagram_type == "pen" {
            let blob_path = design_blobs::blob_path(&design_blobs::blob_root(), design.id);
            if blob_path.is_file() {
                atomic_copy(&blob_path, &source_path)?;
            } else {
                atomic_write(&source_path, design.source.as_bytes())?;
                warnings.push(format!("document '{}' has no saved .fig blob; exported its marker instead", design.title));
            }
        } else {
            let source = if design.diagram_type == "reactflow" {
                match serde_json::from_str::<serde_json::Value>(&design.source) {
                    Ok(value) => serde_json::to_string_pretty(&value)?,
                    Err(_) => design.source.clone(),
                }
            } else {
                design.source.clone()
            };
            atomic_write(&source_path, source.as_bytes())?;
        }
        files_written += 1;
        document_meta.push(DocumentMeta {
            id: design.id,
            project_id: design.project_id,
            title: design.title.clone(),
            kind: design.kind.clone(),
            diagram_type: design.diagram_type.clone(),
            notes: design.notes.clone(),
            tags: design.tags.clone(),
            sort_order: design.sort_order,
            status: design.status.clone(),
            created_by: design.created_by.clone(),
            created_at: design.created_at,
            updated_at: design.updated_at,
            source_file: file_name,
            budgets: budgets_by_design.get(&design.id).cloned().unwrap_or_default(),
        });
    }
    write_json(&docs_dir.join("index.json"), &DocsIndex { version: BUNDLE_VERSION, documents: document_meta })?;
    files_written += 1;

    let notes_by_task = snapshot.task_notes.iter().cloned().fold(
        HashMap::<Uuid, Vec<TaskNoteRow>>::new(),
        |mut map, note| {
            map.entry(note.task_id).or_default().push(note);
            map
        },
    );
    for task in &snapshot.tasks {
        let task_file = TaskFile {
            task: task.clone(),
            notes: notes_by_task.get(&task.id).cloned().unwrap_or_default(),
        };
        write_json(&tasks_dir.join(record_file_name(task.id, &task.title, "json")), &task_file)?;
        files_written += 1;
    }
    for routine in &snapshot.routines {
        write_json(&routines_dir.join(record_file_name(routine.id, &routine.title, "json")), routine)?;
        files_written += 1;
    }
    for lesson in &snapshot.lessons {
        write_json(&lessons_dir.join(record_file_name(lesson.id, &lesson.title, "json")), lesson)?;
        files_written += 1;
    }

    let manifest = BundleManifest {
        format: BUNDLE_FORMAT.to_string(),
        version: BUNDLE_VERSION,
        project_id: snapshot.project_id,
        project_name: snapshot.project_name.clone(),
        exported_at: Utc::now(),
        counts: BundleCounts {
            documents: snapshot.designs.len(),
            tasks: snapshot.tasks.len(),
            routines: snapshot.routines.len(),
            lessons: snapshot.lessons.len(),
            task_notes: snapshot.task_notes.len(),
            budgets: snapshot.budgets.len(),
        },
    };
    atomic_write(
        &bundle.join("README.md"),
        bundle_readme(&snapshot.project_name).as_bytes(),
    )?;
    files_written += 1;
    write_json(&bundle.join("manifest.json"), &manifest)?;
    files_written += 1;

    Ok(SyncResponse {
        action: "export",
        bundle_path: BUNDLE_DIR.to_string(),
        documents: snapshot.designs.len(),
        tasks: snapshot.tasks.len(),
        routines: snapshot.routines.len(),
        lessons: snapshot.lessons.len(),
        task_notes: snapshot.task_notes.len(),
        budgets: snapshot.budgets.len(),
        files_written,
        warnings,
    })
}

async fn import_project(state: &AppState, project_id: Uuid, root: PathBuf) -> Result<SyncResponse> {
    let snapshot = tokio::task::spawn_blocking(move || read_bundle(&root, project_id))
        .await
        .context("import task failed")??;

    let document_ids: HashSet<Uuid> = snapshot.documents.iter().map(|document| document.meta.id).collect();
    let routine_ids: HashSet<Uuid> = snapshot.routines.iter().map(|routine| routine.id).collect();
    let task_ids: HashSet<Uuid> = snapshot.tasks.iter().map(|task| task.task.id).collect();

    let mut tx = state.db.begin().await.context("starting project import transaction")?;

    for routine in &snapshot.routines {
        upsert_routine(&mut tx, routine, project_id).await?;
    }

    for document in &snapshot.documents {
        if let Some(bytes) = document.pencil_bytes.as_ref() {
            if bytes.len() > design_blobs::MAX_DESIGN_BLOB_BYTES {
                bail!("document '{}' exceeds the design file size limit", document.meta.title);
            }
            write_design_blob(document.meta.id, bytes).await?;
        }
        upsert_document(&mut tx, &document.meta, &document.source, project_id).await?;
        for budget in &document.meta.budgets {
            upsert_budget(&mut tx, budget, project_id, &document_ids).await?;
        }
    }

    for task_file in &snapshot.tasks {
        if let Some(routine_id) = task_file.task.routine_id {
            if !routine_ids.contains(&routine_id) && !routine_belongs_to_project(&mut tx, routine_id, project_id).await? {
                bail!("task '{}' references a routine outside this project", task_file.task.title);
            }
        }
        upsert_task_without_parent(&mut tx, &task_file.task, project_id).await?;
    }
    for task_file in &snapshot.tasks {
        if let Some(parent_id) = task_file.task.parent_id {
            if !task_ids.contains(&parent_id) && !task_belongs_to_project(&mut tx, parent_id, project_id).await? {
                bail!("task '{}' references a parent outside this project", task_file.task.title);
            }
            sqlx::query("UPDATE project_tasks SET parent_id = $1, updated_at = $2 WHERE id = $3 AND project_id = $4")
                .bind(parent_id)
                .bind(task_file.task.updated_at)
                .bind(task_file.task.id)
                .bind(project_id)
                .execute(&mut *tx)
                .await
                .context("updating task parent")?;
        }
        for note in &task_file.notes {
            upsert_task_note(&mut tx, note, project_id).await?;
        }
    }

    for lesson in &snapshot.lessons {
        upsert_lesson(&mut tx, lesson, project_id).await?;
    }

    tx.commit().await.context("committing project import")?;

    Ok(SyncResponse {
        action: "import",
        bundle_path: BUNDLE_DIR.to_string(),
        documents: snapshot.documents.len(),
        tasks: snapshot.tasks.len(),
        routines: snapshot.routines.len(),
        lessons: snapshot.lessons.len(),
        task_notes: snapshot.task_notes,
        budgets: snapshot.budgets,
        files_written: 0,
        warnings: Vec::new(),
    })
}

async fn upsert_document(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    meta: &DocumentMeta,
    source: &str,
    project_id: Uuid,
) -> Result<()> {
    if meta.project_id != project_id {
        bail!("document '{}' belongs to a different project", meta.title);
    }
    let result = sqlx::query(
        "INSERT INTO project_designs (id, project_id, title, kind, diagram_type, source, notes, tags, sort_order, status, created_by, created_at, updated_at) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) \
         ON CONFLICT (id) DO UPDATE SET project_id=EXCLUDED.project_id, title=EXCLUDED.title, kind=EXCLUDED.kind, \
             diagram_type=EXCLUDED.diagram_type, source=EXCLUDED.source, notes=EXCLUDED.notes, tags=EXCLUDED.tags, \
             sort_order=EXCLUDED.sort_order, status=EXCLUDED.status, created_by=EXCLUDED.created_by, \
             created_at=EXCLUDED.created_at, updated_at=EXCLUDED.updated_at \
         WHERE project_designs.project_id = EXCLUDED.project_id",
    )
    .bind(meta.id)
    .bind(project_id)
    .bind(&meta.title)
    .bind(&meta.kind)
    .bind(&meta.diagram_type)
    .bind(source)
    .bind(&meta.notes)
    .bind(&meta.tags)
    .bind(meta.sort_order)
    .bind(&meta.status)
    .bind(&meta.created_by)
    .bind(meta.created_at)
    .bind(meta.updated_at)
    .execute(&mut **tx)
    .await
    .context("upserting document")?;
    if result.rows_affected() == 0 {
        bail!("document '{}' belongs to a different project", meta.title);
    }
    Ok(())
}

async fn upsert_budget(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    budget: &BudgetRow,
    project_id: Uuid,
    document_ids: &HashSet<Uuid>,
) -> Result<()> {
    if !document_ids.contains(&budget.design_id) {
        bail!("budget '{}' references a document not present in this bundle", budget.name);
    }
    let existing_owner: Option<Uuid> = sqlx::query_scalar(
        "SELECT d.project_id FROM design_budget_forecasts b JOIN project_designs d ON d.id = b.design_id WHERE b.id = $1",
    )
    .bind(budget.id)
    .fetch_optional(&mut **tx)
    .await
    .context("checking budget ownership")?;
    if existing_owner.is_some_and(|owner| owner != project_id) {
        bail!("budget '{}' belongs to a different project", budget.name);
    }
    sqlx::query(
        "INSERT INTO design_budget_forecasts (id, design_id, forecast_profile_id, name, conditions, currency, monthly_total_cents, line_items, confidence, pricing_basis, created_by, created_at, updated_at) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) \
         ON CONFLICT (id) DO UPDATE SET design_id=EXCLUDED.design_id, forecast_profile_id=EXCLUDED.forecast_profile_id, \
             name=EXCLUDED.name, conditions=EXCLUDED.conditions, currency=EXCLUDED.currency, \
             monthly_total_cents=EXCLUDED.monthly_total_cents, line_items=EXCLUDED.line_items, confidence=EXCLUDED.confidence, \
             pricing_basis=EXCLUDED.pricing_basis, created_by=EXCLUDED.created_by, created_at=EXCLUDED.created_at, updated_at=EXCLUDED.updated_at",
    )
    .bind(budget.id)
    .bind(budget.design_id)
    .bind(budget.forecast_profile_id)
    .bind(&budget.name)
    .bind(&budget.conditions)
    .bind(&budget.currency)
    .bind(budget.monthly_total_cents)
    .bind(&budget.line_items)
    .bind(&budget.confidence)
    .bind(&budget.pricing_basis)
    .bind(&budget.created_by)
    .bind(budget.created_at)
    .bind(budget.updated_at)
    .execute(&mut **tx)
    .await
    .context("upserting document budget")?;
    Ok(())
}

async fn upsert_routine(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    routine: &RoutineRow,
    project_id: Uuid,
) -> Result<()> {
    if routine.project_id != project_id {
        bail!("routine '{}' belongs to a different project", routine.title);
    }
    let result = sqlx::query(
        "INSERT INTO project_routines (id, project_id, title, description, frequency, priority, assigned_to, last_task_date, enabled, created_at, updated_at, labels) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) \
         ON CONFLICT (id) DO UPDATE SET project_id=EXCLUDED.project_id, title=EXCLUDED.title, description=EXCLUDED.description, \
             frequency=EXCLUDED.frequency, priority=EXCLUDED.priority, assigned_to=EXCLUDED.assigned_to, \
             last_task_date=EXCLUDED.last_task_date, enabled=EXCLUDED.enabled, created_at=EXCLUDED.created_at, \
             updated_at=EXCLUDED.updated_at, labels=EXCLUDED.labels \
         WHERE project_routines.project_id = EXCLUDED.project_id",
    )
    .bind(routine.id)
    .bind(project_id)
    .bind(&routine.title)
    .bind(&routine.description)
    .bind(&routine.frequency)
    .bind(&routine.priority)
    .bind(&routine.assigned_to)
    .bind(routine.last_task_date)
    .bind(routine.enabled)
    .bind(routine.created_at)
    .bind(routine.updated_at)
    .bind(&routine.labels)
    .execute(&mut **tx)
    .await
    .context("upserting routine")?;
    if result.rows_affected() == 0 {
        bail!("routine '{}' belongs to a different project", routine.title);
    }
    Ok(())
}

async fn upsert_task_without_parent(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    task: &TaskRow,
    project_id: Uuid,
) -> Result<()> {
    if task.project_id != project_id {
        bail!("task '{}' belongs to a different project", task.title);
    }
    let result = sqlx::query(
        "INSERT INTO project_tasks (id, project_id, title, description, status, priority, assigned_to, created_by, routine_id, created_at, updated_at, labels, parent_id, start_date, due_date, sort_order) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NULL,$13,$14,$15) \
         ON CONFLICT (id) DO UPDATE SET project_id=EXCLUDED.project_id, title=EXCLUDED.title, description=EXCLUDED.description, \
             status=EXCLUDED.status, priority=EXCLUDED.priority, assigned_to=EXCLUDED.assigned_to, created_by=EXCLUDED.created_by, \
             routine_id=EXCLUDED.routine_id, created_at=EXCLUDED.created_at, updated_at=EXCLUDED.updated_at, labels=EXCLUDED.labels, \
             start_date=EXCLUDED.start_date, due_date=EXCLUDED.due_date, sort_order=EXCLUDED.sort_order \
         WHERE project_tasks.project_id = EXCLUDED.project_id",
    )
    .bind(task.id)
    .bind(project_id)
    .bind(&task.title)
    .bind(&task.description)
    .bind(&task.status)
    .bind(&task.priority)
    .bind(&task.assigned_to)
    .bind(&task.created_by)
    .bind(task.routine_id)
    .bind(task.created_at)
    .bind(task.updated_at)
    .bind(&task.labels)
    .bind(task.start_date)
    .bind(task.due_date)
    .bind(task.sort_order)
    .execute(&mut **tx)
    .await
    .context("upserting task")?;
    if result.rows_affected() == 0 {
        bail!("task '{}' belongs to a different project", task.title);
    }
    Ok(())
}

async fn upsert_task_note(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    note: &TaskNoteRow,
    project_id: Uuid,
) -> Result<()> {
    if !task_belongs_to_project(tx, note.task_id, project_id).await? {
        bail!("task note references a task outside this project");
    }
    let result = sqlx::query(
        "INSERT INTO project_task_notes (id, task_id, content, author, created_at, note_type, decision_options, decision_selection_mode, decision_status, decision_resolved_by, decision_resolved_at) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) \
         ON CONFLICT (id) DO UPDATE SET task_id=EXCLUDED.task_id, content=EXCLUDED.content, author=EXCLUDED.author, created_at=EXCLUDED.created_at, \
             note_type=EXCLUDED.note_type, decision_options=EXCLUDED.decision_options, decision_selection_mode=EXCLUDED.decision_selection_mode, decision_status=EXCLUDED.decision_status, \
             decision_resolved_by=EXCLUDED.decision_resolved_by, decision_resolved_at=EXCLUDED.decision_resolved_at \
         WHERE project_task_notes.task_id = EXCLUDED.task_id",
    )
    .bind(note.id)
    .bind(note.task_id)
    .bind(&note.content)
    .bind(&note.author)
    .bind(note.created_at)
    .bind(&note.note_type)
    .bind(&note.decision_options)
    .bind(&note.decision_selection_mode)
    .bind(&note.decision_status)
    .bind(&note.decision_resolved_by)
    .bind(note.decision_resolved_at)
    .execute(&mut **tx)
    .await
    .context("upserting task note")?;
    if result.rows_affected() == 0 {
        bail!("task note belongs to a different project");
    }

    // Replace the note's answer history wholesale, preserving each row's original id and
    // answered_at so repeated imports of the same bundle are idempotent.
    sqlx::query("DELETE FROM project_task_decision_answers WHERE note_id = $1")
        .bind(note.id)
        .execute(&mut **tx)
        .await
        .context("clearing task decision answer history")?;
    for answer in &note.decision_answers {
        sqlx::query(
            "INSERT INTO project_task_decision_answers (id, note_id, selected_options, reply, answered_by, answered_at) \
             VALUES ($1,$2,$3,$4,$5,$6)",
        )
        .bind(answer.id)
        .bind(note.id)
        .bind(&answer.selected_options)
        .bind(&answer.reply)
        .bind(&answer.answered_by)
        .bind(answer.answered_at)
        .execute(&mut **tx)
        .await
        .context("restoring task decision answer")?;
    }
    Ok(())
}

async fn upsert_lesson(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    lesson: &LessonRow,
    project_id: Uuid,
) -> Result<()> {
    if lesson.project_id != project_id {
        bail!("lesson '{}' belongs to a different project", lesson.title);
    }
    let result = sqlx::query(
        "INSERT INTO project_lessons (id, project_id, title, context, rule, category, severity, status, tags, occurrences, created_by, last_seen_at, created_at, updated_at) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) \
         ON CONFLICT (id) DO UPDATE SET project_id=EXCLUDED.project_id, title=EXCLUDED.title, context=EXCLUDED.context, \
             rule=EXCLUDED.rule, category=EXCLUDED.category, severity=EXCLUDED.severity, status=EXCLUDED.status, \
             tags=EXCLUDED.tags, occurrences=EXCLUDED.occurrences, created_by=EXCLUDED.created_by, last_seen_at=EXCLUDED.last_seen_at, \
             created_at=EXCLUDED.created_at, updated_at=EXCLUDED.updated_at \
         WHERE project_lessons.project_id = EXCLUDED.project_id",
    )
    .bind(lesson.id)
    .bind(project_id)
    .bind(&lesson.title)
    .bind(&lesson.context)
    .bind(&lesson.rule)
    .bind(&lesson.category)
    .bind(&lesson.severity)
    .bind(&lesson.status)
    .bind(&lesson.tags)
    .bind(lesson.occurrences)
    .bind(&lesson.created_by)
    .bind(lesson.last_seen_at)
    .bind(lesson.created_at)
    .bind(lesson.updated_at)
    .execute(&mut **tx)
    .await
    .context("upserting lesson")?;
    if result.rows_affected() == 0 {
        bail!("lesson '{}' belongs to a different project", lesson.title);
    }
    Ok(())
}

async fn routine_belongs_to_project(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    routine_id: Uuid,
    project_id: Uuid,
) -> Result<bool> {
    Ok(sqlx::query_scalar::<_, Uuid>("SELECT project_id FROM project_routines WHERE id = $1")
        .bind(routine_id)
        .fetch_optional(&mut **tx)
        .await
        .context("checking routine ownership")?
        .is_some_and(|owner| owner == project_id))
}

async fn task_belongs_to_project(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    task_id: Uuid,
    project_id: Uuid,
) -> Result<bool> {
    Ok(sqlx::query_scalar::<_, Uuid>("SELECT project_id FROM project_tasks WHERE id = $1")
        .bind(task_id)
        .fetch_optional(&mut **tx)
        .await
        .context("checking task ownership")?
        .is_some_and(|owner| owner == project_id))
}

async fn write_design_blob(design_id: Uuid, bytes: &[u8]) -> Result<()> {
    let root = design_blobs::blob_root();
    tokio::fs::create_dir_all(&root).await.context("creating design blob directory")?;
    let final_path = design_blobs::blob_path(&root, design_id);
    let temp_path = design_blobs::temp_blob_path(&root, design_id);
    tokio::fs::write(&temp_path, bytes).await.context("writing imported design blob")?;
    if let Err(error) = tokio::fs::rename(&temp_path, &final_path).await {
        let _ = tokio::fs::remove_file(&temp_path).await;
        return Err(error).context("installing imported design blob");
    }
    Ok(())
}

fn read_bundle(root: &Path, project_id: Uuid) -> Result<ImportSnapshot> {
    let bundle = existing_dir(&root.join(BUNDLE_DIR))?;
    let manifest: BundleManifest = read_json(&bundle.join("manifest.json"))?;
    if manifest.format != BUNDLE_FORMAT || manifest.version != BUNDLE_VERSION {
        bail!("unsupported OpenMemory bundle format or version");
    }
    if manifest.project_id != project_id {
        bail!("this bundle belongs to project {}, not this project", manifest.project_id);
    }

    let docs_dir = existing_dir(&bundle.join("docs"))?;
    let docs_index: DocsIndex = read_json(&docs_dir.join("index.json"))?;
    if docs_index.version != BUNDLE_VERSION {
        bail!("unsupported document index version");
    }
    let mut documents = Vec::with_capacity(docs_index.documents.len());
    let mut document_ids = HashSet::new();
    let mut budgets = 0;
    for meta in docs_index.documents {
        if meta.project_id != project_id || !document_ids.insert(meta.id) {
            bail!("document metadata has an invalid project or duplicate id");
        }
        let source_path = safe_record_file(&docs_dir, &meta.source_file, meta.id)?;
        let (source, pencil_bytes) = if meta.diagram_type == "pen" {
            (PENCIL_SOURCE.to_string(), Some(fs::read(&source_path).with_context(|| format!("reading {}", meta.source_file))?))
        } else {
            (fs::read_to_string(&source_path).with_context(|| format!("reading {}", meta.source_file))?, None)
        };
        budgets += meta.budgets.len();
        documents.push(ImportedDocument { meta, source, pencil_bytes });
    }

    let tasks = read_record_files::<TaskFile>(&existing_dir(&bundle.join("tasks"))?)?;
    let routines = read_record_files::<RoutineRow>(&existing_dir(&bundle.join("routines"))?)?;
    let lessons = read_record_files::<LessonRow>(&existing_dir(&bundle.join("lessons"))?)?;
    let task_notes = tasks.iter().map(|task| task.notes.len()).sum();

    for task in &tasks {
        if task.task.project_id != project_id {
            bail!("task metadata has an invalid project or id");
        }
        for note in &task.notes {
            if note.task_id != task.task.id {
                bail!("task note {} points at a different task", note.id);
            }
        }
    }
    for routine in &routines {
        if routine.project_id != project_id {
            bail!("routine '{}' belongs to a different project", routine.title);
        }
    }
    for lesson in &lessons {
        if lesson.project_id != project_id {
            bail!("lesson '{}' belongs to a different project", lesson.title);
        }
    }

    Ok(ImportSnapshot { documents, tasks, routines, lessons, task_notes, budgets })
}

fn read_record_files<T: DeserializeOwned>(dir: &Path) -> Result<Vec<T>> {
    let mut records = Vec::new();
    let mut record_ids = HashSet::new();
    for entry in fs::read_dir(dir).with_context(|| format!("reading {}", dir.display()))? {
        let entry = entry?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            continue;
        }
        if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
            continue;
        }
        if path.file_name().and_then(|name| name.to_str()) == Some("index.json") {
            continue;
        }
        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| anyhow!("record file has an invalid name: {}", path.display()))?;
        let id = file_name
            .split("--")
            .next()
            .and_then(|prefix| Uuid::parse_str(prefix).ok())
            .ok_or_else(|| anyhow!("record file has no stable UUID prefix: {file_name}"))?;
        if !record_ids.insert(id) {
            bail!("duplicate record UUID in bundle: {id}");
        }

        let value: serde_json::Value = read_json(&path)?;
        let value_id = value
            .get("id")
            .and_then(serde_json::Value::as_str)
            .and_then(|value| Uuid::parse_str(value).ok())
            .ok_or_else(|| anyhow!("record file {file_name} has no valid id"))?;
        if value_id != id {
            bail!("record file {file_name} does not match its stable id");
        }
        records.push(serde_json::from_value(value).with_context(|| format!("parsing {file_name}"))?);
    }
    Ok(records)
}

fn ensure_dir(path: &Path) -> Result<PathBuf> {
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            bail!("bundle path is not a real directory: {}", path.display());
        }
    } else {
        fs::create_dir_all(path).with_context(|| format!("creating {}", path.display()))?;
    }
    Ok(path.to_path_buf())
}

fn existing_dir(path: &Path) -> Result<PathBuf> {
    let metadata = fs::symlink_metadata(path).with_context(|| format!("missing bundle directory {}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        bail!("bundle path is not a real directory: {}", path.display());
    }
    Ok(path.to_path_buf())
}

fn clear_record_files(dir: &Path) -> Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let has_uuid_prefix = name.split("--").next().and_then(|prefix| Uuid::parse_str(prefix).ok()).is_some();
        if has_uuid_prefix {
            fs::remove_file(path)?;
        }
    }
    Ok(())
}

fn safe_record_file(dir: &Path, file_name: &str, id: Uuid) -> Result<PathBuf> {
    let relative = Path::new(file_name);
    if relative.is_absolute()
        || relative.components().count() != 1
        || !matches!(relative.components().next(), Some(Component::Normal(_)))
        || relative.file_name().and_then(|name| name.to_str()).and_then(|name| name.split("--").next()).and_then(|prefix| Uuid::parse_str(prefix).ok()) != Some(id)
    {
        bail!("invalid bundle file name: {file_name}");
    }
    let path = dir.join(relative);
    let metadata = fs::symlink_metadata(&path).with_context(|| format!("missing bundle file {file_name}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        bail!("bundle file is not a regular file: {file_name}");
    }
    Ok(path)
}

fn record_file_name(id: Uuid, title: &str, extension: &str) -> String {
    format!("{id}--{}.{}", slugify(title), extension)
}

fn document_extension(diagram_type: &str) -> &'static str {
    match diagram_type {
        "text" => "md",
        "drawio" => "drawio",
        "mermaid" => "mmd",
        "pen" => "pen",
        "reactflow" => "json",
        _ => "txt",
    }
}

fn slugify(value: &str) -> String {
    let mut output = String::new();
    let mut previous_dash = false;
    for character in value.chars() {
        if character.is_ascii_alphanumeric() {
            output.push(character.to_ascii_lowercase());
            previous_dash = false;
        } else if !previous_dash && !output.is_empty() {
            output.push('-');
            previous_dash = true;
        }
        if output.chars().count() >= 56 {
            break;
        }
    }
    while output.ends_with('-') {
        output.pop();
    }
    if output.is_empty() { "document".to_string() } else { output }
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(value)?;
    atomic_write(path, &bytes)
}

fn read_json<T: DeserializeOwned>(path: &Path) -> Result<T> {
    let bytes = fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    serde_json::from_slice(&bytes).with_context(|| format!("parsing {}", path.display()))
}

fn atomic_copy(source: &Path, destination: &Path) -> Result<()> {
    let bytes = fs::read(source).with_context(|| format!("reading {}", source.display()))?;
    atomic_write(destination, &bytes)
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().ok_or_else(|| anyhow!("bundle file has no parent"))?;
    let temp = parent.join(format!(".{}.{}.tmp", path.file_name().unwrap_or_default().to_string_lossy(), Uuid::new_v4()));
    fs::write(&temp, bytes).with_context(|| format!("writing {}", path.display()))?;
    if let Err(error) = fs::rename(&temp, path) {
        let _ = fs::remove_file(&temp);
        return Err(error).with_context(|| format!("installing {}", path.display()));
    }
    Ok(())
}

fn bundle_readme(project_name: &str) -> String {
    format!(
        "# OpenMemory project data\n\nThis folder is the Git-friendly mirror for **{}**.\n\n- `docs/` contains source documents (`.md`, `.mmd`, `.drawio`, `.json`, or `.pen`) plus `index.json` metadata.\n- `tasks/`, `routines/`, and `lessons/` contain one JSON file per record. Task notes and decision checkpoints live inside each task file.\n- `manifest.json` records the bundle format and exported counts.\n\nUse the project page's Import / Export menu after checking out or merging these files. Import merges records by their stable IDs; it does not delete records that are absent from the bundle.\n",
        project_name
    )
}
