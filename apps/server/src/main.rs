mod autofill;
mod budget_ai;
mod claude_usage;
mod commit_ai;
mod crypto;
mod design_ai;
mod design_blobs;
mod design_budgets;
mod falkordb;
mod forecasts;
mod llm;
mod resources;
mod workflows;

use openmemory_server::run_session_migrations;
use openmemory_server::project_graphs;
use openmemory_server::indexer;
use openmemory_server::git_browser;
use openmemory_server::design_assets;

use std::{cmp::Ordering, net::SocketAddr, time::Duration};

use anyhow::Context;
use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, HeaderValue, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use crypto::{decrypt_value, derive_key, encrypt_value, fingerprint, EnvParamRow};
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

const MEMORY_GRAPH_SUMMARY_EDGE_LIMIT: usize = 3_000;

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
    claude_usage_cache: Arc<Mutex<Option<(std::time::Instant, serde_json::Value)>>>,
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

#[derive(Deserialize)]
struct TimeseriesParams {
    bucket: Option<String>,
    periods: Option<i64>,
}

fn default_limit() -> i64 { 50 }
fn default_messages_limit() -> i64 { 200 }

const VALID_VERSION_STATUSES: [&str; 4] = ["active", "maintenance", "archived", "deprecated"];

#[derive(Debug, Deserialize)]
struct CreateProjectGraphPayload {
    name: String,
    path: Option<String>,
    description: Option<String>,
    version_status: Option<String>,
}

/// Deserializes a present-but-possibly-null JSON field into `Some(value)`,
/// leaving it `None` when the field is omitted entirely. Lets PATCH-style
/// payloads distinguish "don't touch this field" from "clear it".
fn deserialize_some<'de, T, D>(deserializer: D) -> Result<Option<T>, D::Error>
where
    T: Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    Deserialize::deserialize(deserializer).map(Some)
}

#[derive(Debug, Deserialize)]
struct UpdateProjectGraphPayload {
    name: Option<String>,
    #[serde(default, deserialize_with = "deserialize_some")]
    path: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_some")]
    description: Option<Option<String>>,
    version_status: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ForecastProfilePayload {
    name: String,
    description: Option<String>,
    application_type: String,
    user_count: i64,
    monthly_budget_usd: i64,
    stress_tolerance: String,
    usage_pattern: String,
    engagement_percent: i32,
    planning_horizon_months: i32,
    annual_growth_percent: i32,
    notes: Option<String>,
}

impl From<ForecastProfilePayload> for forecasts::ForecastInput {
    fn from(value: ForecastProfilePayload) -> Self {
        Self {
            name: value.name,
            description: value.description,
            application_type: value.application_type,
            user_count: value.user_count,
            monthly_budget_usd: value.monthly_budget_usd,
            stress_tolerance: value.stress_tolerance,
            usage_pattern: value.usage_pattern,
            engagement_percent: value.engagement_percent,
            planning_horizon_months: value.planning_horizon_months,
            annual_growth_percent: value.annual_growth_percent,
            notes: value.notes,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, FromRow)]
struct ProjectTask {
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
    start_date: Option<chrono::NaiveDate>,
    due_date: Option<chrono::NaiveDate>,
    sort_order: i32,
}

#[derive(Debug, Deserialize)]
struct CreateTaskPayload {
    title: String,
    description: Option<String>,
    status: Option<String>,
    priority: Option<String>,
    assigned_to: Option<String>,
    labels: Option<Vec<String>>,
    parent_id: Option<Uuid>,
    start_date: Option<chrono::NaiveDate>,
    due_date: Option<chrono::NaiveDate>,
}

#[derive(Debug, Deserialize)]
struct UpdateTaskPayload {
    title: Option<String>,
    description: Option<String>,
    status: Option<String>,
    priority: Option<String>,
    assigned_to: Option<String>,
    labels: Option<Vec<String>>,
    #[serde(default, deserialize_with = "deserialize_some")]
    parent_id: Option<Option<Uuid>>,
    #[serde(default, deserialize_with = "deserialize_some")]
    start_date: Option<Option<chrono::NaiveDate>>,
    #[serde(default, deserialize_with = "deserialize_some")]
    due_date: Option<Option<chrono::NaiveDate>>,
}

#[derive(Debug, Serialize, Deserialize, FromRow)]
struct ProjectLesson {
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

#[derive(Debug, Deserialize)]
struct CreateLessonPayload {
    title: String,
    rule: String,
    context: Option<String>,
    category: Option<String>,
    severity: Option<String>,
    tags: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct UpdateLessonPayload {
    title: Option<String>,
    #[serde(default, deserialize_with = "deserialize_some")]
    context: Option<Option<String>>,
    rule: Option<String>,
    category: Option<String>,
    severity: Option<String>,
    status: Option<String>,
    tags: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct WorkflowPayload {
    name: String,
    description: Option<String>,
    #[serde(default = "empty_json_object")]
    input_schema: serde_json::Value,
    steps: serde_json::Value,
    #[serde(default = "default_true")]
    enabled: bool,
}

#[derive(Debug, Deserialize)]
struct WorkflowRunPayload {
    #[serde(default = "empty_json_object")]
    input: serde_json::Value,
}

#[derive(Debug, Deserialize)]
struct WorkflowContinuePayload {
    result: serde_json::Value,
}

fn empty_json_object() -> serde_json::Value { serde_json::json!({}) }
fn default_true() -> bool { true }

#[derive(Debug, Serialize, Deserialize, FromRow)]
struct ProjectDesign {
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

#[derive(Debug, Deserialize)]
struct CreateDesignPayload {
    title: String,
    kind: Option<String>,
    diagram_type: Option<String>,
    source: Option<String>,
    notes: Option<String>,
    tags: Option<Vec<String>>,
    sort_order: Option<i32>,
}

#[derive(Debug, Deserialize)]
struct UpdateDesignPayload {
    title: Option<String>,
    kind: Option<String>,
    diagram_type: Option<String>,
    source: Option<String>,
    #[serde(default, deserialize_with = "deserialize_some")]
    notes: Option<Option<String>>,
    tags: Option<Vec<String>>,
    sort_order: Option<i32>,
    status: Option<String>,
}

pub(crate) const VALID_DIAGRAM_TYPES: &[&str] = &["drawio", "mermaid", "reactflow", "pen"];

#[derive(Debug, Deserialize)]
struct ListDesignsParams {
    status: Option<String>,
}

const PROJECT_DESIGN_COLUMNS: &str = "id, project_id, title, kind, diagram_type, source, notes, tags, sort_order, status, created_by, created_at, updated_at";

#[derive(Debug, Deserialize)]
struct ListLessonsParams {
    query: Option<String>,
    category: Option<String>,
    tags: Option<String>,
    status: Option<String>,
    #[serde(default = "default_task_limit")]
    limit: i64,
    #[serde(default)]
    offset: i64,
}

/// Trim/lowercase/dedupe task labels — built-ins and free-text custom labels alike.
fn normalize_labels(labels: &[String]) -> Vec<String> {
    let mut out: Vec<String> = labels.iter()
        .map(|l| l.trim().to_lowercase())
        .filter(|l| !l.is_empty())
        .collect();
    out.sort();
    out.dedup();
    out
}

#[derive(Debug, Deserialize)]
struct ListTasksParams {
    status: Option<String>,
    #[serde(default)]
    routine_id: Option<Uuid>,
    #[serde(default = "default_task_limit")]
    limit: i64,
    #[serde(default)]
    offset: i64,
}
fn default_task_limit() -> i64 { 50 }

#[derive(Debug, Serialize, Deserialize, FromRow)]
struct ProjectRoutine {
    id: Uuid,
    project_id: Uuid,
    title: String,
    description: Option<String>,
    frequency: String,   // 'daily' | 'weekly' | 'monthly'
    priority: String,
    assigned_to: Option<String>,
    last_task_date: Option<chrono::NaiveDate>,
    enabled: bool,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    labels: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct CreateRoutinePayload {
    title: String,
    description: Option<String>,
    frequency: Option<String>,
    priority: Option<String>,
    assigned_to: Option<String>,
    labels: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct UpdateRoutinePayload {
    title: Option<String>,
    description: Option<String>,
    frequency: Option<String>,
    priority: Option<String>,
    assigned_to: Option<String>,
    enabled: Option<bool>,
    labels: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct CheckRoutinesParams {
    #[serde(default)]
    dry_run: bool,
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

#[derive(Debug, Deserialize)]
struct GetProjectGraphParams {
    detail: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ListProjectFilesParams {
    #[serde(default)]
    path: String,
}

#[derive(Debug, Deserialize)]
struct ListProjectCommitsParams {
    #[serde(default = "default_commit_limit")]
    limit: usize,
}
fn default_commit_limit() -> usize { 300 }

#[derive(Debug, Deserialize)]
struct CommitPushPayload {
    message: String,
}

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

    async fn get_by_ids(&self, ids: &[String]) -> anyhow::Result<Vec<MemoryDocument>> {
        if ids.is_empty() {
            return Ok(vec![]);
        }
        let url = format!("{}/{}/_search", self.base_url, self.index);
        let search_body = serde_json::json!({
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
        #[serde(default)]
        include_graph_view: bool,
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

    #[serde(rename = "memory.graph_data")]
    MemoryGraphData {
        #[serde(default)]
        user_id: Option<String>,
        #[serde(default)]
        limit: Option<usize>,
    },

    #[serde(rename = "memory.graph_rebuild")]
    MemoryGraphRebuild {
        #[serde(default)]
        user_id: Option<String>,
        #[serde(default)]
        limit: Option<usize>,
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

    #[serde(rename = "ai.autofill")]
    AiAutofill {
        kind: String,
        content: String,
        #[serde(default)]
        existing_tags: Option<Vec<String>>,
    },

    #[serde(rename = "ai.design_diagram")]
    AiDesignDiagram {
        prompt: String,
        #[serde(default)]
        kind: Option<String>,
        #[serde(default)]
        format: Option<String>,
        #[serde(default)]
        forecast_profile_id: Option<Uuid>,
    },

    #[serde(rename = "ai.budget_forecast")]
    AiBudgetForecast {
        design_id: Uuid,
        #[serde(default)]
        forecast_profile_id: Option<Uuid>,
        #[serde(default)]
        conditions: Option<String>,
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

    // File uploads from the web UI: the browser can't hand us a server-side
    // path (unlike the MCP env_set_file tool, which reads a path on the same
    // machine as the agent), so the frontend base64-encodes the file client-side
    // and posts the bytes here. Always stored as a secret, matching env_set_file.
    #[serde(rename = "env.set_file")]
    EnvSetFile {
        key: String,
        file_content_base64: String,
        #[serde(default)]
        description: Option<String>,
    },

    #[serde(rename = "env.get")]
    EnvGet { key: String },

    #[serde(rename = "env.list")]
    EnvList {},

    #[serde(rename = "env.delete")]
    EnvDelete { key: String },

    #[serde(rename = "resource.list")]
    ResourceList {
        #[serde(default)]
        kind: Option<String>,
        #[serde(default)]
        tags: Option<Vec<String>>,
        #[serde(default)]
        query: Option<String>,
    },

    #[serde(rename = "resource.tags")]
    ResourceTags {},

    #[serde(rename = "resource.get")]
    ResourceGet {
        /// UUID or name / env slug
        id_or_name: String,
    },

    #[serde(rename = "resource.add")]
    ResourceAdd {
        name: String,
        kind: String,
        location: String,
        #[serde(default)]
        description: Option<String>,
        #[serde(default)]
        tags: Option<Vec<String>>,
        #[serde(default)]
        env_param_keys: Option<Vec<String>>,
    },

    #[serde(rename = "resource.update")]
    ResourceUpdate {
        id: Uuid,
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        kind: Option<String>,
        #[serde(default)]
        location: Option<String>,
        /// Pass null explicitly to clear; omit to leave unchanged.
        #[serde(default)]
        description: Option<Option<String>>,
        #[serde(default)]
        tags: Option<Vec<String>>,
        /// Replaces the full set when present (even `[]`); omit to leave unchanged.
        #[serde(default)]
        env_param_keys: Option<Vec<String>>,
    },

    #[serde(rename = "resource.delete")]
    ResourceDelete { id: Uuid },
}

#[derive(Debug, Serialize)]
struct ResourceTagCount {
    tag: String,
    count: i64,
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
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        related_facts: Vec<falkordb::FactResult>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        graph_view: Option<String>,
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

    #[serde(rename = "memory.graph_data.result")]
    MemoryGraphDataResult {
        memories: Vec<MemoryNodeInfo>,
        edges: Vec<falkordb::EdgeInfo>,
    },

    #[serde(rename = "memory.graph_rebuild.result")]
    MemoryGraphRebuildResult {
        rebuilt: usize,
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

    #[serde(rename = "ai.autofill.result")]
    AiAutofillResult {
        suggestion: autofill::AutofillSuggestion,
        model: String,
    },

    #[serde(rename = "ai.design_diagram.result")]
    AiDesignDiagramResult {
        source: String,
        model: String,
    },

    #[serde(rename = "ai.budget_forecast.result")]
    AiBudgetForecastResult {
        estimate: budget_ai::BudgetEstimate,
        model: String,
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

    #[serde(rename = "resource.list.result")]
    ResourceListResult {
        resources: Vec<resources::ResourceView>,
        total: usize,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        warnings: Vec<String>,
    },

    #[serde(rename = "resource.tags.result")]
    ResourceTagsResult {
        tags: Vec<ResourceTagCount>,
    },

    #[serde(rename = "resource.get.result")]
    ResourceGetResult {
        resource: resources::ResourceView,
    },

    #[serde(rename = "resource.add.result")]
    ResourceAddResult {
        id: Uuid,
        name: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        warning: Option<String>,
    },

    #[serde(rename = "resource.update.result")]
    ResourceUpdateResult {
        id: Uuid,
        #[serde(skip_serializing_if = "Option::is_none")]
        warning: Option<String>,
    },

    #[serde(rename = "resource.delete.result")]
    ResourceDeleteResult { id: Uuid },
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
    #[serde(default)]
    via_graph: bool,
}

// Lightweight memory node for graph visualization — no content, just what's needed to render a node.
#[derive(Debug, Serialize, FromRow)]
struct MemoryNodeInfo {
    id: Uuid,
    summary: Option<String>,
    importance_score: f32,
    tags: Vec<String>,
    created_at: DateTime<Utc>,
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
    if std::env::args().nth(1).as_deref() == Some("rotate-secret-key") {
        tracing_subscriber::fmt()
            .with_env_filter(
                tracing_subscriber::EnvFilter::try_from_default_env()
                    .unwrap_or_else(|_| "openmemory=info,sqlx=warn".into()),
            )
            .init();
        let dry_run = std::env::args().any(|a| a == "--dry-run");
        return rotate_secret_key(dry_run).await;
    }

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

    let secret_key = match std::env::var("OPENMEMORY_SECRET_KEY") {
        Ok(key) => key,
        Err(_) if std::env::var("OPENMEMORY_ALLOW_INSECURE_DEV_KEY").as_deref() == Ok("1") => {
            warn!("OPENMEMORY_ALLOW_INSECURE_DEV_KEY=1 set: using the well-known dev secret key. CI/tests only.");
            "dev-secret-key-change-me".to_string()
        }
        Err(_) => {
            eprintln!(
                "OPENMEMORY_SECRET_KEY is not set. Generate one with:  openssl rand -base64 48\n\
                 and set it in .env / your MCP server env. Refusing to start.\n\
                 (Set OPENMEMORY_ALLOW_INSECURE_DEV_KEY=1 to use the well-known dev key — CI/tests only.)"
            );
            std::process::exit(1);
        }
    };
    let encryption_key = derive_key(&secret_key);

    let state = AppState {
        db,
        opensearch,
        redis,
        falkordb,
        api_token,
        encryption_key,
        pg_cache: Arc::new(Mutex::new(HashMap::new())),
        claude_usage_cache: Arc::new(Mutex::new(None)),
    };

    // Background scheduler: periodically check every project's routines for due
    // tasks and create them automatically — no manual "Check due" click required.
    // Runs inside this same process; if the machine was shut down for days, the
    // immediate run below catches up overdue routines (one task each, since
    // is_routine_due compares dates and naturally collapses multi-day gaps).
    {
        let scheduler_db = state.db.clone();
        let interval_secs: u64 = std::env::var("OPENMEMORY_ROUTINE_CHECK_INTERVAL_SECS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(300);

        tokio::spawn(async move {
            run_routine_check_for_all_projects(&scheduler_db).await;

            let mut ticker = tokio::time::interval(Duration::from_secs(interval_secs));
            ticker.tick().await; // consume the immediate first tick — we already ran above
            loop {
                ticker.tick().await;
                run_routine_check_for_all_projects(&scheduler_db).await;
            }
        });
        info!(interval_secs, "routine background scheduler started");
    }

    let app = Router::new()
        .route("/health", get(health))
        .route("/mcp", post(mcp))
        .route("/sessions", get(list_sessions))
        .route("/sessions/:id", get(get_session))
        .route("/sessions/:id/messages", get(get_session_messages))
        .route("/agents", get(list_agents).post(create_agent))
        .route("/agents/usage-summary", get(get_agents_usage_summary))
        .route("/agents/:id", get(get_agent).put(update_agent).delete(delete_agent))
        .route("/agents/:id/stats", get(get_agent_stats))
        .route("/agents/:id/stats/timeseries", get(get_agent_stats_timeseries))
        .route("/agents/:id/claude-usage", get(get_agent_claude_usage))
        .route("/projects", get(list_project_graphs).post(create_project_graph))
        .route("/projects/:id", get(get_project_graph).put(update_project_graph).delete(delete_project_graph))
        .route("/projects/:id/rebuild", post(rebuild_project_graph))
        .route("/projects/:id/query", get(query_project_graph))
        .route("/projects/:id/files", get(list_project_files))
        .route("/projects/:id/changes", get(list_project_changes))
        .route("/projects/:id/commits", get(list_project_commits))
        .route("/projects/:id/commit-message", post(suggest_project_commit_message))
        .route("/projects/:id/commit-push", post(commit_and_push_project))
        .route("/projects/:id/tasks", get(list_project_tasks).post(create_project_task))
        .route("/projects/:id/tasks/:task_id", axum::routing::put(update_project_task).delete(delete_project_task))
        .route("/projects/:id/routines", get(list_project_routines).post(create_project_routine))
        .route("/projects/:id/routines/check", post(check_project_routines))
        .route("/projects/:id/routines/:routine_id", axum::routing::put(update_project_routine).delete(delete_project_routine))
        .route("/projects/:id/lessons", get(list_project_lessons).post(create_project_lesson))
        .route("/projects/:id/lessons/:lesson_id", axum::routing::put(update_project_lesson).delete(delete_project_lesson))
        .route("/lessons", get(search_lessons))
        .route("/projects/:id/designs", get(list_project_designs).post(create_project_design))
        .route("/projects/:id/designs/:design_id", axum::routing::put(update_project_design).delete(delete_project_design))
        .route(
            "/projects/:id/designs/:design_id/blob",
            get(design_blobs::get_design_blob)
                .put(design_blobs::put_design_blob)
                // Scoped to this route only (not the whole router): a little above
                // MAX_DESIGN_BLOB_BYTES so axum only rejects truly oversized bodies,
                // leaving the handler's own check to return the documented JSON error
                // for anything between the two thresholds.
                .layer(axum::extract::DefaultBodyLimit::max(design_blobs::MAX_DESIGN_BLOB_BYTES + 1024)),
        )
        .route("/projects/:id/designs/:design_id/budgets", get(list_design_budgets).post(create_design_budget))
        .route("/projects/:id/designs/:design_id/budgets/:budget_id", axum::routing::put(update_design_budget).delete(delete_design_budget))
        .route("/projects/:id/design-assets", get(list_project_design_assets))
        .route("/forecast-profiles", get(list_forecast_profiles).post(create_forecast_profile))
        .route("/forecast-profiles/:id", axum::routing::put(update_forecast_profile).delete(delete_forecast_profile))
        .route("/workflows", get(list_workflows).post(create_workflow))
        .route("/workflows/:id", get(get_workflow).put(update_workflow).delete(delete_workflow))
        .route("/workflows/:id/run", post(run_workflow))
        .route("/workflow-runs/:id/continue", post(continue_workflow_run))
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

/// Re-wraps every `env_params.value_encrypted` row from `OPENMEMORY_OLD_SECRET_KEY`
/// to `OPENMEMORY_NEW_SECRET_KEY`, in a single transaction with `SELECT ... FOR UPDATE`.
///
/// Trial-decrypts with the new key first (a row that already verifies under the new
/// key is left alone and counted as `skipped`), then falls back to the old key and
/// re-encrypts. Any row that decrypts under neither key aborts the whole transaction
/// (nothing is written). `dry_run` performs identical work but issues `ROLLBACK`
/// instead of `COMMIT`, so it's safe to run against a live database.
async fn rotate_secret_key(dry_run: bool) -> anyhow::Result<()> {
    use rand::{rngs::OsRng, RngCore};

    let old_secret = std::env::var("OPENMEMORY_OLD_SECRET_KEY")
        .context("OPENMEMORY_OLD_SECRET_KEY must be set (never pass keys as argv)")?;
    let new_secret = std::env::var("OPENMEMORY_NEW_SECRET_KEY")
        .context("OPENMEMORY_NEW_SECRET_KEY must be set (never pass keys as argv)")?;
    if old_secret == new_secret {
        anyhow::bail!("OPENMEMORY_OLD_SECRET_KEY and OPENMEMORY_NEW_SECRET_KEY are identical; nothing to rotate");
    }
    let old_key = derive_key(&old_secret);
    let new_key = derive_key(&new_secret);

    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://openmemory:openmemory@localhost:5432/openmemory".to_string());
    let db = PgPoolOptions::new()
        .max_connections(2)
        .connect(&database_url)
        .await
        .context("failed to connect to PostgreSQL")?;

    // Per-run salt: fingerprints are only comparable within this run and are never
    // printed, so they can't be brute-forced offline.
    let mut run_salt = [0u8; 32];
    OsRng.fill_bytes(&mut run_salt);

    let mut tx = db.begin().await.context("failed to start transaction")?;

    #[derive(FromRow)]
    struct Row {
        id: Uuid,
        key: String,
        value_encrypted: Vec<u8>,
        is_secret: bool,
    }

    let rows: Vec<Row> = sqlx::query_as(
        "SELECT id, key, value_encrypted, is_secret FROM env_params ORDER BY key FOR UPDATE",
    )
    .fetch_all(&mut *tx)
    .await
    .context("failed to select env_params FOR UPDATE")?;

    let total = rows.len();
    let mut rewrapped = 0usize;
    let mut skipped = 0usize;
    let mut report: Vec<(String, bool, String, String, bool)> = Vec::with_capacity(total);

    for row in &rows {
        if let Ok(plaintext) = decrypt_value(&new_key, &row.value_encrypted) {
            // Already rotated in a previous (partial) run — leave it alone.
            let fp = fingerprint(&run_salt, &plaintext);
            skipped += 1;
            report.push((row.key.clone(), row.is_secret, fp.clone(), fp, true));
            continue;
        }

        let plaintext_old = match decrypt_value(&old_key, &row.value_encrypted) {
            Ok(p) => p,
            Err(e) => {
                tx.rollback().await.ok();
                anyhow::bail!(
                    "row '{}' decrypts under neither OPENMEMORY_OLD_SECRET_KEY nor \
                     OPENMEMORY_NEW_SECRET_KEY ({e}); aborting, nothing written",
                    row.key
                );
            }
        };
        let fp_before = fingerprint(&run_salt, &plaintext_old);

        let new_blob = encrypt_value(&new_key, &plaintext_old);
        sqlx::query("UPDATE env_params SET value_encrypted = $1 WHERE id = $2")
            .bind(&new_blob)
            .bind(row.id)
            .execute(&mut *tx)
            .await
            .context("failed to write re-encrypted value")?;

        let plaintext_after = match decrypt_value(&new_key, &new_blob) {
            Ok(p) => p,
            Err(e) => {
                tx.rollback().await.ok();
                anyhow::bail!(
                    "row '{}' failed to re-decrypt immediately after rewrap ({e}); aborting",
                    row.key
                );
            }
        };
        let fp_after = fingerprint(&run_salt, &plaintext_after);
        let matched = fp_before == fp_after && plaintext_old == plaintext_after;
        if !matched {
            tx.rollback().await.ok();
            anyhow::bail!(
                "row '{}' fingerprint mismatch after rewrap; aborting, nothing written",
                row.key
            );
        }

        rewrapped += 1;
        report.push((row.key.clone(), row.is_secret, fp_before, fp_after, matched));
    }

    println!(
        "{:<40} {:<9} {:<14} {:<14} {}",
        "key", "is_secret", "fp(before)", "fp(after)", "match"
    );
    for (key, is_secret, fp_before, fp_after, matched) in &report {
        println!(
            "{:<40} {:<9} {:<14} {:<14} {}",
            key,
            is_secret,
            fp_before,
            fp_after,
            if *matched { "OK" } else { "MISMATCH" }
        );
    }

    println!(
        "{total} rows: {rewrapped} rewrapped, {skipped} already-new, 0 undecryptable"
    );

    if dry_run {
        tx.rollback().await.context("failed to roll back dry-run transaction")?;
        println!("ROLLED BACK (--dry-run: no changes were persisted)");
    } else {
        tx.commit().await.context("failed to commit rotation transaction")?;
        println!("COMMITTED");
    }

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

    // resources catalog (paths / URLs + optional env_param_keys links)
    resources::ensure_resources_table(db).await?;
    forecasts::ensure_table(db).await?;

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

    // Make path optional (idempotent on fresh DBs; fixes NOT NULL on existing DBs)
    sqlx::query("ALTER TABLE project_graphs ALTER COLUMN path DROP NOT NULL")
        .execute(db).await.ok();
    sqlx::query("ALTER TABLE project_graphs ALTER COLUMN canonical_path DROP NOT NULL")
        .execute(db).await.ok();

    // Manual version-status label for a project (active/maintenance/archived/deprecated)
    sqlx::query("ALTER TABLE project_graphs ADD COLUMN IF NOT EXISTS version_status TEXT NOT NULL DEFAULT 'active'")
        .execute(db).await.ok();

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
    .execute(db)
    .await
    .context("failed to create project_tasks table")?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_project_tasks_project_id ON project_tasks(project_id)")
        .execute(db).await.ok();

    // Task labels (built-in + free-text), same convention as resources.tags.
    sqlx::query("ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS labels TEXT[] NOT NULL DEFAULT '{}'")
        .execute(db).await.ok();
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_project_tasks_labels ON project_tasks USING gin(labels)")
        .execute(db).await.ok();

    // Routine templates (repeating task definitions)
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
    .execute(db)
    .await
    .context("failed to create project_routines table")?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_project_routines_project_id ON project_routines(project_id)")
        .execute(db).await.ok();

    // Routine labels (built-in + free-text), same convention as project_tasks.labels.
    sqlx::query("ALTER TABLE project_routines ADD COLUMN IF NOT EXISTS labels TEXT[] NOT NULL DEFAULT '{}'")
        .execute(db).await.ok();
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_project_routines_labels ON project_routines USING gin(labels)")
        .execute(db).await.ok();

    // Add routine_id FK to tasks (nullable — only set on routine-generated tasks)
    sqlx::query("ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS routine_id UUID REFERENCES project_routines(id) ON DELETE SET NULL")
        .execute(db).await.ok();

    // Hierarchical subtasks + Gantt scheduling fields.
    sqlx::query("ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES project_tasks(id) ON DELETE CASCADE")
        .execute(db).await.ok();
    sqlx::query("ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS start_date DATE")
        .execute(db).await.ok();
    sqlx::query("ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS due_date DATE")
        .execute(db).await.ok();
    sqlx::query("ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0")
        .execute(db).await.ok();
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_project_tasks_parent_id ON project_tasks(parent_id)")
        .execute(db).await.ok();

    // Lessons learned (structured equivalent of tasks/lessons.md)
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS project_lessons (
            id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
            project_id   UUID        NOT NULL REFERENCES project_graphs(id) ON DELETE CASCADE,
            title        TEXT        NOT NULL,
            context      TEXT,
            rule         TEXT        NOT NULL,
            category     TEXT        NOT NULL DEFAULT 'correction',
            severity     TEXT        NOT NULL DEFAULT 'medium',
            status       TEXT        NOT NULL DEFAULT 'active',
            tags         TEXT[]      NOT NULL DEFAULT '{}',
            occurrences  INTEGER     NOT NULL DEFAULT 1,
            created_by   TEXT        NOT NULL DEFAULT 'agent',
            last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        "#,
    )
    .execute(db)
    .await
    .context("failed to create project_lessons table")?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_project_lessons_project_id ON project_lessons(project_id)")
        .execute(db).await.ok();
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_project_lessons_tags ON project_lessons USING gin(tags)")
        .execute(db).await.ok();
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_project_lessons_fts ON project_lessons \
         USING gin(to_tsvector('english', title || ' ' || coalesce(context,'') || ' ' || rule))"
    )
        .execute(db).await.ok();

    // Design docs (mermaid diagrams: UI/structure/workflow/DB-schema for code projects,
    // characters/plot/timeline/world for narrative projects). Source lives in the DB, not on
    // disk, so it works for projects with no filesystem path at all.
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS project_designs (
            id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
            project_id   UUID        NOT NULL REFERENCES project_graphs(id) ON DELETE CASCADE,
            title        TEXT        NOT NULL,
            kind         TEXT        NOT NULL DEFAULT 'other',
            diagram_type TEXT        NOT NULL DEFAULT 'mermaid',
            source       TEXT        NOT NULL DEFAULT '',
            notes        TEXT,
            tags         TEXT[]      NOT NULL DEFAULT '{}',
            sort_order   INTEGER     NOT NULL DEFAULT 0,
            status       TEXT        NOT NULL DEFAULT 'active',
            created_by   TEXT        NOT NULL DEFAULT 'user',
            created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        "#,
    )
    .execute(db)
    .await
    .context("failed to create project_designs table")?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_project_designs_project_id ON project_designs(project_id)")
        .execute(db).await.ok();
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_project_designs_tags ON project_designs USING gin(tags)")
        .execute(db).await.ok();

    design_budgets::ensure_table(db).await?;

    workflows::ensure_table(db).await?;

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

async fn list_agents(State(state): State<AppState>, headers: HeaderMap) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }
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
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }
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

async fn get_agent_stats(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }

    let agent = sqlx::query_as::<_, WatcherAgentRow>(
        "SELECT id, name, path, enabled, is_builtin, description, created_at, updated_at \
         FROM watcher_agents WHERE id = $1"
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await;

    let agent = match agent {
        Ok(Some(a)) => a,
        Ok(None) => return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "agent not found"}))).into_response(),
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
    };

    let session_count: Result<(i64,), _> = sqlx::query_as(
        "SELECT COUNT(*) FROM sessions WHERE agent_name = $1"
    )
    .bind(&agent.name)
    .fetch_one(&state.db)
    .await;

    let message_count: Result<(i64,), _> = sqlx::query_as(
        "SELECT COALESCE(SUM(message_count), 0) FROM sessions WHERE agent_name = $1"
    )
    .bind(&agent.name)
    .fetch_one(&state.db)
    .await;

    // Aggregate Task (subagent) and Skill tool invocations from assistant
    // messages belonging to this agent's recorded sessions.
    let tool_rows: Result<Vec<(String, Option<String>, i64)>, _> = sqlx::query_as(
        r#"
        SELECT
            elem->>'name' AS tool_name,
            COALESCE(elem->'input'->>'subagent_type', elem->'input'->>'skill') AS detail,
            COUNT(*) AS uses
        FROM session_messages sm
        JOIN sessions s ON s.id = sm.session_id
        CROSS JOIN LATERAL jsonb_array_elements(
            CASE jsonb_typeof(sm.raw_event->'message'->'content')
                WHEN 'array' THEN sm.raw_event->'message'->'content'
                ELSE '[]'::jsonb
            END
        ) elem
        WHERE s.agent_name = $1
          AND sm.event_type = 'assistant'
          AND elem->>'type' = 'tool_use'
          AND elem->>'name' IN ('Task', 'Skill')
        GROUP BY tool_name, detail
        ORDER BY uses DESC
        "#,
    )
    .bind(&agent.name)
    .fetch_all(&state.db)
    .await;

    match (session_count, message_count, tool_rows) {
        (Ok((sessions,)), Ok((messages,)), Ok(rows)) => {
            let subagents: Vec<_> = rows.iter()
                .filter(|(tool, _, _)| tool == "Task")
                .map(|(_, detail, uses)| serde_json::json!({
                    "name": detail.clone().unwrap_or_else(|| "unknown".to_string()),
                    "uses": uses,
                }))
                .collect();
            let skills: Vec<_> = rows.iter()
                .filter(|(tool, _, _)| tool == "Skill")
                .map(|(_, detail, uses)| serde_json::json!({
                    "name": detail.clone().unwrap_or_else(|| "unknown".to_string()),
                    "uses": uses,
                }))
                .collect();

            Json(serde_json::json!({
                "agent_id": agent.id,
                "agent_name": agent.name,
                "session_count": sessions,
                "message_count": messages,
                "subagent_usage": subagents,
                "skill_usage": skills,
            })).into_response()
        }
        (Err(e), _, _) | (_, Err(e), _) | (_, _, Err(e)) => {
            error!("get_agent_stats error: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response()
        }
    }
}

async fn get_agent_stats_timeseries(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Query(params): Query<TimeseriesParams>,
) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }

    let agent = sqlx::query_as::<_, WatcherAgentRow>(
        "SELECT id, name, path, enabled, is_builtin, description, created_at, updated_at \
         FROM watcher_agents WHERE id = $1"
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await;

    let agent = match agent {
        Ok(Some(a)) => a,
        Ok(None) => return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "agent not found"}))).into_response(),
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
    };

    // Security: `bucket` is never interpolated as raw user input. date_trunc's
    // first argument cannot be a bind parameter, so we sanitize to one of two
    // Rust-side literals before it ever touches the query string. Any value
    // other than "week" falls back to "day".
    let is_week = params.bucket.as_deref() == Some("week");
    let bucket = if is_week { "week" } else { "day" };
    let periods = params.periods.unwrap_or(30).clamp(1, 180);

    // Known simplification: buckets use the Postgres server's timezone (UTC
    // in this deployment). A session spanning midnight attributes all of its
    // messages to the bucket containing its started_at.
    let query = if is_week {
        r#"
        WITH buckets AS (
            SELECT generate_series(
                date_trunc('week', now()) - ($2::int - 1) * interval '1 week',
                date_trunc('week', now()), interval '1 week') AS bucket_start
        )
        SELECT b.bucket_start,
               COUNT(s.id)                       AS sessions,
               COALESCE(SUM(s.message_count), 0) AS messages
        FROM buckets b
        LEFT JOIN sessions s
          ON s.agent_name = $1
         AND date_trunc('week', s.started_at) = b.bucket_start
        GROUP BY b.bucket_start ORDER BY b.bucket_start
        "#
    } else {
        r#"
        WITH buckets AS (
            SELECT generate_series(
                date_trunc('day', now()) - ($2::int - 1) * interval '1 day',
                date_trunc('day', now()), interval '1 day') AS bucket_start
        )
        SELECT b.bucket_start,
               COUNT(s.id)                       AS sessions,
               COALESCE(SUM(s.message_count), 0) AS messages
        FROM buckets b
        LEFT JOIN sessions s
          ON s.agent_name = $1
         AND date_trunc('day', s.started_at) = b.bucket_start
        GROUP BY b.bucket_start ORDER BY b.bucket_start
        "#
    };

    let rows: Result<Vec<(DateTime<Utc>, i64, i64)>, _> = sqlx::query_as(query)
        .bind(&agent.name)
        .bind(periods)
        .fetch_all(&state.db)
        .await;

    match rows {
        Ok(rows) => {
            let points: Vec<_> = rows.into_iter()
                .map(|(bucket_start, sessions, messages)| serde_json::json!({
                    "bucket_start": bucket_start,
                    "sessions": sessions,
                    "messages": messages,
                }))
                .collect();

            Json(serde_json::json!({
                "agent_id": agent.id,
                "agent_name": agent.name,
                "bucket": bucket,
                "periods": periods,
                "points": points,
            })).into_response()
        }
        Err(e) => {
            error!("get_agent_stats_timeseries error: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response()
        }
    }
}

/// Number of daily buckets returned in each agent's `sparkline`.
const AGENTS_USAGE_SPARKLINE_DAYS: i32 = 30;

/// Cross-agent usage summary for the `/agents/usage` dashboard. Unlike
/// `get_agent_stats`, every `watcher_agents` row is included via a LEFT JOIN
/// (not just agents with recorded sessions) so agents with zero sessions
/// still appear, with zero-filled counts and a null `last_active_at`.
async fn get_agents_usage_summary(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }

    let counts: Result<Vec<(Uuid, String, String, bool, bool, i64, i64, Option<DateTime<Utc>>)>, _> = sqlx::query_as(
        r#"
        SELECT a.id, a.name, a.path, a.enabled, a.is_builtin,
               COUNT(s.id) AS session_count,
               COALESCE(SUM(s.message_count), 0) AS message_count,
               MAX(s.last_event_at) AS last_active_at
        FROM watcher_agents a
        LEFT JOIN sessions s ON s.agent_name = a.name
        GROUP BY a.id, a.name, a.path, a.enabled, a.is_builtin
        ORDER BY a.is_builtin DESC, a.name ASC
        "#,
    )
    .fetch_all(&state.db)
    .await;

    let counts = match counts {
        Ok(rows) => rows,
        Err(e) => {
            error!("get_agents_usage_summary counts error: {e}");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response();
        }
    };

    // Dense, zero-filled 30-day sparkline per agent: same generate_series +
    // date_trunc + LEFT JOIN zero-fill pattern as get_agent_stats_timeseries,
    // generalized here from one agent to a CROSS JOIN over all of them.
    let spark_rows: Result<Vec<(Uuid, DateTime<Utc>, i64)>, _> = sqlx::query_as(
        r#"
        WITH buckets AS (
            SELECT generate_series(
                date_trunc('day', now()) - ($1::int - 1) * interval '1 day',
                date_trunc('day', now()), interval '1 day') AS bucket_start
        )
        SELECT a.id, b.bucket_start, COUNT(s.id) AS sessions
        FROM watcher_agents a
        CROSS JOIN buckets b
        LEFT JOIN sessions s
          ON s.agent_name = a.name
         AND date_trunc('day', s.started_at) = b.bucket_start
        GROUP BY a.id, b.bucket_start
        ORDER BY a.id, b.bucket_start ASC
        "#,
    )
    .bind(AGENTS_USAGE_SPARKLINE_DAYS)
    .fetch_all(&state.db)
    .await;

    let spark_rows = match spark_rows {
        Ok(rows) => rows,
        Err(e) => {
            error!("get_agents_usage_summary sparkline error: {e}");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response();
        }
    };

    let mut sparklines: HashMap<Uuid, Vec<i64>> = HashMap::new();
    for (agent_id, _bucket_start, sessions) in spark_rows {
        sparklines.entry(agent_id).or_default().push(sessions);
    }

    let mut agent_count = 0i64;
    let mut total_sessions = 0i64;
    let mut total_messages = 0i64;

    let agents: Vec<_> = counts.into_iter().map(|(id, name, path, enabled, is_builtin, session_count, message_count, last_active_at)| {
        agent_count += 1;
        total_sessions += session_count;
        total_messages += message_count;

        let claude_usage_supported = claude_usage::credentials_path_for(&path, resolve_user_path).is_some();
        let sparkline = sparklines.get(&id).cloned().unwrap_or_default();

        serde_json::json!({
            "agent_id": id,
            "agent_name": name,
            "path": path,
            "enabled": enabled,
            "is_builtin": is_builtin,
            "session_count": session_count,
            "message_count": message_count,
            "last_active_at": last_active_at,
            "claude_usage_supported": claude_usage_supported,
            "sparkline": sparkline,
        })
    }).collect();

    Json(serde_json::json!({
        "generated_at": Utc::now(),
        "bucket": "day",
        "periods": AGENTS_USAGE_SPARKLINE_DAYS,
        "totals": {
            "agent_count": agent_count,
            "session_count": total_sessions,
            "message_count": total_messages,
        },
        "agents": agents,
    })).into_response()
}

/// How long a successful claude-usage read stays cached before we re-hit
/// Anthropic. Kept short since utilization changes with live usage.
const CLAUDE_USAGE_CACHE_TTL_OK: std::time::Duration = std::time::Duration::from_secs(90);
/// Negative TTL for transient failures (`network_error`/`upstream_error`)
/// only — `token_expired`/`no_credentials` are pure local reads and are
/// never cached, so re-authenticating is reflected immediately.
const CLAUDE_USAGE_CACHE_TTL_ERR: std::time::Duration = std::time::Duration::from_secs(15);

async fn get_agent_claude_usage(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }

    let agent = sqlx::query_as::<_, WatcherAgentRow>(
        "SELECT id, name, path, enabled, is_builtin, description, created_at, updated_at \
         FROM watcher_agents WHERE id = $1"
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await;

    let agent = match agent {
        Ok(Some(a)) => a,
        Ok(None) => return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "agent not found"}))).into_response(),
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
    };

    let Some(creds_path) = claude_usage::credentials_path_for(&agent.path, resolve_user_path) else {
        // Not a Claude Code-shaped agent path (Codex/Gemini/etc). No file
        // read, no network call.
        return Json(serde_json::json!({"supported": false})).into_response();
    };

    // Check cache first (never hold the lock across an .await — clone the
    // value out inside this short scope, same pattern as pg_cache above).
    let cached = {
        if let Ok(cache) = state.claude_usage_cache.lock() {
            cache.clone()
        } else {
            None
        }
    };

    if let Some((cached_at, cached_value)) = cached {
        let cached_state = cached_value.get("state").and_then(|v| v.as_str()).unwrap_or("");
        let ttl = if cached_state == "ok" { CLAUDE_USAGE_CACHE_TTL_OK } else { CLAUDE_USAGE_CACHE_TTL_ERR };
        let is_cacheable_state = matches!(cached_state, "ok" | "network_error" | "upstream_error");
        if is_cacheable_state && cached_at.elapsed() < ttl {
            let mut value = cached_value;
            value["cached"] = serde_json::json!(true);
            return Json(value).into_response();
        }
    }

    // Read the credentials file. Any failure — missing file, bad
    // permissions, malformed JSON, missing keys — becomes `no_credentials`.
    // Only the io::Error *kind* is logged, never the path or file contents.
    let oauth = match claude_usage::read_oauth(&creds_path) {
        Ok(o) => o,
        Err(e) => {
            warn!("claude_usage: credentials read failed ({})", io_error_kind_of(&e));
            return Json(serde_json::json!({
                "supported": true,
                "state": "no_credentials",
                "message": "No Claude Code credentials found on this host — run `claude login` on the machine running OpenMemory.",
                "plan": null,
                "rate_limit_tier": null,
                "five_hour": null,
                "seven_day": null,
                "extra_usage": null,
                "fetched_at": Utc::now(),
                "cached": false,
            })).into_response();
        }
    };

    let now_ms = Utc::now().timestamp_millis();
    if oauth.expires_at <= now_ms {
        return Json(serde_json::json!({
            "supported": true,
            "state": "token_expired",
            "message": "Access token expired — re-authenticate with `claude login`.",
            "plan": oauth.subscription_type,
            "rate_limit_tier": oauth.rate_limit_tier,
            "five_hour": null,
            "seven_day": null,
            "extra_usage": null,
            "fetched_at": Utc::now(),
            "cached": false,
        })).into_response();
    }

    let raw = match claude_usage::fetch_usage(&oauth.access_token, Duration::from_secs(10)).await {
        Ok(v) => v,
        Err(e) => {
            let msg = e.to_string();
            let (state_name, message) = if msg.contains("returned") {
                ("upstream_error", format!("Anthropic returned an error: {}", msg))
            } else {
                ("network_error", "Couldn't reach api.anthropic.com.".to_string())
            };
            warn!("claude_usage: fetch_usage failed: {state_name}");
            let value = serde_json::json!({
                "supported": true,
                "state": state_name,
                "message": message,
                "plan": oauth.subscription_type,
                "rate_limit_tier": oauth.rate_limit_tier,
                "five_hour": null,
                "seven_day": null,
                "extra_usage": null,
                "fetched_at": Utc::now(),
                "cached": false,
            });
            if let Ok(mut cache) = state.claude_usage_cache.lock() {
                *cache = Some((std::time::Instant::now(), value.clone()));
            }
            return Json(value).into_response();
        }
    };

    let mut summary = claude_usage::summarize(&oauth, &raw);
    summary["fetched_at"] = serde_json::json!(Utc::now());
    summary["cached"] = serde_json::json!(false);

    if let Ok(mut cache) = state.claude_usage_cache.lock() {
        *cache = Some((std::time::Instant::now(), summary.clone()));
    }

    Json(summary).into_response()
}

/// Extracts just the io::Error kind (e.g. "NotFound", "PermissionDenied")
/// from an anyhow chain, for safe logging that never includes paths or file
/// contents.
fn io_error_kind_of(e: &anyhow::Error) -> String {
    for cause in e.chain() {
        if let Some(io_err) = cause.downcast_ref::<std::io::Error>() {
            return format!("{:?}", io_err.kind());
        }
    }
    "unknown".to_string()
}

async fn create_agent(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<CreateAgentPayload>,
) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }
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
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(payload): Json<UpdateAgentPayload>,
) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }
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
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }
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

/// Expand a leading `~` in a user-supplied path (e.g. an agent's recorded
/// watch path) using `OPENMEMORY_HOME_DIR`, falling back to `HOME` only if
/// that's unset. `OPENMEMORY_HOME_DIR` exists because inside this
/// container `HOME` resolves to `/` (see docker-compose.yml — the image's
/// `useradd --no-create-home` combined with the `user:` override leaves
/// `HOME` unset/root), while the real host home directory is still mounted
/// read-only at its original absolute path. This is a distinct concern from
/// `token_file_path()`/`resolve_api_token()` below, which intentionally keep
/// using `HOME` for the writable `.openmemory/api_token` file and must not
/// be changed by this helper.
fn resolve_user_path(p: &str) -> std::path::PathBuf {
    if let Some(rest) = p.strip_prefix("~/") {
        let home = std::env::var("OPENMEMORY_HOME_DIR")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_else(|_| "/".to_string());
        std::path::PathBuf::from(home).join(rest)
    } else if p == "~" {
        let home = std::env::var("OPENMEMORY_HOME_DIR")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_else(|_| "/".to_string());
        std::path::PathBuf::from(home)
    } else {
        std::path::PathBuf::from(p)
    }
}

fn token_file_path() -> std::path::PathBuf {
    let home = std::env::var("HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::PathBuf::from("/tmp"));
    home.join(".openmemory").join("api_token")
}

/// Write the token file with owner-only (0600) permissions on Unix.
fn write_token_file(path: &std::path::Path, token: &str) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        f.write_all(token.as_bytes())
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, token)
    }
}

/// Best-effort: tighten permissions on an existing token file that may have
/// been created before this check existed (or with a looser umask).
fn tighten_token_file_perms(path: &std::path::Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(path) {
            if meta.permissions().mode() & 0o077 != 0 {
                if let Err(e) = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)) {
                    warn!("Could not tighten permissions on {}: {e}", path.display());
                }
            }
        }
    }
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
            tighten_token_file_perms(&path);
            return token;
        }
    }

    // 3. First run: generate a cryptographically random token and persist it
    let token = Uuid::new_v4().to_string();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match write_token_file(&path, &token) {
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
                let db_c2 = state.db.clone();
                let (id_c, uid_c, sum_c, tags_c, ts) = (
                    id,
                    user_id.clone(),
                    summary.clone(),
                    tags.clone(),
                    now.to_rfc3339(),
                );
                tokio::spawn(async move {
                    let excluded = frequent_tags(&db_c2, Some(&tags_c), AUTO_LINK_TAG_MAX_FRACTION).await;
                    if let Err(e) = fdb
                        .save_node(id_c, uid_c.as_deref(), sum_c.as_deref(), importance_score, &tags_c, &ts, &excluded)
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
            include_graph_view,
        } => {
            let limit = limit.unwrap_or(5).clamp(1, 50);

            // Try cache first
            let cache_key = format!(
                "search:{}:{}:{}",
                user_id.as_deref().unwrap_or("*"),
                &query,
                limit
            );

            // Related facts are temporally sensitive, so always fetch fresh — even on a
            // cached `results` hit — rather than caching them alongside results.
            let related_facts = match &state.falkordb {
                Some(fdb) => {
                    let mut fdb = fdb.clone();
                    fdb.query_facts(&query, None, 5, true).await.unwrap_or_default()
                }
                None => vec![],
            };

            if let Some(mut redis_conn) = state.redis.clone() {
                if let Ok(cached) = redis_conn.get::<_, String>(&cache_key).await {
                    if let Ok(cached_results) = serde_json::from_str::<Vec<SearchResult>>(&cached) {
                        info!("cache hit for query: {}", query);
                        let graph_view = if include_graph_view {
                            compute_graph_view(&state.falkordb, &cached_results, &related_facts, user_id.as_deref()).await
                        } else {
                            None
                        };
                        return Ok((
                            StatusCode::OK,
                            Json(McpResponse::MemorySearchResult {
                                query,
                                results: cached_results,
                                related_facts,
                                graph_view,
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

            // Combine and score (base signal: BM25 candidacy + importance/recency)
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
                        via_graph: false,
                    })
                })
                .collect();

            results.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(Ordering::Equal));

            if let Some(fdb) = &state.falkordb {
                let mut fdb = fdb.clone();

                // 1. Proximity boost: reward BM25 hits that are graph-connected to each other.
                match fdb.connection_counts(&ids, user_id.as_deref()).await {
                    Ok(counts) => {
                        for r in results.iter_mut() {
                            if let Some(&n) = counts.get(&r.id) {
                                r.score += (0.05 * n as f32).min(0.15);
                            }
                        }
                        results.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(Ordering::Equal));
                    }
                    Err(e) => warn!("memory_search: connection_counts failed: {e}"),
                }

                // 2. Graph-recall: expand from the top hit to surface memories BM25's text
                // match missed entirely, discounted since they aren't a direct text match.
                if let Some(top) = results.first().map(|r| r.id) {
                    match fdb.get_neighbors(top, user_id.as_deref(), 1, 5).await {
                        Ok(neighbors) => {
                            let existing: std::collections::HashSet<Uuid> =
                                results.iter().map(|r| r.id).collect();
                            let new_neighbors: Vec<&falkordb::NeighborInfo> = neighbors
                                .iter()
                                .filter(|n| !existing.contains(&n.id))
                                .collect();

                            if !new_neighbors.is_empty() {
                                let new_ids: Vec<String> =
                                    new_neighbors.iter().map(|n| n.id.to_string()).collect();
                                let neighbor_docs = state.opensearch.get_by_ids(&new_ids).await.unwrap_or_default();
                                let neighbor_uuids: Vec<Uuid> =
                                    new_neighbors.iter().map(|n| n.id).collect();
                                let neighbor_index: Vec<MemoryIndex> = sqlx::query_as(
                                    "SELECT id, user_id, summary, importance_score, tags, created_at, updated_at FROM memory_index WHERE id = ANY($1)"
                                )
                                .bind(&neighbor_uuids)
                                .fetch_all(&state.db)
                                .await
                                .unwrap_or_default();

                                for n in new_neighbors {
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
                                results.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(Ordering::Equal));
                            }
                        }
                        Err(e) => warn!("memory_search: get_neighbors failed: {e}"),
                    }
                }
            }

            results.truncate(limit);

            // Cache results (facts and graph_view are always fetched fresh, so they're excluded from the cache entry)
            if let Some(mut redis_conn) = state.redis.clone() {
                if let Ok(json) = serde_json::to_string(&results) {
                    let _: Result<(), _> = redis_conn.set_ex(&cache_key, json, 300).await;
                }
            }

            let graph_view = if include_graph_view {
                compute_graph_view(&state.falkordb, &results, &related_facts, user_id.as_deref()).await
            } else {
                None
            };

            Ok((
                StatusCode::OK,
                Json(McpResponse::MemorySearchResult { query, results, related_facts, graph_view }),
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
                let db_c3 = state.db.clone();
                let (sum_c, imp_c, tags_c) = (summary.clone(), importance, tags.clone());
                tokio::spawn(async move {
                    let excluded = match &tags_c {
                        Some(t) => frequent_tags(&db_c3, Some(t), AUTO_LINK_TAG_MAX_FRACTION).await,
                        None => vec![],
                    };
                    if let Err(e) = fdb
                        .update_node(id, sum_c.as_deref(), imp_c.map(clamp01), tags_c.as_deref(), &excluded)
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

        McpRequest::MemoryGraphData { user_id, limit } => {
            // A bounded request is the compact graph overview. Prefer memories with
            // real relationships so the first render is both small and meaningful.
            // No limit remains the explicit full-graph request.
            let limit = limit.map(|l| l.max(1) as i64).unwrap_or(i64::MAX);
            let overview_ids = if limit == i64::MAX {
                vec![]
            } else {
                match &state.falkordb {
                    Some(fdb) => {
                        let mut fdb = fdb.clone();
                        fdb.top_connected_memory_ids(user_id.as_deref(), limit as usize)
                            .await
                            .unwrap_or_default()
                    }
                    None => vec![],
                }
            };

            let mut memories: Vec<MemoryNodeInfo> = if !overview_ids.is_empty() {
                match &user_id {
                    Some(uid) => sqlx::query_as(
                        "SELECT id, summary, importance_score, tags, created_at FROM memory_index WHERE user_id = $1 AND id = ANY($2)"
                    )
                    .bind(uid)
                    .bind(&overview_ids)
                    .fetch_all(&state.db)
                    .await
                    .unwrap_or_default(),
                    None => sqlx::query_as(
                        "SELECT id, summary, importance_score, tags, created_at FROM memory_index WHERE id = ANY($1)"
                    )
                    .bind(&overview_ids)
                    .fetch_all(&state.db)
                    .await
                    .unwrap_or_default(),
                }
            } else { match &user_id {
                Some(uid) => sqlx::query_as(
                    "SELECT id, summary, importance_score, tags, created_at FROM memory_index WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2"
                )
                .bind(uid)
                .bind(limit)
                .fetch_all(&state.db)
                .await
                .unwrap_or_default(),
                None => sqlx::query_as(
                    "SELECT id, summary, importance_score, tags, created_at FROM memory_index ORDER BY created_at DESC LIMIT $1"
                )
                .bind(limit)
                .fetch_all(&state.db)
                .await
                .unwrap_or_default(),
            }};

            // Most memories are auto-captured (e.g. the session watcher) and never set a
            // summary — fall back to a truncated content preview so graph nodes have a label.
            let unlabeled_ids: Vec<String> = memories
                .iter()
                .filter(|m| m.summary.as_deref().is_none_or(str::is_empty))
                .map(|m| m.id.to_string())
                .collect();
            if !unlabeled_ids.is_empty() {
                let docs = state.opensearch.get_by_ids(&unlabeled_ids).await.unwrap_or_default();
                for m in memories.iter_mut() {
                    if m.summary.as_deref().is_none_or(str::is_empty) {
                        if let Some(doc) = docs.iter().find(|d| d.id == m.id.to_string()) {
                            m.summary = Some(content_preview(&doc.content));
                        }
                    }
                }
            }

            let mut edges = match &state.falkordb {
                Some(fdb) => {
                    let mut fdb = fdb.clone();
                    if limit == i64::MAX {
                        fdb.get_all_edges(user_id.as_deref()).await.unwrap_or_default()
                    } else {
                        let ids: Vec<Uuid> = memories.iter().map(|memory| memory.id).collect();
                        fdb.edges_within(&ids, user_id.as_deref())
                            .await
                            .unwrap_or_default()
                            .into_iter()
                            .map(|(from_id, to_id, rel_type)| falkordb::EdgeInfo {
                                from_id: from_id.to_string(),
                                to_id: to_id.to_string(),
                                rel_type,
                                relationship: None,
                            })
                            .collect()
                    }
                }
                None => vec![],
            };
            if limit != i64::MAX && edges.len() > MEMORY_GRAPH_SUMMARY_EDGE_LIMIT {
                // Keep intentional links before auto-generated shared-tag links in
                // the compact overview, then cap rendering work to a predictable size.
                edges.sort_unstable_by_key(|edge| (edge.rel_type != "LINKED_TO") as u8);
                edges.truncate(MEMORY_GRAPH_SUMMARY_EDGE_LIMIT);
            }
            // A bounded graph request is used by the interactive preview. Filter the
            // relationship payload here as well: returning every edge would otherwise
            // negate the node limit before the browser can render anything.
            let memory_ids: HashSet<String> = memories
                .iter()
                .map(|memory| memory.id.to_string())
                .collect();
            let edges = edges
                .into_iter()
                .filter(|edge| memory_ids.contains(&edge.from_id) && memory_ids.contains(&edge.to_id))
                .collect();

            Ok((
                StatusCode::OK,
                Json(McpResponse::MemoryGraphDataResult { memories, edges }),
            ))
        }

        McpRequest::MemoryGraphRebuild { user_id, limit } => {
            let mut fdb = match &state.falkordb {
                Some(f) => f.clone(),
                None => return Ok((
                    StatusCode::OK,
                    Json(McpResponse::MemoryGraphRebuildResult { rebuilt: 0 }),
                )),
            };

            // Rebuild is a one-time maintenance backfill, not a live render — unlike
            // memory.graph_data it should cover everything by default, not just a page.
            // An explicit limit is still honored (e.g. to rebuild only the newest N).
            let limit = limit.map(|l| l.max(1) as i64).unwrap_or(i64::MAX);

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
                .fetch_all(&state.db)
                .await
                .unwrap_or_default(),
                None => sqlx::query_as(
                    "SELECT id, user_id, summary, importance_score, tags, created_at, updated_at FROM memory_index ORDER BY created_at DESC LIMIT $1"
                )
                .bind(limit)
                .fetch_all(&state.db)
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

            let excluded = frequent_tags(&state.db, None, AUTO_LINK_TAG_MAX_FRACTION).await;
            if let Err(e) = fdb.relink_all_tag_edges(user_id.as_deref(), &excluded).await {
                error!("MemoryGraphRebuild relink_all_tag_edges failed: {e}");
            }

            Ok((
                StatusCode::OK,
                Json(McpResponse::MemoryGraphRebuildResult { rebuilt }),
            ))
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
            if !is_authenticated(&headers, &state.api_token) {
                return Err((
                    StatusCode::UNAUTHORIZED,
                    Json(serde_json::json!({"error": "authentication required"})),
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

        McpRequest::EnvSetFile { key, file_content_base64, description } => {
            if !is_authenticated(&headers, &state.api_token) {
                return Err((
                    StatusCode::UNAUTHORIZED,
                    Json(serde_json::json!({"error": "authentication required"})),
                ));
            }

            // Validate it's actually base64 before storing — catches a
            // corrupted client-side encode early instead of failing silently
            // at decrypt/use time later.
            use base64::{engine::general_purpose::STANDARD, Engine as _};
            if STANDARD.decode(file_content_base64.trim()).is_err() {
                return Err((
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({ "error": "file_content_base64 is not valid base64" })),
                ));
            }

            let encrypted = encrypt_value(&state.encryption_key, &file_content_base64);
            let now = Utc::now();

            let result = sqlx::query(
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
            .bind(&description)
            .bind(now)
            .execute(&state.db)
            .await;

            match result {
                Ok(_) => Ok((StatusCode::OK, Json(McpResponse::EnvSetResult { key }))),
                Err(e) => {
                    error!("Failed to set env param from file: {e}");
                    Err((
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(serde_json::json!({ "error": "Failed to save uploaded file" })),
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
            if !is_authenticated(&headers, &state.api_token) {
                return Err((
                    StatusCode::UNAUTHORIZED,
                    Json(serde_json::json!({"error": "authentication required"})),
                ));
            }

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

        McpRequest::ResourceList { kind, tags, query } => {
            match resources::list_resources(
                &state.db,
                &state.encryption_key,
                kind.as_deref(),
                tags.as_deref(),
                query.as_deref(),
            )
            .await
            {
                Ok((resources, warnings)) => {
                    let total = resources.len();
                    Ok((
                        StatusCode::OK,
                        Json(McpResponse::ResourceListResult {
                            resources,
                            total,
                            warnings,
                        }),
                    ))
                }
                Err(e) => {
                    error!("ResourceList failed: {e}");
                    Err((
                        StatusCode::BAD_REQUEST,
                        Json(serde_json::json!({ "error": e.to_string() })),
                    ))
                }
            }
        }

        McpRequest::ResourceTags {} => match resources::list_distinct_tags(&state.db).await {
            Ok(tags) => Ok((
                StatusCode::OK,
                Json(McpResponse::ResourceTagsResult {
                    tags: tags
                        .into_iter()
                        .map(|(tag, count)| ResourceTagCount { tag, count })
                        .collect(),
                }),
            )),
            Err(e) => {
                error!("ResourceTags failed: {e}");
                Err((
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({ "error": e.to_string() })),
                ))
            }
        },

        McpRequest::ResourceGet { id_or_name } => {
            match resources::get_resource(&state.db, &state.encryption_key, &id_or_name).await {
                Ok(Some(resource)) => Ok((
                    StatusCode::OK,
                    Json(McpResponse::ResourceGetResult { resource }),
                )),
                Ok(None) => Err((
                    StatusCode::NOT_FOUND,
                    Json(serde_json::json!({ "error": "Resource not found" })),
                )),
                Err(e) => {
                    error!("ResourceGet failed: {e}");
                    Err((
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(serde_json::json!({ "error": "Database error" })),
                    ))
                }
            }
        }

        McpRequest::ResourceAdd {
            name,
            kind,
            location,
            description,
            tags,
            env_param_keys,
        } => {
            let tags = tags.unwrap_or_default();
            let env_param_keys = env_param_keys.unwrap_or_default();
            match resources::add_resource(
                &state.db,
                &name,
                &kind,
                &location,
                description.as_deref(),
                &tags,
                &env_param_keys,
            )
            .await
            {
                Ok((id, warning)) => Ok((
                    StatusCode::OK,
                    Json(McpResponse::ResourceAddResult { id, name, warning }),
                )),
                Err(e) => {
                    error!("ResourceAdd failed: {e}");
                    Err((
                        StatusCode::BAD_REQUEST,
                        Json(serde_json::json!({ "error": e.to_string() })),
                    ))
                }
            }
        }

        McpRequest::ResourceUpdate {
            id,
            name,
            kind,
            location,
            description,
            tags,
            env_param_keys,
        } => {
            let desc_arg: Option<Option<&str>> = description
                .as_ref()
                .map(|inner| inner.as_deref());
            match resources::update_resource(
                &state.db,
                id,
                name.as_deref(),
                kind.as_deref(),
                location.as_deref(),
                desc_arg,
                tags.as_deref(),
                env_param_keys.as_deref(),
            )
            .await
            {
                Ok(warning) => Ok((
                    StatusCode::OK,
                    Json(McpResponse::ResourceUpdateResult { id, warning }),
                )),
                Err(e) => {
                    let msg = e.to_string();
                    let status = if msg.contains("not found") {
                        StatusCode::NOT_FOUND
                    } else {
                        StatusCode::BAD_REQUEST
                    };
                    Err((status, Json(serde_json::json!({ "error": msg }))))
                }
            }
        }

        McpRequest::ResourceDelete { id } => match resources::delete_resource(&state.db, id).await {
            Ok(()) => Ok((
                StatusCode::OK,
                Json(McpResponse::ResourceDeleteResult { id }),
            )),
            Err(e) => {
                let msg = e.to_string();
                let status = if msg.contains("not found") {
                    StatusCode::NOT_FOUND
                } else {
                    StatusCode::BAD_REQUEST
                };
                Err((status, Json(serde_json::json!({ "error": msg }))))
            }
        },

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

        McpRequest::AiAutofill { kind, content, existing_tags } => {
            if !is_authenticated(&headers, &state.api_token) {
                return Err((
                    StatusCode::UNAUTHORIZED,
                    Json(serde_json::json!({"error": "authentication required"})),
                ));
            }

            let autofill_kind = match autofill::AutofillKind::parse(&kind) {
                Some(k) => k,
                None => {
                    return Err((
                        StatusCode::BAD_REQUEST,
                        Json(serde_json::json!({"error": format!("unknown autofill kind: {kind}")})),
                    ));
                }
            };

            let cfg = match load_llm_config(&state.db, &state.encryption_key).await {
                Some(c) => c,
                None => {
                    return Err((
                        StatusCode::BAD_REQUEST,
                        Json(serde_json::json!({"error": "LLM not configured — set GRAPH_LLM_API_KEY via LLM Settings"})),
                    ));
                }
            };

            let vocabulary = match autofill_kind {
                autofill::AutofillKind::Memory => top_tags(&state.db, 20).await,
                autofill::AutofillKind::Resource => resources::list_distinct_tags(&state.db)
                    .await
                    .unwrap_or_default()
                    .into_iter()
                    .map(|(tag, _)| tag)
                    .collect(),
                autofill::AutofillKind::Task => autofill::BUILTIN_TASK_LABELS
                    .iter()
                    .map(|s| s.to_string())
                    .collect(),
            };

            // existing_tags, when the caller supplies it, extends the server-derived
            // vocabulary hint (e.g. a client that already has locally-known custom
            // labels not yet reflected in any task in the DB).
            let mut vocabulary = vocabulary;
            if let Some(extra) = existing_tags {
                vocabulary.extend(extra);
            }

            let input = autofill::AutofillInput { kind: autofill_kind, content, vocabulary };

            match autofill::suggest(&input, &cfg).await {
                Ok(suggestion) => Ok((
                    StatusCode::OK,
                    Json(McpResponse::AiAutofillResult { suggestion, model: cfg.model }),
                )),
                Err(e) => {
                    warn!("ai.autofill failed (provider={}): {e}", cfg.provider);
                    Err((
                        StatusCode::BAD_GATEWAY,
                        Json(serde_json::json!({"error": format!("LLM request failed: {e}")})),
                    ))
                }
            }
        }

        McpRequest::AiBudgetForecast { design_id, forecast_profile_id, conditions } => {
            if !is_authenticated(&headers, &state.api_token) {
                return Err((StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "authentication required"}))));
            }
            let design = sqlx::query_as::<_, (String, String, String)>(
                "SELECT title, kind, source FROM project_designs WHERE id = $1",
            ).bind(design_id).fetch_optional(&state.db).await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))))?;
            let Some((title, kind, source)) = design else {
                return Err((StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "design not found"}))));
            };
            let mut planning_conditions = conditions.unwrap_or_default();
            if let Some(profile_id) = forecast_profile_id {
                let profile = forecasts::get(&state.db, profile_id).await
                    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))))?;
                let Some(profile) = profile else {
                    return Err((StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "forecast profile not found"}))));
                };
                planning_conditions = format!("{}\n{}", forecasts::design_context(&profile), planning_conditions);
            }
            if planning_conditions.trim().is_empty() {
                return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "choose a forecast profile or provide custom conditions"}))));
            }
            let cfg = load_llm_config(&state.db, &state.encryption_key).await.ok_or_else(|| (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "LLM not configured — set GRAPH_LLM_API_KEY via LLM Settings"})),
            ))?;
            match budget_ai::estimate(&title, &kind, &source, &planning_conditions, &cfg).await {
                Ok(estimate) => Ok((StatusCode::OK, Json(McpResponse::AiBudgetForecastResult { estimate, model: cfg.model }))),
                Err(e) => Err((StatusCode::BAD_GATEWAY, Json(serde_json::json!({"error": format!("LLM request failed: {e}")})))),
            }
        }

        McpRequest::AiDesignDiagram { prompt, kind, format, forecast_profile_id } => {
            if !is_authenticated(&headers, &state.api_token) {
                return Err((
                    StatusCode::UNAUTHORIZED,
                    Json(serde_json::json!({"error": "authentication required"})),
                ));
            }

            if prompt.trim().is_empty() {
                return Err((
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({"error": "prompt is required"})),
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

            let prompt = if let Some(profile_id) = forecast_profile_id {
                match forecasts::get(&state.db, profile_id).await {
                    Ok(Some(profile)) => format!("{}\n\n{}", prompt, forecasts::design_context(&profile)),
                    Ok(None) => return Err((StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "forecast profile not found"})))),
                    Err(e) => return Err((StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()})))),
                }
            } else {
                prompt
            };

            let result = if format.as_deref() == Some("reactflow") {
                design_ai::generate_graph(&prompt, kind.as_deref(), &cfg).await
            } else {
                design_ai::generate(&prompt, &cfg).await
            };

            match result {
                Ok(source) => Ok((
                    StatusCode::OK,
                    Json(McpResponse::AiDesignDiagramResult { source, model: cfg.model }),
                )),
                Err(e) => {
                    warn!("ai.design_diagram failed (provider={}): {e}", cfg.provider);
                    Err((
                        StatusCode::BAD_GATEWAY,
                        Json(serde_json::json!({"error": format!("LLM request failed: {e}")})),
                    ))
                }
            }
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

/// Best-effort mermaid graph_view for a memory_search result set. Returns None if the
/// graph layer is unavailable or the edge lookup fails — the caller degrades gracefully.
async fn compute_graph_view(
    falkordb: &Option<FalkorDbClient>,
    results: &[SearchResult],
    related_facts: &[falkordb::FactResult],
    user_id: Option<&str>,
) -> Option<String> {
    let mut fdb = falkordb.as_ref()?.clone();
    let ids: Vec<Uuid> = results.iter().map(|r| r.id).collect();
    match fdb.edges_within(&ids, user_id).await {
        Ok(edges) => Some(build_mermaid(results, &edges, related_facts)),
        Err(e) => {
            warn!("memory_search: edges_within failed: {e}");
            None
        }
    }
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

fn recency_score(created_at: DateTime<Utc>) -> f32 {
    let age = Utc::now().signed_duration_since(created_at);
    let age_days = age.num_seconds().max(0) as f32 / (60.0 * 60.0 * 24.0);
    (-age_days / 30.0).exp().clamp(0.0, 1.0)
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
/// on the hot memory.save/update path); `None` scans all distinct tags (used by
/// the bulk rebuild, which needs the full picture).
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

/// Most-used memory tags, most frequent first — used as a soft "prefer these
/// if they fit" vocabulary hint for ai.autofill. Never a hard constraint.
async fn top_tags(db: &PgPool, limit: i64) -> Vec<String> {
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT tag FROM (SELECT unnest(tags) AS tag FROM memory_index) t \
         GROUP BY tag ORDER BY count(*) DESC LIMIT $1",
    )
    .bind(limit)
    .fetch_all(db)
    .await
    .unwrap_or_default();
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

async fn list_forecast_profiles(State(state): State<AppState>, headers: HeaderMap) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }
    match forecasts::list(&state.db).await {
        Ok(profiles) => Json(serde_json::json!({"profiles": profiles})).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
    }
}

async fn create_forecast_profile(
    State(state): State<AppState>, headers: HeaderMap, Json(payload): Json<ForecastProfilePayload>,
) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }
    let input: forecasts::ForecastInput = payload.into();
    if let Err(message) = input.validate() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": message}))).into_response();
    }
    match forecasts::create(&state.db, &input).await {
        Ok(profile) => (StatusCode::CREATED, Json(serde_json::json!(profile))).into_response(),
        Err(e) if e.to_string().contains("unique") => (StatusCode::CONFLICT, Json(serde_json::json!({"error": "a forecast profile with this name already exists"}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
    }
}

async fn update_forecast_profile(
    State(state): State<AppState>, headers: HeaderMap, Path(id): Path<Uuid>,
    Json(payload): Json<ForecastProfilePayload>,
) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }
    let input: forecasts::ForecastInput = payload.into();
    if let Err(message) = input.validate() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": message}))).into_response();
    }
    match forecasts::update(&state.db, id, &input).await {
        Ok(Some(profile)) => Json(serde_json::json!(profile)).into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "forecast profile not found"}))).into_response(),
        Err(e) if e.to_string().contains("unique") => (StatusCode::CONFLICT, Json(serde_json::json!({"error": "a forecast profile with this name already exists"}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
    }
}

async fn delete_forecast_profile(
    State(state): State<AppState>, headers: HeaderMap, Path(id): Path<Uuid>,
) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }
    match sqlx::query("DELETE FROM forecast_profiles WHERE id = $1 RETURNING id")
        .bind(id).fetch_optional(&state.db).await
    {
        Ok(Some(_)) => Json(serde_json::json!({"deleted": true})).into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "forecast profile not found"}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
    }
}

async fn list_project_graphs(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }

    let rows = sqlx::query_as::<_, project_graphs::ProjectGraphRow>(
        "WITH task_flags AS ( \
           SELECT project_id, \
             bool_or(status NOT IN ('done','cancelled') AND labels @> ARRAY['bug'])     AS has_open_bug, \
             bool_or(status NOT IN ('done','cancelled') AND labels @> ARRAY['feature']) AS has_open_feature \
           FROM project_tasks GROUP BY project_id \
         ) \
         SELECT pg.id, pg.name, pg.path, pg.canonical_path, pg.description, pg.node_count, pg.edge_count, \
           pg.graph_hash, pg.graph_file_size, pg.imported_at, pg.created_at, pg.updated_at, pg.version_status, \
           CASE \
             WHEN COALESCE(tf.has_open_bug, false)     THEN 'bug_detected' \
             WHEN COALESCE(tf.has_open_feature, false) THEN 'feature_updating' \
             ELSE pg.version_status \
           END AS effective_version_status \
         FROM project_graphs pg \
         LEFT JOIN task_flags tf ON tf.project_id = pg.id \
         ORDER BY pg.created_at DESC"
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

    if payload.name.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "name must be non-empty"}))).into_response();
    }
    let version_status = payload.version_status.clone().unwrap_or_else(|| "active".to_string());
    if !VALID_VERSION_STATUSES.contains(&version_status.as_str()) {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "invalid version_status"}))).into_response();
    }

    let (graph_data, graph_hash, file_size, path_stored, canonical_stored, node_count, edge_count) =
        if let Some(ref p) = payload.path {
            if p.trim().is_empty() {
                return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "path must be non-empty when provided"}))).into_response();
            }
            // Canonicalize the path first — this is always required when a path is given.
            let canonical = match project_graphs::canonicalize_project_path(p).await {
                Ok(c) => c,
                Err(e) => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
            };
            // Index the project directory directly — no external tool or graph.json needed.
            // Graph is still optional: an indexing error (e.g. permissions) stores the path
            // without graph data rather than failing project creation outright.
            match indexer::index_project(p).await {
                Ok((data, hash, size, _canonical)) => {
                    let (nc, ec) = project_graphs::count_nodes_edges(&data);
                    (data, Some(hash), size as i64, Some(p.clone()), Some(canonical), nc, ec)
                }
                Err(_) => {
                    (serde_json::json!({}), None, 0i64, Some(p.clone()), Some(canonical), 0i32, 0i32)
                }
            }
        } else {
            (serde_json::json!({}), None, 0i64, None, None, 0i32, 0i32)
        };

    let row = if canonical_stored.is_some() {
        sqlx::query(
            "INSERT INTO project_graphs \
             (name, path, canonical_path, description, graph_data, graph_hash, graph_file_size, node_count, edge_count, imported_at, version_status) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), $10) \
             ON CONFLICT (canonical_path) DO UPDATE SET \
               name = $1, description = $4, graph_data = $5, graph_hash = $6, \
               graph_file_size = $7, node_count = $8, edge_count = $9, \
               imported_at = NOW(), updated_at = NOW() \
             RETURNING id, name, path, canonical_path, description, node_count, edge_count, \
                       graph_hash, graph_file_size, imported_at, created_at, updated_at, version_status, \
                       (xmax = 0) AS was_inserted"
        )
        .bind(&payload.name)
        .bind(&path_stored)
        .bind(&canonical_stored)
        .bind(&payload.description)
        .bind(&graph_data)
        .bind(&graph_hash)
        .bind(file_size)
        .bind(node_count)
        .bind(edge_count)
        .bind(&version_status)
        .fetch_one(&state.db)
        .await
    } else {
        sqlx::query(
            "INSERT INTO project_graphs \
             (name, path, canonical_path, description, graph_data, graph_hash, graph_file_size, node_count, edge_count, version_status) \
             VALUES ($1, NULL, NULL, $2, $3, NULL, 0, 0, 0, $4) \
             RETURNING id, name, path, canonical_path, description, node_count, edge_count, \
                       graph_hash, graph_file_size, imported_at, created_at, updated_at, version_status, \
                       TRUE AS was_inserted"
        )
        .bind(&payload.name)
        .bind(&payload.description)
        .bind(serde_json::json!({}))
        .bind(&version_status)
        .fetch_one(&state.db)
        .await
    };

    match row {
        Ok(r) => {
            let was_inserted: bool = r.try_get("was_inserted").unwrap_or(true);
            let status = if was_inserted { StatusCode::CREATED } else { StatusCode::OK };
            let project = serde_json::json!({
                "id": r.try_get::<uuid::Uuid, _>("id").ok(),
                "name": r.try_get::<String, _>("name").ok(),
                "path": r.try_get::<Option<String>, _>("path").ok().flatten(),
                "canonical_path": r.try_get::<Option<String>, _>("canonical_path").ok().flatten(),
                "description": r.try_get::<Option<String>, _>("description").ok().flatten(),
                "node_count": r.try_get::<i32, _>("node_count").ok(),
                "edge_count": r.try_get::<i32, _>("edge_count").ok(),
                "graph_hash": r.try_get::<Option<String>, _>("graph_hash").ok().flatten(),
                "graph_file_size": r.try_get::<Option<i64>, _>("graph_file_size").ok().flatten(),
                "imported_at": r.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("imported_at").ok().flatten(),
                "created_at": r.try_get::<chrono::DateTime<chrono::Utc>, _>("created_at").ok(),
                "updated_at": r.try_get::<chrono::DateTime<chrono::Utc>, _>("updated_at").ok(),
                "version_status": r.try_get::<String, _>("version_status").unwrap_or_else(|_| "active".to_string()),
                "effective_version_status": r.try_get::<String, _>("version_status").unwrap_or_else(|_| "active".to_string()),
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
    Query(params): Query<GetProjectGraphParams>,
) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }

    let row = sqlx::query(
        "WITH task_flags AS ( \
           SELECT project_id, \
             bool_or(status NOT IN ('done','cancelled') AND labels @> ARRAY['bug'])     AS has_open_bug, \
             bool_or(status NOT IN ('done','cancelled') AND labels @> ARRAY['feature']) AS has_open_feature \
           FROM project_tasks WHERE project_id = $1 GROUP BY project_id \
         ) \
         SELECT pg.id, pg.name, pg.path, pg.canonical_path, pg.description, pg.node_count, pg.edge_count, \
           pg.graph_data, pg.graph_hash, pg.graph_file_size, pg.imported_at, pg.created_at, pg.updated_at, pg.version_status, \
           CASE \
             WHEN COALESCE(tf.has_open_bug, false)     THEN 'bug_detected' \
             WHEN COALESCE(tf.has_open_feature, false) THEN 'feature_updating' \
             ELSE pg.version_status \
           END AS effective_version_status \
         FROM project_graphs pg \
         LEFT JOIN task_flags tf ON tf.project_id = pg.id \
         WHERE pg.id = $1"
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await;

    match row {
        Ok(Some(r)) => {
            let raw_graph_data: serde_json::Value = r.try_get("graph_data")
                .unwrap_or(serde_json::Value::Object(Default::default()));
            let graph_detail = match params.detail.as_deref().unwrap_or("summary") {
                "summary" => "summary",
                "full" => "full",
                _ => {
                    return (
                        StatusCode::BAD_REQUEST,
                        Json(serde_json::json!({"error": "detail must be summary or full"})),
                    ).into_response();
                }
            };
            let graph_data = if graph_detail == "full" {
                raw_graph_data
            } else {
                project_graphs::summary_graph_data(&raw_graph_data)
            };
            let project = serde_json::json!({
                "id": r.try_get::<Uuid, _>("id").ok().map(|u| u.to_string()),
                "name": r.try_get::<String, _>("name").unwrap_or_default(),
                "path": r.try_get::<String, _>("path").unwrap_or_default(),
                "canonical_path": r.try_get::<String, _>("canonical_path").ok(),
                "description": r.try_get::<Option<String>, _>("description").ok().flatten(),
                "node_count": r.try_get::<i32, _>("node_count").unwrap_or(0),
                "edge_count": r.try_get::<i32, _>("edge_count").unwrap_or(0),
                "graph_data": graph_data,
                "graph_detail": graph_detail,
                "graph_hash": r.try_get::<Option<String>, _>("graph_hash").ok().flatten(),
                "graph_file_size": r.try_get::<Option<i64>, _>("graph_file_size").ok().flatten(),
                "imported_at": r.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("imported_at").ok().flatten(),
                "created_at": r.try_get::<chrono::DateTime<chrono::Utc>, _>("created_at").ok(),
                "updated_at": r.try_get::<chrono::DateTime<chrono::Utc>, _>("updated_at").ok(),
                "version_status": r.try_get::<String, _>("version_status").unwrap_or_else(|_| "active".to_string()),
                "effective_version_status": r.try_get::<String, _>("effective_version_status").unwrap_or_else(|_| "active".to_string()),
            });
            Json(project).into_response()
        }
        Ok(None) => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "project graph not found"}))).into_response(),
        Err(e) => {
            error!("get_project_graph error: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response()
        }
    }
}

async fn update_project_graph(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(payload): Json<UpdateProjectGraphPayload>,
) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }

    if let Some(ref n) = payload.name {
        if n.trim().is_empty() {
            return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "name must be non-empty"}))).into_response();
        }
    }
    if let Some(ref vs) = payload.version_status {
        if !VALID_VERSION_STATUSES.contains(&vs.as_str()) {
            return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "invalid version_status"}))).into_response();
        }
    }

    let existing = sqlx::query("SELECT canonical_path FROM project_graphs WHERE id = $1")
        .bind(id)
        .fetch_optional(&state.db)
        .await;
    let current_canonical: Option<String> = match existing {
        Ok(Some(r)) => r.try_get("canonical_path").unwrap_or(None),
        Ok(None) => return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "project graph not found"}))).into_response(),
        Err(e) => {
            error!("update_project_graph fetch error: {e}");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response();
        }
    };

    // Resolve the path change, if any, into a (new_path, new_canonical_path) pair.
    // `None` means "leave path/canonical_path/graph fields untouched".
    let path_change: Option<(Option<String>, Option<String>)> = match payload.path {
        None => None,
        Some(None) => {
            if current_canonical.is_some() { Some((None, None)) } else { None }
        }
        Some(Some(ref p)) if p.trim().is_empty() => {
            if current_canonical.is_some() { Some((None, None)) } else { None }
        }
        Some(Some(ref p)) => {
            let canonical = match project_graphs::canonicalize_project_path(p).await {
                Ok(c) => c,
                Err(e) => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
            };
            if current_canonical.as_deref() == Some(canonical.as_str()) {
                None
            } else {
                Some((Some(p.clone()), Some(canonical)))
            }
        }
    };

    if let Some((_, Some(ref new_canonical))) = path_change {
        let collision = sqlx::query("SELECT id FROM project_graphs WHERE canonical_path = $1 AND id != $2")
            .bind(new_canonical)
            .bind(id)
            .fetch_optional(&state.db)
            .await;
        match collision {
            Ok(Some(_)) => return (StatusCode::CONFLICT, Json(serde_json::json!({"error": "another project already uses this path"}))).into_response(),
            Ok(None) => {}
            Err(e) => {
                error!("update_project_graph collision check error: {e}");
                return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response();
            }
        }
    }

    let path_changed = path_change.is_some();
    let (new_path, new_canonical) = path_change.unwrap_or((None, None));
    let description_set = payload.description.is_some();
    let new_description = payload.description.flatten();

    let row = sqlx::query(
        "WITH updated AS ( \
           UPDATE project_graphs SET \
             name = COALESCE($1, name), \
             description = CASE WHEN $2 THEN $3 ELSE description END, \
             path = CASE WHEN $4 THEN $5 ELSE path END, \
             canonical_path = CASE WHEN $4 THEN $6 ELSE canonical_path END, \
             graph_data = CASE WHEN $4 THEN '{}'::jsonb ELSE graph_data END, \
             graph_hash = CASE WHEN $4 THEN NULL ELSE graph_hash END, \
             graph_file_size = CASE WHEN $4 THEN 0 ELSE graph_file_size END, \
             node_count = CASE WHEN $4 THEN 0 ELSE node_count END, \
             edge_count = CASE WHEN $4 THEN 0 ELSE edge_count END, \
             imported_at = CASE WHEN $4 THEN NULL ELSE imported_at END, \
             version_status = COALESCE($8, version_status), \
             updated_at = NOW() \
           WHERE id = $7 \
           RETURNING id, name, path, canonical_path, description, node_count, edge_count, \
                     graph_hash, graph_file_size, imported_at, created_at, updated_at, version_status \
         ), \
         task_flags AS ( \
           SELECT project_id, \
             bool_or(status NOT IN ('done','cancelled') AND labels @> ARRAY['bug'])     AS has_open_bug, \
             bool_or(status NOT IN ('done','cancelled') AND labels @> ARRAY['feature']) AS has_open_feature \
           FROM project_tasks WHERE project_id = $7 GROUP BY project_id \
         ) \
         SELECT u.*, \
           CASE \
             WHEN COALESCE(tf.has_open_bug, false)     THEN 'bug_detected' \
             WHEN COALESCE(tf.has_open_feature, false) THEN 'feature_updating' \
             ELSE u.version_status \
           END AS effective_version_status \
         FROM updated u \
         LEFT JOIN task_flags tf ON tf.project_id = u.id"
    )
    .bind(&payload.name)
    .bind(description_set)
    .bind(&new_description)
    .bind(path_changed)
    .bind(&new_path)
    .bind(&new_canonical)
    .bind(id)
    .bind(&payload.version_status)
    .fetch_one(&state.db)
    .await;

    if path_changed {
        if let Ok(mut cache) = state.pg_cache.lock() {
            cache.remove(&id);
        }
    }

    match row {
        Ok(r) => {
            let project = serde_json::json!({
                "id": r.try_get::<Uuid, _>("id").ok().map(|u| u.to_string()),
                "name": r.try_get::<String, _>("name").ok(),
                "path": r.try_get::<Option<String>, _>("path").ok().flatten(),
                "canonical_path": r.try_get::<Option<String>, _>("canonical_path").ok().flatten(),
                "description": r.try_get::<Option<String>, _>("description").ok().flatten(),
                "node_count": r.try_get::<i32, _>("node_count").ok(),
                "edge_count": r.try_get::<i32, _>("edge_count").ok(),
                "graph_hash": r.try_get::<Option<String>, _>("graph_hash").ok().flatten(),
                "graph_file_size": r.try_get::<Option<i64>, _>("graph_file_size").ok().flatten(),
                "imported_at": r.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("imported_at").ok().flatten(),
                "created_at": r.try_get::<chrono::DateTime<chrono::Utc>, _>("created_at").ok(),
                "updated_at": r.try_get::<chrono::DateTime<chrono::Utc>, _>("updated_at").ok(),
                "version_status": r.try_get::<String, _>("version_status").unwrap_or_else(|_| "active".to_string()),
                "effective_version_status": r.try_get::<String, _>("effective_version_status").unwrap_or_else(|_| "active".to_string()),
            });
            Json(project).into_response()
        }
        Err(e) if e.to_string().contains("unique") => {
            (StatusCode::CONFLICT, Json(serde_json::json!({"error": "another project already uses this path"}))).into_response()
        }
        Err(e) => {
            error!("update_project_graph error: {e}");
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

    let path: Option<String> = row.try_get("path").unwrap_or(None);
    let old_hash: Option<String> = row.try_get("graph_hash").unwrap_or(None);

    let path = match path {
        Some(p) if !p.is_empty() => p,
        _ => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "this project has no folder path — add a path before rebuilding"}))).into_response(),
    };

    let (graph_data, graph_hash, file_size, _canonical) = match indexer::index_project(&path).await {
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

/// Fetches `canonical_path` for `id`, resolving the shared 400/404 cases every git-browsing
/// handler needs before it can shell out. `Ok(Err(response))` lets callers `return` it directly.
async fn resolve_git_project_root(
    state: &AppState,
    id: Uuid,
) -> Result<std::path::PathBuf, axum::response::Response> {
    let row = sqlx::query("SELECT canonical_path FROM project_graphs WHERE id = $1")
        .bind(id)
        .fetch_optional(&state.db)
        .await;

    let canonical_path: Option<String> = match row {
        Ok(Some(r)) => r.try_get("canonical_path").unwrap_or(None),
        Ok(None) => {
            return Err((StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "project graph not found"}))).into_response());
        }
        Err(e) => {
            error!("resolve_git_project_root fetch error: {e}");
            return Err((StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response());
        }
    };

    let canonical_path = match canonical_path {
        Some(p) if !p.is_empty() => p,
        _ => {
            return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "this project has no folder path"}))).into_response());
        }
    };

    let root = std::path::PathBuf::from(&canonical_path);
    if !git_browser::has_git_repo(&root) {
        return Err((StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "not_a_git_repo"}))).into_response());
    }
    Ok(root)
}

/// Like `resolve_git_project_root`, but does not require a `.git` folder — used for design-asset
/// scanning, which should work for any project with a registered filesystem path (e.g.
/// `/home/toyofumi/projects/test` or `/home/toyofumi/agent`, neither of which is a git repo).
/// Returns `Ok(None)` (not an error) when the project simply has no filesystem path — callers
/// that treat "no path" as a valid, empty result (e.g. design-assets scanning) can match on that
/// directly instead of parsing an error response.
async fn resolve_project_root(
    state: &AppState,
    id: Uuid,
) -> Result<Option<std::path::PathBuf>, axum::response::Response> {
    let row = sqlx::query("SELECT canonical_path FROM project_graphs WHERE id = $1")
        .bind(id)
        .fetch_optional(&state.db)
        .await;

    let canonical_path: Option<String> = match row {
        Ok(Some(r)) => r.try_get("canonical_path").unwrap_or(None),
        Ok(None) => {
            return Err((StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "project graph not found"}))).into_response());
        }
        Err(e) => {
            error!("resolve_project_root fetch error: {e}");
            return Err((StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response());
        }
    };

    Ok(canonical_path.filter(|p| !p.is_empty()).map(std::path::PathBuf::from))
}

async fn list_project_files(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Query(params): Query<ListProjectFilesParams>,
) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }

    let root = match resolve_git_project_root(&state, id).await {
        Ok(r) => r,
        Err(resp) => return resp,
    };

    let requested_path = params.path.clone();
    let entries = tokio::task::spawn_blocking(move || git_browser::list_directory(&root, &params.path)).await;
    match entries {
        Ok(Ok(entries)) => Json(serde_json::json!({"path": requested_path, "entries": entries})).into_response(),
        Ok(Err(e)) => (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
        Err(e) => {
            error!("list_project_files task panicked: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "internal error"}))).into_response()
        }
    }
}

async fn list_project_changes(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }

    let root = match resolve_git_project_root(&state, id).await {
        Ok(r) => r,
        Err(resp) => return resp,
    };

    let changes = tokio::task::spawn_blocking(move || git_browser::working_tree_changes(&root)).await;
    match changes {
        Ok(Ok(changes)) => Json(serde_json::json!({
            "branch": changes.branch,
            "files": changes.files,
        })).into_response(),
        Ok(Err(e)) => (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
        Err(e) => {
            error!("list_project_changes task panicked: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "internal error"}))).into_response()
        }
    }
}

async fn list_project_commits(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Query(params): Query<ListProjectCommitsParams>,
) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }

    let root = match resolve_git_project_root(&state, id).await {
        Ok(r) => r,
        Err(resp) => return resp,
    };

    let limit = params.limit;
    let commits = tokio::task::spawn_blocking(move || git_browser::commit_graph(&root, limit)).await;
    match commits {
        Ok(commits) => Json(serde_json::json!({"commits": commits})).into_response(),
        Err(e) => {
            error!("list_project_commits task panicked: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "internal error"}))).into_response()
        }
    }
}

async fn commit_and_push_project(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(payload): Json<CommitPushPayload>,
) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }

    let root = match resolve_git_project_root(&state, id).await {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    let message = payload.message;
    let result = tokio::task::spawn_blocking(move || git_browser::commit_and_push(&root, &message)).await;
    match result {
        Ok(Ok(result)) if result.pushed => Json(serde_json::json!({
            "branch": result.branch,
            "commit_hash": result.commit_hash,
            "pushed": true,
        })).into_response(),
        Ok(Ok(result)) => (
            StatusCode::BAD_GATEWAY,
            Json(serde_json::json!({
                "error": result.push_error.unwrap_or_else(|| "Push failed".to_string()),
                "branch": result.branch,
                "commit_hash": result.commit_hash,
                "pushed": false,
            })),
        ).into_response(),
        Ok(Err(e)) => (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
        Err(e) => {
            error!("commit_and_push_project task panicked: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "internal error"}))).into_response()
        }
    }
}

async fn suggest_project_commit_message(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }

    let root = match resolve_git_project_root(&state, id).await {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    let changes = match tokio::task::spawn_blocking(move || git_browser::working_tree_changes(&root)).await {
        Ok(Ok(changes)) => changes,
        Ok(Err(e)) => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
        Err(e) => {
            error!("suggest_project_commit_message task panicked: {e}");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "internal error"}))).into_response();
        }
    };

    if changes.files.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "no working-tree changes to analyze"}))).into_response();
    }

    let cfg = match load_llm_config(&state.db, &state.encryption_key).await {
        Some(cfg) => cfg,
        None => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({
            "error": "LLM not configured — set GRAPH_LLM_API_KEY via LLM Settings"
        }))).into_response(),
    };

    match commit_ai::suggest(&changes, &cfg).await {
        Ok(message) => Json(serde_json::json!({"message": message, "model": cfg.model})).into_response(),
        Err(e) => {
            warn!("ai.commit_message failed (provider={}): {e}", cfg.provider);
            (StatusCode::BAD_GATEWAY, Json(serde_json::json!({"error": format!("LLM request failed: {e}")}))).into_response()
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

// ---------------------------------------------------------------------------
// Project Task handlers
// ---------------------------------------------------------------------------

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

async fn list_project_tasks(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Query(params): Query<ListTasksParams>,
) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }

    let limit = params.limit.clamp(1, 200);
    let offset = params.offset.max(0);

    let rows = match (&params.status, &params.routine_id) {
        (Some(status), Some(routine_id)) => {
            sqlx::query_as::<_, ProjectTask>(
                "SELECT id, project_id, title, description, status, priority, assigned_to, created_by, routine_id, created_at, updated_at, labels, parent_id, start_date, due_date, sort_order \
                 FROM project_tasks WHERE project_id = $1 AND status = $2 AND routine_id = $3 \
                 ORDER BY sort_order ASC, created_at DESC LIMIT $4 OFFSET $5"
            )
            .bind(project_id).bind(status).bind(routine_id).bind(limit).bind(offset)
            .fetch_all(&state.db).await
        }
        (Some(status), None) => {
            sqlx::query_as::<_, ProjectTask>(
                "SELECT id, project_id, title, description, status, priority, assigned_to, created_by, routine_id, created_at, updated_at, labels, parent_id, start_date, due_date, sort_order \
                 FROM project_tasks WHERE project_id = $1 AND status = $2 \
                 ORDER BY sort_order ASC, created_at DESC LIMIT $3 OFFSET $4"
            )
            .bind(project_id).bind(status).bind(limit).bind(offset)
            .fetch_all(&state.db).await
        }
        (None, Some(routine_id)) => {
            sqlx::query_as::<_, ProjectTask>(
                "SELECT id, project_id, title, description, status, priority, assigned_to, created_by, routine_id, created_at, updated_at, labels, parent_id, start_date, due_date, sort_order \
                 FROM project_tasks WHERE project_id = $1 AND routine_id = $2 \
                 ORDER BY sort_order ASC, created_at DESC LIMIT $3 OFFSET $4"
            )
            .bind(project_id).bind(routine_id).bind(limit).bind(offset)
            .fetch_all(&state.db).await
        }
        (None, None) => {
            sqlx::query_as::<_, ProjectTask>(
                "SELECT id, project_id, title, description, status, priority, assigned_to, created_by, routine_id, created_at, updated_at, labels, parent_id, start_date, due_date, sort_order \
                 FROM project_tasks WHERE project_id = $1 \
                 ORDER BY sort_order ASC, created_at DESC LIMIT $2 OFFSET $3"
            )
            .bind(project_id).bind(limit).bind(offset)
            .fetch_all(&state.db).await
        }
    };

    match rows {
        Ok(tasks) => Json(serde_json::json!({"tasks": tasks, "total": tasks.len()})).into_response(),
        Err(e) => {
            error!("list_project_tasks error: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response()
        }
    }
}

async fn create_project_task(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Json(payload): Json<CreateTaskPayload>,
) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }

    if payload.title.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "title must be non-empty"}))).into_response();
    }

    let status = payload.status.as_deref().unwrap_or("todo");
    let priority = payload.priority.as_deref().unwrap_or("medium");
    let labels = normalize_labels(&payload.labels.clone().unwrap_or_default());

    if let Some(parent_id) = payload.parent_id {
        let parent_project: Option<Uuid> = sqlx::query_scalar("SELECT project_id FROM project_tasks WHERE id = $1")
            .bind(parent_id)
            .fetch_optional(&state.db)
            .await
            .unwrap_or(None);
        if parent_project != Some(project_id) {
            return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "parent_id must reference a task in the same project"}))).into_response();
        }
    }

    let row = sqlx::query_as::<_, ProjectTask>(
        "INSERT INTO project_tasks (project_id, title, description, status, priority, assigned_to, labels, created_by, parent_id, start_date, due_date) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'human', $8, $9, $10) \
         RETURNING id, project_id, title, description, status, priority, assigned_to, created_by, routine_id, created_at, updated_at, labels, parent_id, start_date, due_date, sort_order"
    )
    .bind(project_id)
    .bind(&payload.title)
    .bind(&payload.description)
    .bind(status)
    .bind(priority)
    .bind(&payload.assigned_to)
    .bind(&labels)
    .bind(payload.parent_id)
    .bind(payload.start_date)
    .bind(payload.due_date)
    .fetch_one(&state.db)
    .await;

    match row {
        Ok(task) => (StatusCode::CREATED, Json(serde_json::json!(task))).into_response(),
        Err(e) => {
            error!("create_project_task error: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response()
        }
    }
}

async fn update_project_task(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, task_id)): Path<(Uuid, Uuid)>,
    Json(payload): Json<UpdateTaskPayload>,
) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }

    let labels = payload.labels.as_ref().map(|l| normalize_labels(l));

    // parent_id: Some(Some(id)) = reparent, Some(None) = clear to root, None = leave untouched.
    if let Some(Some(new_parent_id)) = payload.parent_id {
        let parent_project: Option<Uuid> = sqlx::query_scalar("SELECT project_id FROM project_tasks WHERE id = $1")
            .bind(new_parent_id)
            .fetch_optional(&state.db)
            .await
            .unwrap_or(None);
        if parent_project != Some(project_id) {
            return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "parent_id must reference a task in the same project"}))).into_response();
        }
        match would_create_cycle(&state.db, task_id, new_parent_id).await {
            Ok(true) => {
                return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "parent_id would create a cycle"}))).into_response();
            }
            Ok(false) => {}
            Err(e) => {
                error!("update_project_task cycle check error: {e}");
                return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response();
            }
        }
    }

    let parent_id_set = payload.parent_id.is_some();
    let parent_id_value = payload.parent_id.flatten();
    let start_date_set = payload.start_date.is_some();
    let start_date_value = payload.start_date.flatten();
    let due_date_set = payload.due_date.is_some();
    let due_date_value = payload.due_date.flatten();

    let row = sqlx::query_as::<_, ProjectTask>(
        "UPDATE project_tasks SET \
         title = COALESCE($1, title), \
         description = CASE WHEN $2::text IS NOT NULL THEN $2 ELSE description END, \
         status = COALESCE($3, status), \
         priority = COALESCE($4, priority), \
         assigned_to = CASE WHEN $5::text IS NOT NULL THEN $5 ELSE assigned_to END, \
         labels = COALESCE($6, labels), \
         parent_id = CASE WHEN $9 THEN $10 ELSE parent_id END, \
         start_date = CASE WHEN $11 THEN $12 ELSE start_date END, \
         due_date = CASE WHEN $13 THEN $14 ELSE due_date END, \
         updated_at = NOW() \
         WHERE id = $7 AND project_id = $8 \
         RETURNING id, project_id, title, description, status, priority, assigned_to, created_by, routine_id, created_at, updated_at, labels, parent_id, start_date, due_date, sort_order"
    )
    .bind(&payload.title)
    .bind(&payload.description)
    .bind(&payload.status)
    .bind(&payload.priority)
    .bind(&payload.assigned_to)
    .bind(&labels)
    .bind(task_id)
    .bind(project_id)
    .bind(parent_id_set)
    .bind(parent_id_value)
    .bind(start_date_set)
    .bind(start_date_value)
    .bind(due_date_set)
    .bind(due_date_value)
    .fetch_optional(&state.db)
    .await;

    match row {
        Ok(Some(task)) => Json(serde_json::json!(task)).into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "task not found"}))).into_response(),
        Err(e) => {
            error!("update_project_task error: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response()
        }
    }
}

async fn delete_project_task(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, task_id)): Path<(Uuid, Uuid)>,
) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }

    let result = sqlx::query("DELETE FROM project_tasks WHERE id = $1 AND project_id = $2 RETURNING id")
        .bind(task_id)
        .bind(project_id)
        .fetch_optional(&state.db)
        .await;

    match result {
        Ok(Some(_)) => Json(serde_json::json!({"deleted": task_id})).into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "task not found"}))).into_response(),
        Err(e) => {
            error!("delete_project_task error: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response()
        }
    }
}

// ---------------------------------------------------------------------------
// Lessons-learned handlers
// ---------------------------------------------------------------------------

const PROJECT_LESSON_COLUMNS: &str = "id, project_id, title, context, rule, category, severity, status, tags, occurrences, created_by, last_seen_at, created_at, updated_at";

async fn list_project_lessons(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Query(params): Query<ListLessonsParams>,
) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }

    let limit = params.limit.clamp(1, 200);
    let offset = params.offset.max(0);
    let status = params.status.as_deref().unwrap_or("active");
    let tag_filter: Vec<String> = normalize_labels(
        &params.tags.as_deref().unwrap_or("").split(',').map(|s| s.to_string()).collect::<Vec<_>>()
    );

    let rows = if let Some(query) = params.query.as_ref().filter(|q| !q.trim().is_empty()) {
        sqlx::query_as::<_, ProjectLesson>(&format!(
            "SELECT {cols} FROM project_lessons \
             WHERE project_id = $1 AND status = $2 \
               AND ($3::text IS NULL OR category = $3) \
               AND ($4::text[] IS NULL OR cardinality($4::text[]) = 0 OR tags && $4) \
               AND to_tsvector('english', title || ' ' || coalesce(context,'') || ' ' || rule) @@ plainto_tsquery('english', $5) \
             ORDER BY ts_rank(to_tsvector('english', title || ' ' || coalesce(context,'') || ' ' || rule), plainto_tsquery('english', $5)) DESC \
             LIMIT $6 OFFSET $7",
            cols = PROJECT_LESSON_COLUMNS
        ))
        .bind(project_id)
        .bind(status)
        .bind(&params.category)
        .bind(&tag_filter)
        .bind(query)
        .bind(limit)
        .bind(offset)
        .fetch_all(&state.db).await
    } else {
        sqlx::query_as::<_, ProjectLesson>(&format!(
            "SELECT {cols} FROM project_lessons \
             WHERE project_id = $1 AND status = $2 \
               AND ($3::text IS NULL OR category = $3) \
               AND ($4::text[] IS NULL OR cardinality($4::text[]) = 0 OR tags && $4) \
             ORDER BY severity DESC, last_seen_at DESC \
             LIMIT $5 OFFSET $6",
            cols = PROJECT_LESSON_COLUMNS
        ))
        .bind(project_id)
        .bind(status)
        .bind(&params.category)
        .bind(&tag_filter)
        .bind(limit)
        .bind(offset)
        .fetch_all(&state.db).await
    };

    match rows {
        Ok(lessons) => Json(serde_json::json!({"lessons": lessons, "total": lessons.len()})).into_response(),
        Err(e) => {
            error!("list_project_lessons error: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response()
        }
    }
}

async fn create_project_lesson(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Json(payload): Json<CreateLessonPayload>,
) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }

    if payload.title.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "title must be non-empty"}))).into_response();
    }
    if payload.rule.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "rule must be non-empty"}))).into_response();
    }

    let category = payload.category.as_deref().unwrap_or("correction");
    let severity = payload.severity.as_deref().unwrap_or("medium");
    let tags = normalize_labels(&payload.tags.clone().unwrap_or_default());

    // Dedupe: same project + case-insensitive title match among active lessons bumps
    // occurrences/last_seen_at instead of inserting a duplicate row.
    let existing: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM project_lessons WHERE project_id = $1 AND status = 'active' AND lower(trim(title)) = lower(trim($2))"
    )
    .bind(project_id)
    .bind(&payload.title)
    .fetch_optional(&state.db)
    .await
    .unwrap_or(None);

    let row = if let Some(lesson_id) = existing {
        sqlx::query_as::<_, ProjectLesson>(&format!(
            "UPDATE project_lessons SET occurrences = occurrences + 1, last_seen_at = NOW(), updated_at = NOW() \
             WHERE id = $1 RETURNING {cols}",
            cols = PROJECT_LESSON_COLUMNS
        ))
        .bind(lesson_id)
        .fetch_one(&state.db)
        .await
    } else {
        sqlx::query_as::<_, ProjectLesson>(&format!(
            "INSERT INTO project_lessons (project_id, title, context, rule, category, severity, tags) \
             VALUES ($1, $2, $3, $4, $5, $6, $7) \
             RETURNING {cols}",
            cols = PROJECT_LESSON_COLUMNS
        ))
        .bind(project_id)
        .bind(&payload.title)
        .bind(&payload.context)
        .bind(&payload.rule)
        .bind(category)
        .bind(severity)
        .bind(&tags)
        .fetch_one(&state.db)
        .await
    };

    match row {
        Ok(lesson) => (StatusCode::CREATED, Json(serde_json::json!(lesson))).into_response(),
        Err(e) => {
            error!("create_project_lesson error: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response()
        }
    }
}

async fn update_project_lesson(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, lesson_id)): Path<(Uuid, Uuid)>,
    Json(payload): Json<UpdateLessonPayload>,
) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }

    let tags = payload.tags.as_ref().map(|t| normalize_labels(t));

    let row = sqlx::query_as::<_, ProjectLesson>(&format!(
        "UPDATE project_lessons SET \
         title = COALESCE($1, title), \
         context = CASE WHEN $2 THEN $3 ELSE context END, \
         rule = COALESCE($4, rule), \
         category = COALESCE($5, category), \
         severity = COALESCE($6, severity), \
         status = COALESCE($7, status), \
         tags = COALESCE($8, tags), \
         updated_at = NOW() \
         WHERE id = $9 AND project_id = $10 \
         RETURNING {cols}",
        cols = PROJECT_LESSON_COLUMNS
    ))
    .bind(&payload.title)
    .bind(payload.context.is_some())
    .bind(payload.context.clone().flatten())
    .bind(&payload.rule)
    .bind(&payload.category)
    .bind(&payload.severity)
    .bind(&payload.status)
    .bind(&tags)
    .bind(lesson_id)
    .bind(project_id)
    .fetch_optional(&state.db)
    .await;

    match row {
        Ok(Some(lesson)) => Json(serde_json::json!(lesson)).into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "lesson not found"}))).into_response(),
        Err(e) => {
            error!("update_project_lesson error: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response()
        }
    }
}

async fn delete_project_lesson(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, lesson_id)): Path<(Uuid, Uuid)>,
) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }

    let result = sqlx::query("DELETE FROM project_lessons WHERE id = $1 AND project_id = $2 RETURNING id")
        .bind(lesson_id)
        .bind(project_id)
        .fetch_optional(&state.db)
        .await;

    match result {
        Ok(Some(_)) => Json(serde_json::json!({"deleted": lesson_id})).into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "lesson not found"}))).into_response(),
        Err(e) => {
            error!("delete_project_lesson error: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response()
        }
    }
}

async fn search_lessons(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ListLessonsParams>,
) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }

    let limit = params.limit.clamp(1, 200);
    let offset = params.offset.max(0);
    let status = params.status.as_deref().unwrap_or("active");
    let tag_filter: Vec<String> = normalize_labels(
        &params.tags.as_deref().unwrap_or("").split(',').map(|s| s.to_string()).collect::<Vec<_>>()
    );

    let rows = if let Some(query) = params.query.as_ref().filter(|q| !q.trim().is_empty()) {
        sqlx::query_as::<_, ProjectLesson>(&format!(
            "SELECT {cols} FROM project_lessons \
             WHERE status = $1 \
               AND ($2::text IS NULL OR category = $2) \
               AND ($3::text[] IS NULL OR cardinality($3::text[]) = 0 OR tags && $3) \
               AND to_tsvector('english', title || ' ' || coalesce(context,'') || ' ' || rule) @@ plainto_tsquery('english', $4) \
             ORDER BY ts_rank(to_tsvector('english', title || ' ' || coalesce(context,'') || ' ' || rule), plainto_tsquery('english', $4)) DESC \
             LIMIT $5 OFFSET $6",
            cols = PROJECT_LESSON_COLUMNS
        ))
        .bind(status)
        .bind(&params.category)
        .bind(&tag_filter)
        .bind(query)
        .bind(limit)
        .bind(offset)
        .fetch_all(&state.db).await
    } else {
        sqlx::query_as::<_, ProjectLesson>(&format!(
            "SELECT {cols} FROM project_lessons \
             WHERE status = $1 \
               AND ($2::text IS NULL OR category = $2) \
               AND ($3::text[] IS NULL OR cardinality($3::text[]) = 0 OR tags && $3) \
             ORDER BY severity DESC, last_seen_at DESC \
             LIMIT $4 OFFSET $5",
            cols = PROJECT_LESSON_COLUMNS
        ))
        .bind(status)
        .bind(&params.category)
        .bind(&tag_filter)
        .bind(limit)
        .bind(offset)
        .fetch_all(&state.db).await
    };

    match rows {
        Ok(lessons) => Json(serde_json::json!({"lessons": lessons, "total": lessons.len()})).into_response(),
        Err(e) => {
            error!("search_lessons error: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response()
        }
    }
}

async fn design_belongs_to_project(db: &PgPool, project_id: Uuid, design_id: Uuid) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM project_designs WHERE id = $1 AND project_id = $2)",
    ).bind(design_id).bind(project_id).fetch_one(db).await
}

async fn list_design_budgets(
    State(state): State<AppState>, headers: HeaderMap,
    Path((project_id, design_id)): Path<(Uuid, Uuid)>,
) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }
    match design_belongs_to_project(&state.db, project_id, design_id).await {
        Ok(false) => return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "design not found"}))).into_response(),
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
        Ok(true) => {}
    }
    match design_budgets::list(&state.db, design_id).await {
        Ok(forecasts) => Json(serde_json::json!({"forecasts": forecasts})).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
    }
}

async fn create_design_budget(
    State(state): State<AppState>, headers: HeaderMap,
    Path((project_id, design_id)): Path<(Uuid, Uuid)>,
    Json(mut input): Json<design_budgets::BudgetInput>,
) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }
    match design_belongs_to_project(&state.db, project_id, design_id).await {
        Ok(false) => return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "design not found"}))).into_response(),
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
        Ok(true) => {}
    }
    input.created_by = Some("human".into());
    if let Err(message) = input.validate() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": message}))).into_response();
    }
    match design_budgets::create(&state.db, design_id, &input).await {
        Ok(forecast) => (StatusCode::CREATED, Json(serde_json::json!(forecast))).into_response(),
        Err(e) if e.to_string().contains("foreign key") => (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "forecast profile not found"}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
    }
}

async fn update_design_budget(
    State(state): State<AppState>, headers: HeaderMap,
    Path((project_id, design_id, budget_id)): Path<(Uuid, Uuid, Uuid)>,
    Json(input): Json<design_budgets::BudgetInput>,
) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }
    match design_belongs_to_project(&state.db, project_id, design_id).await {
        Ok(false) => return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "design not found"}))).into_response(),
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
        Ok(true) => {}
    }
    if let Err(message) = input.validate() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": message}))).into_response();
    }
    match design_budgets::update(&state.db, design_id, budget_id, &input).await {
        Ok(Some(forecast)) => Json(serde_json::json!(forecast)).into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "budget forecast not found"}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
    }
}

async fn delete_design_budget(
    State(state): State<AppState>, headers: HeaderMap,
    Path((project_id, design_id, budget_id)): Path<(Uuid, Uuid, Uuid)>,
) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }
    let result = sqlx::query(
        "DELETE FROM design_budget_forecasts b USING project_designs d \
         WHERE b.id = $1 AND b.design_id = $2 AND d.id = b.design_id AND d.project_id = $3 RETURNING b.id",
    ).bind(budget_id).bind(design_id).bind(project_id).fetch_optional(&state.db).await;
    match result {
        Ok(Some(_)) => Json(serde_json::json!({"deleted": true})).into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "budget forecast not found"}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
    }
}

async fn list_project_designs(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Query(params): Query<ListDesignsParams>,
) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }

    let status = params.status.as_deref().unwrap_or("active");

    let rows = sqlx::query_as::<_, ProjectDesign>(&format!(
        "SELECT {cols} FROM project_designs \
         WHERE project_id = $1 AND status = $2 \
         ORDER BY sort_order ASC, created_at ASC",
        cols = PROJECT_DESIGN_COLUMNS
    ))
    .bind(project_id)
    .bind(status)
    .fetch_all(&state.db)
    .await;

    match rows {
        Ok(designs) => Json(serde_json::json!({"designs": designs, "total": designs.len()})).into_response(),
        Err(e) => {
            error!("list_project_designs error: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response()
        }
    }
}

async fn create_project_design(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Json(payload): Json<CreateDesignPayload>,
) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }

    if payload.title.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "title must be non-empty"}))).into_response();
    }

    if let Some(dt) = payload.diagram_type.as_deref() {
        if !VALID_DIAGRAM_TYPES.contains(&dt) {
            return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "diagram_type must be one of: drawio, mermaid, reactflow, pen"}))).into_response();
        }
    }

    let kind = payload.kind.as_deref().unwrap_or("other");
    let diagram_type = payload.diagram_type.as_deref().unwrap_or("drawio");
    let source = payload.source.clone().unwrap_or_default();
    let tags = normalize_labels(&payload.tags.clone().unwrap_or_default());
    let sort_order = payload.sort_order.unwrap_or(0);

    let row = sqlx::query_as::<_, ProjectDesign>(&format!(
        "INSERT INTO project_designs (project_id, title, kind, diagram_type, source, notes, tags, sort_order) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) \
         RETURNING {cols}",
        cols = PROJECT_DESIGN_COLUMNS
    ))
    .bind(project_id)
    .bind(&payload.title)
    .bind(kind)
    .bind(diagram_type)
    .bind(&source)
    .bind(&payload.notes)
    .bind(&tags)
    .bind(sort_order)
    .fetch_one(&state.db)
    .await;

    match row {
        Ok(design) => (StatusCode::CREATED, Json(serde_json::json!(design))).into_response(),
        Err(e) => {
            error!("create_project_design error: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response()
        }
    }
}

async fn update_project_design(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, design_id)): Path<(Uuid, Uuid)>,
    Json(payload): Json<UpdateDesignPayload>,
) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }

    if let Some(dt) = payload.diagram_type.as_deref() {
        if !VALID_DIAGRAM_TYPES.contains(&dt) {
            return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "diagram_type must be one of: drawio, mermaid, reactflow, pen"}))).into_response();
        }
    }

    let tags = payload.tags.as_ref().map(|t| normalize_labels(t));

    let row = sqlx::query_as::<_, ProjectDesign>(&format!(
        "UPDATE project_designs SET \
         title = COALESCE($1, title), \
         kind = COALESCE($2, kind), \
         source = COALESCE($3, source), \
         notes = CASE WHEN $4 THEN $5 ELSE notes END, \
         tags = COALESCE($6, tags), \
         sort_order = COALESCE($7, sort_order), \
         status = COALESCE($8, status), \
         diagram_type = COALESCE($11, diagram_type), \
         updated_at = NOW() \
         WHERE id = $9 AND project_id = $10 \
         RETURNING {cols}",
        cols = PROJECT_DESIGN_COLUMNS
    ))
    .bind(&payload.title)
    .bind(&payload.kind)
    .bind(&payload.source)
    .bind(payload.notes.is_some())
    .bind(payload.notes.clone().flatten())
    .bind(&tags)
    .bind(payload.sort_order)
    .bind(&payload.status)
    .bind(design_id)
    .bind(project_id)
    .bind(&payload.diagram_type)
    .fetch_optional(&state.db)
    .await;

    match row {
        Ok(Some(design)) => Json(serde_json::json!(design)).into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "design not found"}))).into_response(),
        Err(e) => {
            error!("update_project_design error: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response()
        }
    }
}

async fn delete_project_design(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, design_id)): Path<(Uuid, Uuid)>,
) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }

    let result = sqlx::query("DELETE FROM project_designs WHERE id = $1 AND project_id = $2 RETURNING id")
        .bind(design_id)
        .bind(project_id)
        .fetch_optional(&state.db)
        .await;

    match result {
        Ok(Some(_)) => Json(serde_json::json!({"deleted": design_id})).into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "design not found"}))).into_response(),
        Err(e) => {
            error!("delete_project_design error: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response()
        }
    }
}

async fn list_project_design_assets(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }

    let root = match resolve_project_root(&state, id).await {
        Ok(Some(root)) => root,
        Ok(None) => {
            // No filesystem path registered for this project — a valid, empty result, not an error.
            return Json(serde_json::json!({"docs_dir_exists": false, "docs_dir": "", "entries": []})).into_response();
        }
        Err(resp) => return resp,
    };

    let assets = tokio::task::spawn_blocking(move || design_assets::scan(&root)).await;
    match assets {
        Ok(assets) => Json(serde_json::json!(assets)).into_response(),
        Err(e) => {
            error!("list_project_design_assets task panicked: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "internal error"}))).into_response()
        }
    }
}

// ---------------------------------------------------------------------------
// Routine due-check logic (supports daily/weekly/monthly/yearly/custom cron)
// ---------------------------------------------------------------------------

/// Returns true if the routine should fire given its last_task_date.
/// Custom frequencies are treated as 5-field cron expressions (min hour day month weekday).
fn is_routine_due(frequency: &str, last_task_date: Option<chrono::NaiveDate>) -> bool {
    use chrono::{Datelike, Utc};
    let today = Utc::now().date_naive();

    let Some(last) = last_task_date else { return true }; // never run

    match frequency {
        "daily"   => last < today,
        "weekly"  => (today - last).num_days() >= 7,
        "monthly" => {
            let first_of_month = chrono::NaiveDate::from_ymd_opt(today.year(), today.month(), 1).unwrap_or(today);
            last < first_of_month
        }
        "yearly" => {
            let first_of_year = chrono::NaiveDate::from_ymd_opt(today.year(), 1, 1).unwrap_or(today);
            last < first_of_year
        }
        cron_expr => {
            // Standard 5-field cron (min hour day month weekday) → 7-field (prepend sec, append year)
            use std::str::FromStr;
            let full = format!("0 {} *", cron_expr);
            match cron::Schedule::from_str(&full) {
                Ok(schedule) => {
                    let last_dt = last.and_time(chrono::NaiveTime::MIN).and_utc();
                    schedule.after(&last_dt).next()
                        .map(|next| next <= Utc::now())
                        .unwrap_or(false)
                }
                Err(_) => false,
            }
        }
    }
}

/// Core routine due-check + task creation for a single project.
/// Shared by the HTTP handler and the background scheduler so both paths
/// stay in sync and neither duplicates the creation logic.
async fn run_routine_check(db: &PgPool, project_id: Uuid) -> Result<Vec<serde_json::Value>, sqlx::Error> {
    let all_routines = sqlx::query_as::<_, ProjectRoutine>(
        r#"SELECT id, project_id, title, description, frequency, priority, assigned_to,
                  last_task_date, enabled, created_at, updated_at
           FROM project_routines WHERE project_id = $1 AND enabled = TRUE"#
    )
    .bind(project_id)
    .fetch_all(db)
    .await?;

    let routines: Vec<&ProjectRoutine> = all_routines.iter()
        .filter(|r| is_routine_due(&r.frequency, r.last_task_date))
        .collect();

    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let mut created_tasks: Vec<serde_json::Value> = Vec::new();

    for r in routines {
        // Atomically claim the day for this routine: only proceed if this call is the
        // one that flips last_task_date forward. This prevents the manual "Check due"
        // button and the background scheduler from both creating a task for the same
        // routine on the same day.
        let claimed = sqlx::query(
            "UPDATE project_routines SET last_task_date = CURRENT_DATE, updated_at = NOW() \
             WHERE id = $1 AND (last_task_date IS NULL OR last_task_date < CURRENT_DATE) \
             RETURNING id"
        )
        .bind(r.id)
        .fetch_optional(db)
        .await?;

        if claimed.is_none() {
            continue;
        }

        let task_title = format!("{} — {}", r.title, today);
        let task = sqlx::query(
            "INSERT INTO project_tasks \
             (project_id, routine_id, title, description, status, priority, assigned_to, created_by) \
             VALUES ($1, $2, $3, $4, 'todo', $5, $6, 'agent') \
             RETURNING id, title, status"
        )
        .bind(r.project_id)
        .bind(r.id)
        .bind(&task_title)
        .bind(&r.description)
        .bind(&r.priority)
        .bind(&r.assigned_to)
        .fetch_one(db)
        .await?;

        created_tasks.push(serde_json::json!({
            "id": task.try_get::<Uuid, _>("id").ok(),
            "title": task.try_get::<String, _>("title").ok(),
            "status": task.try_get::<String, _>("status").ok(),
            "routine_id": r.id,
            "routine_title": r.title,
        }));
    }

    Ok(created_tasks)
}

/// Lists the IDs of all known projects (project_graphs table) so the
/// background scheduler can sweep every project's routines each tick.
async fn list_all_project_ids(db: &PgPool) -> Result<Vec<Uuid>, sqlx::Error> {
    sqlx::query_scalar::<_, Uuid>("SELECT id FROM project_graphs").fetch_all(db).await
}

/// Runs the routine due-check for every project, logging per-project outcomes.
/// A failure on one project is logged and skipped so it never blocks the others
/// or brings down the scheduler loop.
async fn run_routine_check_for_all_projects(db: &PgPool) {
    let project_ids = match list_all_project_ids(db).await {
        Ok(ids) => ids,
        Err(e) => {
            warn!("routine scheduler: failed to list projects: {e}");
            return;
        }
    };

    for project_id in project_ids {
        match run_routine_check(db, project_id).await {
            Ok(created) if !created.is_empty() => {
                info!(%project_id, count = created.len(), "routine scheduler: created task(s) from due routines");
            }
            Ok(_) => {}
            Err(e) => {
                warn!(%project_id, "routine scheduler: check failed: {e}");
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Project Routine handlers
// ---------------------------------------------------------------------------

async fn list_project_routines(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }
    let rows = sqlx::query_as::<_, ProjectRoutine>(
        "SELECT id, project_id, title, description, frequency, priority, assigned_to, \
         last_task_date, enabled, created_at, updated_at, labels \
         FROM project_routines WHERE project_id = $1 ORDER BY created_at ASC"
    )
    .bind(project_id)
    .fetch_all(&state.db)
    .await;

    match rows {
        Ok(routines) => Json(serde_json::json!({"routines": routines})).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
    }
}

async fn create_project_routine(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Json(payload): Json<CreateRoutinePayload>,
) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }
    if payload.title.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "title required"}))).into_response();
    }
    let frequency = payload.frequency.as_deref().unwrap_or("daily");
    let priority = payload.priority.as_deref().unwrap_or("medium");
    let labels = normalize_labels(&payload.labels.clone().unwrap_or_default());

    let row = sqlx::query_as::<_, ProjectRoutine>(
        "INSERT INTO project_routines (project_id, title, description, frequency, priority, assigned_to, labels) \
         VALUES ($1, $2, $3, $4, $5, $6, $7) \
         RETURNING id, project_id, title, description, frequency, priority, assigned_to, \
                   last_task_date, enabled, created_at, updated_at, labels"
    )
    .bind(project_id).bind(&payload.title).bind(&payload.description)
    .bind(frequency).bind(priority).bind(&payload.assigned_to)
    .bind(&labels)
    .fetch_one(&state.db).await;

    match row {
        Ok(r) => (StatusCode::CREATED, Json(serde_json::json!(r))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
    }
}

async fn update_project_routine(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, routine_id)): Path<(Uuid, Uuid)>,
    Json(payload): Json<UpdateRoutinePayload>,
) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }
    let labels = payload.labels.as_ref().map(|l| normalize_labels(l));

    let row = sqlx::query_as::<_, ProjectRoutine>(
        "UPDATE project_routines SET \
         title       = COALESCE($1, title), \
         description = CASE WHEN $2::text IS NOT NULL THEN $2 ELSE description END, \
         frequency   = COALESCE($3, frequency), \
         priority    = COALESCE($4, priority), \
         assigned_to = CASE WHEN $5::text IS NOT NULL THEN $5 ELSE assigned_to END, \
         enabled     = COALESCE($6, enabled), \
         labels      = COALESCE($9, labels), \
         updated_at  = NOW() \
         WHERE id = $7 AND project_id = $8 \
         RETURNING id, project_id, title, description, frequency, priority, assigned_to, \
                   last_task_date, enabled, created_at, updated_at, labels"
    )
    .bind(&payload.title).bind(&payload.description)
    .bind(&payload.frequency).bind(&payload.priority).bind(&payload.assigned_to)
    .bind(payload.enabled)
    .bind(routine_id).bind(project_id)
    .bind(&labels)
    .fetch_optional(&state.db).await;

    match row {
        Ok(Some(r)) => Json(serde_json::json!(r)).into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "routine not found"}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
    }
}

async fn delete_project_routine(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, routine_id)): Path<(Uuid, Uuid)>,
) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }
    let result = sqlx::query("DELETE FROM project_routines WHERE id = $1 AND project_id = $2 RETURNING id")
        .bind(routine_id).bind(project_id)
        .fetch_optional(&state.db).await;

    match result {
        Ok(Some(_)) => Json(serde_json::json!({"deleted": routine_id})).into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "routine not found"}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
    }
}

async fn check_project_routines(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Query(params): Query<CheckRoutinesParams>,
) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }

    if params.dry_run {
        // Report which routines are currently due without creating tasks or claiming the day.
        let all_routines = sqlx::query_as::<_, ProjectRoutine>(
            r#"SELECT id, project_id, title, description, frequency, priority, assigned_to,
                      last_task_date, enabled, created_at, updated_at
               FROM project_routines WHERE project_id = $1 AND enabled = TRUE"#
        )
        .bind(project_id)
        .fetch_all(&state.db)
        .await;

        return match all_routines {
            Ok(rs) => {
                let due: Vec<&ProjectRoutine> = rs.iter().filter(|r| is_routine_due(&r.frequency, r.last_task_date)).collect();
                Json(serde_json::json!({"due": due, "created": []})).into_response()
            }
            Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
        };
    }

    match run_routine_check(&state.db, project_id).await {
        Ok(created_tasks) => Json(serde_json::json!({
            "checked": created_tasks.len(),
            "created": created_tasks,
        })).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
    }
}

async fn list_workflows(State(state): State<AppState>, headers: HeaderMap) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }
    match workflows::list(&state.db).await {
        Ok(items) => Json(serde_json::json!({"workflows": items, "total": items.len()})).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
    }
}

async fn get_workflow(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }
    match workflows::get(&state.db, &id).await {
        Ok(item) => Json(serde_json::json!(item)).into_response(),
        Err(e) => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
    }
}

async fn create_workflow(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<WorkflowPayload>,
) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }
    match workflows::create(&state.db, &payload.name, payload.description.as_deref(), &payload.input_schema, &payload.steps, payload.enabled).await {
        Ok(item) => (StatusCode::CREATED, Json(serde_json::json!(item))).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
    }
}

async fn update_workflow(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(payload): Json<WorkflowPayload>,
) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }
    match workflows::update(&state.db, id, &payload.name, payload.description.as_deref(), &payload.input_schema, &payload.steps, payload.enabled).await {
        Ok(item) => Json(serde_json::json!(item)).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
    }
}

async fn delete_workflow(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }
    match workflows::delete(&state.db, id).await {
        Ok(()) => Json(serde_json::json!({"deleted": id})).into_response(),
        Err(e) => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
    }
}

async fn run_workflow(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(payload): Json<WorkflowRunPayload>,
) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }
    match workflows::run(&state.db, &state.encryption_key, &id, payload.input).await {
        Ok(result) => Json(serde_json::json!(result)).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
    }
}

async fn continue_workflow_run(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(payload): Json<WorkflowContinuePayload>,
) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }
    match workflows::continue_run(&state.db, &state.encryption_key, id, payload.result).await {
        Ok(result) => Json(serde_json::json!(result)).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
    }
}

#[allow(dead_code)]
async fn _sleep_for_readability() {
    tokio::time::sleep(Duration::from_millis(10)).await;
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

        assert_eq!(mermaid.matches("E_Alice[\"Alice\"]").count(), 1);
        assert_eq!(mermaid.matches("E_Team[\"Team\"]").count(), 1);
        assert!(mermaid.contains("-->|member_of|"));
        assert!(mermaid.contains("-->|leads|"));
    }
}
