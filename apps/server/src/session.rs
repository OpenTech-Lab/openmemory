use anyhow::Context;
use sqlx::PgPool;
use tracing::info;

/// Creates the three session-watcher tables. Called by both the HTTP server
/// (so query endpoints work even before the watcher runs) and the watcher
/// binary itself on startup.
pub async fn run_session_migrations(db: &PgPool) -> anyhow::Result<()> {
    // sessions — one row per Claude Code session JSONL file
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS sessions (
            id            TEXT PRIMARY KEY,
            file_path     TEXT NOT NULL,
            project_name  TEXT,
            git_branch    TEXT,
            cwd           TEXT,
            agent_name    TEXT,
            started_at    TIMESTAMPTZ,
            last_event_at TIMESTAMPTZ,
            message_count INTEGER NOT NULL DEFAULT 0,
            created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        "#,
    )
    .execute(db)
    .await
    .context("failed to create sessions table")?;

    // Migration: existing installs predate the agent_name column.
    sqlx::query("ALTER TABLE sessions ADD COLUMN IF NOT EXISTS agent_name TEXT")
        .execute(db)
        .await
        .context("failed to add agent_name column")?;

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_sessions_last_event ON sessions(last_event_at DESC NULLS LAST)"
    )
    .execute(db)
    .await
    .ok();

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_name)"
    )
    .execute(db)
    .await
    .ok();

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_sessions_agent_name ON sessions(agent_name)"
    )
    .execute(db)
    .await
    .ok();

    // Backfill: every session recorded before agent_name existed was parsed
    // by the Claude Code JSONL schema (the only one this watcher understands
    // today), so it's safe to attribute pre-migration NULLs to it. Sessions
    // recorded from here on always get agent_name set by the watcher, so
    // this UPDATE becomes a no-op once the backfill has run.
    sqlx::query("UPDATE sessions SET agent_name = 'Claude Code' WHERE agent_name IS NULL")
        .execute(db)
        .await
        .ok();

    // session_messages — one row per parsed JSONL line
    //
    // Dedup key: (session_id, byte_start) — byte offset of the line within
    // the JSONL file. Deterministic and stable even for events with no uuid.
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS session_messages (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            event_type      TEXT NOT NULL,
            role            TEXT,
            content_text    TEXT,
            raw_event       JSONB NOT NULL,
            event_timestamp TIMESTAMPTZ,
            sequence_num    INTEGER NOT NULL,
            byte_start      BIGINT NOT NULL,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        "#,
    )
    .execute(db)
    .await
    .context("failed to create session_messages table")?;

    sqlx::query(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_position \
         ON session_messages(session_id, byte_start)"
    )
    .execute(db)
    .await
    .ok();

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_messages_session_seq \
         ON session_messages(session_id, sequence_num)"
    )
    .execute(db)
    .await
    .ok();

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_messages_event_type \
         ON session_messages(event_type)"
    )
    .execute(db)
    .await
    .ok();

    // watcher_cursors — crash recovery: last byte offset consumed per file
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS watcher_cursors (
            file_path    TEXT PRIMARY KEY,
            byte_offset  BIGINT NOT NULL DEFAULT 0,
            session_id   TEXT,
            line_count   INTEGER NOT NULL DEFAULT 0,
            last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        "#,
    )
    .execute(db)
    .await
    .context("failed to create watcher_cursors table")?;

    // watcher_agents — per-agent recording configuration
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS watcher_agents (
            id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            name        TEXT NOT NULL UNIQUE,
            path        TEXT NOT NULL,
            enabled     BOOLEAN NOT NULL DEFAULT TRUE,
            is_builtin  BOOLEAN NOT NULL DEFAULT FALSE,
            description TEXT,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        "#,
    )
    .execute(db)
    .await
    .context("failed to create watcher_agents table")?;

    // Seed built-in agents — idempotent, never overwrites user changes.
    // `path` is the tool root, not a tool-specific session subdirectory. The
    // watcher resolves the supported settings/session locations below it.
    sqlx::query(
        r#"
        INSERT INTO watcher_agents (name, path, enabled, is_builtin, description) VALUES
          ('Claude Code',     '~/.claude',                 TRUE,  TRUE, 'Claude Code settings and conversation sessions'),
          ('Gemini CLI',      '~/.gemini',                 TRUE,  TRUE, 'Gemini CLI settings and conversation sessions'),
          ('Codex CLI',       '~/.codex',                  TRUE,  TRUE, 'OpenAI Codex CLI settings and conversation sessions'),
          ('GitHub Copilot',  '~/.config/github-copilot',  FALSE, TRUE, 'GitHub Copilot — no local JSONL logs; enable if a custom log path is configured')
        ON CONFLICT (name) DO NOTHING
        "#,
    )
    .execute(db)
    .await
    .context("failed to seed watcher_agents")?;

    // Migration: older installs stored the Claude and Cursor session
    // subdirectories. Convert only those exact defaults; a custom path set by
    // a user is left untouched.
    sqlx::query(
        "UPDATE watcher_agents SET path = '~/.claude' \
         WHERE name = 'Claude Code' AND is_builtin = TRUE AND path = '~/.claude/projects'",
    )
    .execute(db)
    .await
    .context("failed to migrate Claude Code watcher root")?;

    sqlx::query(
        "UPDATE watcher_agents SET path = '~/.cursor' \
         WHERE name = 'Cursor' AND path = '~/.cursor/chats'",
    )
    .execute(db)
    .await
    .context("failed to migrate Cursor watcher root")?;

    info!("session watcher migrations complete");
    Ok(())
}
