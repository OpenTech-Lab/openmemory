use super::*;

impl McpServer {
    pub(super) async fn new() -> Result<Self> {
        // PostgreSQL connection
        let database_url = std::env::var("DATABASE_URL").unwrap_or_else(|_| {
            "postgres://openmemory:openmemory@localhost:5432/openmemory".to_string()
        });

        let db = PgPoolOptions::new()
            .max_connections(5)
            .connect(&database_url)
            .await
            .context("failed to connect to PostgreSQL")?;

        info!("connected to PostgreSQL");

        // Run migrations
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS memory_index (
                id UUID PRIMARY KEY,
                user_id TEXT,
                summary TEXT,
                importance_score REAL NOT NULL DEFAULT 0.5,
                tags TEXT[] NOT NULL DEFAULT '{}',
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            "#,
        )
        .execute(&db)
        .await
        .context("failed to create memory_index table")?;

        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS env_params (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                key TEXT NOT NULL UNIQUE,
                value_encrypted BYTEA NOT NULL,
                is_secret BOOLEAN NOT NULL DEFAULT FALSE,
                description TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            "#,
        )
        .execute(&db)
        .await
        .context("failed to create env_params table")?;

        resources::ensure_resources_table(&db).await?;
        forecasts::ensure_table(&db).await?;
        workflows::ensure_table(&db).await?;

        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS project_graphs (
                id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
                name            TEXT        NOT NULL,
                path            TEXT        NOT NULL UNIQUE,
                canonical_path  TEXT        NOT NULL UNIQUE,
                description     TEXT,
                node_count      INTEGER     NOT NULL DEFAULT 0 CHECK (node_count >= 0),
                edge_count      INTEGER     NOT NULL DEFAULT 0 CHECK (edge_count >= 0),
                graph_data      JSONB       NOT NULL DEFAULT '{}',
                graph_hash      TEXT,
                graph_file_size BIGINT,
                imported_at     TIMESTAMPTZ,
                created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            "#,
        )
        .execute(&db)
        .await
        .context("failed to create project_graphs table")?;

        sqlx::query("CREATE INDEX IF NOT EXISTS idx_project_graphs_path ON project_graphs(path)")
            .execute(&db)
            .await
            .context("failed to create idx_project_graphs_path")?;

        sqlx::query(
            "CREATE INDEX IF NOT EXISTS idx_project_graphs_created_at ON project_graphs(created_at DESC)",
        )
        .execute(&db)
        .await
        .context("failed to create idx_project_graphs_created_at")?;

        // Make path optional
        sqlx::query("ALTER TABLE project_graphs ALTER COLUMN path DROP NOT NULL")
            .execute(&db)
            .await
            .ok();
        sqlx::query("ALTER TABLE project_graphs ALTER COLUMN canonical_path DROP NOT NULL")
            .execute(&db)
            .await
            .ok();

        sqlx::query(
            r#"CREATE TABLE IF NOT EXISTS project_designs (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                project_id UUID NOT NULL REFERENCES project_graphs(id) ON DELETE CASCADE,
                title TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'other',
                diagram_type TEXT NOT NULL DEFAULT 'mermaid', source TEXT NOT NULL DEFAULT '',
                notes TEXT, tags TEXT[] NOT NULL DEFAULT '{}', sort_order INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'active', created_by TEXT NOT NULL DEFAULT 'user',
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )"#,
        ).execute(&db).await.context("failed to create project_designs table")?;
        sqlx::query("CREATE INDEX IF NOT EXISTS idx_project_designs_project_id ON project_designs(project_id)")
            .execute(&db).await.ok();
        design_budgets::ensure_table(&db).await?;

        // Project tasks table
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS project_tasks (
                id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
                project_id   UUID        NOT NULL REFERENCES project_graphs(id) ON DELETE CASCADE,
                title        TEXT        NOT NULL,
                description  TEXT,
                status       TEXT        NOT NULL DEFAULT 'todo',
                priority     TEXT        NOT NULL DEFAULT 'medium',
                assigned_to  TEXT,
                created_by   TEXT        NOT NULL DEFAULT 'human',
                created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            "#,
        )
        .execute(&db)
        .await
        .context("failed to create project_tasks table")?;

        sqlx::query(
            "CREATE INDEX IF NOT EXISTS idx_project_tasks_project_id ON project_tasks(project_id)",
        )
        .execute(&db)
        .await
        .ok();

        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS project_task_notes (
                id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
                task_id    UUID        NOT NULL REFERENCES project_tasks(id) ON DELETE CASCADE,
                content    TEXT        NOT NULL,
                author     TEXT        NOT NULL DEFAULT 'human',
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            "#,
        )
        .execute(&db)
        .await
        .context("failed to create project_task_notes table")?;

        sqlx::query(
            "CREATE INDEX IF NOT EXISTS idx_project_task_notes_task_id_created_at ON project_task_notes(task_id, created_at)",
        )
        .execute(&db)
        .await
        .ok();

        // Routine templates
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS project_routines (
                id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
                project_id      UUID        NOT NULL REFERENCES project_graphs(id) ON DELETE CASCADE,
                title           TEXT        NOT NULL,
                description     TEXT,
                frequency       TEXT        NOT NULL DEFAULT 'daily',
                priority        TEXT        NOT NULL DEFAULT 'medium',
                assigned_to     TEXT,
                last_task_date  DATE,
                enabled         BOOLEAN     NOT NULL DEFAULT TRUE,
                created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            "#,
        )
        .execute(&db).await.ok();

        sqlx::query("CREATE INDEX IF NOT EXISTS idx_project_routines_project_id ON project_routines(project_id)")
            .execute(&db).await.ok();

        sqlx::query("ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS routine_id UUID REFERENCES project_routines(id) ON DELETE SET NULL")
            .execute(&db).await.ok();

        // OpenSearch connection
        let opensearch_url =
            std::env::var("OPENSEARCH_URL").unwrap_or_else(|_| "http://localhost:9201".to_string());

        let opensearch = OpenSearchClient::new(&opensearch_url);
        opensearch.create_index().await?;
        info!("connected to OpenSearch");

        // Optional FalkorDB connection (graph layer)
        let mut falkordb = match std::env::var("FALKORDB_URL") {
            Ok(url) => FalkorDbClient::connect(&url).await,
            Err(_) => {
                info!("FALKORDB_URL not set, running without graph layer");
                None
            }
        };
        if let Some(ref mut fdb) = falkordb {
            if let Err(e) = fdb.init_indexes().await {
                warn!("FalkorDB index init failed: {e}");
            }
        }

        let secret_key = match std::env::var("OPENMEMORY_SECRET_KEY") {
            Ok(key) => key,
            Err(_) if std::env::var("OPENMEMORY_ALLOW_INSECURE_DEV_KEY").as_deref() == Ok("1") => {
                warn!("OPENMEMORY_ALLOW_INSECURE_DEV_KEY=1 set: using the well-known dev secret key. CI/tests only.");
                "dev-secret-key-change-me".to_string()
            }
            Err(_) => {
                anyhow::bail!(
                    "OPENMEMORY_SECRET_KEY is not set. Generate one with:  openssl rand -base64 48\n\
                     and set it in .env / your MCP server env. Refusing to start.\n\
                     (Set OPENMEMORY_ALLOW_INSECURE_DEV_KEY=1 to use the well-known dev key — CI/tests only.)"
                );
            }
        };
        let encryption_key = derive_key(&secret_key);

        Ok(Self {
            db,
            opensearch,
            falkordb,
            encryption_key,
        })
    }
}
