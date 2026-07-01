#![recursion_limit = "512"]

mod crypto;
mod falkordb;
mod project_graphs;

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

        let secret_key = std::env::var("OPENMEMORY_SECRET_KEY")
            .unwrap_or_else(|_| "dev-secret-key-change-me".to_string());
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
                    "name": "env_http_request",
                    "description": "Make an HTTP request with a stored secret injected as the auth header. The secret value is never exposed to the agent — the server resolves it internally and forwards the request. Use this to call external APIs (Cloudflare, GitHub, etc.) whose credentials are stored as secret env params.",
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
                            "auth_key": {
                                "type": "string",
                                "description": "Name of the secret env param whose value will be used as the auth credential (e.g. CLAUDEFLARE_API_TOKEN_ACCESS)"
                            },
                            "auth_header": {
                                "type": "string",
                                "description": "Header name for the credential. Defaults to 'Authorization'."
                            },
                            "auth_prefix": {
                                "type": "string",
                                "description": "Prefix for the header value. Defaults to 'Bearer '. Set to '' for bare token headers like X-Auth-Key."
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
                        "required": ["method", "url", "auth_key"]
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
                    "description": "Register a local folder as a project and import its graphify-generated knowledge graph. The folder must already have a graphify-out/graph.json file — run `/graphify {path}` in Claude Code first if it does not.",
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
                    "description": "Re-import a project's graph.json from disk. Run after updating the project with /graphify. Skips if the file hash is unchanged.",
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
                            "path": {"type": "string", "description": "Optional: absolute path to a folder with graphify-out/graph.json"},
                            "description": {"type": "string", "description": "Optional description"}
                        },
                        "required": ["name"]
                    }
                },
                {
                    "name": "project_task_list",
                    "description": "List tasks for a project. Optionally filter by status (todo, in_progress, done).",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "project_id": {"type": "string", "description": "UUID of the project"},
                            "status": {"type": "string", "description": "Filter by status: todo | in_progress | done"},
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
                            "status": {"type": "string", "description": "todo | in_progress | done (default: todo)"},
                            "priority": {"type": "string", "description": "low | medium | high (default: medium)"},
                            "assigned_to": {"type": "string", "description": "human | agent | null"}
                        },
                        "required": ["project_id", "title"]
                    }
                },
                {
                    "name": "project_task_update",
                    "description": "Update a task's title, description, status, priority, or assigned_to. Only provided fields are changed.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "project_id": {"type": "string"},
                            "task_id": {"type": "string"},
                            "title": {"type": "string"},
                            "description": {"type": "string"},
                            "status": {"type": "string", "description": "todo | in_progress | done"},
                            "priority": {"type": "string", "description": "low | medium | high"},
                            "assigned_to": {"type": "string", "description": "human | agent | null"}
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
            "env_list" => self.env_list(arguments).await,
            "env_delete" => self.env_delete(arguments).await,
            "env_http_request" => self.env_http_request(arguments).await,
            "project_graph_list" => self.project_graph_list(arguments).await,
            "project_graph_create" => self.project_graph_create(arguments).await,
            "project_graph_query" => self.project_graph_query(arguments).await,
            "project_graph_node_detail" => self.project_graph_node_detail(arguments).await,
            "project_graph_shortest_path" => self.project_graph_shortest_path(arguments).await,
            "project_graph_god_nodes" => self.project_graph_god_nodes(arguments).await,
            "project_graph_delete" => self.project_graph_delete(arguments).await,
            "project_graph_rebuild" => self.project_graph_rebuild(arguments).await,
            "project_list" => self.project_list(arguments).await,
            "project_create" => self.project_create(arguments).await,
            "project_task_list" => self.project_task_list(arguments).await,
            "project_task_create" => self.project_task_create(arguments).await,
            "project_task_update" => self.project_task_update(arguments).await,
            "project_task_delete" => self.project_task_delete(arguments).await,
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

    async fn env_http_request(&mut self, args: &serde_json::Value) -> Result<serde_json::Value> {
        let method = args["method"].as_str().context("missing method")?.to_uppercase();
        let url = args["url"].as_str().context("missing url")?.to_string();
        let auth_key = args["auth_key"].as_str().context("missing auth_key")?.to_string();
        let auth_header = args["auth_header"].as_str().unwrap_or("Authorization").to_string();
        let auth_prefix = args["auth_prefix"].as_str().unwrap_or("Bearer ").to_string();

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

        let auth_value = format!("{}{}", auth_prefix, secret_value);
        let client = HttpClient::new();

        let mut req = match method.as_str() {
            "GET"    => client.get(&url),
            "POST"   => client.post(&url),
            "PUT"    => client.put(&url),
            "PATCH"  => client.patch(&url),
            "DELETE" => client.delete(&url),
            other    => anyhow::bail!("Unsupported HTTP method: {}", other),
        }
        .header(&auth_header, &auth_value)
        .header("Content-Type", "application/json");

        // Inject any extra headers
        if let Some(headers) = args["headers"].as_object() {
            for (k, v) in headers {
                if let Some(v_str) = v.as_str() {
                    req = req.header(k.as_str(), v_str);
                }
            }
        }

        // Attach body for mutating methods
        if let Some(body) = args.get("body") {
            if !body.is_null() {
                req = req.body(body.to_string());
            }
        }

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
            project_graphs::load_graph_json(&path).await?;
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
            project_graphs::load_graph_json(&path).await?;

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
            let (data, hash, size, canonical) = project_graphs::load_graph_json(path).await?;
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
                "SELECT id, title, status, priority, assigned_to, created_by, created_at \
                 FROM project_tasks WHERE project_id = $1 AND status = $2 \
                 ORDER BY created_at DESC LIMIT $3 OFFSET $4"
            )
            .bind(project_id).bind(status).bind(limit).bind(offset)
            .fetch_all(&self.db).await
        } else {
            sqlx::query(
                "SELECT id, title, status, priority, assigned_to, created_by, created_at \
                 FROM project_tasks WHERE project_id = $1 \
                 ORDER BY created_at DESC LIMIT $2 OFFSET $3"
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
            text.push_str(&format!(
                "• [{}] {} ({}){}\n  id: {}\n",
                status, title, priority,
                assigned.as_deref().map(|a| format!(" → {}", a)).unwrap_or_default(),
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

        let row = sqlx::query(
            "INSERT INTO project_tasks (project_id, title, description, status, priority, assigned_to, created_by) \
             VALUES ($1, $2, $3, $4, $5, $6, 'agent') RETURNING id"
        )
        .bind(project_id).bind(&title).bind(&description)
        .bind(status).bind(priority).bind(&assigned_to)
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

        let result = sqlx::query(
            "UPDATE project_tasks SET \
             title = COALESCE($1, title), \
             description = CASE WHEN $2::text IS NOT NULL THEN $2 ELSE description END, \
             status = COALESCE($3, status), \
             priority = COALESCE($4, priority), \
             assigned_to = CASE WHEN $5::text IS NOT NULL THEN $5 ELSE assigned_to END, \
             updated_at = NOW() \
             WHERE id = $6 AND project_id = $7 RETURNING id"
        )
        .bind(&title).bind(&description).bind(&status).bind(&priority).bind(&assigned_to)
        .bind(task_id).bind(project_id)
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
