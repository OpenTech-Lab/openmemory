use anyhow::{Context, Result};
use serde::Serialize;
use tracing::{info, warn};
use uuid::Uuid;

const GRAPH_NAME: &str = "openmemory";

#[derive(Clone, Debug, Serialize)]
pub struct EdgeInfo {
    pub from_id: String,
    pub to_id: String,
    pub rel_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relationship: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct NeighborInfo {
    pub id: Uuid,
    pub summary: Option<String>,
    pub importance: f32,
    pub tags: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct EpisodeInfo {
    pub id: String,
    pub name: String,
    pub source: String,
    pub content: String,
    pub group_id: String,
    pub created_at: String,
    pub valid_at: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct EntityInfo {
    pub id: String,
    pub name: String,
    pub entity_type: String,
    pub summary: Option<String>,
    pub group_id: String,
    pub created_at: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct FactResult {
    pub fact_id: String,
    pub subject_name: String,
    pub subject_type: String,
    pub relationship: String,
    pub fact: String,
    pub object_name: String,
    pub object_type: String,
    pub valid_at: String,
    pub invalid_at: Option<String>,
    pub episode_id: Option<String>,
    pub is_current: bool,
}

#[derive(Clone)]
pub struct FalkorDbClient {
    conn: redis::aio::ConnectionManager,
}

impl FalkorDbClient {
    pub async fn connect(url: &str) -> Option<Self> {
        match redis::Client::open(url) {
            Ok(client) => match client.get_connection_manager().await {
                Ok(conn) => {
                    info!("connected to FalkorDB (graph store)");
                    Some(Self { conn })
                }
                Err(e) => {
                    warn!("FalkorDB connection failed: {e}, continuing without graph layer");
                    None
                }
            },
            Err(e) => {
                warn!("FalkorDB client creation failed: {e}");
                None
            }
        }
    }

    /// Create indexes for Memory, Episode, and Entity node types — idempotent, errors are silently ignored.
    pub async fn init_indexes(&mut self) -> Result<()> {
        let indexes = [
            "CREATE INDEX ON :Memory(id)",
            "CREATE INDEX ON :Episode(id)",
            "CREATE INDEX ON :Episode(group_id)",
            "CREATE INDEX ON :Entity(id)",
            "CREATE INDEX ON :Entity(name)",
            "CREATE INDEX ON :Entity(group_id)",
        ];
        for q in &indexes {
            let _ = redis::cmd("GRAPH.QUERY")
                .arg(GRAPH_NAME)
                .arg(q)
                .query_async::<redis::Value>(&mut self.conn)
                .await;
        }
        info!("FalkorDB graph store ready (temporal schema)");
        Ok(())
    }

    /// Upsert a memory node and auto-create RELATED_TO edges to nodes sharing ≥1 tag.
    pub async fn save_node(
        &mut self,
        id: Uuid,
        user_id: Option<&str>,
        summary: Option<&str>,
        importance: f32,
        tags: &[String],
        created_at: &str,
    ) -> Result<()> {
        let tags_lit = cypher_string_list(tags);
        let user_id_lit = escape_option_str(user_id);
        let summary_lit = escape_option_str(summary);

        let q1 = format!(
            "MERGE (m:Memory {{id: \"{id}\"}}) \
             SET m.user_id = {user_id_lit}, \
                 m.summary = {summary_lit}, \
                 m.importance = {importance}, \
                 m.tags = {tags_lit}, \
                 m.created_at = \"{created_at}\""
        );
        redis::cmd("GRAPH.QUERY")
            .arg(GRAPH_NAME)
            .arg(&q1)
            .query_async::<redis::Value>(&mut self.conn)
            .await
            .context("FalkorDB MERGE node failed")?;

        if !tags.is_empty() {
            // Only connect memories belonging to the same tenant.
            // Cypher: NULL = NULL is NULL (falsy), so we must handle the null-user case explicitly.
            let q2 = format!(
                "MATCH (a:Memory {{id: \"{id}\"}}), (b:Memory) \
                 WHERE b.id <> \"{id}\" \
                   AND ANY(t IN a.tags WHERE t IN b.tags) \
                   AND (a.user_id = b.user_id OR (a.user_id IS NULL AND b.user_id IS NULL)) \
                   AND NOT (a)-[:RELATED_TO]-(b) \
                 MERGE (a)-[:RELATED_TO]->(b) \
                 MERGE (b)-[:RELATED_TO]->(a)"
            );
            redis::cmd("GRAPH.QUERY")
                .arg(GRAPH_NAME)
                .arg(&q2)
                .query_async::<redis::Value>(&mut self.conn)
                .await
                .context("FalkorDB auto-edge failed")?;
        }

        Ok(())
    }

    /// Update a memory node's properties and re-sync RELATED_TO edges after tag changes.
    pub async fn update_node(
        &mut self,
        id: Uuid,
        summary: Option<&str>,
        importance: Option<f32>,
        tags: Option<&[String]>,
    ) -> Result<()> {
        // Build SET clause only for provided fields
        let mut sets = Vec::new();
        if let Some(s) = summary {
            sets.push(format!("m.summary = {}", escape_option_str(Some(s))));
        }
        if let Some(imp) = importance {
            sets.push(format!("m.importance = {imp}"));
        }
        if let Some(t) = tags {
            sets.push(format!("m.tags = {}", cypher_string_list(t)));
        }

        if !sets.is_empty() {
            let q = format!(
                "MATCH (m:Memory {{id: \"{id}\"}}) SET {}",
                sets.join(", ")
            );
            redis::cmd("GRAPH.QUERY")
                .arg(GRAPH_NAME)
                .arg(&q)
                .query_async::<redis::Value>(&mut self.conn)
                .await
                .context("FalkorDB update_node SET failed")?;
        }

        // When tags change, re-sync RELATED_TO edges: drop old ones, create new ones
        if let Some(new_tags) = tags {
            // Remove all existing auto-edges from this node
            let q_del = format!(
                "MATCH (a:Memory {{id: \"{id}\"}})-[r:RELATED_TO]-(b:Memory) DELETE r"
            );
            redis::cmd("GRAPH.QUERY")
                .arg(GRAPH_NAME)
                .arg(&q_del)
                .query_async::<redis::Value>(&mut self.conn)
                .await
                .context("FalkorDB edge cleanup failed")?;

            // Re-create edges for current tags (same logic as save_node)
            if !new_tags.is_empty() {
                let q_add = format!(
                    "MATCH (a:Memory {{id: \"{id}\"}}), (b:Memory) \
                     WHERE b.id <> \"{id}\" \
                       AND ANY(t IN a.tags WHERE t IN b.tags) \
                       AND (a.user_id = b.user_id OR (a.user_id IS NULL AND b.user_id IS NULL)) \
                       AND NOT (a)-[:RELATED_TO]-(b) \
                     MERGE (a)-[:RELATED_TO]->(b) \
                     MERGE (b)-[:RELATED_TO]->(a)"
                );
                redis::cmd("GRAPH.QUERY")
                    .arg(GRAPH_NAME)
                    .arg(&q_add)
                    .query_async::<redis::Value>(&mut self.conn)
                    .await
                    .context("FalkorDB edge re-sync failed")?;
            }
        }

        Ok(())
    }

    /// Remove a memory node and all its edges.
    pub async fn delete_node(&mut self, id: Uuid) -> Result<()> {
        let q = format!("MATCH (m:Memory {{id: \"{id}\"}}) DETACH DELETE m");
        redis::cmd("GRAPH.QUERY")
            .arg(GRAPH_NAME)
            .arg(&q)
            .query_async::<redis::Value>(&mut self.conn)
            .await
            .context("FalkorDB DETACH DELETE failed")?;
        Ok(())
    }

    /// Return all edges in the graph, scoped to a user namespace.
    pub async fn get_all_edges(&mut self, user_id: Option<&str>) -> Result<Vec<EdgeInfo>> {
        // No user_id → unscoped (single-user mode). A user_id → filter to that tenant only.
        let user_filter = match user_id {
            Some(uid) => format!(
                " WHERE a.user_id = \"{}\" AND b.user_id = \"{}\"",
                escape_str(uid),
                escape_str(uid)
            ),
            None => String::new(),
        };
        let q = format!(
            "MATCH (a:Memory)-[r]->(b:Memory){user_filter} \
             RETURN a.id AS from_id, b.id AS to_id, type(r) AS rel_type, r.relationship AS rel_name"
        );
        let result: redis::Value = redis::cmd("GRAPH.QUERY")
            .arg(GRAPH_NAME)
            .arg(&q)
            .query_async(&mut self.conn)
            .await
            .context("FalkorDB get_all_edges failed")?;

        Ok(parse_edge_rows(result))
    }

    /// Return neighbor memories via 1–2 hop graph traversal, scoped to the same user.
    pub async fn get_neighbors(
        &mut self,
        id: Uuid,
        user_id: Option<&str>,
        hops: u8,
        limit: usize,
    ) -> Result<Vec<NeighborInfo>> {
        let hops = hops.clamp(1, 2);
        // Scope to tenant when user_id is provided; unscoped for single-user mode.
        let user_filter = match user_id {
            Some(uid) => format!(" AND b.user_id = \"{}\"", escape_str(uid)),
            None => String::new(),
        };
        let q = format!(
            "MATCH (a:Memory {{id: \"{id}\"}})-[:RELATED_TO|LINKED_TO*1..{hops}]-(b:Memory) \
             WHERE b.id <> \"{id}\"{user_filter} \
             RETURN DISTINCT b.id AS id, b.summary AS summary, \
                    b.importance AS importance, b.tags AS tags \
             LIMIT {limit}"
        );
        let result: redis::Value = redis::cmd("GRAPH.QUERY")
            .arg(GRAPH_NAME)
            .arg(&q)
            .query_async(&mut self.conn)
            .await
            .context("FalkorDB get_neighbors failed")?;

        Ok(parse_neighbor_rows(result))
    }

    /// Create an explicit named LINKED_TO edge between two memories.
    /// Returns an error if either node is not present in FalkorDB (e.g. pre-existing
    /// memory or async save hasn't completed yet) so callers don't see silent no-ops.
    pub async fn relate_nodes(
        &mut self,
        from_id: Uuid,
        to_id: Uuid,
        relationship: &str,
    ) -> Result<()> {
        // Verify both nodes exist AND share the same namespace before creating the edge.
        // Checking user_id equality here prevents LINKED_TO edges from crossing tenants,
        // matching the same-namespace restriction used for auto RELATED_TO edges.
        let check_q = format!(
            "MATCH (a:Memory {{id: \"{from_id}\"}}), (b:Memory {{id: \"{to_id}\"}}) \
             WHERE (a.user_id = b.user_id OR (a.user_id IS NULL AND b.user_id IS NULL)) \
             RETURN count(*) AS n"
        );
        let check_result: redis::Value = redis::cmd("GRAPH.QUERY")
            .arg(GRAPH_NAME)
            .arg(&check_q)
            .query_async(&mut self.conn)
            .await
            .context("FalkorDB relate_nodes namespace check failed")?;

        let found = extract_node_count(check_result);
        if found < 1 {
            anyhow::bail!(
                "One or both memories are not in the graph or belong to different namespaces. \
                 The async graph write may still be in flight — retry in a moment."
            );
        }

        let rel_escaped = escape_str(relationship);
        let q = format!(
            "MATCH (a:Memory {{id: \"{from_id}\"}}), (b:Memory {{id: \"{to_id}\"}})\n\
             MERGE (a)-[r:LINKED_TO {{relationship: \"{rel_escaped}\"}}]->(b)"
        );
        redis::cmd("GRAPH.QUERY")
            .arg(GRAPH_NAME)
            .arg(&q)
            .query_async::<redis::Value>(&mut self.conn)
            .await
            .context("FalkorDB relate_nodes failed")?;
        Ok(())
    }
}

fn escape_str(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

fn escape_option_str(opt: Option<&str>) -> String {
    opt.map(|s| format!("\"{}\"", escape_str(s)))
        .unwrap_or_else(|| "null".to_string())
}

fn cypher_string_list(tags: &[String]) -> String {
    let items: Vec<String> = tags
        .iter()
        .map(|t| format!("\"{}\"", escape_str(t)))
        .collect();
    format!("[{}]", items.join(", "))
}

fn parse_edge_rows(result: redis::Value) -> Vec<EdgeInfo> {
    let outer = match result {
        redis::Value::Array(v) => v,
        _ => return vec![],
    };
    if outer.len() < 2 {
        return vec![];
    }
    let rows = match &outer[1] {
        redis::Value::Array(rows) => rows,
        _ => return vec![],
    };
    rows.iter()
        .filter_map(|row| {
            let cols = match row {
                redis::Value::Array(c) => c,
                _ => return None,
            };
            if cols.len() < 3 {
                return None;
            }
            let from_id = extract_string(&cols[0])?;
            let to_id = extract_string(&cols[1])?;
            let rel_type = extract_string(&cols[2]).unwrap_or_else(|| "RELATED_TO".to_string());
            let relationship = if cols.len() >= 4 { extract_string(&cols[3]) } else { None };
            Some(EdgeInfo { from_id, to_id, rel_type, relationship })
        })
        .collect()
}

// FalkorDB returns GRAPH.QUERY results as:
//   Array[ column_names, rows, stats ]
// where each row is Array[ col0_val, col1_val, ... ]
// Property values may be plain BulkString/Int or wrapped as Array[type_id, value].
fn parse_neighbor_rows(result: redis::Value) -> Vec<NeighborInfo> {
    let outer = match result {
        redis::Value::Array(v) => v,
        _ => return vec![],
    };
    if outer.len() < 2 {
        return vec![];
    }
    let rows = match &outer[1] {
        redis::Value::Array(rows) => rows,
        _ => return vec![],
    };
    rows.iter()
        .filter_map(|row| {
            let cols = match row {
                redis::Value::Array(c) => c,
                _ => return None,
            };
            if cols.len() < 4 {
                return None;
            }
            let id_str = extract_string(&cols[0])?;
            let id = Uuid::parse_str(&id_str).ok()?;
            let summary = extract_string(&cols[1]);
            let importance = extract_f32(&cols[2]).unwrap_or(0.5);
            let tags = extract_string_list(&cols[3]);
            Some(NeighborInfo { id, summary, importance, tags })
        })
        .collect()
}

fn extract_string(v: &redis::Value) -> Option<String> {
    match v {
        redis::Value::BulkString(bytes) => String::from_utf8(bytes.clone()).ok(),
        redis::Value::SimpleString(s) => Some(s.clone()),
        // FalkorDB may wrap values as [type_id, actual_value]
        redis::Value::Array(arr) if arr.len() == 2 => extract_string(&arr[1]),
        _ => None,
    }
}

fn extract_f32(v: &redis::Value) -> Option<f32> {
    match v {
        redis::Value::BulkString(bytes) => String::from_utf8(bytes.clone())
            .ok()
            .and_then(|s| s.parse().ok()),
        redis::Value::Int(i) => Some(*i as f32),
        redis::Value::Array(arr) if arr.len() == 2 => extract_f32(&arr[1]),
        _ => None,
    }
}

/// Parse an integer count from a GRAPH.QUERY result (e.g. `RETURN count(m) AS n`).
fn extract_node_count(result: redis::Value) -> i64 {
    let outer = match result {
        redis::Value::Array(v) => v,
        _ => return 0,
    };
    if outer.len() < 2 {
        return 0;
    }
    let rows = match &outer[1] {
        redis::Value::Array(rows) => rows,
        _ => return 0,
    };
    rows.first()
        .and_then(|row| match row {
            redis::Value::Array(cols) => cols.first().and_then(|v| extract_f32(v)),
            _ => None,
        })
        .unwrap_or(0.0) as i64
}

fn extract_string_list(v: &redis::Value) -> Vec<String> {
    match v {
        redis::Value::Array(arr) => {
            if arr.len() == 2 {
                if let redis::Value::Array(_) = &arr[1] {
                    return extract_string_list(&arr[1]);
                }
            }
            arr.iter().filter_map(extract_string).collect()
        }
        _ => vec![],
    }
}
