mod crypto;
mod falkordb;

use openmemory_server::run_session_migrations;

use std::{cmp::Ordering, net::SocketAddr, time::Duration};

use anyhow::Context;
use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, HeaderValue, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use crypto::{decrypt_value, derive_key, encrypt_value, EnvParamRow};
use chrono::{DateTime, Utc};
use falkordb::FalkorDbClient;
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
    falkordb: Option<FalkorDbClient>,
    api_token: String,
    encryption_key: [u8; 32],
}

// Session query response types
#[derive(Serialize, FromRow)]
struct SessionRow {
    id: String,
    project_name: Option<String>,
    git_branch: Option<String>,
    cwd: Option<String>,
    started_at: Option<DateTime<Utc>>,
    last_event_at: Option<DateTime<Utc>>,
    message_count: i32,
    created_at: DateTime<Utc>,
}

#[derive(Serialize, FromRow)]
struct SessionMessageRow {
    id: Uuid,
    event_type: String,
    role: Option<String>,
    content_text: Option<String>,
    event_timestamp: Option<DateTime<Utc>>,
    sequence_num: i32,
    byte_start: i64,
    created_at: DateTime<Utc>,
}

#[derive(Deserialize)]
struct SessionListParams {
    #[serde(default = "default_limit")]
    limit: i64,
}

#[derive(Deserialize)]
struct MessagesParams {
    #[serde(default = "default_messages_limit")]
    limit: i64,
    after: Option<i32>,
}

fn default_limit() -> i64 { 50 }
fn default_messages_limit() -> i64 { 200 }

// Watcher agent config types
#[derive(Serialize, FromRow)]
struct WatcherAgentRow {
    id: Uuid,
    name: String,
    path: String,
    enabled: bool,
    is_builtin: bool,
    description: Option<String>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

#[derive(Deserialize)]
struct CreateAgentPayload {
    name: String,
    path: String,
    description: Option<String>,
}

#[derive(Deserialize)]
struct UpdateAgentPayload {
    name: Option<String>,
    path: Option<String>,
    enabled: Option<bool>,
    description: Option<String>,
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

    #[serde(rename = "memory.graph_all")]
    MemoryGraphAll {
        #[serde(default)]
        user_id: Option<String>,
    },

    #[serde(rename = "memory.graph_neighbors")]
    MemoryGraphNeighbors {
        id: Uuid,
        #[serde(default)]
        hops: Option<u8>,
        #[serde(default)]
        limit: Option<usize>,
        #[serde(default)]
        user_id: Option<String>,
    },

    #[serde(rename = "memory.graph_relate")]
    MemoryGraphRelate {
        from_id: Uuid,
        to_id: Uuid,
        relationship: String,
    },

    #[serde(rename = "graph.add_episode")]
    GraphAddEpisode {
        name: String,
        source: String,
        source_description: String,
        content: String,
        #[serde(default)]
        group_id: Option<String>,
        #[serde(default)]
        valid_at: Option<String>,
    },

    #[serde(rename = "graph.add_entity")]
    GraphAddEntity {
        name: String,
        entity_type: String,
        #[serde(default)]
        group_id: Option<String>,
        #[serde(default)]
        summary: Option<String>,
        #[serde(default)]
        episode_id: Option<String>,
    },

    #[serde(rename = "graph.add_fact")]
    GraphAddFact {
        subject: String,
        subject_type: String,
        object: String,
        object_type: String,
        name: String,
        fact: String,
        #[serde(default)]
        group_id: Option<String>,
        #[serde(default)]
        episode_id: Option<String>,
        #[serde(default)]
        valid_at: Option<String>,
        #[serde(default)]
        invalidate_previous: Option<bool>,
    },

    #[serde(rename = "graph.query_facts")]
    GraphQueryFacts {
        query: String,
        #[serde(default)]
        group_id: Option<String>,
        #[serde(default)]
        limit: Option<usize>,
        #[serde(default)]
        valid_only: Option<bool>,
    },

    #[serde(rename = "graph.query_at")]
    GraphQueryAt {
        timestamp: String,
        #[serde(default)]
        entity_name: Option<String>,
        #[serde(default)]
        group_id: Option<String>,
        #[serde(default)]
        limit: Option<usize>,
    },

    #[serde(rename = "graph.get_entity_history")]
    GraphGetEntityHistory {
        entity_name: String,
        #[serde(default)]
        group_id: Option<String>,
        #[serde(default)]
        limit: Option<usize>,
    },

    #[serde(rename = "graph.get_entity")]
    GraphGetEntity {
        entity_name: String,
        #[serde(default)]
        entity_type: Option<String>,
        #[serde(default)]
        group_id: Option<String>,
    },

    #[serde(rename = "env.set")]
    EnvSet {
        key: String,
        value: String,
        #[serde(default)]
        is_secret: Option<bool>,
        #[serde(default)]
        description: Option<String>,
    },

    #[serde(rename = "env.get")]
    EnvGet { key: String },

    #[serde(rename = "env.list")]
    EnvList {},

    #[serde(rename = "env.delete")]
    EnvDelete { key: String },
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

    #[serde(rename = "memory.graph_all.result")]
    MemoryGraphAllResult {
        edges: Vec<falkordb::EdgeInfo>,
    },

    #[serde(rename = "memory.graph_neighbors.result")]
    MemoryGraphNeighborsResult {
        id: Uuid,
        neighbors: Vec<falkordb::NeighborInfo>,
        hops: u8,
    },

    #[serde(rename = "memory.graph_relate.result")]
    MemoryGraphRelateResult {
        from_id: Uuid,
        to_id: Uuid,
        relationship: String,
    },

    #[serde(rename = "graph.add_episode.result")]
    GraphAddEpisodeResult {
        id: Uuid,
        created_at: DateTime<Utc>,
    },

    #[serde(rename = "graph.add_entity.result")]
    GraphAddEntityResult {
        id: String,
        entity_name: String,
        entity_type: String,
        created: bool,
    },

    #[serde(rename = "graph.add_fact.result")]
    GraphAddFactResult {
        id: String,
        invalidated_count: u32,
    },

    #[serde(rename = "graph.query_facts.result")]
    GraphQueryFactsResult {
        query: String,
        facts: Vec<falkordb::FactResult>,
    },

    #[serde(rename = "graph.query_at.result")]
    GraphQueryAtResult {
        timestamp: String,
        facts: Vec<falkordb::FactResult>,
    },

    #[serde(rename = "graph.get_entity_history.result")]
    GraphGetEntityHistoryResult {
        entity_name: String,
        facts: Vec<falkordb::FactResult>,
    },

    #[serde(rename = "graph.get_entity.result")]
    GraphGetEntityResult {
        entity: Option<falkordb::EntityInfo>,
    },

    #[serde(rename = "env.set.result")]
    EnvSetResult { key: String },

    #[serde(rename = "env.get.result")]
    EnvGetResult { key: String, value: String },

    #[serde(rename = "env.list.result")]
    EnvListResult { params: Vec<EnvParamRow>, total: usize },

    #[serde(rename = "env.delete.result")]
    EnvDeleteResult { key: String },
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

    let host = std::env::var("OPENMEMORY_HOST")
        .unwrap_or_else(|_| "127.0.0.1".to_string());
    let addr: SocketAddr = format!("{host}:{port}")
        .parse()
        .with_context(|| format!("invalid bind address {host}:{port}"))?;

    let is_loopback = addr.ip().is_loopback();
    if !is_loopback {
        warn!(
            "⚠️  OPENMEMORY_HOST is set to a non-loopback address ({host}). \
             The API has NO authentication — do not expose port {port} publicly \
             without adding auth middleware first."
        );
    }

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
        .unwrap_or_else(|_| "http://localhost:9201".to_string());

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

    let api_token = resolve_api_token();

    let secret_key = std::env::var("OPENMEMORY_SECRET_KEY")
        .unwrap_or_else(|_| {
            warn!("OPENMEMORY_SECRET_KEY not set — using insecure dev default. Set this in production.");
            "dev-secret-key-change-me".to_string()
        });
    let encryption_key = derive_key(&secret_key);

    let state = AppState { db, opensearch, redis, falkordb, api_token, encryption_key };

    let app = Router::new()
        .route("/health", get(health))
        .route("/mcp", post(mcp))
        .route("/sessions", get(list_sessions))
        .route("/sessions/:id", get(get_session))
        .route("/sessions/:id/messages", get(get_session_messages))
        .route("/agents", get(list_agents).post(create_agent))
        .route("/agents/:id", get(get_agent).put(update_agent).delete(delete_agent))
        .layer(TraceLayer::new_for_http())
        .layer({
            match std::env::var("OPENMEMORY_CORS_ORIGINS") {
                Ok(origins) => {
                    let allowed: Vec<HeaderValue> = origins
                        .split(',')
                        .filter_map(|o| o.trim().parse().ok())
                        .collect();
                    CorsLayer::new()
                        .allow_origin(allowed)
                        .allow_headers(Any)
                        .allow_methods(Any)
                }
                Err(_) => CorsLayer::new()
                    .allow_origin([
                        "http://localhost".parse::<HeaderValue>().unwrap(),
                        "http://localhost:3000".parse::<HeaderValue>().unwrap(),
                        "http://127.0.0.1".parse::<HeaderValue>().unwrap(),
                    ])
                    .allow_headers(Any)
                    .allow_methods(Any),
            }
        })
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

    // env_params table for user-managed environment variables and secrets
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
    .execute(db)
    .await
    .context("failed to create env_params table")?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_env_params_key ON env_params(key)")
        .execute(db)
        .await
        .ok();

    info!("PostgreSQL migrations complete");
    run_session_migrations(db).await?;
    Ok(())
}

async fn list_sessions(
    State(state): State<AppState>,
    Query(params): Query<SessionListParams>,
) -> impl IntoResponse {
    let limit = params.limit.clamp(1, 200);
    let rows = sqlx::query_as::<_, SessionRow>(
        "SELECT id, project_name, git_branch, cwd, started_at, last_event_at, message_count, created_at \
         FROM sessions ORDER BY last_event_at DESC NULLS LAST LIMIT $1"
    )
    .bind(limit)
    .fetch_all(&state.db)
    .await;

    match rows {
        Ok(sessions) => {
            let total = sessions.len();
            Json(serde_json::json!({"sessions": sessions, "total": total})).into_response()
        }
        Err(e) => {
            error!("list_sessions error: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response()
        }
    }
}

async fn get_session(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let row = sqlx::query_as::<_, SessionRow>(
        "SELECT id, project_name, git_branch, cwd, started_at, last_event_at, message_count, created_at \
         FROM sessions WHERE id = $1"
    )
    .bind(&id)
    .fetch_optional(&state.db)
    .await;

    match row {
        Ok(Some(session)) => Json(session).into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "session not found"}))).into_response(),
        Err(e) => {
            error!("get_session error: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response()
        }
    }
}

async fn get_session_messages(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(params): Query<MessagesParams>,
) -> impl IntoResponse {
    let limit = params.limit.clamp(1, 500);
    let after = params.after.unwrap_or(0);

    let rows = sqlx::query_as::<_, SessionMessageRow>(
        "SELECT id, event_type, role, content_text, event_timestamp, sequence_num, byte_start, created_at \
         FROM session_messages \
         WHERE session_id = $1 AND sequence_num > $2 \
         ORDER BY sequence_num ASC LIMIT $3"
    )
    .bind(&id)
    .bind(after)
    .bind(limit)
    .fetch_all(&state.db)
    .await;

    match rows {
        Ok(messages) => {
            let total = messages.len();
            let next_after = messages.last().map(|m| m.sequence_num);
            Json(serde_json::json!({
                "session_id": id,
                "messages": messages,
                "total": total,
                "next_after": next_after,
            })).into_response()
        }
        Err(e) => {
            error!("get_session_messages error: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response()
        }
    }
}

async fn list_agents(State(state): State<AppState>) -> impl IntoResponse {
    let rows = sqlx::query_as::<_, WatcherAgentRow>(
        "SELECT id, name, path, enabled, is_builtin, description, created_at, updated_at \
         FROM watcher_agents ORDER BY is_builtin DESC, name ASC"
    )
    .fetch_all(&state.db)
    .await;

    match rows {
        Ok(agents) => Json(serde_json::json!({"agents": agents, "total": agents.len()})).into_response(),
        Err(e) => {
            error!("list_agents error: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response()
        }
    }
}

async fn get_agent(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> impl IntoResponse {
    let row = sqlx::query_as::<_, WatcherAgentRow>(
        "SELECT id, name, path, enabled, is_builtin, description, created_at, updated_at \
         FROM watcher_agents WHERE id = $1"
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await;

    match row {
        Ok(Some(agent)) => Json(agent).into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "agent not found"}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
    }
}

async fn create_agent(
    State(state): State<AppState>,
    Json(payload): Json<CreateAgentPayload>,
) -> impl IntoResponse {
    let name = payload.name.trim().to_string();
    let path = payload.path.trim().to_string();
    if name.is_empty() || path.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "name and path are required"}))).into_response();
    }

    let row = sqlx::query_as::<_, WatcherAgentRow>(
        "INSERT INTO watcher_agents (name, path, enabled, is_builtin, description) \
         VALUES ($1, $2, TRUE, FALSE, $3) \
         RETURNING id, name, path, enabled, is_builtin, description, created_at, updated_at"
    )
    .bind(&name)
    .bind(&path)
    .bind(payload.description.as_deref())
    .fetch_one(&state.db)
    .await;

    match row {
        Ok(agent) => (StatusCode::CREATED, Json(agent)).into_response(),
        Err(e) if e.to_string().contains("unique") => {
            (StatusCode::CONFLICT, Json(serde_json::json!({"error": "agent name already exists"}))).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
    }
}

async fn update_agent(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(payload): Json<UpdateAgentPayload>,
) -> impl IntoResponse {
    // Check if agent exists and whether it's built-in
    let existing = sqlx::query_as::<_, WatcherAgentRow>(
        "SELECT id, name, path, enabled, is_builtin, description, created_at, updated_at \
         FROM watcher_agents WHERE id = $1"
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await;

    let agent = match existing {
        Ok(Some(a)) => a,
        Ok(None) => return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "agent not found"}))).into_response(),
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
    };

    if agent.is_builtin && payload.name.is_some() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "cannot rename a built-in agent"}))).into_response();
    }

    let new_name = payload.name.as_deref().unwrap_or(&agent.name);
    let new_path = payload.path.as_deref().unwrap_or(&agent.path);
    let new_enabled = payload.enabled.unwrap_or(agent.enabled);
    let new_desc = payload.description.as_deref().or(agent.description.as_deref());

    let row = sqlx::query_as::<_, WatcherAgentRow>(
        "UPDATE watcher_agents SET name=$2, path=$3, enabled=$4, description=$5, updated_at=NOW() \
         WHERE id=$1 \
         RETURNING id, name, path, enabled, is_builtin, description, created_at, updated_at"
    )
    .bind(id)
    .bind(new_name)
    .bind(new_path)
    .bind(new_enabled)
    .bind(new_desc)
    .fetch_one(&state.db)
    .await;

    match row {
        Ok(agent) => Json(agent).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
    }
}

async fn delete_agent(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> impl IntoResponse {
    let existing = sqlx::query_as::<_, WatcherAgentRow>(
        "SELECT id, name, path, enabled, is_builtin, description, created_at, updated_at \
         FROM watcher_agents WHERE id = $1"
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await;

    match existing {
        Ok(Some(agent)) if agent.is_builtin => {
            (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "cannot delete a built-in agent"}))).into_response()
        }
        Ok(Some(_)) => {
            let result = sqlx::query("DELETE FROM watcher_agents WHERE id = $1")
                .bind(id)
                .execute(&state.db)
                .await;
            match result {
                Ok(_) => (StatusCode::OK, Json(serde_json::json!({"deleted": id.to_string()}))).into_response(),
                Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
            }
        }
        Ok(None) => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "agent not found"}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
    }
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    warn!("shutdown signal received");
}

fn token_file_path() -> std::path::PathBuf {
    let home = std::env::var("HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::PathBuf::from("/tmp"));
    home.join(".openmemory").join("api_token")
}

fn resolve_api_token() -> String {
    // 1. Explicit env var takes precedence (Docker / CI / scripting)
    if let Ok(token) = std::env::var("OPENMEMORY_API_TOKEN") {
        let token = token.trim().to_string();
        if !token.is_empty() {
            info!("API token loaded from OPENMEMORY_API_TOKEN env var");
            return token;
        }
    }

    // 2. Persisted token file — survives restarts without requiring env var
    let path = token_file_path();
    if let Ok(stored) = std::fs::read_to_string(&path) {
        let token = stored.trim().to_string();
        if !token.is_empty() {
            info!("API token loaded from {}", path.display());
            return token;
        }
    }

    // 3. First run: generate a cryptographically random token and persist it
    let token = Uuid::new_v4().to_string();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match std::fs::write(&path, &token) {
        Ok(_) => {
            warn!(
                "\n\n\
                 ╔══════════════════════════════════════════════════════════╗\n\
                 ║  OpenMemory: new API token generated (first run)         ║\n\
                 ║                                                          ║\n\
                 ║  Token : {token}  ║\n\
                 ║  Saved : {path}  ║\n\
                 ║                                                          ║\n\
                 ║  Set OPENMEMORY_API_TOKEN env var to use a fixed token.  ║\n\
                 ╚══════════════════════════════════════════════════════════╝\n",
                path = path.display(),
            );
        }
        Err(e) => {
            warn!(
                "Generated API token but could not persist it to {}: {e}\n\
                 Token will change on next restart. Set OPENMEMORY_API_TOKEN to fix this.\n\
                 Token: {token}",
                path.display()
            );
        }
    }

    token
}

async fn health() -> impl IntoResponse {
    (StatusCode::OK, Json(serde_json::json!({ "status": "ok" })))
}

async fn mcp(
    State(state): State<AppState>,
    headers: HeaderMap,
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

            // 3. Save graph node (non-blocking — failure is logged, not fatal)
            if let Some(fdb) = &state.falkordb {
                let mut fdb = fdb.clone();
                let (id_c, uid_c, sum_c, tags_c, ts) = (
                    id,
                    user_id.clone(),
                    summary.clone(),
                    tags.clone(),
                    now.to_rfc3339(),
                );
                tokio::spawn(async move {
                    if let Err(e) = fdb
                        .save_node(id_c, uid_c.as_deref(), sum_c.as_deref(), importance_score, &tags_c, &ts)
                        .await
                    {
                        warn!("FalkorDB save_node failed: {e}");
                    }
                });
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

            // 3. Sync graph node (non-blocking — keeps summary/importance/tags in sync)
            if let Some(fdb) = &state.falkordb {
                let mut fdb = fdb.clone();
                let (sum_c, imp_c, tags_c) = (summary.clone(), importance, tags.clone());
                tokio::spawn(async move {
                    if let Err(e) = fdb
                        .update_node(id, sum_c.as_deref(), imp_c.map(clamp01), tags_c.as_deref())
                        .await
                    {
                        warn!("FalkorDB update_node failed: {e}");
                    }
                });
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

            // 3. Remove graph node (non-blocking)
            if let Some(fdb) = &state.falkordb {
                let mut fdb = fdb.clone();
                tokio::spawn(async move {
                    if let Err(e) = fdb.delete_node(id).await {
                        warn!("FalkorDB delete_node failed: {e}");
                    }
                });
            }

            Ok((
                StatusCode::OK,
                Json(McpResponse::MemoryDeleteResult { id, deleted: true }),
            ))
        }

        McpRequest::MemoryGraphAll { user_id } => {
            match &state.falkordb {
                None => Ok((
                    StatusCode::OK,
                    Json(McpResponse::MemoryGraphAllResult { edges: vec![] }),
                )),
                Some(fdb) => {
                    let mut fdb = fdb.clone();
                    match fdb.get_all_edges(user_id.as_deref()).await {
                        Ok(edges) => Ok((
                            StatusCode::OK,
                            Json(McpResponse::MemoryGraphAllResult { edges }),
                        )),
                        Err(e) => {
                            error!("FalkorDB get_all_edges failed: {e}");
                            Ok((
                                StatusCode::OK,
                                Json(McpResponse::MemoryGraphAllResult { edges: vec![] }),
                            ))
                        }
                    }
                }
            }
        }

        McpRequest::MemoryGraphNeighbors { id, hops, limit, user_id } => {
            let hops = hops.unwrap_or(1).clamp(1, 2);
            let limit = limit.unwrap_or(10).clamp(1, 50);

            // NOTE: user_id here is a client-supplied namespace selector, identical to how
            // memory_search / memory_list use it. This codebase has no auth layer — there is
            // no server-side session or token to derive identity from. A real ownership check
            // requires adding auth middleware (e.g. Bearer token → user_id on McpState).
            // The user_id is passed to FalkorDB to scope traversal within a namespace only.

            let mut fdb = match &state.falkordb {
                Some(fdb) => fdb.clone(),
                None => {
                    return Err((
                        StatusCode::SERVICE_UNAVAILABLE,
                        Json(serde_json::json!({ "error": "Graph layer not configured (FALKORDB_URL not set)" })),
                    ));
                }
            };

            match fdb.get_neighbors(id, user_id.as_deref(), hops, limit).await {
                Ok(neighbors) => Ok((
                    StatusCode::OK,
                    Json(McpResponse::MemoryGraphNeighborsResult { id, neighbors, hops }),
                )),
                Err(e) => {
                    error!("FalkorDB get_neighbors failed: {e}");
                    Err((
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(serde_json::json!({ "error": "Graph query failed" })),
                    ))
                }
            }
        }

        McpRequest::MemoryGraphRelate { from_id, to_id, relationship } => {
            // NOTE: same no-auth caveat as MemoryGraphNeighbors. user_id is dropped here
            // because relate_nodes does not use it — the existence check in relate_nodes
            // (MATCH … RETURN count) verifies both nodes are present in the graph.

            let mut fdb = match &state.falkordb {
                Some(fdb) => fdb.clone(),
                None => {
                    return Err((
                        StatusCode::SERVICE_UNAVAILABLE,
                        Json(serde_json::json!({ "error": "Graph layer not configured (FALKORDB_URL not set)" })),
                    ));
                }
            };

            match fdb.relate_nodes(from_id, to_id, &relationship).await {
                Ok(()) => Ok((
                    StatusCode::OK,
                    Json(McpResponse::MemoryGraphRelateResult { from_id, to_id, relationship }),
                )),
                Err(e) => {
                    error!("FalkorDB relate_nodes failed: {e}");
                    Err((
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(serde_json::json!({ "error": "Failed to create relationship" })),
                    ))
                }
            }
        }

        McpRequest::GraphAddEpisode { name, source, source_description, content, group_id, valid_at } => {
            let id = Uuid::new_v4();
            let now = Utc::now();
            let ts = valid_at.unwrap_or_else(|| now.to_rfc3339());
            let gid = group_id.as_deref().unwrap_or("default");

            match &state.falkordb {
                None => Err((
                    StatusCode::SERVICE_UNAVAILABLE,
                    Json(serde_json::json!({"error": "Graph layer not configured (FALKORDB_URL not set)"})),
                )),
                Some(fdb) => {
                    let mut fdb = fdb.clone();
                    fdb.add_episode(id, &name, &source, &source_description, &content, gid, &now.to_rfc3339(), &ts)
                        .await
                        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))))?;
                    Ok((StatusCode::OK, Json(McpResponse::GraphAddEpisodeResult { id, created_at: now })))
                }
            }
        }

        McpRequest::GraphAddEntity { name, entity_type, group_id, summary, episode_id } => {
            let new_id = Uuid::new_v4();
            let now = Utc::now();
            let gid = group_id.as_deref().unwrap_or("default");

            let mut fdb = match &state.falkordb {
                Some(fdb) => fdb.clone(),
                None => return Err((
                    StatusCode::SERVICE_UNAVAILABLE,
                    Json(serde_json::json!({"error": "Graph layer not configured (FALKORDB_URL not set)"})),
                )),
            };

            let (entity_id, created) = fdb
                .add_entity(new_id, &name, &entity_type, gid, summary.as_deref(), &now.to_rfc3339())
                .await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))))?;

            if let Some(ref ep_id) = episode_id {
                let ep_uuid = Uuid::parse_str(ep_id).map_err(|_| (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({"error": format!("invalid episode_id UUID: {}", ep_id)})),
                ))?;
                if let Err(e) = fdb.link_episode_to_entity(ep_uuid, &name, &entity_type, gid).await {
                    warn!("link_episode_to_entity failed (entity still saved): {e}");
                }
            }

            Ok((StatusCode::OK, Json(McpResponse::GraphAddEntityResult {
                id: entity_id,
                entity_name: name,
                entity_type,
                created,
            })))
        }

        McpRequest::GraphAddFact { subject, subject_type, object, object_type, name, fact,
                                    group_id, episode_id, valid_at, invalidate_previous } => {
            let id = Uuid::new_v4();
            let now = Utc::now();
            let gid = group_id.as_deref().unwrap_or("default");
            let now_str = now.to_rfc3339();
            let ts = valid_at.as_deref().unwrap_or(&now_str);
            let invalidate = invalidate_previous.unwrap_or(false);

            let mut fdb = match &state.falkordb {
                Some(fdb) => fdb.clone(),
                None => return Err((
                    StatusCode::SERVICE_UNAVAILABLE,
                    Json(serde_json::json!({"error": "Graph layer not configured (FALKORDB_URL not set)"})),
                )),
            };

            let (fact_id, invalidated) = fdb
                .add_fact(id, &subject, &subject_type, &object, &object_type,
                          gid, &name, &fact, episode_id.as_deref(), ts, &now_str, invalidate)
                .await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))))?;

            Ok((StatusCode::OK, Json(McpResponse::GraphAddFactResult { id: fact_id, invalidated_count: invalidated })))
        }

        McpRequest::GraphQueryFacts { query, group_id, limit, valid_only } => {
            let limit = limit.unwrap_or(10).clamp(1, 50);
            let valid_only = valid_only.unwrap_or(false);

            let mut fdb = match &state.falkordb {
                Some(fdb) => fdb.clone(),
                None => return Ok((StatusCode::OK, Json(McpResponse::GraphQueryFactsResult { query, facts: vec![] }))),
            };

            let facts = fdb.query_facts(&query, group_id.as_deref(), limit, valid_only)
                .await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))))?;
            Ok((StatusCode::OK, Json(McpResponse::GraphQueryFactsResult { query, facts })))
        }

        McpRequest::GraphQueryAt { timestamp, entity_name, group_id, limit } => {
            let limit = limit.unwrap_or(20).clamp(1, 100);

            let mut fdb = match &state.falkordb {
                Some(fdb) => fdb.clone(),
                None => return Ok((StatusCode::OK, Json(McpResponse::GraphQueryAtResult { timestamp, facts: vec![] }))),
            };

            let facts = fdb.query_at(&timestamp, entity_name.as_deref(), group_id.as_deref(), limit)
                .await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))))?;
            Ok((StatusCode::OK, Json(McpResponse::GraphQueryAtResult { timestamp, facts })))
        }

        McpRequest::GraphGetEntityHistory { entity_name, group_id, limit } => {
            let limit = limit.unwrap_or(20).clamp(1, 100);

            let mut fdb = match &state.falkordb {
                Some(fdb) => fdb.clone(),
                None => return Ok((StatusCode::OK, Json(McpResponse::GraphGetEntityHistoryResult {
                    entity_name, facts: vec![] }))),
            };

            let facts = fdb.get_entity_history(&entity_name, group_id.as_deref(), limit)
                .await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))))?;
            Ok((StatusCode::OK, Json(McpResponse::GraphGetEntityHistoryResult { entity_name, facts })))
        }

        McpRequest::GraphGetEntity { entity_name, entity_type, group_id } => {
            let mut fdb = match &state.falkordb {
                Some(fdb) => fdb.clone(),
                None => return Ok((StatusCode::OK, Json(McpResponse::GraphGetEntityResult { entity: None }))),
            };

            let entity = fdb.get_entity(&entity_name, entity_type.as_deref(), group_id.as_deref())
                .await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))))?;
            Ok((StatusCode::OK, Json(McpResponse::GraphGetEntityResult { entity })))
        }

        McpRequest::EnvSet { key, value, is_secret, description } => {
            let is_secret = is_secret.unwrap_or(false);
            let encrypted = encrypt_value(&state.encryption_key, &value);
            let now = Utc::now();

            let result = sqlx::query(
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
            .execute(&state.db)
            .await;

            match result {
                Ok(_) => Ok((StatusCode::OK, Json(McpResponse::EnvSetResult { key }))),
                Err(e) => {
                    error!("Failed to set env param: {e}");
                    Err((
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(serde_json::json!({ "error": "Failed to set parameter" })),
                    ))
                }
            }
        }

        McpRequest::EnvGet { key } => {
            let row: Option<(Vec<u8>, bool)> = sqlx::query_as(
                "SELECT value_encrypted, is_secret FROM env_params WHERE key = $1",
            )
            .bind(&key)
            .fetch_optional(&state.db)
            .await
            .map_err(|e| {
                error!("EnvGet DB query failed: {e}");
                (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": "Database error" })))
            })?;

            match row {
                None => Err((
                    StatusCode::NOT_FOUND,
                    Json(serde_json::json!({ "error": "Parameter not found" })),
                )),
                Some((encrypted, is_secret)) => {
                    if is_secret && !is_authenticated(&headers, &state.api_token) {
                        return Err((
                            StatusCode::FORBIDDEN,
                            Json(serde_json::json!({ "error": "read blocked: secret param" })),
                        ));
                    }
                    match decrypt_value(&state.encryption_key, &encrypted) {
                        Ok(value) => Ok((StatusCode::OK, Json(McpResponse::EnvGetResult { key, value }))),
                        Err(e) => {
                            error!("Failed to decrypt env param: {e}");
                            Err((
                                StatusCode::INTERNAL_SERVER_ERROR,
                                Json(serde_json::json!({ "error": "Failed to decrypt parameter" })),
                            ))
                        }
                    }
                }
            }
        }

        McpRequest::EnvList {} => {
            let params: Vec<EnvParamRow> = sqlx::query_as(
                "SELECT id, key, is_secret, description, created_at, updated_at FROM env_params ORDER BY key ASC",
            )
            .fetch_all(&state.db)
            .await
            .map_err(|e| {
                error!("EnvList DB query failed: {e}");
                (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": "Database error" })))
            })?;

            let total = params.len();
            Ok((StatusCode::OK, Json(McpResponse::EnvListResult { params, total })))
        }

        McpRequest::EnvDelete { key } => {
            let result = sqlx::query("DELETE FROM env_params WHERE key = $1")
                .bind(&key)
                .execute(&state.db)
                .await;

            match result {
                Ok(r) if r.rows_affected() == 0 => Err((
                    StatusCode::NOT_FOUND,
                    Json(serde_json::json!({ "error": "Parameter not found" })),
                )),
                Ok(_) => Ok((StatusCode::OK, Json(McpResponse::EnvDeleteResult { key }))),
                Err(e) => {
                    error!("Failed to delete env param: {e}");
                    Err((
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(serde_json::json!({ "error": "Failed to delete parameter" })),
                    ))
                }
            }
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


fn is_authenticated(headers: &HeaderMap, token: &str) -> bool {
    let expected = format!("Bearer {}", token);
    let expected_bytes = expected.as_bytes();
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .map(|v| {
            let v_bytes = v.as_bytes();
            // Constant-time comparison: avoid early-exit that leaks token length/prefix
            if v_bytes.len() != expected_bytes.len() {
                return false;
            }
            v_bytes
                .iter()
                .zip(expected_bytes.iter())
                .fold(0u8, |acc, (a, b)| acc | (a ^ b))
                == 0
        })
        .unwrap_or(false)
}

#[allow(dead_code)]
async fn _sleep_for_readability() {
    tokio::time::sleep(Duration::from_millis(10)).await;
}
