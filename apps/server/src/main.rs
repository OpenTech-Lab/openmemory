mod crypto;
mod falkordb;
mod llm;

use openmemory_server::run_session_migrations;
use openmemory_server::project_graphs;

use std::{cmp::Ordering, net::SocketAddr, time::Duration};

use anyhow::Context;
use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, HeaderValue, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use crypto::{decrypt_value, derive_key, encrypt_value, EnvParamRow};
use chrono::{DateTime, Utc};
use falkordb::FalkorDbClient;
use redis::AsyncCommands;
use reqwest::Client as HttpClient;
use serde::{Deserialize, Serialize};
use sqlx::{postgres::PgPoolOptions, PgPool, FromRow, Row};
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
    pg_cache: Arc<Mutex<HashMap<uuid::Uuid, (String, serde_json::Value)>>>,
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

#[derive(Debug, Deserialize)]
struct CreateProjectGraphPayload {
    name: String,
    path: String,
    description: Option<String>,
}

#[derive(Debug, Deserialize)]
struct QueryProjectGraphParams {
    q: String,
    #[serde(default = "default_pg_hops")]
    hops: u8,
    #[serde(default = "default_pg_limit")]
    limit: usize,
}
fn default_pg_hops() -> u8 { 2 }
fn default_pg_limit() -> usize { 50 }

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

    /// Returns (docs, total_hits) where total_hits is the full index count from OpenSearch.
    async fn list_all(&self, limit: usize, from: usize) -> anyhow::Result<(Vec<MemoryDocument>, usize)> {
        let url = format!("{}/{}/_search", self.base_url, self.index);

        let search_body = serde_json::json!({
            "from": from,
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
        let total_hits = result["hits"]["total"]["value"].as_u64().unwrap_or(0) as usize;
        let hits = result["hits"]["hits"].as_array();

        let docs: Vec<MemoryDocument> = hits
            .map(|arr| {
                arr.iter()
                    .filter_map(|hit| serde_json::from_value(hit["_source"].clone()).ok())
                    .collect()
            })
            .unwrap_or_default();

        Ok((docs, total_hits))
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
        offset: Option<usize>,
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

    #[serde(rename = "graph.get_graph")]
    GraphGetGraph {
        #[serde(default)]
        group_id: Option<String>,
        #[serde(default)]
        limit: Option<usize>,
    },

    #[serde(rename = "graph.analyze_all")]
    GraphAnalyzeAll {
        #[serde(default)]
        user_id: Option<String>,
        #[serde(default)]
        limit: Option<usize>,
    },

    #[serde(rename = "graph.get_llm_config")]
    GraphGetLlmConfig {},

    #[serde(rename = "graph.set_llm_config")]
    GraphSetLlmConfig {
        provider: String,
        model: String,
        #[serde(default)]
        api_key: Option<String>,
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
        total_count: usize,
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

    #[serde(rename = "graph.get_graph.result")]
    GraphGetGraphResult {
        entities: Vec<falkordb::EntityInfo>,
        facts: Vec<falkordb::FactResult>,
    },

    #[serde(rename = "graph.analyze_all.result")]
    GraphAnalyzeAllResult {
        processed: usize,
        entities_created: usize,
        facts_created: usize,
        errors: usize,
    },

    #[serde(rename = "graph.get_llm_config.result")]
    GraphGetLlmConfigResult {
        provider: String,
        model: String,
        configured: bool,
    },

    #[serde(rename = "graph.set_llm_config.result")]
    GraphSetLlmConfigResult { provider: String },

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

    let state = AppState {
        db,
        opensearch,
        redis,
        falkordb,
        api_token,
        encryption_key,
        pg_cache: Arc::new(Mutex::new(HashMap::new())),
    };

    let app = Router::new()
        .route("/health", get(health))
        .route("/mcp", post(mcp))
        .route("/sessions", get(list_sessions))
        .route("/sessions/:id", get(get_session))
        .route("/sessions/:id/messages", get(get_session_messages))
        .route("/agents", get(list_agents).post(create_agent))
        .route("/agents/:id", get(get_agent).put(update_agent).delete(delete_agent))
        .route("/graph/projects", get(list_project_graphs).post(create_project_graph))
        .route("/graph/projects/:id", get(get_project_graph).delete(delete_project_graph))
        .route("/graph/projects/:id/rebuild", post(rebuild_project_graph))
        .route("/graph/projects/:id/query", get(query_project_graph))
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

    // Add graph_analyzed_at column if not present (tracks which memories have been LLM-extracted)
    sqlx::query(
        "ALTER TABLE memory_index ADD COLUMN IF NOT EXISTS graph_analyzed_at TIMESTAMPTZ",
    )
    .execute(db)
    .await
    .ok();

    // project_graphs table for knowledge graph storage
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
    .execute(db)
    .await
    .context("failed to create project_graphs table")?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_project_graphs_path ON project_graphs(path)")
        .execute(db)
        .await
        .ok();
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_project_graphs_created_at ON project_graphs(created_at DESC)")
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

            // 3. Save graph node + LLM entity extraction (non-blocking — failure is logged, not fatal)
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

            // 4. LLM entity/fact extraction (non-blocking — runs if LLM is configured)
            if let Some(mut fdb_c) = state.falkordb.clone() {
                let db_c = state.db.clone();
                let ek_c = state.encryption_key;
                let content_c = content.clone();
                let uid_c = user_id.clone();
                tokio::spawn(async move {
                    if let Some(cfg) = load_llm_config(&db_c, &ek_c).await {
                        let (entities, facts) =
                            analyze_and_upsert(&content_c, id, uid_c.as_deref(), &mut fdb_c, &db_c, &cfg).await;
                        if entities > 0 || facts > 0 {
                            info!("graph extraction: {entities} entities, {facts} facts from memory {id}");
                        }
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

        McpRequest::MemoryList { limit, offset, user_id, source } => {
            let limit = limit.unwrap_or(20).clamp(1, 500);
            let offset = offset.unwrap_or(0) as i64;
            let source = source.as_deref().unwrap_or("all");

            // Total count always comes from PostgreSQL (authoritative index)
            let total_count: i64 = match &user_id {
                Some(uid) => sqlx::query_scalar(
                    "SELECT COUNT(*) FROM memory_index WHERE user_id = $1",
                )
                .bind(uid)
                .fetch_one(&state.db)
                .await
                .unwrap_or(0),
                None => sqlx::query_scalar("SELECT COUNT(*) FROM memory_index")
                    .fetch_one(&state.db)
                    .await
                    .unwrap_or(0),
            };

            match source {
                "postgres" => {
                    let indexes: Vec<MemoryIndex> = match &user_id {
                        Some(uid) => {
                            sqlx::query_as(
                                "SELECT id, user_id, summary, importance_score, tags, created_at, updated_at \
                                 FROM memory_index WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3",
                            )
                            .bind(uid)
                            .bind(limit as i64)
                            .bind(offset)
                            .fetch_all(&state.db)
                            .await
                        }
                        None => {
                            sqlx::query_as(
                                "SELECT id, user_id, summary, importance_score, tags, created_at, updated_at \
                                 FROM memory_index ORDER BY created_at DESC LIMIT $1 OFFSET $2",
                            )
                            .bind(limit as i64)
                            .bind(offset)
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
                        Json(McpResponse::MemoryListResult {
                            memories: results,
                            total,
                            total_count: total_count as usize,
                            source: "postgres".to_string(),
                        }),
                    ))
                }

                "opensearch" => {
                    let (docs, os_total) = state.opensearch
                        .list_all(limit, offset as usize)
                        .await
                        .unwrap_or_default();

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
                        Json(McpResponse::MemoryListResult {
                            memories: results,
                            total,
                            total_count: os_total.max(total_count as usize),
                            source: "opensearch".to_string(),
                        }),
                    ))
                }

                _ => {
                    // "all" — index from PostgreSQL, content from OpenSearch
                    let indexes: Vec<MemoryIndex> = match &user_id {
                        Some(uid) => {
                            sqlx::query_as(
                                "SELECT id, user_id, summary, importance_score, tags, created_at, updated_at \
                                 FROM memory_index WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3",
                            )
                            .bind(uid)
                            .bind(limit as i64)
                            .bind(offset)
                            .fetch_all(&state.db)
                            .await
                        }
                        None => {
                            sqlx::query_as(
                                "SELECT id, user_id, summary, importance_score, tags, created_at, updated_at \
                                 FROM memory_index ORDER BY created_at DESC LIMIT $1 OFFSET $2",
                            )
                            .bind(limit as i64)
                            .bind(offset)
                            .fetch_all(&state.db)
                            .await
                        }
                    }
                    .unwrap_or_default();

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
                        Json(McpResponse::MemoryListResult {
                            memories: results,
                            total,
                            total_count: total_count as usize,
                            source: "all".to_string(),
                        }),
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

        McpRequest::GraphGetGraph { group_id, limit } => {
            let limit = limit.unwrap_or(500).clamp(1, 2000);
            let mut fdb = match &state.falkordb {
                Some(fdb) => fdb.clone(),
                None => return Ok((
                    StatusCode::OK,
                    Json(McpResponse::GraphGetGraphResult { entities: vec![], facts: vec![] }),
                )),
            };
            match fdb.get_graph_data(group_id.as_deref(), limit).await {
                Ok((entities, facts)) => Ok((
                    StatusCode::OK,
                    Json(McpResponse::GraphGetGraphResult { entities, facts }),
                )),
                Err(e) => {
                    error!("FalkorDB get_graph_data failed: {e}");
                    Ok((
                        StatusCode::OK,
                        Json(McpResponse::GraphGetGraphResult { entities: vec![], facts: vec![] }),
                    ))
                }
            }
        }

        McpRequest::EnvSet { key, value, is_secret, description } => {
            // Prevent unauthenticated callers from overwriting LLM config keys,
            // which would bypass the auth gate on graph.set_llm_config.
            const LLM_RESERVED: &[&str] = &["GRAPH_LLM_PROVIDER", "GRAPH_LLM_API_KEY", "GRAPH_LLM_MODEL"];
            if LLM_RESERVED.contains(&key.as_str()) && !is_authenticated(&headers, &state.api_token) {
                return Err((
                    StatusCode::FORBIDDEN,
                    Json(serde_json::json!({"error": "authentication required to set LLM config keys"})),
                ));
            }

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

        McpRequest::GraphGetLlmConfig {} => {
            let rows: Vec<(String, Vec<u8>)> = sqlx::query_as(
                "SELECT key, value_encrypted FROM env_params \
                 WHERE key IN ('GRAPH_LLM_PROVIDER', 'GRAPH_LLM_API_KEY', 'GRAPH_LLM_MODEL')",
            )
            .fetch_all(&state.db)
            .await
            .map_err(|e| {
                error!("GraphGetLlmConfig DB error: {e}");
                (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error":"Database error"})))
            })?;

            let mut provider = "openrouter".to_string();
            let mut model: Option<String> = None;
            let mut configured = false;

            for (key, encrypted) in rows {
                match decrypt_value(&state.encryption_key, &encrypted) {
                    Ok(val) => match key.as_str() {
                        "GRAPH_LLM_PROVIDER" => provider = val,
                        "GRAPH_LLM_MODEL" => model = Some(val),
                        "GRAPH_LLM_API_KEY" => configured = !val.is_empty(),
                        _ => {}
                    },
                    Err(_) => {}
                }
            }

            let model = model.unwrap_or_else(|| match provider.as_str() {
                "anthropic" => "claude-haiku-4-5-20251001".to_string(),
                "openai" => "gpt-4o-mini".to_string(),
                _ => "anthropic/claude-haiku-4".to_string(),
            });

            Ok((
                StatusCode::OK,
                Json(McpResponse::GraphGetLlmConfigResult { provider, model, configured }),
            ))
        }

        McpRequest::GraphSetLlmConfig { provider, model, api_key } => {
            if !is_authenticated(&headers, &state.api_token) {
                return Err((
                    StatusCode::UNAUTHORIZED,
                    Json(serde_json::json!({"error": "authentication required"})),
                ));
            }

            let now = Utc::now();
            let upsert = |key: &str, val: &str, secret: bool| {
                let encrypted = encrypt_value(&state.encryption_key, val);
                sqlx::query(
                    "INSERT INTO env_params (key, value_encrypted, is_secret, updated_at) \
                     VALUES ($1, $2, $3, $4) \
                     ON CONFLICT (key) DO UPDATE SET \
                         value_encrypted = EXCLUDED.value_encrypted, \
                         is_secret = EXCLUDED.is_secret, \
                         updated_at = EXCLUDED.updated_at",
                )
                .bind(key.to_string())
                .bind(encrypted)
                .bind(secret)
                .bind(now)
            };

            upsert("GRAPH_LLM_PROVIDER", &provider, false)
                .execute(&state.db)
                .await
                .map_err(|e| {
                    error!("Failed to save GRAPH_LLM_PROVIDER: {e}");
                    (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error":"DB error"})))
                })?;

            upsert("GRAPH_LLM_MODEL", &model, false)
                .execute(&state.db)
                .await
                .map_err(|e| {
                    error!("Failed to save GRAPH_LLM_MODEL: {e}");
                    (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error":"DB error"})))
                })?;

            if let Some(key) = api_key.filter(|k| !k.trim().is_empty()) {
                upsert("GRAPH_LLM_API_KEY", &key, true)
                    .execute(&state.db)
                    .await
                    .map_err(|e| {
                        error!("Failed to save GRAPH_LLM_API_KEY: {e}");
                        (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error":"DB error"})))
                    })?;
            }

            Ok((StatusCode::OK, Json(McpResponse::GraphSetLlmConfigResult { provider })))
        }

        McpRequest::GraphAnalyzeAll { user_id, limit } => {
            if !is_authenticated(&headers, &state.api_token) {
                return Err((
                    StatusCode::UNAUTHORIZED,
                    Json(serde_json::json!({"error": "authentication required"})),
                ));
            }

            let cfg = match load_llm_config(&state.db, &state.encryption_key).await {
                Some(c) => c,
                None => {
                    return Err((
                        StatusCode::BAD_REQUEST,
                        Json(serde_json::json!({"error": "LLM not configured — set GRAPH_LLM_API_KEY via LLM Settings"})),
                    ));
                }
            };

            let fdb = match &state.falkordb {
                Some(f) => f.clone(),
                None => {
                    return Err((
                        StatusCode::SERVICE_UNAVAILABLE,
                        Json(serde_json::json!({"error": "FalkorDB not connected"})),
                    ));
                }
            };

            let limit = limit.unwrap_or(50).clamp(1, 200);

            // Fetch IDs of memories not yet analyzed, optionally scoped to a user
            let unanalyzed: Vec<(Uuid, Option<String>)> = if let Some(ref uid) = user_id {
                sqlx::query_as(
                    "SELECT id, user_id FROM memory_index \
                     WHERE graph_analyzed_at IS NULL AND user_id = $1 \
                     ORDER BY created_at DESC LIMIT $2",
                )
                .bind(uid)
                .bind(limit as i64)
                .fetch_all(&state.db)
                .await
            } else {
                sqlx::query_as(
                    "SELECT id, user_id FROM memory_index \
                     WHERE graph_analyzed_at IS NULL \
                     ORDER BY created_at DESC LIMIT $1",
                )
                .bind(limit as i64)
                .fetch_all(&state.db)
                .await
            }
            .map_err(|e| {
                error!("GraphAnalyzeAll DB query failed: {e}");
                (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error":"Database error"})))
            })?;

            let total = unanalyzed.len();
            let mut processed = 0usize;
            let mut total_entities = 0usize;
            let mut total_facts = 0usize;
            let mut errors = 0usize;

            for (mem_id, mem_user_id) in unanalyzed {
                match state.opensearch.get_document(&mem_id.to_string()).await {
                    Ok(Some(doc)) => {
                        let mut fdb_c = fdb.clone();
                        let (e, f) = analyze_and_upsert(
                            &doc.content,
                            mem_id,
                            mem_user_id.as_deref(),
                            &mut fdb_c,
                            &state.db,
                            &cfg,
                        )
                        .await;
                        total_entities += e;
                        total_facts += f;
                        processed += 1;
                    }
                    Ok(None) => {
                        // Document missing from OpenSearch — mark as analyzed to skip on next run
                        let _ = sqlx::query(
                            "UPDATE memory_index SET graph_analyzed_at = NOW() WHERE id = $1",
                        )
                        .bind(mem_id)
                        .execute(&state.db)
                        .await;
                        processed += 1;
                    }
                    Err(e) => {
                        warn!("Failed to fetch document {mem_id} from OpenSearch: {e}");
                        errors += 1;
                    }
                }
            }

            info!(
                "graph.analyze_all: {processed}/{total} processed, {total_entities} entities, \
                 {total_facts} facts, {errors} errors"
            );

            Ok((
                StatusCode::OK,
                Json(McpResponse::GraphAnalyzeAllResult {
                    processed,
                    entities_created: total_entities,
                    facts_created: total_facts,
                    errors,
                }),
            ))
        }
    }
}

async fn load_llm_config(db: &PgPool, encryption_key: &[u8; 32]) -> Option<llm::LlmConfig> {
    let rows: Vec<(String, Vec<u8>)> = sqlx::query_as(
        "SELECT key, value_encrypted FROM env_params \
         WHERE key IN ('GRAPH_LLM_PROVIDER', 'GRAPH_LLM_API_KEY', 'GRAPH_LLM_MODEL')",
    )
    .fetch_all(db)
    .await
    .ok()?;

    let mut provider = "openrouter".to_string();
    let mut api_key: Option<String> = None;
    let mut model: Option<String> = None;

    for (key, encrypted) in rows {
        match decrypt_value(encryption_key, &encrypted) {
            Ok(val) => match key.as_str() {
                "GRAPH_LLM_PROVIDER" => provider = val,
                "GRAPH_LLM_API_KEY" => api_key = Some(val),
                "GRAPH_LLM_MODEL" => model = Some(val),
                _ => {}
            },
            Err(e) => warn!("Failed to decrypt {key}: {e}"),
        }
    }

    let api_key = api_key?;
    let model = model.unwrap_or_else(|| match provider.as_str() {
        "anthropic" => "claude-haiku-4-5-20251001".to_string(),
        "openai" => "gpt-4o-mini".to_string(),
        _ => "anthropic/claude-haiku-4".to_string(),
    });

    Some(llm::LlmConfig { provider, api_key, model })
}

async fn analyze_and_upsert(
    content: &str,
    memory_id: Uuid,
    user_id: Option<&str>,
    fdb: &mut FalkorDbClient,
    db: &PgPool,
    cfg: &llm::LlmConfig,
) -> (usize, usize) {
    let extraction = llm::extract_graph(content, cfg).await;

    let group_id = user_id.unwrap_or("default");
    let now = Utc::now().to_rfc3339();
    let mut entity_count = 0usize;
    let mut fact_count = 0usize;

    // Create an Episode node for provenance tracking
    let episode_id = Uuid::new_v4();
    let episode_id_str = episode_id.to_string();
    let episode_name: String = content.chars().take(120).collect();
    let content_preview: String = content.chars().take(1000).collect();
    if let Err(e) = fdb
        .add_episode(
            episode_id,
            &episode_name,
            "memory",
            "LLM-extracted memory",
            &content_preview,
            group_id,
            &now,
            &now,
        )
        .await
    {
        warn!("Episode creation failed (continuing without provenance): {e}");
    }

    // Build a canonical_name → entity_type map so facts use the same type as their entities,
    // preventing duplicate Entity nodes from type disagreements between the entities and facts lists.
    let entity_type_map: std::collections::HashMap<String, String> = extraction
        .entities
        .iter()
        .map(|e| (e.canonical_name.clone(), e.entity_type.clone()))
        .collect();

    for entity in &extraction.entities {
        match fdb
            .merge_entity(
                Uuid::new_v4(),
                &entity.canonical_name,
                &entity.display_name,
                &entity.entity_type,
                group_id,
                entity.summary.as_deref(),
                &now,
            )
            .await
        {
            Ok(_) => entity_count += 1,
            Err(e) => warn!("merge_entity '{}' failed: {e}", entity.canonical_name),
        }
    }

    for fact in &extraction.facts {
        // Use entity_type from the extracted entity list when available; fall back to fact's own type.
        let subj_type = entity_type_map
            .get(&fact.subject)
            .map(|s| s.as_str())
            .unwrap_or(&fact.subject_type);
        let obj_type = entity_type_map
            .get(&fact.object)
            .map(|s| s.as_str())
            .unwrap_or(&fact.object_type);

        // Ensure both endpoint entities exist before creating the fact edge
        let _ = fdb
            .merge_entity(
                Uuid::new_v4(),
                &fact.subject,
                &fact.subject,
                subj_type,
                group_id,
                None,
                &now,
            )
            .await;
        let _ = fdb
            .merge_entity(
                Uuid::new_v4(),
                &fact.object,
                &fact.object,
                obj_type,
                group_id,
                None,
                &now,
            )
            .await;

        match fdb
            .merge_extracted_fact(
                &fact.subject,
                subj_type,
                &fact.object,
                obj_type,
                &fact.relation,
                &fact.fact,
                group_id,
                Some(&episode_id_str),
                &now,
            )
            .await
        {
            Ok(_) => fact_count += 1,
            Err(e) => warn!("merge_extracted_fact failed: {e}"),
        }
    }

    // Only mark as analyzed when the LLM call itself succeeded (even if no entities found).
    // Transport errors (network, auth, rate-limit) leave graph_analyzed_at NULL so the
    // memory gets retried on the next analyze_all run.
    if extraction.ok {
        let _ = sqlx::query("UPDATE memory_index SET graph_analyzed_at = NOW() WHERE id = $1")
            .bind(memory_id)
            .execute(db)
            .await;
    }

    (entity_count, fact_count)
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

// ---------------------------------------------------------------------------
// Project Graph handlers
// ---------------------------------------------------------------------------

async fn list_project_graphs(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }

    let rows = sqlx::query_as::<_, project_graphs::ProjectGraphRow>(
        "SELECT id, name, path, canonical_path, description, node_count, edge_count, \
         graph_hash, graph_file_size, imported_at, created_at, updated_at \
         FROM project_graphs ORDER BY created_at DESC"
    )
    .fetch_all(&state.db)
    .await;

    match rows {
        Ok(projects) => {
            let total = projects.len();
            Json(serde_json::json!({"projects": projects, "total": total})).into_response()
        }
        Err(e) => {
            error!("list_project_graphs error: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response()
        }
    }
}

async fn create_project_graph(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<CreateProjectGraphPayload>,
) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }

    if payload.name.trim().is_empty() || payload.path.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "name and path must be non-empty"}))).into_response();
    }

    let (graph_data, graph_hash, file_size, canonical) = match project_graphs::load_graph_json(&payload.path).await {
        Ok(result) => result,
        Err(e) => {
            return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": e.to_string()}))).into_response();
        }
    };

    let (node_count, edge_count) = project_graphs::count_nodes_edges(&graph_data);

    let row = sqlx::query(
        "INSERT INTO project_graphs \
         (name, path, canonical_path, description, graph_data, graph_hash, graph_file_size, node_count, edge_count, imported_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW()) \
         ON CONFLICT (canonical_path) DO UPDATE SET \
           name = $1, description = $4, graph_data = $5, graph_hash = $6, \
           graph_file_size = $7, node_count = $8, edge_count = $9, \
           imported_at = NOW(), updated_at = NOW() \
         RETURNING id, name, path, canonical_path, description, node_count, edge_count, \
                   graph_hash, graph_file_size, imported_at, created_at, updated_at, \
                   (xmax = 0) AS was_inserted"
    )
    .bind(&payload.name)
    .bind(&payload.path)
    .bind(&canonical)
    .bind(&payload.description)
    .bind(&graph_data)
    .bind(&graph_hash)
    .bind(file_size as i64)
    .bind(node_count)
    .bind(edge_count)
    .fetch_one(&state.db)
    .await;

    match row {
        Ok(r) => {
            let was_inserted: bool = r.try_get("was_inserted").unwrap_or(true);
            let status = if was_inserted { StatusCode::CREATED } else { StatusCode::OK };
            let project = serde_json::json!({
                "id": r.try_get::<uuid::Uuid, _>("id").ok(),
                "name": r.try_get::<String, _>("name").ok(),
                "path": r.try_get::<String, _>("path").ok(),
                "canonical_path": r.try_get::<String, _>("canonical_path").ok(),
                "description": r.try_get::<Option<String>, _>("description").ok().flatten(),
                "node_count": r.try_get::<i32, _>("node_count").ok(),
                "edge_count": r.try_get::<i32, _>("edge_count").ok(),
                "graph_hash": r.try_get::<Option<String>, _>("graph_hash").ok().flatten(),
                "graph_file_size": r.try_get::<Option<i64>, _>("graph_file_size").ok().flatten(),
                "imported_at": r.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("imported_at").ok().flatten(),
                "created_at": r.try_get::<chrono::DateTime<chrono::Utc>, _>("created_at").ok(),
                "updated_at": r.try_get::<chrono::DateTime<chrono::Utc>, _>("updated_at").ok(),
            });
            (status, Json(project)).into_response()
        }
        Err(e) => {
            error!("create_project_graph error: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response()
        }
    }
}

async fn get_project_graph(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }

    let row = sqlx::query_as::<_, project_graphs::ProjectGraphRow>(
        "SELECT id, name, path, canonical_path, description, node_count, edge_count, \
         graph_hash, graph_file_size, imported_at, created_at, updated_at \
         FROM project_graphs WHERE id = $1"
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await;

    match row {
        Ok(Some(project)) => Json(serde_json::json!(project)).into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "project graph not found"}))).into_response(),
        Err(e) => {
            error!("get_project_graph error: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response()
        }
    }
}

async fn delete_project_graph(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }

    let row = sqlx::query("DELETE FROM project_graphs WHERE id = $1 RETURNING name")
        .bind(id)
        .fetch_optional(&state.db)
        .await;

    match row {
        Ok(Some(r)) => {
            // Invalidate cache only on confirmed deletion
            if let Ok(mut cache) = state.pg_cache.lock() {
                cache.remove(&id);
            }
            let name: String = r.try_get("name").unwrap_or_default();
            (StatusCode::OK, Json(serde_json::json!({"deleted": id, "name": name}))).into_response()
        }
        Ok(None) => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "project graph not found"}))).into_response(),
        Err(e) => {
            error!("delete_project_graph error: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response()
        }
    }
}

async fn rebuild_project_graph(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }

    // Get existing project to find path and old hash
    let existing = sqlx::query(
        "SELECT path, graph_hash FROM project_graphs WHERE id = $1"
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await;

    let row = match existing {
        Ok(Some(r)) => r,
        Ok(None) => return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "project graph not found"}))).into_response(),
        Err(e) => {
            error!("rebuild_project_graph fetch error: {e}");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response();
        }
    };

    let path: String = row.try_get("path").unwrap_or_default();
    let old_hash: Option<String> = row.try_get("graph_hash").unwrap_or(None);

    let (graph_data, graph_hash, file_size, _canonical) = match project_graphs::load_graph_json(&path).await {
        Ok(result) => result,
        Err(e) => {
            return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": e.to_string()}))).into_response();
        }
    };

    // Skip update if hash unchanged
    if old_hash.as_deref() == Some(graph_hash.as_str()) {
        return Json(serde_json::json!({
            "id": id,
            "status": "unchanged",
            "graph_hash": graph_hash,
        })).into_response();
    }

    let (node_count, edge_count) = project_graphs::count_nodes_edges(&graph_data);

    let update = sqlx::query(
        "UPDATE project_graphs SET \
         graph_data = $1, graph_hash = $2, graph_file_size = $3, \
         node_count = $4, edge_count = $5, imported_at = NOW(), updated_at = NOW() \
         WHERE id = $6"
    )
    .bind(&graph_data)
    .bind(&graph_hash)
    .bind(file_size as i64)
    .bind(node_count)
    .bind(edge_count)
    .bind(id)
    .execute(&state.db)
    .await;

    // Invalidate cache
    if let Ok(mut cache) = state.pg_cache.lock() {
        cache.remove(&id);
    }

    match update {
        Ok(_) => Json(serde_json::json!({
            "id": id,
            "status": "rebuilt",
            "graph_hash": graph_hash,
            "node_count": node_count,
            "edge_count": edge_count,
        })).into_response(),
        Err(e) => {
            error!("rebuild_project_graph update error: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response()
        }
    }
}

async fn query_project_graph(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Query(params): Query<QueryProjectGraphParams>,
) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }

    if params.q.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "q must be non-empty"}))).into_response();
    }

    // Check cache first (don't hold lock across await)
    let cached = {
        if let Ok(cache) = state.pg_cache.lock() {
            cache.get(&id).cloned()
        } else {
            None
        }
    };

    let graph_data = if let Some((cached_hash, cached_data)) = cached {
        // Verify hash still matches DB
        let hash_check = sqlx::query("SELECT graph_hash FROM project_graphs WHERE id = $1")
            .bind(id)
            .fetch_optional(&state.db)
            .await;

        let db_hash = match hash_check {
            Ok(Some(r)) => r.try_get::<Option<String>, _>("graph_hash").ok().flatten(),
            Ok(None) => {
                return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "project not found"}))).into_response();
            }
            Err(e) => {
                return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response();
            }
        };

        if db_hash.as_deref() == Some(cached_hash.as_str()) {
            cached_data
        } else {
            // Cache stale — reload
            let row = sqlx::query("SELECT graph_data, graph_hash FROM project_graphs WHERE id = $1")
                .bind(id)
                .fetch_optional(&state.db)
                .await;

            match row {
                Ok(Some(r)) => {
                    let data: serde_json::Value = r.try_get("graph_data").unwrap_or(serde_json::Value::Null);
                    let hash: String = r.try_get("graph_hash").ok().flatten().unwrap_or_default();
                    if let Ok(mut cache) = state.pg_cache.lock() {
                        cache.insert(id, (hash, data.clone()));
                    }
                    data
                }
                Ok(None) => return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "project graph not found"}))).into_response(),
                Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
            }
        }
    } else {
        // Cache miss — fetch from DB
        let row = sqlx::query("SELECT graph_data, graph_hash FROM project_graphs WHERE id = $1")
            .bind(id)
            .fetch_optional(&state.db)
            .await;

        match row {
            Ok(Some(r)) => {
                let data: serde_json::Value = r.try_get("graph_data").unwrap_or(serde_json::Value::Null);
                let hash: String = r.try_get("graph_hash").ok().flatten().unwrap_or_default();
                if let Ok(mut cache) = state.pg_cache.lock() {
                    cache.insert(id, (hash, data.clone()));
                }
                data
            }
            Ok(None) => return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "project graph not found"}))).into_response(),
            Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
        }
    };

    let hops = params.hops.min(4);
    let limit = params.limit.min(200);
    let result = project_graphs::bfs_query(&graph_data, &params.q, hops, limit);
    Json(serde_json::json!(result)).into_response()
}

#[allow(dead_code)]
async fn _sleep_for_readability() {
    tokio::time::sleep(Duration::from_millis(10)).await;
}
