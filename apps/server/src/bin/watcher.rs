use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

use anyhow::Context;
use notify::{EventKind, RecursiveMode, Watcher};
use openmemory_server::run_session_migrations;
use reqwest::Client as HttpClient;
use serde::Deserialize;
use serde_json::Value;
use sqlx::{postgres::PgPoolOptions, PgPool};
use tokio::{
    io::{AsyncBufReadExt, AsyncSeekExt, BufReader, SeekFrom},
    sync::Mutex,
    time::sleep,
};
use tracing::{debug, info, warn};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Memory saving
// ---------------------------------------------------------------------------

/// Pending user turns keyed by session_id — used to pair user+assistant into memories.
type PendingUserText = Arc<Mutex<HashMap<String, String>>>;

async fn save_memory(client: &HttpClient, server_url: &str, content: String, tags: Vec<String>) {
    let body = serde_json::json!({
        "type": "memory.save",
        "content": content,
        "importance": 0.5,
        "tags": tags,
    });
    match client
        .post(format!("{server_url}/mcp"))
        .json(&body)
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => {}
        Ok(r) => warn!("memory save returned {}", r.status()),
        Err(e) => warn!("memory save request failed: {e}"),
    }
}

// ---------------------------------------------------------------------------
// Claude Code JSONL event types
// ---------------------------------------------------------------------------

/// Top-level envelope parsed from each JSONL line.
#[derive(Debug, Deserialize)]
struct RawEvent {
    #[serde(rename = "type")]
    event_type: String,

    // Present on user/assistant events
    message: Option<Value>,
    timestamp: Option<String>,

    // May appear on user events
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    cwd: Option<String>,
    #[serde(rename = "gitBranch")]
    git_branch: Option<String>,

    // attachment events
    attachment: Option<Value>,
}

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

async fn run_watcher_migrations(db: &PgPool) -> anyhow::Result<()> {
    run_session_migrations(db).await
}

/// Returns the cursor state for a file (byte_offset + line_count), or (0, 0).
async fn get_cursor(db: &PgPool, file_path: &str) -> (i64, i32) {
    let row = sqlx::query_as::<_, (i64, i32)>(
        "SELECT byte_offset, line_count FROM watcher_cursors WHERE file_path = $1",
    )
    .bind(file_path)
    .fetch_optional(db)
    .await
    .unwrap_or(None);

    row.unwrap_or((0, 0))
}

/// Persist cursor progress.
async fn update_cursor(
    db: &PgPool,
    file_path: &str,
    byte_offset: i64,
    session_id: Option<&str>,
    line_count: i32,
) -> anyhow::Result<()> {
    sqlx::query(
        r#"
        INSERT INTO watcher_cursors (file_path, byte_offset, session_id, line_count, last_seen_at)
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (file_path) DO UPDATE SET
            byte_offset  = EXCLUDED.byte_offset,
            session_id   = COALESCE(EXCLUDED.session_id, watcher_cursors.session_id),
            line_count   = EXCLUDED.line_count,
            last_seen_at = NOW()
        "#,
    )
    .bind(file_path)
    .bind(byte_offset)
    .bind(session_id)
    .bind(line_count)
    .execute(db)
    .await
    .context("update_cursor")?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Content text extraction
// ---------------------------------------------------------------------------

/// Flatten a Claude Code message content array to plain text.
/// Tolerates string, array, or missing content.
fn extract_content_text(content: &Value) -> Option<String> {
    match content {
        Value::Array(items) => {
            let text: Vec<&str> = items
                .iter()
                .filter_map(|item| {
                    if item.get("type")?.as_str()? == "text" {
                        item.get("text")?.as_str()
                    } else {
                        None
                    }
                })
                .collect();
            if text.is_empty() {
                None
            } else {
                Some(text.join("\n"))
            }
        }
        Value::String(s) => Some(s.clone()),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Core file processing
// ---------------------------------------------------------------------------

/// Derive the session UUID from the JSONL filename (e.g. `<uuid>.jsonl`).
fn session_id_from_path(path: &Path) -> Option<String> {
    path.file_stem()?.to_str().map(String::from)
}

/// Derive a human-readable project name from the project directory name.
fn project_name_from_path(path: &Path) -> Option<String> {
    path.parent()?.file_name()?.to_str().map(String::from)
}

/// Read new lines from `path` starting at `start_offset`, parse them, and
/// write to the database inside per-line transactions.
///
/// Returns the new byte offset after all processed lines.
async fn process_file(
    db: &PgPool,
    path: &Path,
    start_offset: i64,
    start_line: i32,
    projects_root: &Path,
    agent_name: &str,
    memory: Option<(&HttpClient, &str, &PendingUserText)>,
) -> anyhow::Result<(i64, i32)> {
    let file_path_str = path
        .strip_prefix(projects_root)
        .unwrap_or(path)
        .to_string_lossy()
        .into_owned();

    let session_id = match session_id_from_path(path) {
        Some(id) => id,
        None => {
            warn!("cannot derive session_id from {:?}", path);
            return Ok((start_offset, start_line));
        }
    };
    let project_name = project_name_from_path(path);

    // Validate the file is not shorter than our cursor (happens on replacement)
    let metadata = tokio::fs::metadata(path).await;
    if let Ok(meta) = metadata {
        if (meta.len() as i64) < start_offset {
            warn!(
                "file {:?} is shorter ({}) than cursor ({}), resetting",
                path,
                meta.len(),
                start_offset
            );
            return Ok((0, 0));
        }
    }

    let file = tokio::fs::File::open(path).await?;
    let mut reader = BufReader::new(file);
    reader
        .seek(SeekFrom::Start(start_offset as u64))
        .await?;

    let mut current_offset = start_offset;
    let mut sequence_num = start_line;
    let mut last_session_id: Option<String> = None;
    let mut line = String::new();

    loop {
        let line_start = current_offset;
        line.clear();

        let bytes_read = reader.read_line(&mut line).await?;
        if bytes_read == 0 {
            // EOF — stop; next notify event or poll will resume
            break;
        }

        // Only process complete lines (ending with newline)
        if !line.ends_with('\n') {
            // Partial line — do not advance cursor; wait for rest to arrive
            debug!("partial line at offset {current_offset}, waiting");
            break;
        }

        current_offset += bytes_read as i64;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            // Persist cursor for blank lines too (they are complete)
            update_cursor(db, &file_path_str, current_offset, last_session_id.as_deref(), sequence_num).await.ok();
            continue;
        }

        // Parse the JSONL line into our envelope
        let raw_value: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(e) => {
                warn!("skipping malformed JSONL line at offset {line_start}: {e}");
                update_cursor(db, &file_path_str, current_offset, last_session_id.as_deref(), sequence_num).await.ok();
                continue;
            }
        };

        let event: RawEvent = match serde_json::from_value(raw_value.clone()) {
            Ok(e) => e,
            Err(e) => {
                debug!("cannot parse event at offset {line_start}: {e}");
                update_cursor(db, &file_path_str, current_offset, last_session_id.as_deref(), sequence_num).await.ok();
                continue;
            }
        };

        let event_type = event.event_type.as_str();

        // Skip non-content event types
        if matches!(event_type, "queue-operation" | "last-prompt") {
            update_cursor(db, &file_path_str, current_offset, last_session_id.as_deref(), sequence_num).await.ok();
            continue;
        }

        // Prefer event's sessionId; fall back to filename-derived id
        let eff_session_id = event
            .session_id
            .as_deref()
            .unwrap_or(&session_id)
            .to_string();

        last_session_id = Some(eff_session_id.clone());

        // Extract displayable text from message content
        let (role, content_text) = match event_type {
            "user" | "assistant" => {
                let msg = event.message.as_ref();
                let role = msg
                    .and_then(|m| m.get("role"))
                    .and_then(|r| r.as_str())
                    .unwrap_or(event_type)
                    .to_string();
                let content = msg.and_then(|m| m.get("content"));
                let text = content.and_then(extract_content_text);
                (Some(role), text)
            }
            "attachment" => {
                let text = event.attachment.as_ref().and_then(|a| {
                    // Use a short summary rather than full raw JSON
                    a.get("type")
                        .and_then(|t| t.as_str())
                        .map(|t| format!("[attachment: {t}]"))
                });
                (None, text)
            }
            _ => (None, None),
        };

        // All writes for one line in a single transaction
        let mut tx = db.begin().await.context("begin transaction")?;

        sqlx::query(
            r#"
            INSERT INTO sessions (id, file_path, project_name, git_branch, cwd, agent_name, started_at, last_event_at)
            VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
            ON CONFLICT (id) DO UPDATE SET
                last_event_at = EXCLUDED.last_event_at,
                git_branch    = COALESCE(EXCLUDED.git_branch, sessions.git_branch),
                cwd           = COALESCE(EXCLUDED.cwd, sessions.cwd),
                agent_name    = COALESCE(sessions.agent_name, EXCLUDED.agent_name)
            "#,
        )
        .bind(&eff_session_id)
        .bind(&file_path_str)
        .bind(project_name.as_deref())
        .bind(event.git_branch.as_deref())
        .bind(event.cwd.as_deref())
        .bind(agent_name)
        .execute(&mut *tx)
        .await
        .context("upsert session in tx")?;

        sqlx::query(
            r#"
            INSERT INTO session_messages
                (id, session_id, event_type, role, content_text, raw_event, event_timestamp, sequence_num, byte_start)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            ON CONFLICT (session_id, byte_start) DO NOTHING
            "#,
        )
        .bind(Uuid::new_v4())
        .bind(&eff_session_id)
        .bind(event_type)
        .bind(role.as_deref())
        .bind(content_text.as_deref())
        .bind(&raw_value)
        .bind(
            event
                .timestamp
                .as_deref()
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|dt| dt.with_timezone(&chrono::Utc)),
        )
        .bind(sequence_num)
        .bind(line_start)
        .execute(&mut *tx)
        .await
        .context("insert message in tx")?;

        sqlx::query(
            r#"
            INSERT INTO watcher_cursors (file_path, byte_offset, session_id, line_count, last_seen_at)
            VALUES ($1, $2, $3, $4, NOW())
            ON CONFLICT (file_path) DO UPDATE SET
                byte_offset  = EXCLUDED.byte_offset,
                session_id   = EXCLUDED.session_id,
                line_count   = EXCLUDED.line_count,
                last_seen_at = NOW()
            "#,
        )
        .bind(&file_path_str)
        .bind(current_offset)
        .bind(&eff_session_id)
        .bind(sequence_num)
        .execute(&mut *tx)
        .await
        .context("update cursor in tx")?;

        tx.commit().await.context("commit transaction")?;

        // Pair user+assistant messages into memories (live path only).
        if let Some((http, server_url, pending)) = memory {
            match (role.as_deref(), content_text.as_ref()) {
                (Some("user"), Some(text)) => {
                    pending.lock().await.insert(eff_session_id.clone(), text.clone());
                }
                (Some("assistant"), Some(text)) => {
                    let user_text = pending.lock().await.remove(&eff_session_id);
                    let content = if let Some(u) = user_text {
                        format!("User: {u}\n\nAssistant: {text}")
                    } else {
                        format!("Assistant: {text}")
                    };
                    let mut tags = vec!["session".to_string(), "watcher".to_string()];
                    if let Some(ref pname) = project_name {
                        tags.push(pname.clone());
                    }
                    save_memory(http, server_url, content, tags).await;
                }
                _ => {}
            }
        }

        sequence_num += 1;
        debug!("processed {event_type} at offset {line_start}");
    }

    // Update message_count on session
    if let Some(ref sid) = last_session_id {
        sqlx::query(
            "UPDATE sessions SET message_count = \
             (SELECT COUNT(*) FROM session_messages WHERE session_id = $1) WHERE id = $1",
        )
        .bind(sid)
        .execute(db)
        .await
        .ok();
    }

    Ok((current_offset, sequence_num))
}

// ---------------------------------------------------------------------------
// Startup catchup
// ---------------------------------------------------------------------------

async fn startup_catchup(db: &PgPool, projects_root: &Path, agent_name: &str) -> anyhow::Result<()> {
    info!("startup catchup: scanning {:?}", projects_root);
    let mut count = 0usize;

    let mut project_dirs = tokio::fs::read_dir(projects_root).await?;
    while let Ok(Some(project_entry)) = project_dirs.next_entry().await {
        let project_path = project_entry.path();
        if !project_path.is_dir() {
            continue;
        }
        let mut session_files = match tokio::fs::read_dir(&project_path).await {
            Ok(rd) => rd,
            Err(_) => continue,
        };
        while let Ok(Some(entry)) = session_files.next_entry().await {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let file_path_str = path
                .strip_prefix(projects_root)
                .unwrap_or(&path)
                .to_string_lossy()
                .into_owned();

            let (offset, line_count) = get_cursor(db, &file_path_str).await;
            let (new_offset, new_line_count) =
                process_file(db, &path, offset, line_count, projects_root, agent_name, None)
                    .await
                    .unwrap_or_else(|e| {
                        warn!("process_file error for {:?}: {e:#}", path);
                        (offset, line_count)
                    });

            if new_offset != offset {
                count += 1;
                debug!(
                    "catchup: {:?} offset {} → {}",
                    path, offset, new_offset
                );
                let _ = update_cursor(
                    db,
                    &file_path_str,
                    new_offset,
                    None,
                    new_line_count,
                )
                .await;
            }
        }
    }

    info!("startup catchup complete: {count} files updated");
    Ok(())
}

// ---------------------------------------------------------------------------
// Main watch loop
// ---------------------------------------------------------------------------

/// Expand leading `~/` or `$HOME/` to the actual home directory.
fn expand_path(p: &str) -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/root".to_string());
    if p.starts_with("~/") {
        PathBuf::from(&home).join(&p[2..])
    } else if p.starts_with("$HOME/") {
        PathBuf::from(&home).join(&p[6..])
    } else {
        PathBuf::from(p)
    }
}

/// Load all enabled agent paths from the `watcher_agents` table.
/// Returns `(name, expanded_path)` pairs. Falls back to empty vec on error.
async fn load_enabled_agents(db: &PgPool) -> anyhow::Result<Vec<(String, PathBuf)>> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT name, path FROM watcher_agents WHERE enabled = TRUE ORDER BY name ASC"
    )
    .fetch_all(db)
    .await?;

    Ok(rows
        .into_iter()
        .map(|(name, path)| (name, expand_path(&path)))
        .collect())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "openmemory_watcher=info,warn".into()),
        )
        .init();

    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://openmemory:openmemory@localhost:5432/openmemory".to_string());

    let db = PgPoolOptions::new()
        .max_connections(5)
        .connect(&database_url)
        .await
        .context("failed to connect to PostgreSQL")?;

    info!("connected to PostgreSQL");
    run_watcher_migrations(&db).await?;

    let server_url = std::env::var("OPENMEMORY_URL")
        .unwrap_or_else(|_| "http://localhost:18080".to_string());
    let http_client = HttpClient::new();
    let pending_user_text: PendingUserText = Arc::new(Mutex::new(HashMap::new()));

    // Optional polling fallback (for Docker bind mounts that miss inotify events).
    let poll_interval: Option<Duration> = std::env::var("WATCHER_POLL_INTERVAL_SEC")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .map(Duration::from_secs);

    let dirty = Arc::new(AtomicBool::new(false));

    let (tx, mut rx) = tokio::sync::mpsc::channel::<notify::Result<notify::Event>>(1024);
    let dirty_tx = Arc::clone(&dirty);
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if tx.try_send(res).is_err() {
            dirty_tx.store(true, Ordering::Relaxed);
        }
    })?;

    // Load enabled agents; fall back to CLAUDE_PROJECTS_DIR if table missing/empty.
    let initial_agents = match load_enabled_agents(&db).await {
        Ok(agents) if !agents.is_empty() => agents,
        Ok(_) | Err(_) => {
            warn!("no enabled agents in DB; falling back to CLAUDE_PROJECTS_DIR");
            let home = std::env::var("HOME").unwrap_or_else(|_| "/root".into());
            let root = std::env::var("CLAUDE_PROJECTS_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|_| PathBuf::from(&home).join(".claude").join("projects"));
            vec![("Claude Code (fallback)".to_string(), root)]
        }
    };

    // Shared map of currently watched roots -> agent name (shared with poll task).
    let watched_roots: Arc<Mutex<HashMap<PathBuf, String>>> =
        Arc::new(Mutex::new(HashMap::new()));

    // Register inotify BEFORE startup catchup to avoid race condition.
    {
        let mut roots = watched_roots.lock().await;
        for (name, root) in &initial_agents {
            if !root.exists() {
                warn!("agent '{}' path {:?} does not exist, skipping", name, root);
                continue;
            }
            match watcher.watch(root, RecursiveMode::Recursive) {
                Ok(()) => {
                    info!("watching {:?} ({})", root, name);
                    roots.insert(root.clone(), name.clone());
                }
                Err(e) => warn!("failed to watch {:?}: {e}", root),
            }
        }
    }

    // Startup catchup for each watched root.
    {
        let roots = watched_roots.lock().await;
        for (root, name) in roots.iter() {
            startup_catchup(&db, root, name).await.unwrap_or_else(|e| {
                warn!("startup catchup error for {:?}: {e}", root);
            });
        }
    }

    let in_flight: Arc<Mutex<HashMap<PathBuf, bool>>> =
        Arc::new(Mutex::new(HashMap::new()));

    // Polling task (optional): periodically rescan all watched roots.
    if let Some(interval) = poll_interval {
        let db2 = db.clone();
        let roots2 = Arc::clone(&watched_roots);
        tokio::spawn(async move {
            loop {
                sleep(interval).await;
                let roots = roots2
                    .lock()
                    .await
                    .iter()
                    .map(|(r, n)| (r.clone(), n.clone()))
                    .collect::<Vec<_>>();
                for (root, name) in &roots {
                    info!("poll: rescanning {:?}", root);
                    startup_catchup(&db2, root, name).await.unwrap_or_else(|e| {
                        warn!("poll error: {e}");
                    });
                }
            }
        });
    }

    // Hot-reload ticker: every 60s, diff enabled agents vs currently watched.
    let mut reload_ticker = tokio::time::interval(Duration::from_secs(60));
    reload_ticker.tick().await; // skip first immediate tick

    info!("session watcher running");

    loop {
        tokio::select! {
            Some(res) = rx.recv() => {
                match res {
                    Ok(event) => {
                        // If dirty flag set (channel was full), rescan all roots
                        if dirty.swap(false, Ordering::Relaxed) {
                            warn!("event channel was full; running full rescan");
                            let db2 = db.clone();
                            let roots = watched_roots
                                .lock()
                                .await
                                .iter()
                                .map(|(r, n)| (r.clone(), n.clone()))
                                .collect::<Vec<_>>();
                            tokio::spawn(async move {
                                for (root, name) in &roots {
                                    startup_catchup(&db2, root, name).await.unwrap_or_else(|e| {
                                        warn!("dirty-flag rescan error: {e}");
                                    });
                                }
                            });
                            continue;
                        }

                        for path in event.paths {
                            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                                continue;
                            }
                            match event.kind {
                                EventKind::Create(_) | EventKind::Modify(_) => {}
                                _ => continue,
                            }

                            // Find which watched root this file belongs to.
                            let root_and_name = {
                                let roots = watched_roots.lock().await;
                                roots
                                    .iter()
                                    .find(|(r, _)| path.starts_with(r))
                                    .map(|(r, n)| (r.clone(), n.clone()))
                            };
                            let (root, agent_name) = match root_and_name {
                                Some((r, n)) => (r, n),
                                None => (path.parent().unwrap_or(&path).to_owned(), "Unknown".to_string()),
                            };

                            let db2 = db.clone();
                            let in_flight2 = Arc::clone(&in_flight);
                            let http2 = http_client.clone();
                            let server_url2 = server_url.clone();
                            let pending2 = Arc::clone(&pending_user_text);

                            tokio::spawn(async move {
                                {
                                    let mut guard = in_flight2.lock().await;
                                    if guard.contains_key(&path) {
                                        return;
                                    }
                                    guard.insert(path.clone(), true);
                                }

                                let file_path_str = path
                                    .strip_prefix(&root)
                                    .unwrap_or(&path)
                                    .to_string_lossy()
                                    .into_owned();

                                let (offset, line_count) = get_cursor(&db2, &file_path_str).await;
                                match process_file(&db2, &path, offset, line_count, &root, &agent_name, Some((&http2, &server_url2, &pending2))).await {
                                    Ok((new_offset, new_lines)) if new_offset > offset => {
                                        info!(
                                            "ingested {:?}: +{} bytes, +{} lines",
                                            path.file_name().unwrap_or_default(),
                                            new_offset - offset,
                                            new_lines - line_count,
                                        );
                                    }
                                    Err(e) => warn!("process_file error for {:?}: {e:#}", path),
                                    _ => {}
                                }

                                in_flight2.lock().await.remove(&path);
                            });
                        }
                    }
                    Err(e) => warn!("inotify error: {e}"),
                }
            }

            _ = reload_ticker.tick() => {
                match load_enabled_agents(&db).await {
                    Ok(agents) => {
                        let new_roots: HashMap<PathBuf, String> = agents.into_iter()
                            .filter(|(_, p)| p.exists())
                            .map(|(name, p)| (p, name))
                            .collect();

                        let mut current = watched_roots.lock().await;
                        let current_keys: HashSet<PathBuf> = current.keys().cloned().collect();
                        let new_keys: HashSet<PathBuf> = new_roots.keys().cloned().collect();

                        // Add newly enabled paths.
                        for root in new_keys.difference(&current_keys).cloned().collect::<Vec<_>>() {
                            match watcher.watch(&root, RecursiveMode::Recursive) {
                                Ok(()) => {
                                    let name = new_roots.get(&root).cloned().unwrap_or_else(|| "Unknown".to_string());
                                    info!("hot-reload: now watching {:?} ({name})", root);
                                    startup_catchup(&db, &root, &name).await.unwrap_or_else(|e| {
                                        warn!("hot-reload catchup error: {e}");
                                    });
                                    current.insert(root, name);
                                }
                                Err(e) => warn!("hot-reload: failed to watch {:?}: {e}", root),
                            }
                        }

                        // Remove disabled/deleted paths.
                        for root in current_keys.difference(&new_keys).cloned().collect::<Vec<_>>() {
                            let _ = watcher.unwatch(&root);
                            info!("hot-reload: stopped watching {:?}", root);
                            current.remove(&root);
                        }
                    }
                    Err(e) => warn!("failed to reload agents: {e}"),
                }
            }
        }
    }
}
