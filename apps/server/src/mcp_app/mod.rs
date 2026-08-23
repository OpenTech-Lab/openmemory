//! MCP application layer.
//!
//! The binary entry point only owns the stdio transport.  This module owns the
//! shared server context, while each capability group lives in its own handler
//! module.  Keeping the context here gives handlers a stable dependency seam
//! without making the transport know about storage or tool details.

mod bootstrap;
mod catalog;
mod dispatch;
mod env_tools;
mod graph_tools;
mod helpers;
mod library_tools;
mod memory;
mod opensearch;
mod planning_tools;
mod project_graph_tools;
mod protocol;
mod qa_tools;
mod resource_tools;
mod ssh_tools;
mod workflow_tools;

#[cfg(test)]
mod tests;

use crate::crypto::{decrypt_value, derive_key, encrypt_value, EnvParamRow};
use crate::falkordb::{self, FalkorDbClient};
use crate::{design_budgets, forecasts, indexer, library, project_graphs, qa, resources, workflows};
use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use opensearch::OpenSearchClient;
use reqwest::Client as HttpClient;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{postgres::PgPoolOptions, FromRow, PgPool, Row};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tracing::{error, info, warn};
use uuid::Uuid;

use helpers::{
    build_mermaid, compute_combined_score, content_preview, format_facts, frequent_tags,
    is_routine_due_mcp, normalize_lesson_tags, would_create_cycle, AUTO_LINK_TAG_MAX_FRACTION,
};
#[derive(Debug, Deserialize)]
pub(super) struct JsonRpcRequest {
    pub(super) jsonrpc: String,
    pub(super) id: Option<serde_json::Value>,
    pub(super) method: String,
    pub(super) params: Option<serde_json::Value>,
}

#[derive(Debug, Serialize)]
pub(super) struct JsonRpcResponse {
    pub(super) jsonrpc: String,
    pub(super) id: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) error: Option<JsonRpcError>,
}

#[derive(Debug, Serialize)]
pub(super) struct JsonRpcError {
    pub(super) code: i32,
    pub(super) message: String,
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

struct McpServer {
    db: PgPool,
    opensearch: OpenSearchClient,
    falkordb: Option<FalkorDbClient>,
    encryption_key: [u8; 32],
}

/// Run the MCP stdio application.
pub(crate) async fn run() -> Result<()> {
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
