use std::{cmp::Ordering, net::SocketAddr, time::Duration};

use anyhow::Context;
use axum::{
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use chrono::{DateTime, Utc};
use redis::AsyncCommands;
use reqwest::Client as HttpClient;
use serde::{Deserialize, Serialize};
use sqlx::{postgres::PgPoolOptions, PgPool, FromRow};
use tower_http::{
    cors::{Any, CorsLayer},
    trace::TraceLayer,
};
use tracing::{info, warn, error};
use uuid::Uuid;

// PostgreSQL: Index data (fast lookups, metadata)
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

// OpenSearch: Full content (searchable details)
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

#[derive(Clone)]
struct AppState {
    db: PgPool,
    opensearch: OpenSearchClient,
    redis: Option<redis::aio::ConnectionManager>,
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

    async fn create_index(&self) -> anyhow::Result<()> {
        let url = format!("{}/{}", self.base_url, self.index);

        // Check if index exists
        let resp = self.client.head(&url).send().await;
        if resp.is_ok() && resp.unwrap().status().is_success() {
            info!("OpenSearch index '{}' already exists", self.index);
            return Ok(());
        }

        // Create index with mappings
        let mapping = serde_json::json!({
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

        let resp = self.client
            .put(&url)
            .json(&mapping)
            .send()
            .await?;

        if resp.status().is_success() {
            info!("OpenSearch index '{}' created", self.index);
        } else {
            let body = resp.text().await.unwrap_or_default();
            warn!("OpenSearch index creation response: {}", body);
        }

        Ok(())
    }

    async fn index_document(&self, doc: &MemoryDocument) -> anyhow::Result<()> {
        let url = format!("{}/{}/_doc/{}", self.base_url, self.index, doc.id);

        let resp = self.client
            .put(&url)
            .json(doc)
            .send()
            .await?;

        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            anyhow::bail!("Failed to index document: {}", body);
        }

        Ok(())
    }

    async fn search(&self, query: &str, user_id: Option<&str>, limit: usize) -> anyhow::Result<Vec<MemoryDocument>> {
        let url = format!("{}/{}/_search", self.base_url, self.index);

        let mut must_clauses = vec![
            serde_json::json!({
                "multi_match": {
                    "query": query,
                    "fields": ["content^2", "summary", "tags"],
                    "fuzziness": "AUTO"
                }
            })
        ];

        if let Some(uid) = user_id {
            must_clauses.push(serde_json::json!({
                "term": { "user_id": uid }
            }));
        }

        let search_body = serde_json::json!({
            "size": limit,
            "query": {
                "bool": {
                    "must": must_clauses
                }
            },
            "_source": true
        });

        let resp = self.client
            .post(&url)
            .json(&search_body)
            .send()
            .await?;

        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            anyhow::bail!("Search failed: {}", body);
        }

        let result: serde_json::Value = resp.json().await?;
        let hits = result["hits"]["hits"].as_array();

        let docs: Vec<MemoryDocument> = hits
            .map(|arr| {
                arr.iter()
                    .filter_map(|hit| {
                        serde_json::from_value(hit["_source"].clone()).ok()
                    })
                    .collect()
            })
            .unwrap_or_default();

        Ok(docs)
    }

    async fn list_all(&self, limit: usize) -> anyhow::Result<Vec<MemoryDocument>> {
        let url = format!("{}/{}/_search", self.base_url, self.index);

        let search_body = serde_json::json!({
            "size": limit,
            "query": {
                "match_all": {}
            },
            "sort": [
                { "created_at": { "order": "desc" } }
            ],
            "_source": true
        });

        let resp = self.client.post(&url).json(&search_body).send().await?;

        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            anyhow::bail!("List all failed: {}", body);
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

    async fn get_document(&self, id: &str) -> anyhow::Result<Option<MemoryDocument>> {
        let url = format!("{}/{}/_doc/{}", self.base_url, self.index, id);

        let resp = self.client.get(&url).send().await?;

        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }

        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            anyhow::bail!("Failed to get document: {}", body);
        }

        let result: serde_json::Value = resp.json().await?;
        let doc: MemoryDocument = serde_json::from_value(result["_source"].clone())?;
        Ok(Some(doc))
    }

    async fn delete_document(&self, id: &str) -> anyhow::Result<bool> {
        let url = format!("{}/{}/_doc/{}", self.base_url, self.index, id);

        let resp = self.client.delete(&url).send().await?;

        Ok(resp.status().is_success())
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum McpRequest {
    #[serde(rename = "memory.save")]
    MemorySave {
        content: String,
        #[serde(default)]
        summary: Option<String>,
        #[serde(default)]
        importance: Option<f32>,
        #[serde(default)]
        tags: Option<Vec<String>>,
        #[serde(default)]
        user_id: Option<String>,
    },

    #[serde(rename = "memory.search")]
    MemorySearch {
        query: String,
        #[serde(default)]
        limit: Option<usize>,
        #[serde(default)]
        user_id: Option<String>,
    },

    #[serde(rename = "memory.list")]
    MemoryList {
        #[serde(default)]
        limit: Option<usize>,
        #[serde(default)]
        user_id: Option<String>,
        #[serde(default)]
        source: Option<String>, // "all", "postgres", "opensearch"
    },

    #[serde(rename = "memory.get")]
    MemoryGet {
        id: Uuid,
    },

    #[serde(rename = "memory.update")]
    MemoryUpdate {
        id: Uuid,
        #[serde(default)]
        content: Option<String>,
        #[serde(default)]
        summary: Option<String>,
        #[serde(default)]
        importance: Option<f32>,
        #[serde(default)]
        tags: Option<Vec<String>>,
    },

    #[serde(rename = "memory.delete")]
    MemoryDelete {
        id: Uuid,
    },
}

#[derive(Debug, Serialize)]
#[serde(tag = "type")]
enum McpResponse {
    #[serde(rename = "memory.save.result")]
    MemorySaveResult {
        id: Uuid,
        created_at: DateTime<Utc>,
    },

    #[serde(rename = "memory.search.result")]
    MemorySearchResult {
        query: String,
        results: Vec<SearchResult>,
    },

    #[serde(rename = "memory.list.result")]
    MemoryListResult {
        memories: Vec<ListResult>,
        total: usize,
        source: String,
    },

    #[serde(rename = "memory.get.result")]
    MemoryGetResult {
        memory: Option<FullMemory>,
    },

    #[serde(rename = "memory.update.result")]
    MemoryUpdateResult {
        id: Uuid,
        updated_at: DateTime<Utc>,
    },

    #[serde(rename = "memory.delete.result")]
    MemoryDeleteResult {
        id: Uuid,
        deleted: bool,
    },
}

// List result - combined from both stores
#[derive(Debug, Serialize)]
struct ListResult {
    id: Uuid,
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<String>,
    summary: Option<String>,
    tags: Vec<String>,
    importance_score: f32,
    created_at: DateTime<Utc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    updated_at: Option<DateTime<Utc>>,
}

// Search result - combined from both stores
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

// Full memory - includes content from OpenSearch
#[derive(Debug, Serialize)]
struct FullMemory {
    id: Uuid,
    user_id: Option<String>,
    content: String,
    summary: Option<String>,
    importance_score: f32,
    tags: Vec<String>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "openmemory=info,tower_http=info,sqlx=warn".into()),
        )
        .init();

    let port = std::env::var("OPENMEMORY_PORT")
        .ok()
        .and_then(|v| v.parse::<u16>().ok())
        .unwrap_or(8080);

    let addr = SocketAddr::from(([127, 0, 0, 1], port));

    // PostgreSQL connection (index store)
    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://openmemory:openmemory@localhost:5432/openmemory".to_string());

    let db = PgPoolOptions::new()
        .max_connections(10)
        .connect(&database_url)
        .await
        .context("failed to connect to PostgreSQL")?;

    info!("connected to PostgreSQL (index store)");
    run_migrations(&db).await?;

    // OpenSearch connection (document store)
    let opensearch_url = std::env::var("OPENSEARCH_URL")
        .unwrap_or_else(|_| "http://localhost:9200".to_string());

    let opensearch = OpenSearchClient::new(&opensearch_url);
    opensearch.create_index().await?;
    info!("connected to OpenSearch (document store)");

    // Optional Redis connection (cache)
    let redis = match std::env::var("REDIS_URL") {
        Ok(url) => {
            match redis::Client::open(url.as_str()) {
                Ok(client) => match client.get_connection_manager().await {
                    Ok(conn) => {
                        info!("connected to Redis (cache)");
                        Some(conn)
                    }
                    Err(e) => {
                        warn!("Redis connection failed: {e}, continuing without cache");
                        None
                    }
                },
                Err(e) => {
                    warn!("Redis client creation failed: {e}");
                    None
                }
            }
        }
        Err(_) => {
            info!("REDIS_URL not set, running without cache");
            None
        }
    };

    let state = AppState { db, opensearch, redis };

    let app = Router::new()
        .route("/health", get(health))
        .route("/mcp", post(mcp))
        .layer(TraceLayer::new_for_http())
        .layer(CorsLayer::new().allow_origin(Any).allow_headers(Any).allow_methods(Any))
        .with_state(state);

    info!(%addr, "starting openmemory server");

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .with_context(|| format!("failed to bind to {addr}"))?;

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("server error")?;

    Ok(())
}

async fn run_migrations(db: &PgPool) -> anyhow::Result<()> {
    // PostgreSQL stores index/metadata only
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
    .execute(db)
    .await
    .context("failed to create memory_index table")?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_memory_index_user_id ON memory_index(user_id)")
        .execute(db)
        .await
        .ok();
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_memory_index_created_at ON memory_index(created_at DESC)")
        .execute(db)
        .await
        .ok();
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_memory_index_importance ON memory_index(importance_score DESC)")
        .execute(db)
        .await
        .ok();

    info!("PostgreSQL migrations complete");
    Ok(())
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    warn!("shutdown signal received");
}

async fn health() -> impl IntoResponse {
    (StatusCode::OK, Json(serde_json::json!({ "status": "ok" })))
}

async fn mcp(
    State(state): State<AppState>,
    Json(req): Json<McpRequest>,
) -> Result<impl IntoResponse, (StatusCode, Json<serde_json::Value>)> {
    match req {
        McpRequest::MemorySave {
            content,
            summary,
            importance,
            tags,
            user_id,
        } => {
            let id = Uuid::new_v4();
            let importance_score = clamp01(importance.unwrap_or(0.5));
            let tags = tags.unwrap_or_default();
            let now = Utc::now();

            // 1. Save index to PostgreSQL
            let pg_result = sqlx::query(
                r#"
                INSERT INTO memory_index (id, user_id, summary, importance_score, tags, created_at, updated_at)
                VALUES ($1, $2, $3, $4, $5, $6, $6)
                "#,
            )
            .bind(id)
            .bind(&user_id)
            .bind(&summary)
            .bind(importance_score)
            .bind(&tags)
            .bind(now)
            .execute(&state.db)
            .await;

            if let Err(e) = pg_result {
                error!("Failed to save to PostgreSQL: {e}");
                return Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({ "error": "Failed to save memory index" })),
                ));
            }

            // 2. Save full document to OpenSearch
            let doc = MemoryDocument {
                id: id.to_string(),
                user_id: user_id.clone(),
                content: content.clone(),
                summary: summary.clone(),
                importance_score,
                tags: tags.clone(),
                created_at: now.to_rfc3339(),
                updated_at: now.to_rfc3339(),
            };

            if let Err(e) = state.opensearch.index_document(&doc).await {
                error!("Failed to save to OpenSearch: {e}");
                // Rollback PostgreSQL
                let _ = sqlx::query("DELETE FROM memory_index WHERE id = $1")
                    .bind(id)
                    .execute(&state.db)
                    .await;
                return Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({ "error": "Failed to save memory content" })),
                ));
            }

            Ok((
                StatusCode::OK,
                Json(McpResponse::MemorySaveResult { id, created_at: now }),
            ))
        }

        McpRequest::MemorySearch {
            query,
            limit,
            user_id,
        } => {
            let limit = limit.unwrap_or(5).clamp(1, 50);

            // Try cache first
            let cache_key = format!(
                "search:{}:{}:{}",
                user_id.as_deref().unwrap_or("*"),
                &query,
                limit
            );

            if let Some(mut redis_conn) = state.redis.clone() {
                if let Ok(cached) = redis_conn.get::<_, String>(&cache_key).await {
                    if let Ok(cached_results) = serde_json::from_str::<Vec<SearchResult>>(&cached) {
                        info!("cache hit for query: {}", query);
                        return Ok((
                            StatusCode::OK,
                            Json(McpResponse::MemorySearchResult {
                                query,
                                results: cached_results,
                            }),
                        ));
                    }
                }
            }

            // Search in OpenSearch
            let docs = state.opensearch
                .search(&query, user_id.as_deref(), limit * 2)
                .await
                .unwrap_or_default();

            // Get importance scores from PostgreSQL for ranking
            let ids: Vec<Uuid> = docs.iter()
                .filter_map(|d| Uuid::parse_str(&d.id).ok())
                .collect();

            let index_data: Vec<MemoryIndex> = if !ids.is_empty() {
                sqlx::query_as(
                    "SELECT id, user_id, summary, importance_score, tags, created_at, updated_at FROM memory_index WHERE id = ANY($1)"
                )
                .bind(&ids)
                .fetch_all(&state.db)
                .await
                .unwrap_or_default()
            } else {
                vec![]
            };

            // Combine and score
            let mut results: Vec<SearchResult> = docs.iter()
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

            results.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(Ordering::Equal));
            results.truncate(limit);

            // Cache results
            if let Some(mut redis_conn) = state.redis.clone() {
                if let Ok(json) = serde_json::to_string(&results) {
                    let _: Result<(), _> = redis_conn.set_ex(&cache_key, json, 300).await;
                }
            }

            Ok((
                StatusCode::OK,
                Json(McpResponse::MemorySearchResult { query, results }),
            ))
        }

        McpRequest::MemoryList { limit, user_id, source } => {
            let limit = limit.unwrap_or(100).clamp(1, 500);
            let source = source.as_deref().unwrap_or("all");

            match source {
                "postgres" => {
                    // List from PostgreSQL only (index data)
                    let indexes: Vec<MemoryIndex> = match &user_id {
                        Some(uid) => {
                            sqlx::query_as(
                                "SELECT id, user_id, summary, importance_score, tags, created_at, updated_at FROM memory_index WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2",
                            )
                            .bind(uid)
                            .bind(limit as i64)
                            .fetch_all(&state.db)
                            .await
                        }
                        None => {
                            sqlx::query_as(
                                "SELECT id, user_id, summary, importance_score, tags, created_at, updated_at FROM memory_index ORDER BY created_at DESC LIMIT $1",
                            )
                            .bind(limit as i64)
                            .fetch_all(&state.db)
                            .await
                        }
                    }
                    .unwrap_or_default();

                    let total = indexes.len();
                    let results: Vec<ListResult> = indexes
                        .into_iter()
                        .map(|i| ListResult {
                            id: i.id,
                            content: None,
                            summary: i.summary,
                            tags: i.tags,
                            importance_score: i.importance_score,
                            created_at: i.created_at,
                            updated_at: Some(i.updated_at),
                        })
                        .collect();

                    Ok((
                        StatusCode::OK,
                        Json(McpResponse::MemoryListResult { memories: results, total, source: "postgres".to_string() }),
                    ))
                }

                "opensearch" => {
                    // List from OpenSearch only (full documents)
                    let docs = state.opensearch.list_all(limit).await.unwrap_or_default();

                    let total = docs.len();
                    let results: Vec<ListResult> = docs
                        .into_iter()
                        .filter_map(|d| {
                            let id = Uuid::parse_str(&d.id).ok()?;
                            let created_at = chrono::DateTime::parse_from_rfc3339(&d.created_at)
                                .ok()
                                .map(|dt| dt.with_timezone(&Utc))
                                .unwrap_or_else(Utc::now);
                            let updated_at = chrono::DateTime::parse_from_rfc3339(&d.updated_at)
                                .ok()
                                .map(|dt| dt.with_timezone(&Utc));
                            Some(ListResult {
                                id,
                                content: Some(d.content),
                                summary: d.summary,
                                tags: d.tags,
                                importance_score: d.importance_score,
                                created_at,
                                updated_at,
                            })
                        })
                        .collect();

                    Ok((
                        StatusCode::OK,
                        Json(McpResponse::MemoryListResult { memories: results, total, source: "opensearch".to_string() }),
                    ))
                }

                _ => {
                    // "all" - Combined: Get index from PostgreSQL, content from OpenSearch
                    let indexes: Vec<MemoryIndex> = match &user_id {
                        Some(uid) => {
                            sqlx::query_as(
                                "SELECT id, user_id, summary, importance_score, tags, created_at, updated_at FROM memory_index WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2",
                            )
                            .bind(uid)
                            .bind(limit as i64)
                            .fetch_all(&state.db)
                            .await
                        }
                        None => {
                            sqlx::query_as(
                                "SELECT id, user_id, summary, importance_score, tags, created_at, updated_at FROM memory_index ORDER BY created_at DESC LIMIT $1",
                            )
                            .bind(limit as i64)
                            .fetch_all(&state.db)
                            .await
                        }
                    }
                    .unwrap_or_default();

                    // Fetch content from OpenSearch for each
                    let mut results: Vec<ListResult> = Vec::with_capacity(indexes.len());
                    for idx in &indexes {
                        let content = state.opensearch
                            .get_document(&idx.id.to_string())
                            .await
                            .ok()
                            .flatten()
                            .map(|d| d.content);

                        results.push(ListResult {
                            id: idx.id,
                            content,
                            summary: idx.summary.clone(),
                            tags: idx.tags.clone(),
                            importance_score: idx.importance_score,
                            created_at: idx.created_at,
                            updated_at: Some(idx.updated_at),
                        });
                    }

                    let total = results.len();
                    Ok((
                        StatusCode::OK,
                        Json(McpResponse::MemoryListResult { memories: results, total, source: "all".to_string() }),
                    ))
                }
            }
        }

        McpRequest::MemoryGet { id } => {
            // Get full content from OpenSearch
            let doc = state.opensearch.get_document(&id.to_string()).await.ok().flatten();

            // Get metadata from PostgreSQL
            let index: Option<MemoryIndex> = sqlx::query_as(
                "SELECT id, user_id, summary, importance_score, tags, created_at, updated_at FROM memory_index WHERE id = $1"
            )
            .bind(id)
            .fetch_optional(&state.db)
            .await
            .unwrap_or(None);

            let memory = match (doc, index) {
                (Some(d), Some(i)) => Some(FullMemory {
                    id: i.id,
                    user_id: i.user_id,
                    content: d.content,
                    summary: i.summary,
                    importance_score: i.importance_score,
                    tags: i.tags,
                    created_at: i.created_at,
                    updated_at: i.updated_at,
                }),
                _ => None,
            };

            Ok((
                StatusCode::OK,
                Json(McpResponse::MemoryGetResult { memory }),
            ))
        }

        McpRequest::MemoryUpdate {
            id,
            content,
            summary,
            importance,
            tags,
        } => {
            let now = Utc::now();

            // 1. Update PostgreSQL index
            let pg_result = sqlx::query(
                "UPDATE memory_index SET updated_at = $1, summary = COALESCE($2, summary), importance_score = COALESCE($3, importance_score), tags = COALESCE($4, tags) WHERE id = $5",
            )
            .bind(now)
            .bind(&summary)
            .bind(importance.map(clamp01))
            .bind(&tags)
            .bind(id)
            .execute(&state.db)
            .await;

            match pg_result {
                Ok(r) if r.rows_affected() == 0 => {
                    return Err((
                        StatusCode::NOT_FOUND,
                        Json(serde_json::json!({ "error": "Memory not found" })),
                    ));
                }
                Err(e) => {
                    error!("Failed to update PostgreSQL: {e}");
                    return Err((
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(serde_json::json!({ "error": "Failed to update memory" })),
                    ));
                }
                _ => {}
            }

            // 2. Update OpenSearch document
            if let Ok(Some(mut doc)) = state.opensearch.get_document(&id.to_string()).await {
                if let Some(c) = content {
                    doc.content = c;
                }
                if let Some(s) = &summary {
                    doc.summary = Some(s.clone());
                }
                if let Some(i) = importance {
                    doc.importance_score = clamp01(i);
                }
                if let Some(t) = &tags {
                    doc.tags = t.clone();
                }
                doc.updated_at = now.to_rfc3339();

                if let Err(e) = state.opensearch.index_document(&doc).await {
                    warn!("Failed to update OpenSearch: {e}");
                }
            }

            Ok((
                StatusCode::OK,
                Json(McpResponse::MemoryUpdateResult { id, updated_at: now }),
            ))
        }

        McpRequest::MemoryDelete { id } => {
            // 1. Delete from PostgreSQL
            let pg_result = sqlx::query("DELETE FROM memory_index WHERE id = $1")
                .bind(id)
                .execute(&state.db)
                .await;

            let deleted = match pg_result {
                Ok(r) => r.rows_affected() > 0,
                Err(e) => {
                    error!("Failed to delete from PostgreSQL: {e}");
                    return Err((
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(serde_json::json!({ "error": "Failed to delete memory" })),
                    ));
                }
            };

            if !deleted {
                return Err((
                    StatusCode::NOT_FOUND,
                    Json(serde_json::json!({ "error": "Memory not found" })),
                ));
            }

            // 2. Delete from OpenSearch
            let _ = state.opensearch.delete_document(&id.to_string()).await;

            Ok((
                StatusCode::OK,
                Json(McpResponse::MemoryDeleteResult { id, deleted: true }),
            ))
        }
    }
}

fn compute_combined_score(importance: f32, created_at: DateTime<Utc>) -> f32 {
    let recency = recency_score(created_at);
    // OpenSearch handles keyword relevance, we add importance + recency
    (importance * 0.6) + (recency * 0.4)
}

fn recency_score(created_at: DateTime<Utc>) -> f32 {
    let age = Utc::now().signed_duration_since(created_at);
    let age_days = age.num_seconds().max(0) as f32 / (60.0 * 60.0 * 24.0);
    (-age_days / 30.0).exp().clamp(0.0, 1.0)
}

fn clamp01(v: f32) -> f32 {
    v.clamp(0.0, 1.0)
}

#[allow(dead_code)]
async fn _sleep_for_readability() {
    tokio::time::sleep(Duration::from_millis(10)).await;
}
