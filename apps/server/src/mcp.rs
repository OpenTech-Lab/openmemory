#![recursion_limit = "512"]

mod crypto;
mod design_budgets;
mod falkordb;
mod forecasts;
mod project_graphs;
mod indexer;
mod resources;
mod workflows;

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use crypto::{decrypt_value, derive_key, encrypt_value, EnvParamRow};
use falkordb::FalkorDbClient;
use reqwest::Client as HttpClient;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{postgres::PgPoolOptions, PgPool, Row, FromRow};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tracing::{error, info, warn};
use uuid::Uuid;

#[derive(Debug, Deserialize)]
struct JsonRpcRequest {
    jsonrpc: String,
    id: Option<serde_json::Value>,
    method: String,
    params: Option<serde_json::Value>,
}

#[derive(Debug, Serialize)]
struct JsonRpcResponse {
    jsonrpc: String,
    id: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<JsonRpcError>,
}

#[derive(Debug, Serialize)]
struct JsonRpcError {
    code: i32,
    message: String,
}

// PostgreSQL: Index data
#[derive(Clone, Debug, Serialize, Deserialize, FromRow)]
struct MemoryIndex {
    id: Uuid,
    user_id: Option<String>,
    summary: Option<String>,
    importance_score: f32,
    tags: Vec<String>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

// OpenSearch: Full content
#[derive(Clone, Debug, Serialize, Deserialize)]
struct MemoryDocument {
    id: String,
    user_id: Option<String>,
    content: String,
    summary: Option<String>,
    importance_score: f32,
    tags: Vec<String>,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct SearchResult {
    id: Uuid,
    content: String,
    summary: Option<String>,
    tags: Vec<String>,
    importance_score: f32,
    created_at: DateTime<Utc>,
    score: f32,
    #[serde(default)]
    via_graph: bool,
}

#[derive(Clone)]
struct OpenSearchClient {
    client: HttpClient,
    base_url: String,
    index: String,
}

impl OpenSearchClient {
    fn new(base_url: &str) -> Self {
        Self {
            client: HttpClient::new(),
            base_url: base_url.trim_end_matches('/').to_string(),
            index: "memories".to_string(),
        }
    }

    async fn create_index(&self) -> Result<()> {
        let url = format!("{}/{}", self.base_url, self.index);

        let resp = self.client.head(&url).send().await;
        if resp.is_ok() && resp.unwrap().status().is_success() {
            return Ok(());
        }

        let mapping = json!({
            "settings": {
                "number_of_shards": 1,
                "number_of_replicas": 0
            },
            "mappings": {
                "properties": {
                    "id": { "type": "keyword" },
                    "user_id": { "type": "keyword" },
                    "content": { "type": "text", "analyzer": "standard" },
                    "summary": { "type": "text" },
                    "importance_score": { "type": "float" },
                    "tags": { "type": "keyword" },
                    "created_at": { "type": "date" },
                    "updated_at": { "type": "date" }
                }
            }
        });

        let resp = self.client.put(&url).json(&mapping).send().await?;
        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            warn!("OpenSearch index creation: {}", body);
        }

        Ok(())
    }

    async fn index_document(&self, doc: &MemoryDocument) -> Result<()> {
        let url = format!("{}/{}/_doc/{}", self.base_url, self.index, doc.id);

        let resp = self.client.put(&url).json(doc).send().await?;
        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            anyhow::bail!("Failed to index document: {}", body);
        }

        Ok(())
    }

    async fn search(&self, query: &str, limit: usize) -> Result<Vec<MemoryDocument>> {
        let url = format!("{}/{}/_search", self.base_url, self.index);

        let search_body = json!({
            "size": limit,
            "query": {
                "multi_match": {
                    "query": query,
                    "fields": ["content^2", "summary", "tags"],
                    "fuzziness": "AUTO"
                }
            },
            "_source": true
        });

        let resp = self.client.post(&url).json(&search_body).send().await?;
        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            anyhow::bail!("Search failed: {}", body);
        }

        let result: serde_json::Value = resp.json().await?;
        let hits = result["hits"]["hits"].as_array();

        let docs: Vec<MemoryDocument> = hits
            .map(|arr| {
                arr.iter()
                    .filter_map(|hit| serde_json::from_value(hit["_source"].clone()).ok())
                    .collect()
            })
            .unwrap_or_default();

        Ok(docs)
    }

    async fn get_by_ids(&self, ids: &[String]) -> Result<Vec<MemoryDocument>> {
        if ids.is_empty() {
            return Ok(vec![]);
        }
        let url = format!("{}/{}/_search", self.base_url, self.index);
        let search_body = json!({
            "size": ids.len(),
            "query": { "ids": { "values": ids } },
            "_source": true
        });

        let resp = self.client.post(&url).json(&search_body).send().await?;
        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            anyhow::bail!("get_by_ids failed: {}", body);
        }

        let result: serde_json::Value = resp.json().await?;
        let hits = result["hits"]["hits"].as_array();
        let docs: Vec<MemoryDocument> = hits
            .map(|arr| {
                arr.iter()
                    .filter_map(|hit| serde_json::from_value(hit["_source"].clone()).ok())
                    .collect()
            })
            .unwrap_or_default();

        Ok(docs)
    }
}

struct McpServer {
    db: PgPool,
    opensearch: OpenSearchClient,
    falkordb: Option<FalkorDbClient>,
    encryption_key: [u8; 32],
}

/// Trim/lowercase/dedupe lesson tags — mirrors main.rs's normalize_labels for the REST path.
fn normalize_lesson_tags(tags: &[String]) -> Vec<String> {
    let mut out: Vec<String> = tags.iter()
        .map(|t| t.trim().to_lowercase())
        .filter(|t| !t.is_empty())
        .collect();
    out.sort();
    out.dedup();
    out
}

fn is_routine_due_mcp(frequency: &str, last_task_date: Option<chrono::NaiveDate>) -> bool {
    use chrono::{Datelike, Utc};
    let today = Utc::now().date_naive();
    let Some(last) = last_task_date else { return true };
    match frequency {
        "daily"   => last < today,
        "weekly"  => (today - last).num_days() >= 7,
        "monthly" => {
            let first = chrono::NaiveDate::from_ymd_opt(today.year(), today.month(), 1).unwrap_or(today);
            last < first
        }
        "yearly" => {
            let first = chrono::NaiveDate::from_ymd_opt(today.year(), 1, 1).unwrap_or(today);
            last < first
        }
        cron_expr => {
            use std::str::FromStr;
            let full = format!("0 {} *", cron_expr);
            match cron::Schedule::from_str(&full) {
                Ok(schedule) => {
                    let last_dt = last.and_time(chrono::NaiveTime::MIN).and_utc();
                    schedule.after(&last_dt).next().map(|n| n <= Utc::now()).unwrap_or(false)
                }
                Err(_) => false,
            }
        }
    }
}

impl McpServer {
    async fn new() -> Result<Self> {
        // PostgreSQL connection
        let database_url = std::env::var("DATABASE_URL")
            .unwrap_or_else(|_| "postgres://openmemory:openmemory@localhost:5432/openmemory".to_string());

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

        sqlx::query(
            "CREATE INDEX IF NOT EXISTS idx_project_graphs_path ON project_graphs(path)",
        )
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
            .execute(&db).await.ok();
        sqlx::query("ALTER TABLE project_graphs ALTER COLUMN canonical_path DROP NOT NULL")
            .execute(&db).await.ok();

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

        sqlx::query("CREATE INDEX IF NOT EXISTS idx_project_tasks_project_id ON project_tasks(project_id)")
            .execute(&db).await.ok();

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
        let opensearch_url = std::env::var("OPENSEARCH_URL")
            .unwrap_or_else(|_| "http://localhost:9201".to_string());

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

        Ok(Self { db, opensearch, falkordb, encryption_key })
    }

    async fn handle_request(&mut self, req: JsonRpcRequest) -> JsonRpcResponse {
        let result = match req.method.as_str() {
            "initialize" => self.handle_initialize().await,
            "tools/list" => self.handle_tools_list().await,
            "tools/call" => self.handle_tools_call(req.params).await,
            _ => Err(anyhow::anyhow!("method not found: {}", req.method)),
        };

        match result {
            Ok(value) => JsonRpcResponse {
                jsonrpc: "2.0".to_string(),
                id: req.id,
                result: Some(value),
                error: None,
            },
            Err(e) => JsonRpcResponse {
                jsonrpc: "2.0".to_string(),
                id: req.id,
                result: None,
                error: Some(JsonRpcError {
                    code: -32603,
                    message: e.to_string(),
                }),
            },
        }
    }

    async fn handle_initialize(&self) -> Result<serde_json::Value> {
        Ok(json!({
            "protocolVersion": "2024-11-05",
            "capabilities": {
                "tools": {}
            },
            "serverInfo": {
                "name": "openmemory",
                "version": "0.1.0"
            }
        }))
    }

    async fn handle_tools_list(&self) -> Result<serde_json::Value> {
        Ok(json!({
            "tools": [
                {
                    "name": "memory_save",
                    "description": "Save important information to memory for later recall",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "content": {
                                "type": "string",
                                "description": "The content to remember"
                            },
                            "summary": {
                                "type": "string",
                                "description": "Optional short summary"
                            },
                            "importance": {
                                "type": "number",
                                "description": "Importance score 0.0-1.0 (default 0.5)"
                            },
                            "tags": {
                                "type": "array",
                                "items": {"type": "string"},
                                "description": "Optional tags for categorization"
                            }
                        },
                        "required": ["content"]
                    }
                },
                {
                    "name": "memory_search",
                    "description": "Search memories by keywords and return most relevant results",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "query": {
                                "type": "string",
                                "description": "Search query (keywords)"
                            },
                            "limit": {
                                "type": "number",
                                "description": "Max results to return (default 5)"
                            }
                        },
                        "required": ["query"]
                    }
                },
                {
                    "name": "memory_graph_neighbors",
                    "description": "Find memories related to a given memory via graph traversal (1-2 hops through shared tags or explicit links)",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "id": {
                                "type": "string",
                                "format": "uuid",
                                "description": "UUID of the source memory"
                            },
                            "hops": {
                                "type": "integer",
                                "minimum": 1,
                                "maximum": 2,
                                "description": "Traversal depth: 1 = direct neighbors, 2 = neighbors of neighbors (default 1)"
                            },
                            "limit": {
                                "type": "integer",
                                "minimum": 1,
                                "maximum": 50,
                                "description": "Max neighbors to return (default 10)"
                            },
                            "user_id": {
                                "type": "string",
                                "description": "Optional user ID — restricts traversal to the caller's own memories"
                            }
                        },
                        "required": ["id"]
                    }
                },
                {
                    "name": "memory_graph_relate",
                    "description": "Explicitly link two memories with a named relationship type",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "from_id": {
                                "type": "string",
                                "format": "uuid",
                                "description": "UUID of the source memory"
                            },
                            "to_id": {
                                "type": "string",
                                "format": "uuid",
                                "description": "UUID of the target memory"
                            },
                            "relationship": {
                                "type": "string",
                                "description": "Named relationship type (e.g. 'causes', 'contradicts', 'extends')"
                            },
                            "user_id": {
                                "type": "string",
                                "description": "Optional user ID — both memories must belong to this user"
                            }
                        },
                        "required": ["from_id", "to_id", "relationship"]
                    }
                },
                {
                    "name": "graph_add_episode",
                    "description": "Add an immutable source episode to the knowledge graph (ground truth record)",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string", "description": "Episode name"},
                            "source": {"type": "string", "description": "message | json | text | event"},
                            "source_description": {"type": "string", "description": "Description of the data source"},
                            "content": {"type": "string", "description": "Raw episode content"},
                            "group_id": {"type": "string", "description": "Namespace (default: 'default')"},
                            "valid_at": {"type": "string", "description": "ISO8601 UTC timestamp when this became true"}
                        },
                        "required": ["name", "source", "source_description", "content"]
                    }
                },
                {
                    "name": "graph_add_entity",
                    "description": "Upsert a real-world entity into the knowledge graph (deduped on name+type+group_id)",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string"},
                            "entity_type": {"type": "string", "description": "e.g. Person, Place, Organization, Concept"},
                            "group_id": {"type": "string"},
                            "summary": {"type": "string"},
                            "episode_id": {"type": "string", "description": "UUID of source episode for provenance"}
                        },
                        "required": ["name", "entity_type"]
                    }
                },
                {
                    "name": "graph_add_fact",
                    "description": "Create a temporal fact (relationship) between two entities",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "subject": {"type": "string", "description": "Subject entity name"},
                            "subject_type": {"type": "string"},
                            "object": {"type": "string", "description": "Object entity name"},
                            "object_type": {"type": "string"},
                            "name": {"type": "string", "description": "Relationship name e.g. manages, lives_in, owns"},
                            "fact": {"type": "string", "description": "Human-readable fact statement"},
                            "group_id": {"type": "string"},
                            "episode_id": {"type": "string"},
                            "valid_at": {"type": "string", "description": "ISO8601 UTC timestamp"},
                            "invalidate_previous": {"type": "boolean", "description": "If true, expire prior facts with same name between these entities"}
                        },
                        "required": ["subject", "subject_type", "object", "object_type", "name", "fact"]
                    }
                },
                {
                    "name": "graph_query_facts",
                    "description": "Search facts by keyword across entity names, relationship names, and fact text",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "query": {"type": "string"},
                            "group_id": {"type": "string"},
                            "limit": {"type": "number"},
                            "valid_only": {"type": "boolean", "description": "If true, only return currently valid facts"}
                        },
                        "required": ["query"]
                    }
                },
                {
                    "name": "graph_query_at",
                    "description": "Retrieve all facts that were valid at a specific point in time",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "timestamp": {"type": "string", "description": "ISO8601 UTC timestamp to query at"},
                            "entity_name": {"type": "string", "description": "Filter by entity name"},
                            "group_id": {"type": "string"},
                            "limit": {"type": "number"}
                        },
                        "required": ["timestamp"]
                    }
                },
                {
                    "name": "graph_get_entity_history",
                    "description": "Get the full history of facts (current and historical) involving an entity",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "entity_name": {"type": "string"},
                            "group_id": {"type": "string"},
                            "limit": {"type": "number"}
                        },
                        "required": ["entity_name"]
                    }
                },
                {
                    "name": "graph_get_entity",
                    "description": "Look up a single entity by name, optionally filtered by type and group",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "entity_name": {"type": "string"},
                            "entity_type": {"type": "string"},
                            "group_id": {"type": "string"}
                        },
                        "required": ["entity_name"]
                    }
                },
                {
                    "name": "env_set",
                    "description": "Store an environment parameter or secret. Use is_secret=true for sensitive values like API keys — secret values cannot be read back by agents, only by the web UI.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "key": {
                                "type": "string",
                                "description": "Parameter name (e.g. OPENAI_API_KEY)"
                            },
                            "value": {
                                "type": "string",
                                "description": "Parameter value (stored encrypted)"
                            },
                            "is_secret": {
                                "type": "boolean",
                                "description": "If true, agents cannot read the value back (default false)"
                            },
                            "description": {
                                "type": "string",
                                "description": "Optional human-readable description"
                            }
                        },
                        "required": ["key", "value"]
                    }
                },
                {
                    "name": "env_get",
                    "description": "Get the value of a normal (non-secret) environment parameter. Returns an error for secret parameters — use env_list to check if a key exists.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "key": {
                                "type": "string",
                                "description": "Parameter name to retrieve"
                            }
                        },
                        "required": ["key"]
                    }
                },
                {
                    "name": "env_rename",
                    "description": "Rename an environment parameter while preserving its encrypted value and metadata. Optional fields can replace them in the same transaction; resource links that reference the old key are updated.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "old_key": {
                                "type": "string",
                                "description": "Current parameter name"
                            },
                            "new_key": {
                                "type": "string",
                                "description": "New parameter name"
                            },
                            "value": {
                                "type": "string",
                                "description": "Optional replacement value; omit to preserve the current value"
                            },
                            "is_secret": {
                                "type": "boolean",
                                "description": "Optional replacement for the secret flag"
                            },
                            "description": {
                                "type": ["string", "null"],
                                "description": "Optional replacement description; null clears it"
                            }
                        },
                        "required": ["old_key", "new_key"]
                    }
                },
                {
                    "name": "env_list",
                    "description": "List all environment parameters. Returns key names, descriptions, and is_secret flag — never returns values.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {}
                    }
                },
                {
                    "name": "env_delete",
                    "description": "Delete an environment parameter by key name.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "key": {
                                "type": "string",
                                "description": "Parameter name to delete"
                            }
                        },
                        "required": ["key"]
                    }
                },
                {
                    "name": "resource_list",
                    "description": "List materials/resources the user has registered: local paths and website URLs. Merges manual catalog entries with env-declared roots (RESOURCE_PATH.<slug>, RESOURCE_URL.<slug>). Use at session start when tasks involve files, datasets, docs, or external sites. A resource's env_param_keys can bundle several credential/config fields for one account (e.g. api_key + team_id + token) — use env_http_request / env_get with those key names, never invent paths.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "kind": {
                                "type": "string",
                                "description": "Filter: path | url",
                                "enum": ["path", "url"]
                            },
                            "tags": {
                                "type": "array",
                                "items": {"type": "string"},
                                "description": "Filter by tags (manual resources only) — matches resources with ANY of the given tags. Use resource_tags to see the current tag vocabulary."
                            },
                            "query": {
                                "type": "string",
                                "description": "Substring match on name, location, description, tags"
                            }
                        }
                    }
                },
                {
                    "name": "resource_tags",
                    "description": "List the distinct tags currently used across manual resources, with usage counts (most-used first). Call this before filtering resource_list by tags to see what's available.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {}
                    }
                },
                {
                    "name": "resource_get",
                    "description": "Get one resource by UUID (manual) or by name / env slug.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "id_or_name": {
                                "type": "string",
                                "description": "Resource UUID, name, or env slug"
                            }
                        },
                        "required": ["id_or_name"]
                    }
                },
                {
                    "name": "resource_add",
                    "description": "Register a local path or website URL in the resource catalog so future agents can discover it. Optionally link env_param_keys — a list of existing env_params to bundle as one account's credentials/config (e.g. api_key + team_id + token). For env-only declaration without a catalog row, use env_set with key RESOURCE_PATH.<slug> or RESOURCE_URL.<slug> (normal, not secret).",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string", "description": "Short unique label"},
                            "kind": {"type": "string", "enum": ["path", "url"]},
                            "location": {"type": "string", "description": "Absolute filesystem path or URL"},
                            "description": {"type": "string"},
                            "tags": {"type": "array", "items": {"type": "string"}},
                            "env_param_keys": {"type": "array", "items": {"type": "string"}, "description": "Existing env_params keys to bundle as this resource's credentials/config"}
                        },
                        "required": ["name", "kind", "location"]
                    }
                },
                {
                    "name": "resource_update",
                    "description": "Update a manual resource by UUID. Env-sourced resources must be changed via env_set / env_delete on RESOURCE_* keys.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "id": {"type": "string", "description": "Resource UUID"},
                            "name": {"type": "string"},
                            "kind": {"type": "string", "enum": ["path", "url"]},
                            "location": {"type": "string"},
                            "description": {"type": "string"},
                            "tags": {"type": "array", "items": {"type": "string"}},
                            "env_param_keys": {"type": "array", "items": {"type": "string"}, "description": "Replaces the full set of linked credential/config keys. Pass [] to clear all."},
                            "clear_description": {"type": "boolean", "description": "If true, clear description"}
                        },
                        "required": ["id"]
                    }
                },
                {
                    "name": "resource_delete",
                    "description": "Delete a manual resource by UUID. For env-sourced resources, delete the RESOURCE_PATH.* / RESOURCE_URL.* env key instead.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "id": {"type": "string", "description": "Resource UUID"}
                        },
                        "required": ["id"]
                    }
                },
                {
                    "name": "env_http_request",
                    "description": "Make an HTTP request with a stored secret injected as the auth header (default) or as the full request URL itself. The secret value is never exposed to the agent — the server resolves it internally and forwards the request. Use auth-header mode for API keys/tokens (Cloudflare, GitHub, etc.). Use secret_target='url' for self-authenticating URLs like incoming webhooks (e.g. AWS Amplify build webhooks), where the URL itself is the credential — in that mode omit 'url' entirely. If OPENMEMORY_HTTP_ALLOWED_HOSTS is configured on the server, requests to hosts outside that allowlist are rejected before the secret is resolved.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "method": {
                                "type": "string",
                                "description": "HTTP method: GET, POST, PUT, PATCH, DELETE",
                                "enum": ["GET", "POST", "PUT", "PATCH", "DELETE"]
                            },
                            "url": {
                                "type": "string",
                                "description": "Full URL to request. Required unless secret_target='url' (in which case the secret itself is the URL and this is ignored)."
                            },
                            "auth_key": {
                                "type": "string",
                                "description": "Name of the secret env param whose value will be used as the auth credential (e.g. CLAUDEFLARE_API_TOKEN_ACCESS), or as the full URL when secret_target='url'"
                            },
                            "secret_target": {
                                "type": "string",
                                "description": "Where the secret goes: 'header' (default) puts it in an auth header alongside the 'url' arg; 'url' means the secret itself IS the full request URL (no auth header sent) — for self-authenticating URLs like incoming webhooks; 'query' appends the secret as a URL query parameter (name from secret_query_param, default 'key') — for APIs that require the key in the query string, like Pixabay.",
                                "enum": ["header", "url", "query"]
                            },
                            "auth_header": {
                                "type": "string",
                                "description": "Header name for the credential. Defaults to 'Authorization'. Ignored when secret_target='url'."
                            },
                            "auth_prefix": {
                                "type": "string",
                                "description": "Prefix for the header value. Defaults to 'Bearer '. Set to '' for bare token headers like X-Auth-Key. Ignored when secret_target='url'."
                            },
                            "secret_query_param": {
                                "type": "string",
                                "description": "Query parameter name for the secret when secret_target='query'. Defaults to 'key'."
                            },
                            "body": {
                                "type": "object",
                                "description": "Optional JSON request body (for POST/PUT/PATCH)"
                            },
                            "headers": {
                                "type": "object",
                                "description": "Optional additional headers as key-value pairs"
                            }
                        },
                        "required": ["method", "auth_key"]
                    }
                },
                {
                    "name": "env_http_download",
                    "description": "Like env_http_request, but for binary responses (video, images, archives, any non-text payload): the server streams the response bytes straight to a file on local disk instead of returning them as a JSON/text string. Use this whenever the response isn't text/JSON — env_http_request reads the body as UTF-8 text and silently corrupts binary data (invalid byte sequences get replaced with U+FFFD), so it must never be used for downloads. Only metadata (path, size, content-type, status) is returned to the agent — never the bytes. save_path must be an absolute path; parent directories are created if missing and an existing file at that path is overwritten.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "method": {
                                "type": "string",
                                "description": "HTTP method: GET, POST, PUT, PATCH, DELETE",
                                "enum": ["GET", "POST", "PUT", "PATCH", "DELETE"]
                            },
                            "url": {
                                "type": "string",
                                "description": "Full URL to request. Required unless secret_target='url' (in which case the secret itself is the URL and this is ignored)."
                            },
                            "auth_key": {
                                "type": "string",
                                "description": "Name of the secret env param whose value will be used as the auth credential, or as the full URL when secret_target='url'"
                            },
                            "secret_target": {
                                "type": "string",
                                "description": "Where the secret goes: 'header' (default) puts it in an auth header alongside the 'url' arg; 'url' means the secret itself IS the full request URL (no auth header sent); 'query' appends the secret as a URL query parameter (name from secret_query_param, default 'key') — for APIs that require the key in the query string, like Pixabay.",
                                "enum": ["header", "url", "query"]
                            },
                            "auth_header": {
                                "type": "string",
                                "description": "Header name for the credential. Defaults to 'Authorization'. Ignored when secret_target='url'."
                            },
                            "auth_prefix": {
                                "type": "string",
                                "description": "Prefix for the header value. Defaults to 'Bearer '. Set to '' for bare token headers like X-Auth-Key. Ignored when secret_target='url'."
                            },
                            "secret_query_param": {
                                "type": "string",
                                "description": "Query parameter name for the secret when secret_target='query'. Defaults to 'key'."
                            },
                            "headers": {
                                "type": "object",
                                "description": "Optional additional headers as key-value pairs"
                            },
                            "save_path": {
                                "type": "string",
                                "description": "Absolute local filesystem path to write the downloaded bytes to. Parent directories are created if needed; an existing file is overwritten."
                            }
                        },
                        "required": ["method", "auth_key", "save_path"]
                    }
                },
                {
                    "name": "env_sign_jwt",
                    "description": "Sign a JWT using a stored secret as the signing key and return the token. The raw key value is never exposed to the agent, but the returned token IS a live, usable bearer credential for its ttl_seconds lifetime — prefer env_http_request_jwt when you just need to call an API, since that keeps the token server-side too and never returns it. exp/iat are added automatically from ttl_seconds — do not pass them in claims.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "key": {
                                "type": "string",
                                "description": "Name of the secret env param holding the signing key (PEM for ES256/RS256, raw string for HS256)"
                            },
                            "algorithm": {
                                "type": "string",
                                "description": "JWT signing algorithm",
                                "enum": ["ES256", "RS256", "HS256"]
                            },
                            "header_extra": {
                                "type": "object",
                                "description": "Extra JWT header fields, e.g. {\"kid\": \"...\"}"
                            },
                            "claims": {
                                "type": "object",
                                "description": "JWT claims, e.g. {\"iss\": \"...\", \"aud\": \"appstoreconnect-v1\"}. iat/exp are added automatically."
                            },
                            "ttl_seconds": {
                                "type": "integer",
                                "description": "Token lifetime in seconds. Default 1200, capped at 1200."
                            },
                            "key_from_file": {
                                "type": "boolean",
                                "description": "Set true if 'key' was stored via env_set_file (base64-encoded) — decodes back to raw bytes before signing. Default false (for keys stored via env_set as plain text)."
                            }
                        },
                        "required": ["key", "algorithm", "claims"]
                    }
                },
                {
                    "name": "env_http_request_jwt",
                    "description": "Make an HTTP request authenticated with a freshly-signed JWT, all server-side — the signing key and the resulting token both stay on the server; only the API response is returned to the agent. Use this instead of env_sign_jwt + a separate request whenever you're just calling an API (e.g. App Store Connect: algorithm=ES256, header_extra={\"kid\":...}, claims={\"iss\":...,\"aud\":\"appstoreconnect-v1\"}). exp/iat are added automatically from ttl_seconds — do not pass them in claims.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "method": {
                                "type": "string",
                                "description": "HTTP method: GET, POST, PUT, PATCH, DELETE",
                                "enum": ["GET", "POST", "PUT", "PATCH", "DELETE"]
                            },
                            "url": {
                                "type": "string",
                                "description": "Full URL to request"
                            },
                            "key": {
                                "type": "string",
                                "description": "Name of the secret env param holding the signing key (PEM for ES256/RS256, raw string for HS256)"
                            },
                            "algorithm": {
                                "type": "string",
                                "description": "JWT signing algorithm",
                                "enum": ["ES256", "RS256", "HS256"]
                            },
                            "header_extra": {
                                "type": "object",
                                "description": "Extra JWT header fields, e.g. {\"kid\": \"...\"}"
                            },
                            "claims": {
                                "type": "object",
                                "description": "JWT claims, e.g. {\"iss\": \"...\", \"aud\": \"appstoreconnect-v1\"}. iat/exp are added automatically."
                            },
                            "ttl_seconds": {
                                "type": "integer",
                                "description": "Token lifetime in seconds. Default 1200, capped at 1200."
                            },
                            "body": {
                                "type": "object",
                                "description": "Optional JSON request body (for POST/PUT/PATCH)"
                            },
                            "headers": {
                                "type": "object",
                                "description": "Optional additional headers as key-value pairs"
                            },
                            "key_from_file": {
                                "type": "boolean",
                                "description": "Set true if 'key' was stored via env_set_file (base64-encoded) — decodes back to raw bytes before signing. Default false (for keys stored via env_set as plain text)."
                            }
                        },
                        "required": ["method", "url", "key", "algorithm", "claims"]
                    }
                },
                {
                    "name": "env_set_file",
                    "description": "Store a local file's contents as an env secret. The server reads the file from disk and encrypts it directly — the agent never has to pass the file's bytes as a tool argument, so raw file content never appears in the agent's own tool calls or transcript. Use this for uploading credential files (service account JSON, .p8/.p12 keys, certs) instead of env_set. Always stored as a secret (unreadable by agents) and base64-encoded internally, so both text and binary files work. Use env_http_request / env_http_request_jwt / env_sign_jwt afterward to use the stored file safely.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "key": {
                                "type": "string",
                                "description": "Parameter name to store the file under"
                            },
                            "file_path": {
                                "type": "string",
                                "description": "Absolute path to the file on disk (server reads it directly)"
                            },
                            "description": {
                                "type": "string",
                                "description": "Optional human-readable description"
                            }
                        },
                        "required": ["key", "file_path"]
                    }
                },
                {
                    "name": "env_google_service_account_request",
                    "description": "Call a Google Cloud / Google API authenticated as a service account, entirely server-side. Reads a GCP service account JSON secret (as stored by env_set_file), extracts client_email/private_key/token_uri from it, signs the RS256 JWT assertion, exchanges it for an OAuth2 access token at Google's token endpoint, then makes the actual API request with that token — none of the private key, JWT assertion, or access token ever reach the agent. Only the final API response is returned.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "key": {
                                "type": "string",
                                "description": "Name of the secret env param holding the full GCP service account JSON (base64, as stored by env_set_file)"
                            },
                            "scopes": {
                                "type": "array",
                                "items": {"type": "string"},
                                "description": "OAuth2 scopes to request, e.g. [\"https://www.googleapis.com/auth/cloud-platform\"]"
                            },
                            "method": {
                                "type": "string",
                                "description": "HTTP method for the target API request",
                                "enum": ["GET", "POST", "PUT", "PATCH", "DELETE"]
                            },
                            "url": {
                                "type": "string",
                                "description": "Full URL of the target Google API request"
                            },
                            "body": {
                                "type": "object",
                                "description": "Optional JSON request body (for POST/PUT/PATCH)"
                            },
                            "headers": {
                                "type": "object",
                                "description": "Optional additional headers as key-value pairs"
                            }
                        },
                        "required": ["key", "scopes", "method", "url"]
                    }
                },
                {
                    "name": "project_graph_list",
                    "description": "List all registered project knowledge graphs. Start here to find project_id, name, path, and node/edge counts. Use name or path to find the right project.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {}
                    }
                },
                {
                    "name": "project_graph_create",
                    "description": "Register a local folder as a project. The folder is indexed automatically (tree-sitter parsing of Rust/TypeScript/JavaScript/Python source, plus file nodes for other recognized file types) — no external tool needed.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string", "description": "Display name for this project"},
                            "path": {"type": "string", "description": "Absolute path to the project folder"},
                            "description": {"type": "string", "description": "Optional description"}
                        },
                        "required": ["name", "path"]
                    }
                },
                {
                    "name": "project_graph_query",
                    "description": "Search a project knowledge graph by keyword using IDF-weighted BFS. Returns nodes 2 hops out from matches. Best for 'how does X connect to Y?' questions. Use project_id OR name/path to identify the project.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "project_id": {"type": "string", "description": "UUID of the project (from project_graph_list)"},
                            "name": {"type": "string", "description": "Project name (alternative to project_id)"},
                            "path": {"type": "string", "description": "Project path (alternative to project_id)"},
                            "q": {"type": "string", "description": "Keyword to search for in node labels (case-insensitive)"},
                            "hops": {"type": "integer", "description": "BFS depth from matching nodes (default: 2, max: 4)"},
                            "limit": {"type": "integer", "description": "Max nodes to return (default: 50, max: 200)"}
                        },
                        "required": ["q"]
                    }
                },
                {
                    "name": "project_graph_node_detail",
                    "description": "Get full details for a specific node including all direct edges (in and out). Use after project_graph_query to drill into a specific node.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "project_id": {"type": "string"},
                            "name": {"type": "string", "description": "Project name (alternative to project_id)"},
                            "path": {"type": "string", "description": "Project path (alternative to project_id)"},
                            "node_id": {"type": "string", "description": "The node id (from graph query results)"}
                        },
                        "required": ["node_id"]
                    }
                },
                {
                    "name": "project_graph_shortest_path",
                    "description": "Find the shortest path between two nodes in a project knowledge graph.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "project_id": {"type": "string"},
                            "name": {"type": "string"},
                            "path": {"type": "string"},
                            "from_node": {"type": "string", "description": "Starting node id"},
                            "to_node": {"type": "string", "description": "Ending node id"}
                        },
                        "required": ["from_node", "to_node"]
                    }
                },
                {
                    "name": "project_graph_god_nodes",
                    "description": "Find the most-connected nodes (hubs) in the project graph. Good starting points for orientation.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "project_id": {"type": "string"},
                            "name": {"type": "string"},
                            "path": {"type": "string"},
                            "top_n": {"type": "integer", "description": "How many top nodes to return (default: 10)"}
                        }
                    }
                },
                {
                    "name": "project_graph_delete",
                    "description": "Delete a registered project graph from the database. Original files on disk are not affected.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "project_id": {"type": "string", "description": "UUID of the project to delete"},
                            "name": {"type": "string", "description": "Project name (alternative to project_id)"}
                        }
                    }
                },
                {
                    "name": "project_graph_rebuild",
                    "description": "Re-index a project's folder from disk (tree-sitter parsing of source files). Run after the codebase changes. Skips if the resulting graph is unchanged.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "project_id": {"type": "string"},
                            "name": {"type": "string"},
                            "path": {"type": "string"}
                        }
                    }
                },
                {
                    "name": "workflow_list",
                    "description": "List reusable deterministic workflows configured in OpenMemory. Use this to discover fixed processes before manually reproducing a recurring integration sequence.",
                    "inputSchema": {"type": "object", "properties": {}}
                },
                {
                    "name": "workflow_get",
                    "description": "Get a workflow definition and its expected input schema by UUID or name.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {"id_or_name": {"type": "string"}},
                        "required": ["id_or_name"]
                    }
                },
                {
                    "name": "workflow_run",
                    "description": "Start a configured workflow. HTTP nodes execute server-side. For an agent node, perform the returned action_required exactly, then call workflow_continue with its result. Repeat until status is completed.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "id_or_name": {"type": "string", "description": "Workflow UUID or unique name"},
                            "input": {"type": "object", "description": "Inputs described by workflow_get.input_schema"}
                        },
                        "required": ["id_or_name"]
                    }
                },
                {
                    "name": "workflow_continue",
                    "description": "Resume a workflow paused on an agent action. Pass the run_id returned by workflow_run or the prior workflow_continue call and the completed action's structured result.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "run_id": {"type": "string", "description": "Workflow run UUID"},
                            "result": {"description": "Structured result matching action_required.expected_output"}
                        },
                        "required": ["run_id", "result"]
                    }
                },
                {
                    "name": "forecast_list",
                    "description": "List reusable usage forecast profiles. Reference these before planning or designing a project so user scale, budget, risk tolerance, growth, and usage shape inform decisions.",
                    "inputSchema": {"type": "object", "properties": {}}
                },
                {
                    "name": "forecast_create",
                    "description": "Create a reusable usage forecast profile for future project planning and design.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string"},
                            "description": {"type": "string"},
                            "application_type": {"type": "string", "enum": ["web_saas", "mobile", "ai", "data", "internal", "ecommerce", "other"]},
                            "user_count": {"type": "integer", "minimum": 1},
                            "monthly_budget_usd": {"type": "integer", "minimum": 0},
                            "stress_tolerance": {"type": "string", "enum": ["conservative", "balanced", "aggressive"], "description": "Conservative favors more headroom; aggressive favors lower cost and accepts operational pressure."},
                            "usage_pattern": {"type": "string", "enum": ["steady", "bursty", "seasonal"]},
                            "engagement_percent": {"type": "integer", "minimum": 1, "maximum": 100, "description": "Stickiness: % of monthly active users active on a typical day (e.g. 15 of 30 days = 50)."},
                            "planning_horizon_months": {"type": "integer", "minimum": 1, "maximum": 120},
                            "annual_growth_percent": {"type": "integer", "minimum": 0, "maximum": 1000},
                            "notes": {"type": "string"}
                        },
                        "required": ["name", "application_type", "user_count", "monthly_budget_usd", "stress_tolerance", "usage_pattern", "engagement_percent", "planning_horizon_months", "annual_growth_percent"]
                    }
                },
                {
                    "name": "forecast_update",
                    "description": "Update a forecast profile as assumptions change. Pass the complete profile fields.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "id": {"type": "string"},
                            "name": {"type": "string"}, "description": {"type": "string"},
                            "application_type": {"type": "string", "enum": ["web_saas", "mobile", "ai", "data", "internal", "ecommerce", "other"]},
                            "user_count": {"type": "integer"}, "monthly_budget_usd": {"type": "integer"},
                            "stress_tolerance": {"type": "string", "enum": ["conservative", "balanced", "aggressive"]},
                            "usage_pattern": {"type": "string", "enum": ["steady", "bursty", "seasonal"]},
                            "engagement_percent": {"type": "integer", "minimum": 1, "maximum": 100, "description": "Stickiness: % of monthly active users active on a typical day (e.g. 15 of 30 days = 50)."},
                            "planning_horizon_months": {"type": "integer"}, "annual_growth_percent": {"type": "integer"},
                            "notes": {"type": "string"}
                        },
                        "required": ["id", "name", "application_type", "user_count", "monthly_budget_usd", "stress_tolerance", "usage_pattern", "engagement_percent", "planning_horizon_months", "annual_growth_percent"]
                    }
                },
                {
                    "name": "forecast_delete",
                    "description": "Delete a reusable forecast profile permanently.",
                    "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]}
                },
                {
                    "name": "design_budget_list",
                    "description": "List saved monthly budget forecasts for a design, including AWS service line items and the usage profile or custom conditions used.",
                    "inputSchema": {"type": "object", "properties": {"design_id": {"type": "string"}}, "required": ["design_id"]}
                },
                {
                    "name": "design_budget_create",
                    "description": "Add a monthly budget forecast to a design. Use forecast_profile_id to base it on a saved Settings > Forecasts profile, conditions for custom assumptions, or both. monthly_total is derived from line_items.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "design_id": {"type": "string"}, "name": {"type": "string"},
                            "forecast_profile_id": {"type": "string"}, "conditions": {"type": "string"},
                            "currency": {"type": "string", "default": "USD"},
                            "line_items": {"type": "array", "items": {"type": "object", "properties": {
                                "service": {"type": "string"}, "usage": {"type": "string"},
                                "monthly_cost_cents": {"type": "integer", "minimum": 0}, "notes": {"type": "string"}
                            }, "required": ["service", "usage", "monthly_cost_cents"]}},
                            "confidence": {"type": "string", "enum": ["low", "medium", "high"]},
                            "pricing_basis": {"type": "string"}
                        },
                        "required": ["design_id", "name", "line_items"]
                    }
                },
                {
                    "name": "design_budget_update",
                    "description": "Replace a design budget forecast's assumptions and line items. monthly_total is recalculated from line_items.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "design_id": {"type": "string"}, "budget_id": {"type": "string"}, "name": {"type": "string"},
                            "forecast_profile_id": {"type": "string"}, "conditions": {"type": "string"}, "currency": {"type": "string"},
                            "line_items": {"type": "array", "items": {"type": "object", "properties": {
                                "service": {"type": "string"}, "usage": {"type": "string"},
                                "monthly_cost_cents": {"type": "integer", "minimum": 0}, "notes": {"type": "string"}
                            }, "required": ["service", "usage", "monthly_cost_cents"]}},
                            "confidence": {"type": "string", "enum": ["low", "medium", "high"]}, "pricing_basis": {"type": "string"}
                        },
                        "required": ["design_id", "budget_id", "name", "line_items"]
                    }
                },
                {
                    "name": "design_budget_delete",
                    "description": "Delete a saved design budget forecast permanently.",
                    "inputSchema": {"type": "object", "properties": {"design_id": {"type": "string"}, "budget_id": {"type": "string"}}, "required": ["design_id", "budget_id"]}
                },
                {
                    "name": "project_list",
                    "description": "List all projects with their task counts. Use this to find project_id for task operations.",
                    "inputSchema": {"type": "object", "properties": {}}
                },
                {
                    "name": "project_create",
                    "description": "Create a new project. Folder path is optional — omit it for a pure task-management project with no knowledge graph.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string", "description": "Display name for the project"},
                            "path": {"type": "string", "description": "Optional: absolute path to a folder to index for a knowledge graph"},
                            "description": {"type": "string", "description": "Optional description"}
                        },
                        "required": ["name"]
                    }
                },
                {
                    "name": "project_task_list",
                    "description": "List tasks for a project. Optionally filter by status (todo, in_progress, done, cancelled, scheduled).",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "project_id": {"type": "string", "description": "UUID of the project"},
                            "status": {"type": "string", "description": "Filter by status: todo | in_progress | done | cancelled | scheduled"},
                            "limit": {"type": "integer", "description": "Max results (default 50)"},
                            "offset": {"type": "integer", "description": "Pagination offset (default 0)"}
                        },
                        "required": ["project_id"]
                    }
                },
                {
                    "name": "project_task_create",
                    "description": "Create a task in a project. Can be used by AI agents to add work items.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "project_id": {"type": "string", "description": "UUID of the project"},
                            "title": {"type": "string", "description": "Task title"},
                            "description": {"type": "string", "description": "Optional detailed description"},
                            "status": {"type": "string", "description": "todo | in_progress | done | cancelled (default: todo)"},
                            "priority": {"type": "string", "description": "low | medium | high (default: medium)"},
                            "assigned_to": {"type": "string", "description": "human | agent | null"},
                            "parent_id": {"type": "string", "description": "Optional UUID of a parent task, to create this as a subtask"},
                            "start_date": {"type": "string", "description": "Optional start date, YYYY-MM-DD"},
                            "due_date": {"type": "string", "description": "Optional due date, YYYY-MM-DD"}
                        },
                        "required": ["project_id", "title"]
                    }
                },
                {
                    "name": "project_task_update",
                    "description": "Update a task's title, description, status, priority, assigned_to, parent, or dates. Only provided fields are changed; pass null for parent_id/start_date/due_date to clear them. Use status 'cancelled' (not 'done') for tasks that are being dropped/superseded rather than completed.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "project_id": {"type": "string"},
                            "task_id": {"type": "string"},
                            "title": {"type": "string"},
                            "description": {"type": "string"},
                            "status": {"type": "string", "description": "todo | in_progress | done | cancelled"},
                            "priority": {"type": "string", "description": "low | medium | high"},
                            "assigned_to": {"type": "string", "description": "human | agent | null"},
                            "parent_id": {"type": ["string", "null"], "description": "UUID of a parent task, or null to detach this task from its parent"},
                            "start_date": {"type": ["string", "null"], "description": "Start date YYYY-MM-DD, or null to clear"},
                            "due_date": {"type": ["string", "null"], "description": "Due date YYYY-MM-DD, or null to clear"}
                        },
                        "required": ["project_id", "task_id"]
                    }
                },
                {
                    "name": "project_task_delete",
                    "description": "Delete a task permanently.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "project_id": {"type": "string"},
                            "task_id": {"type": "string"}
                        },
                        "required": ["project_id", "task_id"]
                    }
                },
                {
                    "name": "lesson_create",
                    "description": "Record a lesson learned in a project's lessons store. If an active lesson with the same title already exists in this project, its occurrence count is bumped instead of creating a duplicate.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "project_id": {"type": "string", "description": "UUID of the project"},
                            "title": {"type": "string", "description": "Short lesson title"},
                            "rule": {"type": "string", "description": "The rule to follow going forward"},
                            "context": {"type": "string", "description": "What happened that produced this lesson"},
                            "category": {"type": "string", "description": "correction | discovery | convention | pitfall (default: correction)"},
                            "severity": {"type": "string", "description": "low | medium | high (default: medium)"},
                            "tags": {"type": "array", "items": {"type": "string"}, "description": "Optional free-text tags"}
                        },
                        "required": ["project_id", "title", "rule"]
                    }
                },
                {
                    "name": "lesson_list",
                    "description": "Call this at the start of a session to load the project's accumulated lessons. project_id is optional — omit it to search across all projects. Pass query to full-text search; otherwise lessons are ranked by severity then recency.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "project_id": {"type": "string", "description": "UUID of the project. Omit for a cross-project search."},
                            "query": {"type": "string", "description": "Full-text search across title, context, and rule"},
                            "category": {"type": "string", "description": "Filter by category: correction | discovery | convention | pitfall"},
                            "tags": {"type": "array", "items": {"type": "string"}, "description": "Filter to lessons matching any of these tags"},
                            "status": {"type": "string", "description": "active | archived (default: active)"},
                            "limit": {"type": "integer", "description": "Max results (default 50)"},
                            "offset": {"type": "integer", "description": "Pagination offset (default 0)"}
                        }
                    }
                },
                {
                    "name": "lesson_update",
                    "description": "Update a lesson's title, context, rule, category, severity, status, or tags. Only provided fields are changed; pass null for context to clear it. Set status to 'archived' when a lesson is superseded rather than deleting it.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "project_id": {"type": "string"},
                            "lesson_id": {"type": "string"},
                            "title": {"type": "string"},
                            "context": {"type": ["string", "null"], "description": "New context, or null to clear"},
                            "rule": {"type": "string"},
                            "category": {"type": "string", "description": "correction | discovery | convention | pitfall"},
                            "severity": {"type": "string", "description": "low | medium | high"},
                            "status": {"type": "string", "description": "active | archived"},
                            "tags": {"type": "array", "items": {"type": "string"}}
                        },
                        "required": ["project_id", "lesson_id"]
                    }
                },
                {
                    "name": "lesson_delete",
                    "description": "Delete a lesson permanently.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "project_id": {"type": "string"},
                            "lesson_id": {"type": "string"}
                        },
                        "required": ["project_id", "lesson_id"]
                    }
                },
                {
                    "name": "routine_check",
                    "description": "Check for due routine tasks and create them as new todo items. Call this at the start of a work session to materialise any daily/weekly/monthly tasks that haven't been created yet today. Returns the list of tasks just created. Use dry_run=true to preview without creating.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "project_id": {"type": "string", "description": "Check routines for this project only. Omit to check all projects."},
                            "dry_run": {"type": "boolean", "description": "If true, return due routines without creating tasks (default false)"}
                        }
                    }
                },
                {
                    "name": "routine_list",
                    "description": "List all routines for a project, including their frequency and last-run date.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "project_id": {"type": "string", "description": "UUID of the project"}
                        },
                        "required": ["project_id"]
                    }
                },
                {
                    "name": "routine_create",
                    "description": "Create a new routine task template. The routine will generate a dated task each time routine_check is called and the routine is due.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "project_id": {"type": "string"},
                            "title": {"type": "string", "description": "Base title — today's date is appended when the task is created"},
                            "description": {"type": "string", "description": "Optional task description or instructions for the agent"},
                            "frequency": {"type": "string", "description": "daily | weekly | monthly (default: daily)"},
                            "priority": {"type": "string", "description": "low | medium | high (default: medium)"},
                            "assigned_to": {"type": "string", "description": "human | agent | null"}
                        },
                        "required": ["project_id", "title"]
                    }
                }
            ]
        }))
    }

    async fn handle_tools_call(&mut self, params: Option<serde_json::Value>) -> Result<serde_json::Value> {
        let params = params.context("missing params")?;
        let name = params["name"].as_str().context("missing tool name")?;
        let arguments = &params["arguments"];

        match name {
            "memory_save" => self.memory_save(arguments).await,
            "memory_search" => self.memory_search(arguments).await,
            "memory_graph_all" => self.memory_graph_all(arguments).await,
            "memory_graph_data" => self.memory_graph_data(arguments).await,
            "memory_graph_rebuild" => self.memory_graph_rebuild(arguments).await,
            "memory_graph_neighbors" => self.memory_graph_neighbors(arguments).await,
            "memory_graph_relate" => self.memory_graph_relate(arguments).await,
            "graph_add_episode" => self.graph_add_episode(arguments).await,
            "graph_add_entity" => self.graph_add_entity(arguments).await,
            "graph_add_fact" => self.graph_add_fact(arguments).await,
            "graph_query_facts" => self.graph_query_facts(arguments).await,
            "graph_query_at" => self.graph_query_at(arguments).await,
            "graph_get_entity_history" => self.graph_get_entity_history(arguments).await,
            "graph_get_entity" => self.graph_get_entity(arguments).await,
            "env_set" => self.env_set(arguments).await,
            "env_get" => self.env_get(arguments).await,
            "env_rename" => self.env_rename(arguments).await,
            "env_list" => self.env_list(arguments).await,
            "env_delete" => self.env_delete(arguments).await,
            "resource_list" => self.resource_list(arguments).await,
            "resource_tags" => self.resource_tags(arguments).await,
            "resource_get" => self.resource_get(arguments).await,
            "resource_add" => self.resource_add(arguments).await,
            "resource_update" => self.resource_update(arguments).await,
            "resource_delete" => self.resource_delete(arguments).await,
            "workflow_list" => self.workflow_list(arguments).await,
            "workflow_get" => self.workflow_get(arguments).await,
            "workflow_run" => self.workflow_run(arguments).await,
            "workflow_continue" => self.workflow_continue(arguments).await,
            "env_http_request" => self.env_http_request(arguments).await,
            "env_http_download" => self.env_http_download(arguments).await,
            "env_sign_jwt" => self.env_sign_jwt(arguments).await,
            "env_http_request_jwt" => self.env_http_request_jwt(arguments).await,
            "env_set_file" => self.env_set_file(arguments).await,
            "env_google_service_account_request" => self.env_google_service_account_request(arguments).await,
            "project_graph_list" => self.project_graph_list(arguments).await,
            "project_graph_create" => self.project_graph_create(arguments).await,
            "project_graph_query" => self.project_graph_query(arguments).await,
            "project_graph_node_detail" => self.project_graph_node_detail(arguments).await,
            "project_graph_shortest_path" => self.project_graph_shortest_path(arguments).await,
            "project_graph_god_nodes" => self.project_graph_god_nodes(arguments).await,
            "project_graph_delete" => self.project_graph_delete(arguments).await,
            "project_graph_rebuild" => self.project_graph_rebuild(arguments).await,
            "forecast_list" => self.forecast_list(arguments).await,
            "forecast_create" => self.forecast_create(arguments).await,
            "forecast_update" => self.forecast_update(arguments).await,
            "forecast_delete" => self.forecast_delete(arguments).await,
            "design_budget_list" => self.design_budget_list(arguments).await,
            "design_budget_create" => self.design_budget_create(arguments).await,
            "design_budget_update" => self.design_budget_update(arguments).await,
            "design_budget_delete" => self.design_budget_delete(arguments).await,
            "project_list" => self.project_list(arguments).await,
            "project_create" => self.project_create(arguments).await,
            "project_task_list" => self.project_task_list(arguments).await,
            "project_task_create" => self.project_task_create(arguments).await,
            "project_task_update" => self.project_task_update(arguments).await,
            "project_task_delete" => self.project_task_delete(arguments).await,
            "lesson_create" => self.lesson_create(arguments).await,
            "lesson_list" => self.lesson_list(arguments).await,
            "lesson_update" => self.lesson_update(arguments).await,
            "lesson_delete" => self.lesson_delete(arguments).await,
            "routine_check" => self.routine_check(arguments).await,
            "routine_list" => self.routine_list(arguments).await,
            "routine_create" => self.routine_create(arguments).await,
            _ => Err(anyhow::anyhow!("unknown tool: {}", name)),
        }
    }

    async fn memory_save(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let content = args["content"].as_str().context("missing content")?.to_string();
        let summary = args["summary"].as_str().map(|s| s.to_string());
        let importance = args["importance"].as_f64().unwrap_or(0.5) as f32;
        let importance = importance.clamp(0.0, 1.0);
        let tags: Vec<String> = args["tags"]
            .as_array()
            .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
            .unwrap_or_default();

        let id = Uuid::new_v4();
        let now = Utc::now();

        // 1. Save index to PostgreSQL
        sqlx::query(
            r#"
            INSERT INTO memory_index (id, user_id, summary, importance_score, tags, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $6)
            "#,
        )
        .bind(id)
        .bind(None::<String>)
        .bind(&summary)
        .bind(importance)
        .bind(&tags)
        .bind(now)
        .execute(&self.db)
        .await
        .context("failed to save to PostgreSQL")?;

        // 2. Save full document to OpenSearch
        let doc = MemoryDocument {
            id: id.to_string(),
            user_id: None,
            content: content.clone(),
            summary: summary.clone(),
            importance_score: importance,
            tags: tags.clone(),
            created_at: now.to_rfc3339(),
            updated_at: now.to_rfc3339(),
        };

        if let Err(e) = self.opensearch.index_document(&doc).await {
            // Rollback PostgreSQL on failure
            let _ = sqlx::query("DELETE FROM memory_index WHERE id = $1")
                .bind(id)
                .execute(&self.db)
                .await;
            return Err(e);
        }

        info!("saved memory {} to PostgreSQL + OpenSearch", id);

        // 3. Save graph node (non-blocking)
        if let Some(fdb) = &self.falkordb {
            let mut fdb = fdb.clone();
            let db_c = self.db.clone();
            let (sum_c, tags_c, ts) = (summary.clone(), tags.clone(), now.to_rfc3339());
            tokio::spawn(async move {
                let excluded = frequent_tags(&db_c, Some(&tags_c), AUTO_LINK_TAG_MAX_FRACTION).await;
                if let Err(e) = fdb
                    .save_node(id, None, sum_c.as_deref(), importance, &tags_c, &ts, &excluded)
                    .await
                {
                    warn!("FalkorDB save_node failed: {e}");
                }
            });
        }

        Ok(json!({
            "content": [{
                "type": "text",
                "text": format!("Saved memory with ID: {}\nContent: {}\nSummary: {}\nTags: {:?}\nImportance: {:.1}",
                    id, content, summary.as_deref().unwrap_or("-"), tags, importance)
            }]
        }))
    }

    async fn memory_search(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let query = args["query"].as_str().context("missing query")?.to_string();
        let limit = args["limit"].as_u64().unwrap_or(5) as usize;
        let limit = limit.clamp(1, 20);

        // Search in OpenSearch
        let docs = self.opensearch.search(&query, limit * 2).await.unwrap_or_default();

        // Get importance scores from PostgreSQL
        let ids: Vec<Uuid> = docs
            .iter()
            .filter_map(|d| Uuid::parse_str(&d.id).ok())
            .collect();

        let index_data: Vec<MemoryIndex> = if !ids.is_empty() {
            sqlx::query_as(
                "SELECT id, user_id, summary, importance_score, tags, created_at, updated_at FROM memory_index WHERE id = ANY($1)"
            )
            .bind(&ids)
            .fetch_all(&self.db)
            .await
            .unwrap_or_default()
        } else {
            vec![]
        };

        // Combine and score (base signal: BM25 candidacy + importance/recency)
        let mut results: Vec<SearchResult> = docs
            .iter()
            .filter_map(|doc| {
                let id = Uuid::parse_str(&doc.id).ok()?;
                let index = index_data.iter().find(|i| i.id == id);
                let importance = index.map(|i| i.importance_score).unwrap_or(0.5);
                let created_at = index.map(|i| i.created_at).unwrap_or_else(Utc::now);
                let score = compute_combined_score(importance, created_at);

                Some(SearchResult {
                    id,
                    content: doc.content.clone(),
                    summary: doc.summary.clone(),
                    tags: doc.tags.clone(),
                    importance_score: importance,
                    created_at,
                    score,
                    via_graph: false,
                })
            })
            .collect();

        results.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));

        let mut facts_text = String::new();
        let mut related_facts: Vec<falkordb::FactResult> = vec![];

        if let Some(fdb) = &self.falkordb {
            let mut fdb = fdb.clone();

            // 1. Proximity boost: reward BM25 hits that are graph-connected to each other.
            match fdb.connection_counts(&ids, None).await {
                Ok(counts) => {
                    for r in results.iter_mut() {
                        if let Some(&n) = counts.get(&r.id) {
                            r.score += (0.05 * n as f32).min(0.15);
                        }
                    }
                    results.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
                }
                Err(e) => warn!("memory_search: connection_counts failed: {e}"),
            }

            // 2. Graph-recall: expand from the top hit to surface memories BM25's text
            // match missed entirely, discounted since they aren't a direct text match.
            if let Some(top) = results.first().map(|r| r.id) {
                match fdb.get_neighbors(top, None, 1, 5).await {
                    Ok(neighbors) => {
                        let existing: std::collections::HashSet<Uuid> =
                            results.iter().map(|r| r.id).collect();
                        let new_ids: Vec<String> = neighbors
                            .iter()
                            .filter(|n| !existing.contains(&n.id))
                            .map(|n| n.id.to_string())
                            .collect();

                        if !new_ids.is_empty() {
                            let neighbor_docs = self.opensearch.get_by_ids(&new_ids).await.unwrap_or_default();
                            let neighbor_ids: Vec<Uuid> = neighbors
                                .iter()
                                .filter(|n| !existing.contains(&n.id))
                                .map(|n| n.id)
                                .collect();
                            let neighbor_index: Vec<MemoryIndex> = if !neighbor_ids.is_empty() {
                                sqlx::query_as(
                                    "SELECT id, user_id, summary, importance_score, tags, created_at, updated_at FROM memory_index WHERE id = ANY($1)"
                                )
                                .bind(&neighbor_ids)
                                .fetch_all(&self.db)
                                .await
                                .unwrap_or_default()
                            } else {
                                vec![]
                            };

                            for n in neighbors.iter().filter(|n| !existing.contains(&n.id)) {
                                let Some(doc) = neighbor_docs.iter().find(|d| d.id == n.id.to_string()) else {
                                    continue;
                                };
                                let index = neighbor_index.iter().find(|i| i.id == n.id);
                                let created_at = index.map(|i| i.created_at).unwrap_or_else(Utc::now);
                                let score = compute_combined_score(n.importance, created_at) * 0.9;
                                results.push(SearchResult {
                                    id: n.id,
                                    content: doc.content.clone(),
                                    summary: doc.summary.clone(),
                                    tags: n.tags.clone(),
                                    importance_score: n.importance,
                                    created_at,
                                    score,
                                    via_graph: true,
                                });
                            }
                            results.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
                        }
                    }
                    Err(e) => warn!("memory_search: get_neighbors failed: {e}"),
                }
            }

            // 3. Surface related temporal facts for grounded context.
            match fdb.query_facts(&query, None, 5, true).await {
                Ok(facts) if !facts.is_empty() => {
                    facts_text = format!("\n{}\n", format_facts(&facts, &format!("\"{query}\"")));
                    related_facts = facts;
                }
                Ok(_) => {}
                Err(e) => warn!("memory_search: query_facts failed: {e}"),
            }
        }

        results.truncate(limit);

        // Optional mermaid graph view showing how the returned results connect.
        let mut graph_view_text = String::new();
        if args["include_graph_view"].as_bool().unwrap_or(false) {
            if let Some(fdb) = &self.falkordb {
                let mut fdb = fdb.clone();
                let result_ids: Vec<Uuid> = results.iter().map(|r| r.id).collect();
                match fdb.edges_within(&result_ids, None).await {
                    Ok(edges) => {
                        let mermaid = build_mermaid(&results, &edges, &related_facts);
                        graph_view_text = format!("\n```mermaid\n{mermaid}\n```\n");
                    }
                    Err(e) => warn!("memory_search: edges_within failed: {e}"),
                }
            }
        }

        // Format output
        let mut text = format!("Found {} results for: \"{}\"\n\n", results.len(), query);

        if results.is_empty() {
            text.push_str("No matching memories found.");
        } else {
            for (i, result) in results.iter().enumerate() {
                let provenance = if result.via_graph { " [via graph]" } else { "" };
                text.push_str(&format!(
                    "{}. [Score: {:.2}]{} {}\n   Summary: {}\n   Tags: {:?}\n   Importance: {:.1}\n   Created: {}\n\n",
                    i + 1,
                    result.score,
                    provenance,
                    result.content,
                    result.summary.as_deref().unwrap_or("-"),
                    result.tags,
                    result.importance_score,
                    result.created_at.format("%Y-%m-%d %H:%M")
                ));
            }
        }

        text.push_str(&facts_text);
        text.push_str(&graph_view_text);

        Ok(json!({
            "content": [{
                "type": "text",
                "text": text
            }]
        }))
    }

    async fn memory_graph_all(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let user_id = args["user_id"].as_str().map(|s| s.to_string());
        let edges = match &self.falkordb {
            None => vec![],
            Some(fdb) => {
                let mut fdb = fdb.clone();
                fdb.get_all_edges(user_id.as_deref()).await.unwrap_or_default()
            }
        };
        Ok(json!({ "type": "memory.graph_all.result", "edges": edges }))
    }

    async fn memory_graph_data(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let user_id = args["user_id"].as_str().map(|s| s.to_string());
        // No limit → all memories (the web graph page requests everything by default).
        // An explicit limit is still honored for callers that want a bounded page.
        let limit = args["limit"].as_u64().map(|l| l.max(1) as i64).unwrap_or(i64::MAX);

        let mut memories: Vec<MemoryIndex> = match &user_id {
            Some(uid) => sqlx::query_as(
                "SELECT id, user_id, summary, importance_score, tags, created_at, updated_at FROM memory_index WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2"
            )
            .bind(uid)
            .bind(limit)
            .fetch_all(&self.db)
            .await
            .unwrap_or_default(),
            None => sqlx::query_as(
                "SELECT id, user_id, summary, importance_score, tags, created_at, updated_at FROM memory_index ORDER BY created_at DESC LIMIT $1"
            )
            .bind(limit)
            .fetch_all(&self.db)
            .await
            .unwrap_or_default(),
        };

        // Most memories are auto-captured (e.g. the session watcher) and never set a
        // summary — fall back to a truncated content preview so graph nodes have a label.
        let unlabeled_ids: Vec<String> = memories
            .iter()
            .filter(|m| m.summary.as_deref().is_none_or(str::is_empty))
            .map(|m| m.id.to_string())
            .collect();
        if !unlabeled_ids.is_empty() {
            let docs = self.opensearch.get_by_ids(&unlabeled_ids).await.unwrap_or_default();
            for m in memories.iter_mut() {
                if m.summary.as_deref().is_none_or(str::is_empty) {
                    if let Some(doc) = docs.iter().find(|d| d.id == m.id.to_string()) {
                        m.summary = Some(content_preview(&doc.content));
                    }
                }
            }
        }

        let edges = match &self.falkordb {
            None => vec![],
            Some(fdb) => {
                let mut fdb = fdb.clone();
                fdb.get_all_edges(user_id.as_deref()).await.unwrap_or_default()
            }
        };
        // Keep a bounded preview bounded in both dimensions. Sending all graph
        // edges with a limited node list still makes the first render expensive.
        let memory_ids: std::collections::HashSet<String> = memories
            .iter()
            .map(|memory| memory.id.to_string())
            .collect();
        let edges = edges
            .into_iter()
            .filter(|edge| memory_ids.contains(&edge.from_id) && memory_ids.contains(&edge.to_id))
            .collect::<Vec<_>>();
        let mut edges = edges;
        if limit != i64::MAX && edges.len() > 3_000 {
            edges.sort_unstable_by_key(|edge| (edge.rel_type != "LINKED_TO") as u8);
            edges.truncate(3_000);
        }

        let nodes: Vec<serde_json::Value> = memories
            .iter()
            .map(|m| json!({
                "id": m.id,
                "summary": m.summary,
                "importance_score": m.importance_score,
                "tags": m.tags,
                "created_at": m.created_at,
            }))
            .collect();

        Ok(json!({ "type": "memory.graph_data.result", "memories": nodes, "edges": edges }))
    }

    async fn memory_graph_rebuild(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let mut fdb = match &self.falkordb {
            Some(f) => f.clone(),
            None => return Ok(json!({ "type": "memory.graph_rebuild.result", "rebuilt": 0 })),
        };

        let user_id = args["user_id"].as_str().map(|s| s.to_string());
        // Rebuild is a one-time maintenance backfill, not a live render — unlike
        // memory_graph_data it should cover everything by default, not just a page.
        // An explicit limit is still honored (e.g. to rebuild only the newest N).
        let limit = args["limit"].as_u64().map(|l| l.max(1) as i64).unwrap_or(i64::MAX);

        // upsert_node()/relink_all_tag_edges() are MERGE-based (idempotent) — safe to
        // re-run, no "already built" tracking column needed. Backfills RELATED_TO
        // edges for memories saved before this graph existed, or with tags edited
        // since. Node upserts are per-row (property values differ per memory), but
        // edge computation runs once as a single bulk query at the end — looping
        // save_node()'s per-node edge relink here would be O(n²) round trips.
        let rows: Vec<MemoryIndex> = match &user_id {
            Some(uid) => sqlx::query_as(
                "SELECT id, user_id, summary, importance_score, tags, created_at, updated_at FROM memory_index WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2"
            )
            .bind(uid)
            .bind(limit)
            .fetch_all(&self.db)
            .await
            .unwrap_or_default(),
            None => sqlx::query_as(
                "SELECT id, user_id, summary, importance_score, tags, created_at, updated_at FROM memory_index ORDER BY created_at DESC LIMIT $1"
            )
            .bind(limit)
            .fetch_all(&self.db)
            .await
            .unwrap_or_default(),
        };

        let mut rebuilt = 0usize;
        for row in &rows {
            if fdb
                .upsert_node(
                    row.id,
                    row.user_id.as_deref(),
                    row.summary.as_deref(),
                    row.importance_score,
                    &row.tags,
                    &row.created_at.to_rfc3339(),
                )
                .await
                .is_ok()
            {
                rebuilt += 1;
            }
        }

        let excluded = frequent_tags(&self.db, None, AUTO_LINK_TAG_MAX_FRACTION).await;
        if let Err(e) = fdb.relink_all_tag_edges(user_id.as_deref(), &excluded).await {
            warn!("memory_graph_rebuild: relink_all_tag_edges failed: {e}");
        }

        Ok(json!({ "type": "memory.graph_rebuild.result", "rebuilt": rebuilt }))
    }

    async fn memory_graph_neighbors(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let id_str = args["id"].as_str().context("missing id")?;
        let id = uuid::Uuid::parse_str(id_str).context("invalid uuid")?;
        let hops = args["hops"].as_u64().unwrap_or(1).clamp(1, 2) as u8;
        let limit = args["limit"].as_u64().unwrap_or(10).clamp(1, 50) as usize;
        // user_id is a namespace selector only — consistent with memory_search / memory_list.
        // A real ownership check requires auth middleware (Bearer → server-side identity).
        let user_id = args["user_id"].as_str().map(|s| s.to_string());

        let mut fdb = match &self.falkordb {
            Some(fdb) => fdb.clone(),
            None => anyhow::bail!("Graph layer not configured (FALKORDB_URL not set)"),
        };

        let neighbors = fdb.get_neighbors(id, user_id.as_deref(), hops, limit).await?;

        let mut text = format!(
            "Found {} neighbor(s) for memory {} (depth {})\n\n",
            neighbors.len(),
            id,
            hops
        );
        if neighbors.is_empty() {
            text.push_str("No related memories found.");
        } else {
            for (i, n) in neighbors.iter().enumerate() {
                text.push_str(&format!(
                    "{}. [{}] Summary: {}\n   Tags: {:?}\n   Importance: {:.1}\n\n",
                    i + 1,
                    n.id,
                    n.summary.as_deref().unwrap_or("-"),
                    n.tags,
                    n.importance
                ));
            }
        }

        Ok(json!({ "content": [{ "type": "text", "text": text }] }))
    }

    async fn memory_graph_relate(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let from_id = uuid::Uuid::parse_str(
            args["from_id"].as_str().context("missing from_id")?,
        )
        .context("invalid from_id")?;
        let to_id = uuid::Uuid::parse_str(
            args["to_id"].as_str().context("missing to_id")?,
        )
        .context("invalid to_id")?;
        let relationship = args["relationship"]
            .as_str()
            .context("missing relationship")?
            .to_string();
        // Same no-auth caveat — user_id from args is not a verified identity.
        // relate_nodes itself verifies both nodes exist in FalkorDB before merging.

        let mut fdb = match &self.falkordb {
            Some(fdb) => fdb.clone(),
            None => anyhow::bail!("Graph layer not configured (FALKORDB_URL not set)"),
        };

        fdb.relate_nodes(from_id, to_id, &relationship).await?;

        Ok(json!({
            "content": [{
                "type": "text",
                "text": format!(
                    "Created relationship '{}' from {} to {}",
                    relationship, from_id, to_id
                )
            }]
        }))
    }

    async fn env_set(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let key = args["key"].as_str().context("missing key")?.to_string();
        let value = args["value"].as_str().context("missing value")?.to_string();
        let is_secret = args["is_secret"].as_bool().unwrap_or(false);
        let description = args["description"].as_str().map(|s| s.to_string());

        let encrypted = encrypt_value(&self.encryption_key, &value);
        let now = Utc::now();

        sqlx::query(
            r#"
            INSERT INTO env_params (key, value_encrypted, is_secret, description, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $5)
            ON CONFLICT (key) DO UPDATE SET
                value_encrypted = EXCLUDED.value_encrypted,
                description = COALESCE(EXCLUDED.description, env_params.description),
                updated_at = EXCLUDED.updated_at
            "#,
        )
        .bind(&key)
        .bind(&encrypted)
        .bind(is_secret)
        .bind(&description)
        .bind(now)
        .execute(&self.db)
        .await
        .context("failed to set env param")?;

        let type_label = if is_secret { "secret" } else { "normal" };
        Ok(json!({
            "content": [{
                "type": "text",
                "text": format!("Set {} parameter '{}'{}", type_label, key,
                    description.as_deref().map(|d| format!(" ({})", d)).unwrap_or_default())
            }]
        }))
    }

    async fn env_rename(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let old_key = args["old_key"]
            .as_str()
            .context("missing old_key")?
            .trim()
            .to_string();
        let new_key = args["new_key"]
            .as_str()
            .context("missing new_key")?
            .trim()
            .to_string();
        let value = args.get("value").and_then(|value| value.as_str());
        let is_secret = args.get("is_secret").and_then(|value| value.as_bool());
        let description = args.get("description").map(|value| value.as_str());

        openmemory_server::env_params::rename_env_param(
            &self.db,
            &self.encryption_key,
            &old_key,
            &new_key,
            value,
            is_secret,
            description,
        )
        .await?;

        Ok(json!({
            "content": [{
                "type": "text",
                "text": format!("Renamed environment parameter '{}' to '{}'", old_key, new_key)
            }]
        }))
    }

    async fn env_get(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let key = args["key"].as_str().context("missing key")?.to_string();

        let row: Option<(Vec<u8>, bool)> = sqlx::query_as(
            "SELECT value_encrypted, is_secret FROM env_params WHERE key = $1",
        )
        .bind(&key)
        .fetch_optional(&self.db)
        .await
        .context("failed to query env param")?;

        match row {
            None => anyhow::bail!("Parameter '{}' not found", key),
            Some((_, true)) => {
                // Secret params are blocked from agent reads — agents must call env_list
                // to confirm the key exists, then use it indirectly (e.g. pass to a tool)
                Ok(json!({
                    "content": [{
                        "type": "text",
                        "text": format!("'{}' is a secret parameter — its value cannot be read by agents. Use env_list to confirm it exists.", key)
                    }],
                    "isError": true
                }))
            }
            Some((encrypted, false)) => {
                let value = decrypt_value(&self.encryption_key, &encrypted)
                    .context("failed to decrypt parameter")?;
                Ok(json!({
                    "content": [{
                        "type": "text",
                        "text": format!("{}={}", key, value)
                    }]
                }))
            }
        }
    }

    async fn env_list(&mut self, _args: &serde_json::Value) -> Result<serde_json::Value> {
        let params: Vec<EnvParamRow> = sqlx::query_as(
            "SELECT id, key, is_secret, description, created_at, updated_at FROM env_params ORDER BY key ASC",
        )
        .fetch_all(&self.db)
        .await
        .context("failed to list env params")?;

        if params.is_empty() {
            return Ok(json!({
                "content": [{ "type": "text", "text": "No environment parameters configured." }]
            }));
        }

        let mut text = format!("Environment parameters ({}):\n\n", params.len());
        for p in &params {
            text.push_str(&format!(
                "• {} [{}]{}\n",
                p.key,
                if p.is_secret { "secret" } else { "normal" },
                p.description.as_deref().map(|d| format!(" — {}", d)).unwrap_or_default()
            ));
        }

        Ok(json!({ "content": [{ "type": "text", "text": text }] }))
    }

    async fn env_delete(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let key = args["key"].as_str().context("missing key")?.to_string();

        let result = sqlx::query("DELETE FROM env_params WHERE key = $1")
            .bind(&key)
            .execute(&self.db)
            .await
            .context("failed to delete env param")?;

        if result.rows_affected() == 0 {
            anyhow::bail!("Parameter '{}' not found", key);
        }

        Ok(json!({
            "content": [{
                "type": "text",
                "text": format!("Deleted parameter '{}'", key)
            }]
        }))
    }

    async fn resource_list(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let kind = args["kind"].as_str();
        let tags: Option<Vec<String>> = args["tags"].as_array().map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        });
        let query = args["query"].as_str();
        let (resources, warnings) = resources::list_resources(
            &self.db,
            &self.encryption_key,
            kind,
            tags.as_deref(),
            query,
        )
        .await?;
        let text = resources::format_list_text(&resources, &warnings);
        Ok(json!({ "content": [{ "type": "text", "text": text }] }))
    }

    async fn resource_tags(&mut self, _args: &serde_json::Value) -> Result<serde_json::Value> {
        let tags = resources::list_distinct_tags(&self.db).await?;
        let text = if tags.is_empty() {
            "No tags in use yet.".to_string()
        } else {
            let mut lines = vec![format!("Tags ({}):", tags.len())];
            for (tag, count) in &tags {
                lines.push(format!("• {} ({})", tag, count));
            }
            lines.join("\n")
        };
        Ok(json!({ "content": [{ "type": "text", "text": text }] }))
    }

    async fn resource_get(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let id_or_name = args["id_or_name"].as_str().context("missing id_or_name")?;
        match resources::get_resource(&self.db, &self.encryption_key, id_or_name).await? {
            None => anyhow::bail!("Resource '{}' not found", id_or_name),
            Some(r) => {
                let text = serde_json::to_string_pretty(&r)?;
                Ok(json!({ "content": [{ "type": "text", "text": text }] }))
            }
        }
    }

    async fn resource_add(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let name = args["name"].as_str().context("missing name")?;
        let kind = args["kind"].as_str().context("missing kind")?;
        let location = args["location"].as_str().context("missing location")?;
        let description = args["description"].as_str();
        let tags: Vec<String> = args["tags"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();
        let env_param_keys: Vec<String> = args["env_param_keys"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();

        let (id, warning) = resources::add_resource(
            &self.db,
            name,
            kind,
            location,
            description,
            &tags,
            &env_param_keys,
        )
        .await?;

        let mut text = format!("Added resource '{}' ({}) → {} [{}]", name, kind, location, id);
        if let Some(w) = warning {
            text.push_str(&format!("\n{}", w));
        }
        Ok(json!({ "content": [{ "type": "text", "text": text }] }))
    }

    async fn resource_update(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let id_str = args["id"].as_str().context("missing id")?;
        let id = Uuid::parse_str(id_str).context("invalid resource id")?;
        let name = args["name"].as_str();
        let kind = args["kind"].as_str();
        let location = args["location"].as_str();
        let tags: Option<Vec<String>> = args.get("tags").and_then(|v| {
            v.as_array().map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                    .collect()
            })
        });

        let description: Option<Option<&str>> = if args["clear_description"].as_bool() == Some(true)
        {
            Some(None)
        } else if args.get("description").and_then(|v| v.as_str()).is_some() {
            Some(args["description"].as_str())
        } else {
            None
        };

        let env_param_keys: Option<Vec<String>> = args.get("env_param_keys").and_then(|v| {
            v.as_array().map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                    .collect()
            })
        });

        let warning = resources::update_resource(
            &self.db,
            id,
            name,
            kind,
            location,
            description,
            tags.as_deref(),
            env_param_keys.as_deref(),
        )
        .await?;

        let mut text = format!("Updated resource {}", id);
        if let Some(w) = warning {
            text.push_str(&format!("\n{}", w));
        }
        Ok(json!({ "content": [{ "type": "text", "text": text }] }))
    }

    async fn resource_delete(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let id_str = args["id"].as_str().context("missing id")?;
        let id = Uuid::parse_str(id_str).context("invalid resource id")?;
        resources::delete_resource(&self.db, id).await?;
        Ok(json!({
            "content": [{
                "type": "text",
                "text": format!("Deleted resource {}", id)
            }]
        }))
    }

    async fn workflow_list(&mut self, _args: &serde_json::Value) -> Result<serde_json::Value> {
        let items = workflows::list(&self.db).await?;
        let summaries: Vec<serde_json::Value> = items.into_iter().map(|workflow| json!({
            "id": workflow.id,
            "name": workflow.name,
            "description": workflow.description,
            "input_schema": workflow.input_schema,
            "enabled": workflow.enabled,
            "step_count": workflow.steps.as_array().map(|steps| steps.len()).unwrap_or(0),
            "updated_at": workflow.updated_at,
        })).collect();
        Ok(json!({"content": [{"type": "text", "text": serde_json::to_string_pretty(&summaries)?}]}))
    }

    async fn workflow_get(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let id_or_name = args["id_or_name"].as_str().context("missing id_or_name")?;
        let workflow = workflows::get(&self.db, id_or_name).await?;
        Ok(json!({"content": [{"type": "text", "text": serde_json::to_string_pretty(&workflow)?}]}))
    }

    async fn workflow_run(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let id_or_name = args["id_or_name"].as_str().context("missing id_or_name")?;
        let input = args.get("input").cloned().unwrap_or_else(|| json!({}));
        let result = workflows::run(&self.db, &self.encryption_key, id_or_name, input).await?;
        Ok(json!({
            "content": [{"type": "text", "text": serde_json::to_string_pretty(&result)?}],
            "isError": result.status == "failed",
        }))
    }

    async fn workflow_continue(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let run_id = Uuid::parse_str(args["run_id"].as_str().context("missing run_id")?)?;
        let action_result = args.get("result").cloned().context("missing result")?;
        let result = workflows::continue_run(&self.db, &self.encryption_key, run_id, action_result).await?;
        Ok(json!({
            "content": [{"type": "text", "text": serde_json::to_string_pretty(&result)?}],
            "isError": result.status == "failed",
        }))
    }

    async fn env_http_request(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let method = args["method"].as_str().context("missing method")?.to_uppercase();
        let auth_key = args["auth_key"].as_str().context("missing auth_key")?.to_string();
        let auth_header = args["auth_header"].as_str().unwrap_or("Authorization").to_string();
        let auth_prefix = args["auth_prefix"].as_str().unwrap_or("Bearer ").to_string();
        // "header" (default): secret goes in an auth header, url comes from the
        // "url" arg. "url": the secret itself IS the full request URL (for
        // self-authenticating URLs like incoming webhooks) — no auth header is
        // sent, and the "url" arg is ignored/not required. "query": secret is
        // appended as a query string parameter (name from secret_query_param,
        // default "key") onto the "url" arg — for APIs like Pixabay that only
        // accept the API key as ?key=... and reject header-based auth.
        let secret_target = args["secret_target"].as_str().unwrap_or("header").to_string();
        let secret_query_param = args["secret_query_param"].as_str().unwrap_or("key").to_string();

        // Resolve the secret from the DB — never returned to the agent
        let row: Option<(Vec<u8>, bool)> = sqlx::query_as(
            "SELECT value_encrypted, is_secret FROM env_params WHERE key = $1",
        )
        .bind(&auth_key)
        .fetch_optional(&self.db)
        .await
        .context("failed to query auth secret")?;

        let secret_value = match row {
            None => anyhow::bail!("Secret '{}' not found in env params", auth_key),
            Some((encrypted, _)) => decrypt_value(&self.encryption_key, &encrypted)
                .context("failed to decrypt secret")?,
        };

        let url = if secret_target == "url" {
            secret_value.trim().to_string()
        } else if secret_target == "query" {
            let base = args["url"].as_str().context("missing url")?;
            let mut parsed = reqwest::Url::parse(base).context("invalid url")?;
            parsed
                .query_pairs_mut()
                .append_pair(&secret_query_param, secret_value.trim());
            parsed.to_string()
        } else {
            args["url"].as_str().context("missing url")?.to_string()
        };

        // Optional host allowlist (OPENMEMORY_HTTP_ALLOWED_HOSTS): if set, refuse to
        // resolve or attach the secret unless the destination host is on the list.
        if let Ok(allowed) = std::env::var("OPENMEMORY_HTTP_ALLOWED_HOSTS") {
            let allowed_hosts: Vec<String> = allowed
                .split(',')
                .map(|h| h.trim().to_lowercase())
                .filter(|h| !h.is_empty())
                .collect();
            let parsed = reqwest::Url::parse(&url).context("invalid url")?;
            let host = parsed.host_str().unwrap_or("").to_lowercase();
            if !allowed_hosts.iter().any(|h| h == &host) {
                anyhow::bail!(
                    "Host '{}' is not in OPENMEMORY_HTTP_ALLOWED_HOSTS — request blocked",
                    host
                );
            }
        }

        let client = HttpClient::new();

        let mut req = match method.as_str() {
            "GET"    => client.get(&url),
            "POST"   => client.post(&url),
            "PUT"    => client.put(&url),
            "PATCH"  => client.patch(&url),
            "DELETE" => client.delete(&url),
            other    => anyhow::bail!("Unsupported HTTP method: {}", other),
        }
        .header("Content-Type", "application/json");

        if secret_target != "url" && secret_target != "query" {
            let auth_value = format!("{}{}", auth_prefix, secret_value);
            req = req.header(&auth_header, &auth_value);
        }

        // Inject any extra headers
        if let Some(headers) = args["headers"].as_object() {
            for (k, v) in headers {
                if let Some(v_str) = v.as_str() {
                    req = req.header(k.as_str(), v_str);
                }
            }
        }

        // Attach body for mutating methods
        // Always set a body (even empty) — some APIs (e.g. Google's) require
        // Content-Length on POST/PUT/PATCH and reject requests with none set.
        // reqwest doesn't auto-emit Content-Length for a zero-length body, so
        // set it explicitly in that case.
        req = match args.get("body") {
            Some(body) if !body.is_null() => req.body(body.to_string()),
            _ => req.header("Content-Length", "0").body(""),
        };

        let response = req.send().await.context("HTTP request failed")?;
        let status = response.status().as_u16();
        let body_text = response.text().await.unwrap_or_default();

        // Try to pretty-print JSON responses, fall back to raw text
        let display = serde_json::from_str::<serde_json::Value>(&body_text)
            .map(|v| serde_json::to_string_pretty(&v).unwrap_or(body_text.clone()))
            .unwrap_or(body_text);

        Ok(json!({
            "content": [{
                "type": "text",
                "text": format!("HTTP {} — status {}\n\n{}", method, status, display)
            }],
            "isError": status >= 400
        }))
    }

    async fn env_http_download(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let method = args["method"].as_str().context("missing method")?.to_uppercase();
        let auth_key = args["auth_key"].as_str().context("missing auth_key")?.to_string();
        let auth_header = args["auth_header"].as_str().unwrap_or("Authorization").to_string();
        let auth_prefix = args["auth_prefix"].as_str().unwrap_or("Bearer ").to_string();
        let secret_target = args["secret_target"].as_str().unwrap_or("header").to_string();
        let secret_query_param = args["secret_query_param"].as_str().unwrap_or("key").to_string();
        let save_path = args["save_path"].as_str().context("missing save_path")?.to_string();

        if !std::path::Path::new(&save_path).is_absolute() {
            anyhow::bail!("save_path must be an absolute path");
        }

        // Resolve the secret from the DB — never returned to the agent
        let row: Option<(Vec<u8>, bool)> = sqlx::query_as(
            "SELECT value_encrypted, is_secret FROM env_params WHERE key = $1",
        )
        .bind(&auth_key)
        .fetch_optional(&self.db)
        .await
        .context("failed to query auth secret")?;

        let secret_value = match row {
            None => anyhow::bail!("Secret '{}' not found in env params", auth_key),
            Some((encrypted, _)) => decrypt_value(&self.encryption_key, &encrypted)
                .context("failed to decrypt secret")?,
        };

        let url = if secret_target == "url" {
            secret_value.trim().to_string()
        } else if secret_target == "query" {
            let base = args["url"].as_str().context("missing url")?;
            let mut parsed = reqwest::Url::parse(base).context("invalid url")?;
            parsed
                .query_pairs_mut()
                .append_pair(&secret_query_param, secret_value.trim());
            parsed.to_string()
        } else {
            args["url"].as_str().context("missing url")?.to_string()
        };

        if let Ok(allowed) = std::env::var("OPENMEMORY_HTTP_ALLOWED_HOSTS") {
            let allowed_hosts: Vec<String> = allowed
                .split(',')
                .map(|h| h.trim().to_lowercase())
                .filter(|h| !h.is_empty())
                .collect();
            let parsed = reqwest::Url::parse(&url).context("invalid url")?;
            let host = parsed.host_str().unwrap_or("").to_lowercase();
            if !allowed_hosts.iter().any(|h| h == &host) {
                anyhow::bail!(
                    "Host '{}' is not in OPENMEMORY_HTTP_ALLOWED_HOSTS — request blocked",
                    host
                );
            }
        }

        let client = HttpClient::new();

        let mut req = match method.as_str() {
            "GET"    => client.get(&url),
            "POST"   => client.post(&url),
            "PUT"    => client.put(&url),
            "PATCH"  => client.patch(&url),
            "DELETE" => client.delete(&url),
            other    => anyhow::bail!("Unsupported HTTP method: {}", other),
        };

        if secret_target != "url" && secret_target != "query" {
            let auth_value = format!("{}{}", auth_prefix, secret_value);
            req = req.header(&auth_header, &auth_value);
        }

        if let Some(headers) = args["headers"].as_object() {
            for (k, v) in headers {
                if let Some(v_str) = v.as_str() {
                    req = req.header(k.as_str(), v_str);
                }
            }
        }

        let response = req.send().await.context("HTTP request failed")?;
        let status = response.status().as_u16();
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();

        // Bytes, not text — this is the whole point: no UTF-8 lossy conversion.
        let bytes = response.bytes().await.context("failed to read response body")?;

        if status >= 400 {
            // Error bodies are almost always text (JSON error payloads) — safe to
            // surface directly rather than writing an error page to save_path.
            let text = String::from_utf8_lossy(&bytes).to_string();
            return Ok(json!({
                "content": [{
                    "type": "text",
                    "text": format!("HTTP {} — status {}\n\n{}", method, status, text)
                }],
                "isError": true
            }));
        }

        if let Some(parent) = std::path::Path::new(&save_path).parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .context("failed to create parent directories for save_path")?;
        }
        tokio::fs::write(&save_path, &bytes)
            .await
            .context("failed to write downloaded bytes to save_path")?;

        Ok(json!({
            "content": [{
                "type": "text",
                "text": format!(
                    "HTTP {} — status {}\nSaved {} bytes to {}\nContent-Type: {}",
                    method, status, bytes.len(), save_path, content_type
                )
            }],
            "isError": false
        }))
    }

    // Shared by env_sign_jwt (returns the token to the agent) and
    // env_http_request_jwt (uses the token internally, never returns it).
    async fn sign_jwt_from_args(&self, args: &serde_json::Value) -> Result<String> {
        use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};

        let key_name = args["key"].as_str().context("missing key")?.to_string();
        let algorithm = args["algorithm"].as_str().context("missing algorithm")?.to_string();
        let claims_in = args["claims"].as_object().context("missing claims")?.clone();
        let ttl_seconds = args["ttl_seconds"].as_i64().unwrap_or(1200).clamp(1, 1200);

        // Resolve the signing key from the DB — never returned to the agent
        let row: Option<(Vec<u8>, bool)> = sqlx::query_as(
            "SELECT value_encrypted, is_secret FROM env_params WHERE key = $1",
        )
        .bind(&key_name)
        .fetch_optional(&self.db)
        .await
        .context("failed to query signing key")?;

        let mut key_value = match row {
            None => anyhow::bail!("Parameter '{}' not found in env params", key_name),
            Some((encrypted, _)) => decrypt_value(&self.encryption_key, &encrypted)
                .context("failed to decrypt signing key")?,
        };

        // Keys uploaded via env_set_file are stored base64-encoded (so binary
        // files round-trip safely) — decode back to the raw PEM/secret bytes.
        if args["key_from_file"].as_bool().unwrap_or(false) {
            use base64::{engine::general_purpose::STANDARD, Engine as _};
            let decoded = STANDARD
                .decode(key_value.trim())
                .context("key_from_file was set but the stored value isn't valid base64")?;
            key_value = String::from_utf8(decoded)
                .context("decoded file key is not valid UTF-8 text (binary keys aren't supported by jsonwebtoken)")?;
        }

        let alg = match algorithm.as_str() {
            "ES256" => Algorithm::ES256,
            "RS256" => Algorithm::RS256,
            "HS256" => Algorithm::HS256,
            other => anyhow::bail!("Unsupported algorithm: {} (use ES256, RS256, or HS256)", other),
        };

        let encoding_key = match alg {
            Algorithm::ES256 => EncodingKey::from_ec_pem(key_value.as_bytes())
                .context("failed to parse EC private key (expected PEM)")?,
            Algorithm::RS256 => EncodingKey::from_rsa_pem(key_value.as_bytes())
                .context("failed to parse RSA private key (expected PEM)")?,
            Algorithm::HS256 => EncodingKey::from_secret(key_value.as_bytes()),
            _ => unreachable!(),
        };

        let mut header = Header::new(alg);
        if let Some(extra) = args["header_extra"].as_object() {
            for (k, v) in extra {
                match k.as_str() {
                    "kid" => header.kid = v.as_str().map(|s| s.to_string()),
                    _ => {} // other header fields aren't exposed by jsonwebtoken::Header; extend here if needed
                }
            }
        }

        let now = Utc::now().timestamp();
        let mut claims: serde_json::Map<String, serde_json::Value> = claims_in;
        claims.insert("iat".to_string(), json!(now));
        claims.insert("exp".to_string(), json!(now + ttl_seconds));

        encode(&header, &serde_json::Value::Object(claims), &encoding_key)
            .context("failed to sign JWT")
    }

    async fn env_sign_jwt(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let token = self.sign_jwt_from_args(args).await?;

        Ok(json!({
            "content": [{
                "type": "text",
                "text": token
            }]
        }))
    }

    async fn env_http_request_jwt(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let method = args["method"].as_str().context("missing method")?.to_uppercase();
        let url = args["url"].as_str().context("missing url")?.to_string();

        if let Ok(allowed) = std::env::var("OPENMEMORY_HTTP_ALLOWED_HOSTS") {
            let allowed_hosts: Vec<String> = allowed
                .split(',')
                .map(|h| h.trim().to_lowercase())
                .filter(|h| !h.is_empty())
                .collect();
            let parsed = reqwest::Url::parse(&url).context("invalid url")?;
            let host = parsed.host_str().unwrap_or("").to_lowercase();
            if !allowed_hosts.iter().any(|h| h == &host) {
                anyhow::bail!(
                    "Host '{}' is not in OPENMEMORY_HTTP_ALLOWED_HOSTS — request blocked",
                    host
                );
            }
        }

        // Signed internally; the token never leaves this function.
        let token = self.sign_jwt_from_args(args).await?;

        let client = HttpClient::new();
        let mut req = match method.as_str() {
            "GET"    => client.get(&url),
            "POST"   => client.post(&url),
            "PUT"    => client.put(&url),
            "PATCH"  => client.patch(&url),
            "DELETE" => client.delete(&url),
            other    => anyhow::bail!("Unsupported HTTP method: {}", other),
        }
        .header("Authorization", format!("Bearer {}", token))
        .header("Content-Type", "application/json");

        if let Some(headers) = args["headers"].as_object() {
            for (k, v) in headers {
                if let Some(v_str) = v.as_str() {
                    req = req.header(k.as_str(), v_str);
                }
            }
        }

        // Always set a body (even empty) — some APIs (e.g. Google's) require
        // Content-Length on POST/PUT/PATCH and reject requests with none set.
        // reqwest doesn't auto-emit Content-Length for a zero-length body, so
        // set it explicitly in that case.
        req = match args.get("body") {
            Some(body) if !body.is_null() => req.body(body.to_string()),
            _ => req.header("Content-Length", "0").body(""),
        };

        let response = req.send().await.context("HTTP request failed")?;
        let status = response.status().as_u16();
        let body_text = response.text().await.unwrap_or_default();

        let display = serde_json::from_str::<serde_json::Value>(&body_text)
            .map(|v| serde_json::to_string_pretty(&v).unwrap_or(body_text.clone()))
            .unwrap_or(body_text);

        Ok(json!({
            "content": [{
                "type": "text",
                "text": format!("HTTP {} — status {}\n\n{}", method, status, display)
            }],
            "isError": status >= 400
        }))
    }

    async fn env_set_file(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        use base64::{engine::general_purpose::STANDARD, Engine as _};

        let key = args["key"].as_str().context("missing key")?.to_string();
        let file_path = args["file_path"].as_str().context("missing file_path")?.to_string();
        let description = args["description"].as_str().map(|s| s.to_string());

        // Read on the server side — the file's bytes never pass through the
        // agent's own tool-call arguments or response text.
        let bytes = tokio::fs::read(&file_path)
            .await
            .with_context(|| format!("failed to read file '{}'", file_path))?;
        let encoded = STANDARD.encode(&bytes);

        let encrypted = encrypt_value(&self.encryption_key, &encoded);
        let now = Utc::now();
        let file_desc = description.unwrap_or_else(|| format!("uploaded from {}", file_path));

        sqlx::query(
            r#"
            INSERT INTO env_params (key, value_encrypted, is_secret, description, created_at, updated_at)
            VALUES ($1, $2, TRUE, $3, $4, $4)
            ON CONFLICT (key) DO UPDATE SET
                value_encrypted = EXCLUDED.value_encrypted,
                description = COALESCE(EXCLUDED.description, env_params.description),
                updated_at = EXCLUDED.updated_at
            "#,
        )
        .bind(&key)
        .bind(&encrypted)
        .bind(&file_desc)
        .bind(now)
        .execute(&self.db)
        .await
        .context("failed to store file as env param")?;

        Ok(json!({
            "content": [{
                "type": "text",
                "text": format!(
                    "Stored {} bytes from '{}' as secret parameter '{}'",
                    bytes.len(), file_path, key
                )
            }]
        }))
    }

    async fn env_google_service_account_request(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};

        let key_name = args["key"].as_str().context("missing key")?.to_string();
        let scopes: Vec<String> = args["scopes"]
            .as_array()
            .context("missing scopes")?
            .iter()
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .collect();
        let method = args["method"].as_str().context("missing method")?.to_uppercase();
        let url = args["url"].as_str().context("missing url")?.to_string();

        if let Ok(allowed) = std::env::var("OPENMEMORY_HTTP_ALLOWED_HOSTS") {
            let allowed_hosts: Vec<String> = allowed
                .split(',')
                .map(|h| h.trim().to_lowercase())
                .filter(|h| !h.is_empty())
                .collect();
            let parsed = reqwest::Url::parse(&url).context("invalid url")?;
            let host = parsed.host_str().unwrap_or("").to_lowercase();
            if !allowed_hosts.iter().any(|h| h == &host) {
                anyhow::bail!(
                    "Host '{}' is not in OPENMEMORY_HTTP_ALLOWED_HOSTS — request blocked",
                    host
                );
            }
        }

        // Resolve the service account JSON — never returned to the agent
        let row: Option<(Vec<u8>, bool)> = sqlx::query_as(
            "SELECT value_encrypted, is_secret FROM env_params WHERE key = $1",
        )
        .bind(&key_name)
        .fetch_optional(&self.db)
        .await
        .context("failed to query service account secret")?;

        let stored = match row {
            None => anyhow::bail!("Parameter '{}' not found in env params", key_name),
            Some((encrypted, _)) => decrypt_value(&self.encryption_key, &encrypted)
                .context("failed to decrypt service account secret")?,
        };

        let decoded = STANDARD
            .decode(stored.trim())
            .context("stored value isn't valid base64 (expected a file uploaded via env_set_file)")?;
        let sa_json: serde_json::Value = serde_json::from_slice(&decoded)
            .context("decoded file isn't valid JSON (expected a GCP service account key file)")?;

        let client_email = sa_json["client_email"]
            .as_str()
            .context("service account JSON missing client_email")?
            .to_string();
        let private_key_pem = sa_json["private_key"]
            .as_str()
            .context("service account JSON missing private_key")?
            .to_string();
        let token_uri = sa_json["token_uri"]
            .as_str()
            .unwrap_or("https://oauth2.googleapis.com/token")
            .to_string();

        // Step 1: sign the JWT-bearer assertion (RS256, per Google's
        // server-to-server OAuth2 flow). Never returned to the agent.
        let now = Utc::now().timestamp();
        let claims = json!({
            "iss": client_email,
            "scope": scopes.join(" "),
            "aud": token_uri,
            "iat": now,
            "exp": now + 3600,
        });
        let encoding_key = EncodingKey::from_rsa_pem(private_key_pem.as_bytes())
            .context("failed to parse service account private key (expected PEM)")?;
        let assertion = encode(&Header::new(Algorithm::RS256), &claims, &encoding_key)
            .context("failed to sign service account JWT assertion")?;

        // Step 2: exchange the assertion for a short-lived access token.
        // Never returned to the agent.
        let client = HttpClient::new();
        let token_response = client
            .post(&token_uri)
            .form(&[
                ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
                ("assertion", assertion.as_str()),
            ])
            .send()
            .await
            .context("token exchange request failed")?;
        let token_status = token_response.status();
        let token_body: serde_json::Value = token_response
            .json()
            .await
            .context("failed to parse token endpoint response")?;

        if !token_status.is_success() {
            anyhow::bail!("Token exchange failed (HTTP {}): {}", token_status, token_body);
        }

        let access_token = token_body["access_token"]
            .as_str()
            .context("token endpoint response missing access_token")?
            .to_string();

        // Step 3: the actual API call, authenticated with the access token.
        let mut req = match method.as_str() {
            "GET"    => client.get(&url),
            "POST"   => client.post(&url),
            "PUT"    => client.put(&url),
            "PATCH"  => client.patch(&url),
            "DELETE" => client.delete(&url),
            other    => anyhow::bail!("Unsupported HTTP method: {}", other),
        }
        .header("Authorization", format!("Bearer {}", access_token))
        .header("Content-Type", "application/json");

        if let Some(headers) = args["headers"].as_object() {
            for (k, v) in headers {
                if let Some(v_str) = v.as_str() {
                    req = req.header(k.as_str(), v_str);
                }
            }
        }

        // Always set a body (even empty) — some APIs (e.g. Google's) require
        // Content-Length on POST/PUT/PATCH and reject requests with none set.
        // reqwest doesn't auto-emit Content-Length for a zero-length body, so
        // set it explicitly in that case.
        req = match args.get("body") {
            Some(body) if !body.is_null() => req.body(body.to_string()),
            _ => req.header("Content-Length", "0").body(""),
        };

        let response = req.send().await.context("HTTP request failed")?;
        let status = response.status().as_u16();
        let body_text = response.text().await.unwrap_or_default();

        let display = serde_json::from_str::<serde_json::Value>(&body_text)
            .map(|v| serde_json::to_string_pretty(&v).unwrap_or(body_text.clone()))
            .unwrap_or(body_text);

        Ok(json!({
            "content": [{
                "type": "text",
                "text": format!("HTTP {} — status {}\n\n{}", method, status, display)
            }],
            "isError": status >= 400
        }))
    }

    async fn graph_add_episode(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let name = args["name"].as_str().context("missing name")?.to_string();
        let source = args["source"].as_str().context("missing source")?.to_string();
        let source_description = args["source_description"].as_str().context("missing source_description")?.to_string();
        let content = args["content"].as_str().context("missing content")?.to_string();
        let group_id = args["group_id"].as_str().unwrap_or("default").to_string();
        let id = Uuid::new_v4();
        let now = Utc::now();
        let valid_at = args["valid_at"].as_str().map(|s| s.to_string()).unwrap_or_else(|| now.to_rfc3339());

        let mut fdb = self.falkordb.as_ref().context("Graph layer not configured (FALKORDB_URL not set)")?.clone();
        fdb.add_episode(id, &name, &source, &source_description, &content, &group_id, &now.to_rfc3339(), &valid_at).await?;

        Ok(json!({"content": [{"type": "text", "text": format!("Episode added: '{}' (id: {})", name, id)}]}))
    }

    async fn graph_add_entity(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let name = args["name"].as_str().context("missing name")?.to_string();
        let entity_type = args["entity_type"].as_str().context("missing entity_type")?.to_string();
        let group_id = args["group_id"].as_str().unwrap_or("default").to_string();
        let summary = args["summary"].as_str().map(|s| s.to_string());
        let episode_id = args["episode_id"].as_str().map(|s| s.to_string());
        let new_id = Uuid::new_v4();
        let now = Utc::now();

        let mut fdb = self.falkordb.as_ref().context("Graph layer not configured (FALKORDB_URL not set)")?.clone();
        let (entity_id, created) = fdb.add_entity(new_id, &name, &entity_type, &group_id, summary.as_deref(), &now.to_rfc3339()).await?;

        if let Some(ep_id_str) = episode_id {
            let ep_uuid = Uuid::parse_str(&ep_id_str)
                .map_err(|_| anyhow::anyhow!("invalid episode_id UUID: {}", ep_id_str))?;
            if let Err(e) = fdb.link_episode_to_entity(ep_uuid, &name, &entity_type, &group_id).await {
                warn!("link_episode_to_entity failed (entity still saved): {e}");
            }
        }

        let action = if created { "Created" } else { "Found existing" };
        Ok(json!({"content": [{"type": "text", "text": format!("{} entity '{}' ({}) id={}", action, name, entity_type, entity_id)}]}))
    }

    async fn graph_add_fact(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let subject = args["subject"].as_str().context("missing subject")?.to_string();
        let subject_type = args["subject_type"].as_str().context("missing subject_type")?.to_string();
        let object = args["object"].as_str().context("missing object")?.to_string();
        let object_type = args["object_type"].as_str().context("missing object_type")?.to_string();
        let name = args["name"].as_str().context("missing name")?.to_string();
        let fact = args["fact"].as_str().context("missing fact")?.to_string();
        let group_id = args["group_id"].as_str().unwrap_or("default").to_string();
        let episode_id = args["episode_id"].as_str().map(|s| s.to_string());
        let now = Utc::now();
        let now_str = now.to_rfc3339();
        let valid_at = args["valid_at"].as_str().map(|s| s.to_string()).unwrap_or_else(|| now_str.clone());
        let invalidate = args["invalidate_previous"].as_bool().unwrap_or(false);
        let id = Uuid::new_v4();

        let mut fdb = self.falkordb.as_ref().context("Graph layer not configured (FALKORDB_URL not set)")?.clone();
        let (fact_id, invalidated) = fdb.add_fact(
            id, &subject, &subject_type, &object, &object_type,
            &group_id, &name, &fact, episode_id.as_deref(), &valid_at, &now_str, invalidate,
        ).await?;

        Ok(json!({"content": [{"type": "text", "text":
            format!("Fact added: '{}' -[{}]-> '{}' (id={}, invalidated: {})", subject, name, object, fact_id, invalidated)}]}))
    }

    async fn graph_query_facts(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let query = args["query"].as_str().context("missing query")?.to_string();
        let group_id = args["group_id"].as_str().map(|s| s.to_string());
        let limit = args["limit"].as_u64().unwrap_or(10).clamp(1, 50) as usize;
        let valid_only = args["valid_only"].as_bool().unwrap_or(false);

        let mut fdb = match &self.falkordb {
            Some(f) => f.clone(),
            None => return Ok(json!({"content": [{"type": "text", "text": "No results (graph layer not configured)"}]})),
        };

        let facts = fdb.query_facts(&query, group_id.as_deref(), limit, valid_only).await?;
        let text = format_facts(&facts, &format!("\"{}\"", query));
        Ok(json!({"content": [{"type": "text", "text": text}]}))
    }

    async fn graph_query_at(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let timestamp = args["timestamp"].as_str().context("missing timestamp")?.to_string();
        let entity_name = args["entity_name"].as_str().map(|s| s.to_string());
        let group_id = args["group_id"].as_str().map(|s| s.to_string());
        let limit = args["limit"].as_u64().unwrap_or(20).clamp(1, 100) as usize;

        let mut fdb = match &self.falkordb {
            Some(f) => f.clone(),
            None => return Ok(json!({"content": [{"type": "text", "text": "No results (graph layer not configured)"}]})),
        };

        let facts = fdb.query_at(&timestamp, entity_name.as_deref(), group_id.as_deref(), limit).await?;
        let text = format_facts(&facts, &format!("at {}", timestamp));
        Ok(json!({"content": [{"type": "text", "text": text}]}))
    }

    async fn graph_get_entity_history(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let entity_name = args["entity_name"].as_str().context("missing entity_name")?.to_string();
        let group_id = args["group_id"].as_str().map(|s| s.to_string());
        let limit = args["limit"].as_u64().unwrap_or(20).clamp(1, 100) as usize;

        let mut fdb = match &self.falkordb {
            Some(f) => f.clone(),
            None => return Ok(json!({"content": [{"type": "text", "text": "No history (graph layer not configured)"}]})),
        };

        let facts = fdb.get_entity_history(&entity_name, group_id.as_deref(), limit).await?;
        let text = format_facts(&facts, &format!("history of '{}'", entity_name));
        Ok(json!({"content": [{"type": "text", "text": text}]}))
    }

    async fn graph_get_entity(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let entity_name = args["entity_name"].as_str().context("missing entity_name")?.to_string();
        let entity_type = args["entity_type"].as_str().map(|s| s.to_string());
        let group_id = args["group_id"].as_str().map(|s| s.to_string());

        let mut fdb = match &self.falkordb {
            Some(f) => f.clone(),
            None => return Ok(json!({"content": [{"type": "text", "text": "Entity not found (graph layer not configured)"}]})),
        };

        match fdb.get_entity(&entity_name, entity_type.as_deref(), group_id.as_deref()).await? {
            None => Ok(json!({"content": [{"type": "text", "text": format!("Entity '{}' not found", entity_name)}]})),
            Some(e) => Ok(json!({"content": [{"type": "text", "text":
                format!("Entity: {} ({})\nID: {}\nGroup: {}\nSummary: {}\nCreated: {}",
                    e.name, e.entity_type, e.id, e.group_id,
                    e.summary.as_deref().unwrap_or("-"),
                    e.created_at)}]})),
        }
    }

    // ── Project graph helpers ────────────────────────────────────────────────

    /// Resolve a project row by project_id, name, or path.
    /// Returns (id, graph_data, graph_hash, path).
    async fn resolve_project_graph_data(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<(Uuid, serde_json::Value, Option<String>, String)> {
        let row = if let Some(id_str) = args["project_id"].as_str() {
            let id = Uuid::parse_str(id_str).context("invalid project_id UUID")?;
            sqlx::query(
                "SELECT id, graph_data, graph_hash, path FROM project_graphs WHERE id = $1",
            )
            .bind(id)
            .fetch_optional(&self.db)
            .await
            .context("DB error")?
        } else if let Some(name) = args["name"].as_str() {
            sqlx::query(
                "SELECT id, graph_data, graph_hash, path FROM project_graphs WHERE name ILIKE $1",
            )
            .bind(name)
            .fetch_optional(&self.db)
            .await
            .context("DB error")?
        } else if let Some(path) = args["path"].as_str() {
            sqlx::query(
                "SELECT id, graph_data, graph_hash, path FROM project_graphs WHERE path = $1 OR canonical_path = $1",
            )
            .bind(path)
            .fetch_optional(&self.db)
            .await
            .context("DB error")?
        } else {
            anyhow::bail!("Provide project_id, name, or path to identify the project");
        };

        match row {
            None => anyhow::bail!(
                "Project not found. Use project_graph_list to see available projects."
            ),
            Some(r) => {
                let id: Uuid = r.try_get("id").context("id")?;
                let graph_data: serde_json::Value =
                    r.try_get("graph_data").context("graph_data")?;
                let graph_hash: Option<String> = r.try_get("graph_hash").ok().flatten();
                let path: String = r.try_get("path").context("path")?;
                Ok((id, graph_data, graph_hash, path))
            }
        }
    }

    // ── Project graph tools ──────────────────────────────────────────────────

    async fn project_graph_list(
        &mut self,
        _args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let rows: Vec<project_graphs::ProjectGraphRow> = sqlx::query_as(
            r#"SELECT id, name, path, canonical_path, description, node_count, edge_count,
                      graph_hash, graph_file_size, imported_at, created_at, updated_at
               FROM project_graphs ORDER BY created_at DESC"#,
        )
        .fetch_all(&self.db)
        .await
        .context("failed to list project graphs")?;

        if rows.is_empty() {
            return Ok(json!({
                "content": [{"type": "text", "text": "No project graphs registered yet. Use project_graph_create to add one."}]
            }));
        }

        let mut text = format!("Registered project graphs ({}):\n\n", rows.len());
        for r in &rows {
            let size_str = r
                .graph_file_size
                .map(|b| format!("{:.1}KB", b as f64 / 1024.0))
                .unwrap_or_else(|| "-".to_string());
            let imported = r
                .imported_at
                .map(|t| t.format("%Y-%m-%d %H:%M").to_string())
                .unwrap_or_else(|| "-".to_string());
            text.push_str(&format!(
                "• {} [id: {}]\n  path: {}\n  nodes: {}  edges: {}  size: {}  imported: {}{}\n\n",
                r.name,
                r.id,
                r.path.as_deref().unwrap_or("-"),
                r.node_count,
                r.edge_count,
                size_str,
                imported,
                r.description
                    .as_deref()
                    .map(|d| format!("\n  desc: {}", d))
                    .unwrap_or_default(),
            ));
        }

        Ok(json!({ "content": [{ "type": "text", "text": text }] }))
    }

    async fn project_graph_create(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let name = args["name"].as_str().context("missing name")?.to_string();
        let path = args["path"].as_str().context("missing path")?.to_string();
        let description = args["description"].as_str().map(|s| s.to_string());

        let (data, hash, size, canonical) =
            indexer::index_project(&path).await?;
        let (node_count, edge_count) = project_graphs::count_nodes_edges(&data);
        let now = Utc::now();

        sqlx::query(
            r#"INSERT INTO project_graphs
                (name, path, canonical_path, description, node_count, edge_count,
                 graph_data, graph_hash, graph_file_size, imported_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
               ON CONFLICT (canonical_path) DO UPDATE SET
                 name            = EXCLUDED.name,
                 path            = EXCLUDED.path,
                 description     = COALESCE(EXCLUDED.description, project_graphs.description),
                 node_count      = EXCLUDED.node_count,
                 edge_count      = EXCLUDED.edge_count,
                 graph_data      = EXCLUDED.graph_data,
                 graph_hash      = EXCLUDED.graph_hash,
                 graph_file_size = EXCLUDED.graph_file_size,
                 imported_at     = EXCLUDED.imported_at,
                 updated_at      = NOW()"#,
        )
        .bind(&name)
        .bind(&path)
        .bind(&canonical)
        .bind(&description)
        .bind(node_count)
        .bind(edge_count)
        .bind(&data)
        .bind(&hash)
        .bind(size as i64)
        .bind(now)
        .execute(&self.db)
        .await
        .context("failed to insert project graph")?;

        Ok(json!({
            "content": [{
                "type": "text",
                "text": format!(
                    "Registered project '{}'\n  path: {}\n  nodes: {}  edges: {}  hash: {}",
                    name, path, node_count, edge_count, hash.get(..8).unwrap_or(&hash)
                )
            }]
        }))
    }

    async fn project_graph_query(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let q = args["q"].as_str().context("missing q")?.to_string();
        let hops = args["hops"].as_u64().unwrap_or(2).clamp(1, 4) as u8;
        let limit = args["limit"].as_u64().unwrap_or(50).clamp(1, 200) as usize;

        let (_id, graph_data, _hash, _path) = self.resolve_project_graph_data(args).await?;

        let resp = project_graphs::bfs_query(&graph_data, &q, hops, limit);

        if resp.seed_nodes.is_empty() {
            return Ok(json!({
                "content": [{
                    "type": "text",
                    "text": format!("No nodes found matching '{}'. Try a different keyword.", q)
                }]
            }));
        }

        // Group nodes by community
        let mut communities: std::collections::HashMap<i64, Vec<&project_graphs::GraphNode>> =
            std::collections::HashMap::new();
        for node in &resp.nodes {
            let comm = node.community.unwrap_or(-1);
            communities.entry(comm).or_default().push(node);
        }

        // Collect seed labels for display
        let seed_labels: Vec<String> = resp
            .seed_nodes
            .iter()
            .filter_map(|sid| {
                resp.nodes.iter().find(|n| &n.id == sid).map(|n| n.label.clone())
            })
            .collect();

        let mut text = format!(
            "Found {} seed node(s) matching '{}': [{}]. Expanded to {} nodes across {} communities.{}\n\n",
            resp.seed_nodes.len(),
            q,
            seed_labels.join(", "),
            resp.nodes.len(),
            communities.len(),
            if resp.truncated { " (truncated)" } else { "" }
        );

        // List nodes by community
        let mut comm_keys: Vec<i64> = communities.keys().cloned().collect();
        comm_keys.sort();
        for comm in comm_keys {
            let nodes = &communities[&comm];
            let comm_label = if comm == -1 {
                "unassigned".to_string()
            } else {
                format!("community {}", comm)
            };
            text.push_str(&format!("[{}]\n", comm_label));
            for node in nodes {
                let ft = node.file_type.as_deref().unwrap_or("?");
                let src = node.source_file.as_deref().unwrap_or("");
                let seed_marker = if resp.seed_nodes.contains(&node.id) { " *" } else { "" };
                text.push_str(&format!("  {} ({}) id={}{}\n", node.label, ft, node.id, seed_marker));
                if !src.is_empty() {
                    text.push_str(&format!("    source: {}\n", src));
                }
            }
            text.push('\n');
        }

        // List edges
        if !resp.edges.is_empty() {
            // Build id→label map for readable edge output
            let id_to_label: std::collections::HashMap<String, String> = resp.nodes
                .iter()
                .map(|n| (n.id.clone(), n.label.clone()))
                .collect();

            text.push_str(&format!("Edges ({}):\n", resp.edges.len()));
            for e in &resp.edges {
                text.push_str(&format!(
                    "  {} --[{}]--> {}\n",
                    id_to_label.get(&e.source).unwrap_or(&e.source),
                    e.relation,
                    id_to_label.get(&e.target).unwrap_or(&e.target),
                ));
            }
        }

        Ok(json!({ "content": [{ "type": "text", "text": text }] }))
    }

    async fn project_graph_node_detail(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let node_id = args["node_id"].as_str().context("missing node_id")?.to_string();
        let (_id, graph_data, _hash, _path) = self.resolve_project_graph_data(args).await?;

        // Find the node
        let empty_vec = vec![];
        let nodes_arr = graph_data["nodes"].as_array().unwrap_or(&empty_vec);
        let node_val = nodes_arr
            .iter()
            .find(|n| n["id"].as_str() == Some(&node_id));

        let node = match node_val {
            None => anyhow::bail!("Node '{}' not found in graph", node_id),
            Some(v) => project_graphs::node_from_json(&node_id, v),
        };

        // Find edges
        let links = graph_data["links"]
            .as_array()
            .or_else(|| graph_data["edges"].as_array());

        let mut outgoing: Vec<String> = vec![];
        let mut incoming: Vec<String> = vec![];

        if let Some(edges) = links {
            for e in edges {
                let src = e["source"].as_str().unwrap_or("");
                let tgt = e["target"].as_str().unwrap_or("");
                let rel = e["relation"].as_str().unwrap_or("related");
                if src == node_id {
                    outgoing.push(format!("  --[{}]--> {}", rel, tgt));
                } else if tgt == node_id {
                    incoming.push(format!("  <--[{}]-- {}", rel, src));
                }
            }
        }

        let mut text = format!(
            "Node: {} (id: {})\n  file_type: {}\n  community: {}\n  source_file: {}\n  source_location: {}\n\n",
            node.label,
            node.id,
            node.file_type.as_deref().unwrap_or("-"),
            node.community.map(|c| c.to_string()).unwrap_or_else(|| "-".to_string()),
            node.source_file.as_deref().unwrap_or("-"),
            node.source_location.as_deref().unwrap_or("-"),
        );

        text.push_str(&format!("Outgoing edges ({}):\n", outgoing.len()));
        if outgoing.is_empty() {
            text.push_str("  (none)\n");
        } else {
            for e in &outgoing {
                text.push_str(e);
                text.push('\n');
            }
        }

        text.push_str(&format!("\nIncoming edges ({}):\n", incoming.len()));
        if incoming.is_empty() {
            text.push_str("  (none)\n");
        } else {
            for e in &incoming {
                text.push_str(e);
                text.push('\n');
            }
        }

        Ok(json!({ "content": [{ "type": "text", "text": text }] }))
    }

    async fn project_graph_shortest_path(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let from_node = args["from_node"].as_str().context("missing from_node")?.to_string();
        let to_node = args["to_node"].as_str().context("missing to_node")?.to_string();
        let (_id, graph_data, _hash, _path) = self.resolve_project_graph_data(args).await?;

        match project_graphs::shortest_path(&graph_data, &from_node, &to_node) {
            None => Ok(json!({
                "content": [{
                    "type": "text",
                    "text": format!(
                        "No path found between '{}' and '{}'. They may be in disconnected components.",
                        from_node, to_node
                    )
                }]
            })),
            Some(path) => {
                let path_str: Vec<String> = path.iter().map(|n| n.label.clone()).collect();
                let text = format!(
                    "Shortest path ({} hops): {}\n\nNodes:\n{}",
                    path.len().saturating_sub(1),
                    path_str.join(" → "),
                    path.iter()
                        .enumerate()
                        .map(|(i, n)| format!(
                            "  {}. {} (id: {}, type: {})",
                            i + 1,
                            n.label,
                            n.id,
                            n.file_type.as_deref().unwrap_or("?")
                        ))
                        .collect::<Vec<_>>()
                        .join("\n")
                );
                Ok(json!({ "content": [{ "type": "text", "text": text }] }))
            }
        }
    }

    async fn project_graph_god_nodes(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let top_n = args["top_n"].as_u64().unwrap_or(10).clamp(1, 100) as usize;
        let (_id, graph_data, _hash, _path) = self.resolve_project_graph_data(args).await?;

        // Build adjacency to get degrees
        let adj = project_graphs::build_adjacency(&graph_data);
        let nodes = project_graphs::god_nodes(&graph_data, top_n);

        if nodes.is_empty() {
            return Ok(json!({
                "content": [{"type": "text", "text": "No nodes found in graph."}]
            }));
        }

        let mut text = format!("Top {} most-connected nodes:\n\n", nodes.len());
        for (i, node) in nodes.iter().enumerate() {
            let degree = adj.get(&node.id).map(|v| v.len()).unwrap_or(0);
            text.push_str(&format!(
                "{}. {} ({}) — {} connections\n   id: {}{}\n",
                i + 1,
                node.label,
                node.file_type.as_deref().unwrap_or("?"),
                degree,
                node.id,
                node.source_file
                    .as_deref()
                    .map(|s| format!("\n   source: {}", s))
                    .unwrap_or_default(),
            ));
        }

        Ok(json!({ "content": [{ "type": "text", "text": text }] }))
    }

    async fn project_graph_delete(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        // Require project_id or name — no path-only deletion for safety
        let result = if let Some(id_str) = args["project_id"].as_str() {
            let id = Uuid::parse_str(id_str).context("invalid project_id UUID")?;
            sqlx::query("DELETE FROM project_graphs WHERE id = $1 RETURNING name")
                .bind(id)
                .fetch_optional(&self.db)
                .await
                .context("failed to delete project graph")?
        } else if let Some(name) = args["name"].as_str() {
            sqlx::query(
                "DELETE FROM project_graphs WHERE name ILIKE $1 RETURNING name",
            )
            .bind(name)
            .fetch_optional(&self.db)
            .await
            .context("failed to delete project graph")?
        } else {
            anyhow::bail!("Provide project_id or name to delete a project (path-only deletion is not allowed for safety)");
        };

        match result {
            None => anyhow::bail!(
                "Project not found. Use project_graph_list to see available projects."
            ),
            Some(row) => {
                let deleted_name: String = row.try_get("name").context("failed to get project name from RETURNING")?;
                Ok(json!({
                    "content": [{
                        "type": "text",
                        "text": format!("Deleted project '{}'. Original files on disk are unchanged.", deleted_name)
                    }]
                }))
            }
        }
    }

    async fn project_graph_rebuild(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let (id, _graph_data, current_hash, path) =
            self.resolve_project_graph_data(args).await?;

        let (new_data, new_hash, new_size, _canonical) =
            indexer::index_project(&path).await?;

        // Skip if hash unchanged
        if current_hash.as_deref() == Some(&new_hash) {
            return Ok(json!({
                "content": [{
                    "type": "text",
                    "text": format!("Graph is unchanged (hash: {}). No rebuild needed.", new_hash.get(..8).unwrap_or(&new_hash))
                }]
            }));
        }

        let (node_count, edge_count) = project_graphs::count_nodes_edges(&new_data);
        let now = Utc::now();

        sqlx::query(
            r#"UPDATE project_graphs
               SET graph_data = $1, graph_hash = $2, graph_file_size = $3,
                   node_count = $4, edge_count = $5, imported_at = $6, updated_at = NOW()
               WHERE id = $7"#,
        )
        .bind(&new_data)
        .bind(&new_hash)
        .bind(new_size as i64)
        .bind(node_count)
        .bind(edge_count)
        .bind(now)
        .bind(id)
        .execute(&self.db)
        .await
        .context("failed to update project graph")?;

        Ok(json!({
            "content": [{
                "type": "text",
                "text": format!(
                    "Rebuilt project graph from {}\n  nodes: {}  edges: {}  new hash: {}",
                    path, node_count, edge_count, new_hash.get(..8).unwrap_or(&new_hash)
                )
            }]
        }))
    }

    async fn forecast_list(&mut self, _args: &serde_json::Value) -> Result<serde_json::Value> {
        let profiles = forecasts::list(&self.db).await?;
        let text = if profiles.is_empty() {
            "No forecast profiles configured. Use forecast_create to add one.".to_string()
        } else {
            serde_json::to_string_pretty(&profiles)?
        };
        Ok(json!({"content": [{"type": "text", "text": text}]}))
    }

    async fn forecast_create(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let input: forecasts::ForecastInput = serde_json::from_value(args.clone())
            .context("invalid forecast profile fields")?;
        input.validate().map_err(anyhow::Error::msg)?;
        let profile = forecasts::create(&self.db, &input).await?;
        Ok(json!({"content": [{"type": "text", "text": format!(
            "Created forecast profile '{}' [id: {}].", profile.name, profile.id
        )}]}))
    }

    async fn forecast_update(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let id = Uuid::parse_str(args["id"].as_str().context("missing id")?)
            .context("invalid forecast profile id")?;
        let input: forecasts::ForecastInput = serde_json::from_value(args.clone())
            .context("invalid forecast profile fields")?;
        input.validate().map_err(anyhow::Error::msg)?;
        let profile = forecasts::update(&self.db, id, &input).await?
            .context("forecast profile not found")?;
        Ok(json!({"content": [{"type": "text", "text": format!(
            "Updated forecast profile '{}' [id: {}].", profile.name, profile.id
        )}]}))
    }

    async fn forecast_delete(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let id = Uuid::parse_str(args["id"].as_str().context("missing id")?)
            .context("invalid forecast profile id")?;
        let deleted = sqlx::query("DELETE FROM forecast_profiles WHERE id = $1 RETURNING id")
            .bind(id).fetch_optional(&self.db).await?;
        deleted.context("forecast profile not found")?;
        Ok(json!({"content": [{"type": "text", "text": format!("Deleted forecast profile {id}.")}]}))
    }

    async fn design_budget_list(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let design_id = Uuid::parse_str(args["design_id"].as_str().context("missing design_id")?)
            .context("invalid design_id")?;
        let forecasts = design_budgets::list(&self.db, design_id).await?;
        let text = if forecasts.is_empty() { "No budget forecasts saved for this design.".into() }
            else { serde_json::to_string_pretty(&forecasts)? };
        Ok(json!({"content": [{"type": "text", "text": text}]}))
    }

    async fn design_budget_create(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let design_id = Uuid::parse_str(args["design_id"].as_str().context("missing design_id")?)
            .context("invalid design_id")?;
        let mut input: design_budgets::BudgetInput = serde_json::from_value(args.clone())
            .context("invalid budget forecast fields")?;
        input.created_by = Some("agent".into());
        input.validate().map_err(anyhow::Error::msg)?;
        let forecast = design_budgets::create(&self.db, design_id, &input).await?;
        Ok(json!({"content": [{"type": "text", "text": format!(
            "Created design budget '{}' [id: {}], estimated at {:.2} {} per month.",
            forecast.name, forecast.id, forecast.monthly_total_cents as f64 / 100.0, forecast.currency
        )}]}))
    }

    async fn design_budget_update(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let design_id = Uuid::parse_str(args["design_id"].as_str().context("missing design_id")?)
            .context("invalid design_id")?;
        let budget_id = Uuid::parse_str(args["budget_id"].as_str().context("missing budget_id")?)
            .context("invalid budget_id")?;
        let input: design_budgets::BudgetInput = serde_json::from_value(args.clone())
            .context("invalid budget forecast fields")?;
        input.validate().map_err(anyhow::Error::msg)?;
        let forecast = design_budgets::update(&self.db, design_id, budget_id, &input).await?
            .context("budget forecast not found")?;
        Ok(json!({"content": [{"type": "text", "text": format!(
            "Updated design budget '{}' [id: {}].", forecast.name, forecast.id
        )}]}))
    }

    async fn design_budget_delete(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let design_id = Uuid::parse_str(args["design_id"].as_str().context("missing design_id")?)
            .context("invalid design_id")?;
        let budget_id = Uuid::parse_str(args["budget_id"].as_str().context("missing budget_id")?)
            .context("invalid budget_id")?;
        let deleted = sqlx::query("DELETE FROM design_budget_forecasts WHERE id = $1 AND design_id = $2 RETURNING id")
            .bind(budget_id).bind(design_id).fetch_optional(&self.db).await?;
        deleted.context("budget forecast not found")?;
        Ok(json!({"content": [{"type": "text", "text": format!("Deleted design budget {budget_id}.")}]}))
    }

    async fn project_list(&mut self, _args: &serde_json::Value) -> Result<serde_json::Value> {
        let rows = sqlx::query(
            r#"SELECT p.id, p.name, p.path, p.description, p.node_count, p.edge_count,
                      COUNT(t.id) AS task_count
               FROM project_graphs p
               LEFT JOIN project_tasks t ON t.project_id = p.id
               GROUP BY p.id ORDER BY p.created_at DESC"#,
        )
        .fetch_all(&self.db)
        .await
        .context("failed to list projects")?;

        if rows.is_empty() {
            return Ok(json!({"content": [{"type": "text", "text": "No projects yet. Use project_create to add one."}]}));
        }

        let mut text = format!("Projects ({}):\n\n", rows.len());
        for r in &rows {
            let id: Uuid = r.try_get("id").unwrap_or(Uuid::nil());
            let name: String = r.try_get("name").unwrap_or_default();
            let path: Option<String> = r.try_get("path").unwrap_or(None);
            let task_count: i64 = r.try_get("task_count").unwrap_or(0);
            let node_count: i32 = r.try_get("node_count").unwrap_or(0);
            text.push_str(&format!(
                "• {} [id: {}]  tasks: {}  nodes: {}{}\n",
                name, id, task_count, node_count,
                path.as_deref().map(|p| format!("\n  path: {}", p)).unwrap_or_default(),
            ));
        }

        Ok(json!({"content": [{"type": "text", "text": text}]}))
    }

    async fn project_create(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let name = args["name"].as_str().context("missing name")?.to_string();
        let path_opt = args["path"].as_str().map(|s| s.to_string());
        let description = args["description"].as_str().map(|s| s.to_string());

        if let Some(ref path) = path_opt {
            let (data, hash, size, canonical) = indexer::index_project(path).await?;
            let (node_count, edge_count) = project_graphs::count_nodes_edges(&data);
            sqlx::query(
                r#"INSERT INTO project_graphs (name, path, canonical_path, description, node_count, edge_count,
                   graph_data, graph_hash, graph_file_size, imported_at)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
                   ON CONFLICT (canonical_path) DO UPDATE SET
                     name = EXCLUDED.name, description = COALESCE(EXCLUDED.description, project_graphs.description),
                     node_count = EXCLUDED.node_count, edge_count = EXCLUDED.edge_count,
                     graph_data = EXCLUDED.graph_data, graph_hash = EXCLUDED.graph_hash,
                     graph_file_size = EXCLUDED.graph_file_size, imported_at = EXCLUDED.imported_at,
                     updated_at = NOW()"#,
            )
            .bind(&name).bind(path).bind(&canonical).bind(&description)
            .bind(node_count).bind(edge_count).bind(&data)
            .bind(&hash).bind(size as i64)
            .execute(&self.db).await.context("failed to create project")?;
            Ok(json!({"content": [{"type": "text", "text": format!("Created project '{}' with graph ({} nodes, {} edges).", name, node_count, edge_count)}]}))
        } else {
            sqlx::query(
                "INSERT INTO project_graphs (name, path, canonical_path, description, graph_data) \
                 VALUES ($1, NULL, NULL, $2, '{}'::jsonb)"
            )
            .bind(&name).bind(&description)
            .execute(&self.db).await.context("failed to create project")?;
            Ok(json!({"content": [{"type": "text", "text": format!("Created project '{}' (no graph path — task management only).", name)}]}))
        }
    }

    async fn project_task_list(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let project_id: Uuid = args["project_id"].as_str()
            .context("missing project_id")?
            .parse().context("invalid project_id UUID")?;
        let status_filter = args["status"].as_str();
        let limit: i64 = args["limit"].as_i64().unwrap_or(50).min(200);
        let offset: i64 = args["offset"].as_i64().unwrap_or(0).max(0);

        let tasks = if let Some(status) = status_filter {
            sqlx::query(
                "SELECT id, title, status, priority, assigned_to, created_by, created_at, parent_id, start_date, due_date \
                 FROM project_tasks WHERE project_id = $1 AND status = $2 \
                 ORDER BY sort_order ASC, created_at DESC LIMIT $3 OFFSET $4"
            )
            .bind(project_id).bind(status).bind(limit).bind(offset)
            .fetch_all(&self.db).await
        } else {
            sqlx::query(
                "SELECT id, title, status, priority, assigned_to, created_by, created_at, parent_id, start_date, due_date \
                 FROM project_tasks WHERE project_id = $1 \
                 ORDER BY sort_order ASC, created_at DESC LIMIT $2 OFFSET $3"
            )
            .bind(project_id).bind(limit).bind(offset)
            .fetch_all(&self.db).await
        }.context("failed to list tasks")?;

        if tasks.is_empty() {
            return Ok(json!({"content": [{"type": "text", "text": "No tasks found."}]}));
        }

        let mut text = format!("Tasks ({}):\n\n", tasks.len());
        for t in &tasks {
            let id: Uuid = t.try_get("id").unwrap_or(Uuid::nil());
            let title: String = t.try_get("title").unwrap_or_default();
            let status: String = t.try_get("status").unwrap_or_default();
            let priority: String = t.try_get("priority").unwrap_or_default();
            let assigned: Option<String> = t.try_get("assigned_to").unwrap_or(None);
            let parent_id: Option<Uuid> = t.try_get("parent_id").unwrap_or(None);
            let due_date: Option<chrono::NaiveDate> = t.try_get("due_date").unwrap_or(None);
            text.push_str(&format!(
                "• [{}] {} ({}){}{}{}\n  id: {}\n",
                status, title, priority,
                assigned.as_deref().map(|a| format!(" → {}", a)).unwrap_or_default(),
                due_date.map(|d| format!(" due: {}", d)).unwrap_or_default(),
                parent_id.map(|p| format!(" parent: {}", p)).unwrap_or_default(),
                id
            ));
        }
        Ok(json!({"content": [{"type": "text", "text": text}]}))
    }

    async fn project_task_create(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let project_id: Uuid = args["project_id"].as_str()
            .context("missing project_id")?
            .parse().context("invalid project_id UUID")?;
        let title = args["title"].as_str().context("missing title")?.to_string();
        let description = args["description"].as_str().map(|s| s.to_string());
        let status = args["status"].as_str().unwrap_or("todo");
        let priority = args["priority"].as_str().unwrap_or("medium");
        let assigned_to = args["assigned_to"].as_str().map(|s| s.to_string());
        let parent_id: Option<Uuid> = args["parent_id"].as_str()
            .map(|s| s.parse::<Uuid>()).transpose().context("invalid parent_id UUID")?;
        let start_date: Option<chrono::NaiveDate> = args["start_date"].as_str()
            .map(|s| chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d")).transpose().context("invalid start_date, expected YYYY-MM-DD")?;
        let due_date: Option<chrono::NaiveDate> = args["due_date"].as_str()
            .map(|s| chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d")).transpose().context("invalid due_date, expected YYYY-MM-DD")?;

        if let Some(pid) = parent_id {
            let parent_project: Option<Uuid> = sqlx::query_scalar("SELECT project_id FROM project_tasks WHERE id = $1")
                .bind(pid).fetch_optional(&self.db).await.unwrap_or(None);
            if parent_project != Some(project_id) {
                anyhow::bail!("parent_id must reference a task in the same project");
            }
        }

        let row = sqlx::query(
            "INSERT INTO project_tasks (project_id, title, description, status, priority, assigned_to, created_by, parent_id, start_date, due_date) \
             VALUES ($1, $2, $3, $4, $5, $6, 'agent', $7, $8, $9) RETURNING id"
        )
        .bind(project_id).bind(&title).bind(&description)
        .bind(status).bind(priority).bind(&assigned_to)
        .bind(parent_id).bind(start_date).bind(due_date)
        .fetch_one(&self.db).await.context("failed to create task")?;

        let id: Uuid = row.try_get("id").unwrap_or(Uuid::nil());
        Ok(json!({"content": [{"type": "text", "text": format!("Created task '{}' [{}] id: {}", title, status, id)}]}))
    }

    async fn project_task_update(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let project_id: Uuid = args["project_id"].as_str()
            .context("missing project_id")?
            .parse().context("invalid project_id UUID")?;
        let task_id: Uuid = args["task_id"].as_str()
            .context("missing task_id")?
            .parse().context("invalid task_id UUID")?;

        let title = args["title"].as_str().map(|s| s.to_string());
        let description = args["description"].as_str().map(|s| s.to_string());
        let status = args["status"].as_str().map(|s| s.to_string());
        let priority = args["priority"].as_str().map(|s| s.to_string());
        let assigned_to = args["assigned_to"].as_str().map(|s| s.to_string());

        let parent_id_set = args.get("parent_id").is_some();
        let parent_id_value: Option<Uuid> = args["parent_id"].as_str()
            .map(|s| s.parse::<Uuid>()).transpose().context("invalid parent_id UUID")?;
        let start_date_set = args.get("start_date").is_some();
        let start_date_value: Option<chrono::NaiveDate> = args["start_date"].as_str()
            .map(|s| chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d")).transpose().context("invalid start_date, expected YYYY-MM-DD")?;
        let due_date_set = args.get("due_date").is_some();
        let due_date_value: Option<chrono::NaiveDate> = args["due_date"].as_str()
            .map(|s| chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d")).transpose().context("invalid due_date, expected YYYY-MM-DD")?;

        if let Some(new_parent_id) = parent_id_value {
            let parent_project: Option<Uuid> = sqlx::query_scalar("SELECT project_id FROM project_tasks WHERE id = $1")
                .bind(new_parent_id).fetch_optional(&self.db).await.unwrap_or(None);
            if parent_project != Some(project_id) {
                anyhow::bail!("parent_id must reference a task in the same project");
            }
            if would_create_cycle(&self.db, task_id, new_parent_id).await.context("cycle check failed")? {
                anyhow::bail!("parent_id would create a cycle");
            }
        }

        let result = sqlx::query(
            "UPDATE project_tasks SET \
             title = COALESCE($1, title), \
             description = CASE WHEN $2::text IS NOT NULL THEN $2 ELSE description END, \
             status = COALESCE($3, status), \
             priority = COALESCE($4, priority), \
             assigned_to = CASE WHEN $5::text IS NOT NULL THEN $5 ELSE assigned_to END, \
             parent_id = CASE WHEN $8 THEN $9 ELSE parent_id END, \
             start_date = CASE WHEN $10 THEN $11 ELSE start_date END, \
             due_date = CASE WHEN $12 THEN $13 ELSE due_date END, \
             updated_at = NOW() \
             WHERE id = $6 AND project_id = $7 RETURNING id"
        )
        .bind(&title).bind(&description).bind(&status).bind(&priority).bind(&assigned_to)
        .bind(task_id).bind(project_id)
        .bind(parent_id_set).bind(parent_id_value)
        .bind(start_date_set).bind(start_date_value)
        .bind(due_date_set).bind(due_date_value)
        .fetch_optional(&self.db).await.context("failed to update task")?;

        if result.is_none() {
            return Ok(json!({"content": [{"type": "text", "text": "Task not found."}]}));
        }
        Ok(json!({"content": [{"type": "text", "text": format!("Updated task {}.", task_id)}]}))
    }

    async fn project_task_delete(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let project_id: Uuid = args["project_id"].as_str()
            .context("missing project_id")?
            .parse().context("invalid project_id UUID")?;
        let task_id: Uuid = args["task_id"].as_str()
            .context("missing task_id")?
            .parse().context("invalid task_id UUID")?;

        let result = sqlx::query(
            "DELETE FROM project_tasks WHERE id = $1 AND project_id = $2 RETURNING id"
        )
        .bind(task_id).bind(project_id)
        .fetch_optional(&self.db).await.context("failed to delete task")?;

        if result.is_none() {
            return Ok(json!({"content": [{"type": "text", "text": "Task not found."}]}));
        }
        Ok(json!({"content": [{"type": "text", "text": format!("Deleted task {}.", task_id)}]}))
    }

    async fn lesson_create(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let project_id: Uuid = args["project_id"].as_str()
            .context("missing project_id")?
            .parse().context("invalid project_id UUID")?;
        let title = args["title"].as_str().context("missing title")?.to_string();
        let rule = args["rule"].as_str().context("missing rule")?.to_string();
        let context_val = args["context"].as_str().map(|s| s.to_string());
        let category = args["category"].as_str().unwrap_or("correction");
        let severity = args["severity"].as_str().unwrap_or("medium");
        let tags: Vec<String> = normalize_lesson_tags(&(args["tags"]
            .as_array()
            .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect::<Vec<String>>())
            .unwrap_or_default()));

        let existing: Option<Uuid> = sqlx::query_scalar(
            "SELECT id FROM project_lessons WHERE project_id = $1 AND status = 'active' AND lower(trim(title)) = lower(trim($2))"
        )
        .bind(project_id).bind(&title)
        .fetch_optional(&self.db).await.unwrap_or(None);

        if let Some(lesson_id) = existing {
            let row = sqlx::query(
                "UPDATE project_lessons SET occurrences = occurrences + 1, last_seen_at = NOW(), updated_at = NOW() \
                 WHERE id = $1 RETURNING occurrences"
            )
            .bind(lesson_id)
            .fetch_one(&self.db).await.context("failed to bump lesson occurrences")?;
            let occurrences: i32 = row.try_get("occurrences").unwrap_or(1);
            return Ok(json!({"content": [{"type": "text", "text": format!(
                "Lesson '{}' already recorded — bumped occurrences to {}. id: {}", title, occurrences, lesson_id
            )}]}));
        }

        let row = sqlx::query(
            "INSERT INTO project_lessons (project_id, title, context, rule, category, severity, tags) \
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id"
        )
        .bind(project_id).bind(&title).bind(&context_val).bind(&rule)
        .bind(category).bind(severity).bind(&tags)
        .fetch_one(&self.db).await.context("failed to create lesson")?;

        let id: Uuid = row.try_get("id").unwrap_or(Uuid::nil());
        Ok(json!({"content": [{"type": "text", "text": format!("Created lesson '{}' [{}] id: {}", title, category, id)}]}))
    }

    async fn lesson_list(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let project_id: Option<Uuid> = args["project_id"].as_str()
            .map(|s| s.parse::<Uuid>()).transpose().context("invalid project_id UUID")?;
        let query = args["query"].as_str();
        let category = args["category"].as_str();
        let tags: Vec<String> = normalize_lesson_tags(&(args["tags"]
            .as_array()
            .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect::<Vec<String>>())
            .unwrap_or_default()));
        let status = args["status"].as_str().unwrap_or("active");
        let limit: i64 = args["limit"].as_i64().unwrap_or(50).min(200);
        let offset: i64 = args["offset"].as_i64().unwrap_or(0).max(0);

        let cols = "id, project_id, title, context, rule, category, severity, status, tags, occurrences, last_seen_at";

        let rows = match (project_id, query) {
            (Some(pid), Some(q)) => sqlx::query(&format!(
                "SELECT {cols} FROM project_lessons \
                 WHERE project_id = $1 AND status = $2 \
                   AND ($3::text IS NULL OR category = $3) \
                   AND (cardinality($4::text[]) = 0 OR tags && $4) \
                   AND to_tsvector('english', title || ' ' || coalesce(context,'') || ' ' || rule) @@ plainto_tsquery('english', $5) \
                 ORDER BY ts_rank(to_tsvector('english', title || ' ' || coalesce(context,'') || ' ' || rule), plainto_tsquery('english', $5)) DESC \
                 LIMIT $6 OFFSET $7"
            ))
            .bind(pid).bind(status).bind(category).bind(&tags).bind(q).bind(limit).bind(offset)
            .fetch_all(&self.db).await,
            (Some(pid), None) => sqlx::query(&format!(
                "SELECT {cols} FROM project_lessons \
                 WHERE project_id = $1 AND status = $2 \
                   AND ($3::text IS NULL OR category = $3) \
                   AND (cardinality($4::text[]) = 0 OR tags && $4) \
                 ORDER BY severity DESC, last_seen_at DESC \
                 LIMIT $5 OFFSET $6"
            ))
            .bind(pid).bind(status).bind(category).bind(&tags).bind(limit).bind(offset)
            .fetch_all(&self.db).await,
            (None, Some(q)) => sqlx::query(&format!(
                "SELECT {cols} FROM project_lessons \
                 WHERE status = $1 \
                   AND ($2::text IS NULL OR category = $2) \
                   AND (cardinality($3::text[]) = 0 OR tags && $3) \
                   AND to_tsvector('english', title || ' ' || coalesce(context,'') || ' ' || rule) @@ plainto_tsquery('english', $4) \
                 ORDER BY ts_rank(to_tsvector('english', title || ' ' || coalesce(context,'') || ' ' || rule), plainto_tsquery('english', $4)) DESC \
                 LIMIT $5 OFFSET $6"
            ))
            .bind(status).bind(category).bind(&tags).bind(q).bind(limit).bind(offset)
            .fetch_all(&self.db).await,
            (None, None) => sqlx::query(&format!(
                "SELECT {cols} FROM project_lessons \
                 WHERE status = $1 \
                   AND ($2::text IS NULL OR category = $2) \
                   AND (cardinality($3::text[]) = 0 OR tags && $3) \
                 ORDER BY severity DESC, last_seen_at DESC \
                 LIMIT $4 OFFSET $5"
            ))
            .bind(status).bind(category).bind(&tags).bind(limit).bind(offset)
            .fetch_all(&self.db).await,
        }.context("failed to list lessons")?;

        if rows.is_empty() {
            return Ok(json!({"content": [{"type": "text", "text": "No lessons found."}]}));
        }

        let mut text = format!("Lessons ({}):\n\n", rows.len());
        for r in &rows {
            let id: Uuid = r.try_get("id").unwrap_or(Uuid::nil());
            let title: String = r.try_get("title").unwrap_or_default();
            let rule: String = r.try_get("rule").unwrap_or_default();
            let context_val: Option<String> = r.try_get("context").unwrap_or(None);
            let category: String = r.try_get("category").unwrap_or_default();
            let severity: String = r.try_get("severity").unwrap_or_default();
            let occurrences: i32 = r.try_get("occurrences").unwrap_or(1);
            text.push_str(&format!(
                "• [{}/{}] {} (x{})\n  rule: {}{}\n  id: {}\n",
                category, severity, title, occurrences, rule,
                context_val.map(|c| format!("\n  context: {}", c)).unwrap_or_default(),
                id
            ));
        }
        Ok(json!({"content": [{"type": "text", "text": text}]}))
    }

    async fn lesson_update(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let project_id: Uuid = args["project_id"].as_str()
            .context("missing project_id")?
            .parse().context("invalid project_id UUID")?;
        let lesson_id: Uuid = args["lesson_id"].as_str()
            .context("missing lesson_id")?
            .parse().context("invalid lesson_id UUID")?;

        let title = args["title"].as_str().map(|s| s.to_string());
        let context_set = args.get("context").is_some();
        let context_value = args["context"].as_str().map(|s| s.to_string());
        let rule = args["rule"].as_str().map(|s| s.to_string());
        let category = args["category"].as_str().map(|s| s.to_string());
        let severity = args["severity"].as_str().map(|s| s.to_string());
        let status = args["status"].as_str().map(|s| s.to_string());
        let tags: Option<Vec<String>> = args["tags"].as_array().map(|arr| {
            normalize_lesson_tags(&arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect::<Vec<_>>())
        });

        let result = sqlx::query(
            "UPDATE project_lessons SET \
             title = COALESCE($1, title), \
             context = CASE WHEN $2 THEN $3 ELSE context END, \
             rule = COALESCE($4, rule), \
             category = COALESCE($5, category), \
             severity = COALESCE($6, severity), \
             status = COALESCE($7, status), \
             tags = COALESCE($8, tags), \
             updated_at = NOW() \
             WHERE id = $9 AND project_id = $10 RETURNING id"
        )
        .bind(&title).bind(context_set).bind(&context_value)
        .bind(&rule).bind(&category).bind(&severity).bind(&status).bind(&tags)
        .bind(lesson_id).bind(project_id)
        .fetch_optional(&self.db).await.context("failed to update lesson")?;

        if result.is_none() {
            return Ok(json!({"content": [{"type": "text", "text": "Lesson not found."}]}));
        }
        Ok(json!({"content": [{"type": "text", "text": format!("Updated lesson {}.", lesson_id)}]}))
    }

    async fn lesson_delete(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let project_id: Uuid = args["project_id"].as_str()
            .context("missing project_id")?
            .parse().context("invalid project_id UUID")?;
        let lesson_id: Uuid = args["lesson_id"].as_str()
            .context("missing lesson_id")?
            .parse().context("invalid lesson_id UUID")?;

        let result = sqlx::query(
            "DELETE FROM project_lessons WHERE id = $1 AND project_id = $2 RETURNING id"
        )
        .bind(lesson_id).bind(project_id)
        .fetch_optional(&self.db).await.context("failed to delete lesson")?;

        if result.is_none() {
            return Ok(json!({"content": [{"type": "text", "text": "Lesson not found."}]}));
        }
        Ok(json!({"content": [{"type": "text", "text": format!("Deleted lesson {}.", lesson_id)}]}))
    }

    async fn routine_check(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let project_id_opt = args["project_id"].as_str()
            .map(|s| s.parse::<Uuid>())
            .transpose().context("invalid project_id UUID")?;
        let dry_run = args["dry_run"].as_bool().unwrap_or(false);

        let all = if let Some(pid) = project_id_opt {
            sqlx::query(
                r#"SELECT id, project_id, title, description, frequency, priority, assigned_to, last_task_date
                   FROM project_routines WHERE project_id = $1 AND enabled = TRUE"#
            ).bind(pid).fetch_all(&self.db).await
        } else {
            sqlx::query(
                r#"SELECT id, project_id, title, description, frequency, priority, assigned_to, last_task_date
                   FROM project_routines WHERE enabled = TRUE"#
            ).fetch_all(&self.db).await
        }.context("failed to query routines")?;

        let due: Vec<_> = all.iter().filter(|r| {
            let freq: String = r.try_get("frequency").unwrap_or_default();
            let last: Option<chrono::NaiveDate> = r.try_get("last_task_date").unwrap_or(None);
            is_routine_due_mcp(&freq, last)
        }).collect();

        if due.is_empty() {
            return Ok(json!({"content": [{"type": "text", "text": "No routine tasks are due right now."}]}));
        }

        if dry_run {
            let mut text = format!("{} routine(s) due (dry run — no tasks created):\n\n", due.len());
            for r in &due {
                let title: String = r.try_get("title").unwrap_or_default();
                let freq: String = r.try_get("frequency").unwrap_or_default();
                text.push_str(&format!("• {} ({})\n", title, freq));
            }
            return Ok(json!({"content": [{"type": "text", "text": text}]}));
        }

        let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
        let mut created = Vec::new();

        for r in &due {
            let id: Uuid = r.try_get("id").unwrap_or(Uuid::nil());
            let project_id: Uuid = r.try_get("project_id").unwrap_or(Uuid::nil());
            let title: String = r.try_get("title").unwrap_or_default();
            let description: Option<String> = r.try_get("description").unwrap_or(None);
            let priority: String = r.try_get("priority").unwrap_or_else(|_| "medium".to_string());
            let assigned_to: Option<String> = r.try_get("assigned_to").unwrap_or(None);

            let task_title = format!("{} — {}", title, today);
            let task = sqlx::query(
                "INSERT INTO project_tasks \
                 (project_id, routine_id, title, description, status, priority, assigned_to, created_by) \
                 VALUES ($1, $2, $3, $4, 'todo', $5, $6, 'agent') RETURNING id"
            )
            .bind(project_id).bind(id).bind(&task_title).bind(&description)
            .bind(&priority).bind(&assigned_to)
            .fetch_one(&self.db).await;

            if let Ok(row) = task {
                let task_id: Uuid = row.try_get("id").unwrap_or(Uuid::nil());
                created.push(format!("• {} [id: {}]", task_title, task_id));
                let _ = sqlx::query(
                    "UPDATE project_routines SET last_task_date = CURRENT_DATE, updated_at = NOW() WHERE id = $1"
                ).bind(id).execute(&self.db).await;
            }
        }

        let mut text = format!("Created {} task(s) from routines:\n\n", created.len());
        for line in &created {
            text.push_str(line);
            text.push('\n');
        }
        text.push_str("\nThese tasks are in status 'todo'. Handle them, then mark as done.");
        Ok(json!({"content": [{"type": "text", "text": text}]}))
    }

    async fn routine_list(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let project_id: Uuid = args["project_id"].as_str()
            .context("missing project_id")?
            .parse().context("invalid project_id UUID")?;

        let rows = sqlx::query(
            "SELECT id, title, frequency, priority, assigned_to, last_task_date, enabled \
             FROM project_routines WHERE project_id = $1 ORDER BY created_at ASC"
        )
        .bind(project_id)
        .fetch_all(&self.db).await.context("failed to list routines")?;

        if rows.is_empty() {
            return Ok(json!({"content": [{"type": "text", "text": "No routines defined. Use routine_create to add one."}]}));
        }

        let mut text = format!("Routines ({}):\n\n", rows.len());
        for r in &rows {
            let id: Uuid = r.try_get("id").unwrap_or(Uuid::nil());
            let title: String = r.try_get("title").unwrap_or_default();
            let freq: String = r.try_get("frequency").unwrap_or_default();
            let priority: String = r.try_get("priority").unwrap_or_default();
            let enabled: bool = r.try_get("enabled").unwrap_or(true);
            let last: Option<chrono::NaiveDate> = r.try_get("last_task_date").unwrap_or(None);
            text.push_str(&format!(
                "• {} [{}] {} — last run: {}{}\n  id: {}\n",
                title, freq, priority,
                last.map(|d| d.to_string()).unwrap_or_else(|| "never".to_string()),
                if !enabled { " (disabled)" } else { "" },
                id
            ));
        }
        Ok(json!({"content": [{"type": "text", "text": text}]}))
    }

    async fn routine_create(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let project_id: Uuid = args["project_id"].as_str()
            .context("missing project_id")?
            .parse().context("invalid project_id UUID")?;
        let title = args["title"].as_str().context("missing title")?.to_string();
        let description = args["description"].as_str().map(|s| s.to_string());
        let frequency = args["frequency"].as_str().unwrap_or("daily");
        let priority = args["priority"].as_str().unwrap_or("medium");
        let assigned_to = args["assigned_to"].as_str().map(|s| s.to_string());

        let row = sqlx::query(
            "INSERT INTO project_routines (project_id, title, description, frequency, priority, assigned_to) \
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id"
        )
        .bind(project_id).bind(&title).bind(&description)
        .bind(frequency).bind(priority).bind(&assigned_to)
        .fetch_one(&self.db).await.context("failed to create routine")?;

        let id: Uuid = row.try_get("id").unwrap_or(Uuid::nil());
        Ok(json!({"content": [{"type": "text", "text": format!(
            "Created {} routine '{}'. Run routine_check to generate today's task.\n  id: {}",
            frequency, title, id
        )}]}))
    }
}

fn format_facts(facts: &[falkordb::FactResult], label: &str) -> String {
    if facts.is_empty() {
        return format!("No facts found for {}.", label);
    }
    let mut text = format!("Found {} fact(s) for {}:\n\n", facts.len(), label);
    for (i, f) in facts.iter().enumerate() {
        let status = if f.is_current { "current" } else { "expired" };
        text.push_str(&format!(
            "{}. [{}] {} -[{}]-> {}\n   Fact: {}\n   Valid: {}{}\n\n",
            i + 1,
            status,
            f.subject_name,
            f.relationship,
            f.object_name,
            f.fact,
            f.valid_at,
            f.invalid_at.as_deref().map(|t| format!(" → {}", t)).unwrap_or_default(),
        ));
    }
    text
}

/// Render a memory_search result set as a mermaid `graph TD` block: result memories
/// as nodes, RELATED_TO/LINKED_TO edges between them, plus any related entities/facts.
fn build_mermaid(
    results: &[SearchResult],
    edges: &[(Uuid, Uuid, String)],
    facts: &[falkordb::FactResult],
) -> String {
    let mut out = String::from("graph TD\n");
    for r in results {
        let node_id = format!("M_{}", &r.id.simple().to_string()[..8]);
        let label = r.summary.clone().unwrap_or_else(|| r.content.clone());
        out.push_str(&format!("  {node_id}[\"{}\"]\n", mermaid_escape(&label)));
    }
    for (a, b, rel) in edges {
        let a_id = format!("M_{}", &a.simple().to_string()[..8]);
        let b_id = format!("M_{}", &b.simple().to_string()[..8]);
        out.push_str(&format!("  {a_id} ---|{}| {b_id}\n", mermaid_escape(rel)));
    }
    let mut seen_entities = std::collections::HashSet::new();
    for f in facts {
        let a_id = format!("E_{}", mermaid_id(&f.subject_name));
        let b_id = format!("E_{}", mermaid_id(&f.object_name));
        if seen_entities.insert(f.subject_name.clone()) {
            out.push_str(&format!("  {a_id}[\"{}\"]\n", mermaid_escape(&f.subject_name)));
        }
        if seen_entities.insert(f.object_name.clone()) {
            out.push_str(&format!("  {b_id}[\"{}\"]\n", mermaid_escape(&f.object_name)));
        }
        out.push_str(&format!("  {a_id} -->|{}| {b_id}\n", mermaid_escape(&f.relationship)));
    }
    out
}

fn mermaid_escape(s: &str) -> String {
    s.chars()
        .take(60)
        .collect::<String>()
        .replace('"', "'")
        .replace(['[', ']', '{', '}', '|', '\n'], " ")
}

fn mermaid_id(name: &str) -> String {
    let id: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '_' })
        .collect();
    if id.is_empty() {
        "unknown".to_string()
    } else {
        id
    }
}

/// Tags shared by more than this fraction of all memories are excluded from
/// RELATED_TO auto-linking — see `frequent_tags` doc comment.
const AUTO_LINK_TAG_MAX_FRACTION: f64 = 0.02;

/// Tags present on more than `min_fraction` of all memories — excluded from the
/// RELATED_TO auto-linking predicate since they're boilerplate/administrative
/// (e.g. "session"/"watcher" injected on every auto-captured memory), not a
/// meaningful relatedness signal. Without this, a handful of near-universal tags
/// turn the whole graph into a supernode (millions of edges, unqueryable).
/// `candidate_tags = Some(...)` scopes the check to just those tags (cheap, used
/// on the hot memory_save path); `None` scans all distinct tags (used by the
/// bulk rebuild, which needs the full picture).
/// Walks the ancestor chain starting at `new_parent_id` to check whether making it the
/// parent of `task_id` would introduce a cycle (including `new_parent_id == task_id`).
async fn would_create_cycle(db: &PgPool, task_id: Uuid, new_parent_id: Uuid) -> Result<bool, sqlx::Error> {
    let mut current = new_parent_id;
    loop {
        if current == task_id {
            return Ok(true);
        }
        let parent: Option<Uuid> = sqlx::query_scalar("SELECT parent_id FROM project_tasks WHERE id = $1")
            .bind(current)
            .fetch_optional(db)
            .await?
            .flatten();
        match parent {
            Some(next) => current = next,
            None => return Ok(false),
        }
    }
}

async fn frequent_tags(db: &PgPool, candidate_tags: Option<&[String]>, min_fraction: f64) -> Vec<String> {
    let rows: Vec<(String,)> = match candidate_tags {
        Some(tags) if !tags.is_empty() => sqlx::query_as(
            "WITH total AS (SELECT count(*)::float8 AS n FROM memory_index), \
             freq AS (SELECT tag, count(*) AS c FROM (SELECT unnest(tags) AS tag FROM memory_index) t \
                      WHERE tag = ANY($1) GROUP BY tag) \
             SELECT freq.tag FROM freq, total WHERE freq.c > total.n * $2"
        )
        .bind(tags)
        .bind(min_fraction)
        .fetch_all(db)
        .await
        .unwrap_or_default(),
        Some(_) => vec![],
        None => sqlx::query_as(
            "WITH total AS (SELECT count(*)::float8 AS n FROM memory_index), \
             freq AS (SELECT tag, count(*) AS c FROM (SELECT unnest(tags) AS tag FROM memory_index) t GROUP BY tag) \
             SELECT freq.tag FROM freq, total WHERE freq.c > total.n * $1"
        )
        .bind(min_fraction)
        .fetch_all(db)
        .await
        .unwrap_or_default(),
    };
    rows.into_iter().map(|(t,)| t).collect()
}

/// Truncated, single-line preview of memory content — used as a graph-node label
/// fallback when no explicit summary was set (e.g. watcher-captured memories).
fn content_preview(content: &str) -> String {
    let flat: String = content.split_whitespace().collect::<Vec<_>>().join(" ");
    let truncated: String = flat.chars().take(100).collect();
    if flat.chars().count() > 100 {
        format!("{truncated}…")
    } else {
        truncated
    }
}

fn compute_combined_score(importance: f32, created_at: DateTime<Utc>) -> f32 {
    let recency = recency_score(created_at);
    (importance * 0.6) + (recency * 0.4)
}

fn recency_score(created_at: DateTime<Utc>) -> f32 {
    let age = Utc::now().signed_duration_since(created_at);
    let age_days = age.num_seconds().max(0) as f32 / (60.0 * 60.0 * 24.0);
    (-age_days / 30.0).exp().clamp(0.0, 1.0)
}


#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "openmemory=info".into()),
        )
        .with_writer(std::io::stderr)
        .init();

    info!("openmemory MCP server starting (PostgreSQL + OpenSearch)");

    let mut server = McpServer::new().await?;
    let stdin = tokio::io::stdin();
    let mut stdout = tokio::io::stdout();
    let mut reader = BufReader::new(stdin);
    let mut line = String::new();

    loop {
        line.clear();
        let bytes_read = reader.read_line(&mut line).await?;

        if bytes_read == 0 {
            break; // EOF
        }

        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        match serde_json::from_str::<JsonRpcRequest>(trimmed) {
            Ok(req) => {
                let response = server.handle_request(req).await;
                let response_json = serde_json::to_string(&response)?;
                stdout.write_all(response_json.as_bytes()).await?;
                stdout.write_all(b"\n").await?;
                stdout.flush().await?;
            }
            Err(e) => {
                error!("failed to parse request: {}", e);
                // Send error response
                let error_response = JsonRpcResponse {
                    jsonrpc: "2.0".to_string(),
                    id: None,
                    result: None,
                    error: Some(JsonRpcError {
                        code: -32700,
                        message: format!("Parse error: {}", e),
                    }),
                };
                let response_json = serde_json::to_string(&error_response)?;
                stdout.write_all(response_json.as_bytes()).await?;
                stdout.write_all(b"\n").await?;
                stdout.flush().await?;
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod mermaid_tests {
    use super::*;

    fn result(id: Uuid, content: &str, summary: Option<&str>) -> SearchResult {
        SearchResult {
            id,
            content: content.to_string(),
            summary: summary.map(|s| s.to_string()),
            tags: vec![],
            importance_score: 0.5,
            created_at: Utc::now(),
            score: 0.5,
            via_graph: false,
        }
    }

    #[test]
    fn mermaid_escape_truncates_and_strips_special_chars() {
        let input = "a\"b[c]{d}|e\nf".to_string() + &"x".repeat(100);
        let escaped = mermaid_escape(&input);
        assert!(escaped.len() <= 60);
        assert!(!escaped.contains(['"', '[', ']', '{', '}', '|', '\n']));
    }

    #[test]
    fn mermaid_id_replaces_non_alphanumeric() {
        assert_eq!(mermaid_id("Alice O'Brien"), "Alice_O_Brien");
        assert_eq!(mermaid_id(""), "unknown");
    }

    #[test]
    fn build_mermaid_renders_nodes_and_edges() {
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let results = vec![
            result(a, "content A", Some("summary A")),
            result(b, "content B", None),
        ];
        let edges = vec![(a, b, "RELATED_TO".to_string())];
        let facts = vec![];

        let mermaid = build_mermaid(&results, &edges, &facts);

        assert!(mermaid.starts_with("graph TD\n"));
        assert!(mermaid.contains("summary A"));
        assert!(mermaid.contains("content B")); // falls back to content when summary is None
        assert!(mermaid.contains("---|RELATED_TO|"));
    }

    #[test]
    fn build_mermaid_includes_fact_edges_and_dedupes_entities() {
        let results = vec![];
        let edges = vec![];
        let facts = vec![
            falkordb::FactResult {
                fact_id: "f1".to_string(),
                subject_name: "Alice".to_string(),
                subject_type: "Person".to_string(),
                relationship: "member_of".to_string(),
                fact: "Alice is a member of Team".to_string(),
                object_name: "Team".to_string(),
                object_type: "Team".to_string(),
                valid_at: "2026-01-01T00:00:00Z".to_string(),
                invalid_at: None,
                episode_id: None,
                is_current: true,
            },
            falkordb::FactResult {
                fact_id: "f2".to_string(),
                subject_name: "Alice".to_string(),
                subject_type: "Person".to_string(),
                relationship: "leads".to_string(),
                fact: "Alice leads Team".to_string(),
                object_name: "Team".to_string(),
                object_type: "Team".to_string(),
                valid_at: "2026-01-01T00:00:00Z".to_string(),
                invalid_at: None,
                episode_id: None,
                is_current: true,
            },
        ];

        let mermaid = build_mermaid(&results, &edges, &facts);

        // Entity node lines should appear exactly once each despite two facts sharing them.
        assert_eq!(mermaid.matches("E_Alice[\"Alice\"]").count(), 1);
        assert_eq!(mermaid.matches("E_Team[\"Team\"]").count(), 1);
        assert!(mermaid.contains("-->|member_of|"));
        assert!(mermaid.contains("-->|leads|"));
    }
}
