use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use reqwest::Client as HttpClient;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{postgres::PgPoolOptions, PgPool, FromRow};
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
}

struct McpServer {
    db: PgPool,
    opensearch: OpenSearchClient,
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

        // OpenSearch connection
        let opensearch_url = std::env::var("OPENSEARCH_URL")
            .unwrap_or_else(|_| "http://localhost:9200".to_string());

        let opensearch = OpenSearchClient::new(&opensearch_url);
        opensearch.create_index().await?;
        info!("connected to OpenSearch");

        Ok(Self { db, opensearch })
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

        // Combine and score
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
                })
            })
            .collect();

        results.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        results.truncate(limit);

        // Format output
        let mut text = format!("Found {} results for: \"{}\"\n\n", results.len(), query);

        if results.is_empty() {
            text.push_str("No matching memories found.");
        } else {
            for (i, result) in results.iter().enumerate() {
                text.push_str(&format!(
                    "{}. [Score: {:.2}] {}\n   Summary: {}\n   Tags: {:?}\n   Importance: {:.1}\n   Created: {}\n\n",
                    i + 1,
                    result.score,
                    result.content,
                    result.summary.as_deref().unwrap_or("-"),
                    result.tags,
                    result.importance_score,
                    result.created_at.format("%Y-%m-%d %H:%M")
                ));
            }
        }

        Ok(json!({
            "content": [{
                "type": "text",
                "text": text
            }]
        }))
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
