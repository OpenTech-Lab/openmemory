use anyhow::{Context, Result};
use chrono::Utc;
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

    /// Upsert an Episode node (immutable source record).
    /// Episodes are never updated — MERGE on id ensures idempotency.
    pub async fn add_episode(
        &mut self,
        id: Uuid,
        name: &str,
        source: &str,
        source_description: &str,
        content: &str,
        group_id: &str,
        created_at: &str,
        valid_at: &str,
    ) -> Result<()> {
        let valid_at = normalize_ts(valid_at);
        let q = format!(
            "MERGE (e:Episode {{id: \"{id}\"}}) \
             SET e.name = {name}, \
                 e.source = {source}, \
                 e.source_description = {source_desc}, \
                 e.content = {content}, \
                 e.group_id = {group_id}, \
                 e.created_at = {created_at}, \
                 e.valid_at = {valid_at}",
            name = escape_option_str(Some(name)),
            source = escape_option_str(Some(source)),
            source_desc = escape_option_str(Some(source_description)),
            content = escape_option_str(Some(content)),
            group_id = escape_option_str(Some(group_id)),
            created_at = escape_option_str(Some(created_at)),
            valid_at = escape_option_str(Some(&valid_at)),
        );
        redis::cmd("GRAPH.QUERY")
            .arg(GRAPH_NAME)
            .arg(&q)
            .query_async::<redis::Value>(&mut self.conn)
            .await
            .context("FalkorDB add_episode failed")?;
        Ok(())
    }

    /// Upsert an Entity node. Deduplicates on (name, entity_type, group_id).
    /// Returns (entity_id, was_created): was_created=true if new, false if existing.
    pub async fn add_entity(
        &mut self,
        new_id: Uuid,
        name: &str,
        entity_type: &str,
        group_id: &str,
        summary: Option<&str>,
        created_at: &str,
    ) -> Result<(String, bool)> {
        // Check if entity already exists
        let check_q = format!(
            "MATCH (n:Entity {{name: {name}, entity_type: {etype}, group_id: {gid}}}) \
             RETURN n.id AS id",
            name = escape_option_str(Some(name)),
            etype = escape_option_str(Some(entity_type)),
            gid = escape_option_str(Some(group_id)),
        );
        let existing: redis::Value = redis::cmd("GRAPH.QUERY")
            .arg(GRAPH_NAME)
            .arg(&check_q)
            .query_async(&mut self.conn)
            .await
            .context("FalkorDB add_entity check failed")?;

        if let Some(id) = parse_first_string(existing) {
            // Entity exists — update summary if provided
            if let Some(s) = summary {
                let update_q = format!(
                    "MATCH (n:Entity {{name: {name}, entity_type: {etype}, group_id: {gid}}}) \
                     SET n.summary = {summary}",
                    name = escape_option_str(Some(name)),
                    etype = escape_option_str(Some(entity_type)),
                    gid = escape_option_str(Some(group_id)),
                    summary = escape_option_str(Some(s)),
                );
                if let Err(e) = redis::cmd("GRAPH.QUERY")
                    .arg(GRAPH_NAME)
                    .arg(&update_q)
                    .query_async::<redis::Value>(&mut self.conn)
                    .await
                {
                    warn!("FalkorDB update entity summary failed: {e}");
                }
            }
            return Ok((id, false));
        }

        // Entity does not exist — create it
        let create_q = format!(
            "CREATE (n:Entity {{id: \"{new_id}\", name: {name}, entity_type: {etype}, \
              group_id: {gid}, summary: {summary}, created_at: {created_at}}})",
            name = escape_option_str(Some(name)),
            etype = escape_option_str(Some(entity_type)),
            gid = escape_option_str(Some(group_id)),
            summary = escape_option_str(summary),
            created_at = escape_option_str(Some(created_at)),
        );
        redis::cmd("GRAPH.QUERY")
            .arg(GRAPH_NAME)
            .arg(&create_q)
            .query_async::<redis::Value>(&mut self.conn)
            .await
            .context("FalkorDB add_entity create failed")?;

        Ok((new_id.to_string(), true))
    }

    /// Look up a single entity by name (and optionally type and group_id).
    pub async fn get_entity(
        &mut self,
        name: &str,
        entity_type: Option<&str>,
        group_id: Option<&str>,
    ) -> Result<Option<EntityInfo>> {
        let type_filter = entity_type
            .map(|t| format!(", entity_type: {}", escape_option_str(Some(t))))
            .unwrap_or_default();
        let group_filter = group_id
            .map(|g| format!(", group_id: {}", escape_option_str(Some(g))))
            .unwrap_or_default();

        let q = format!(
            "MATCH (n:Entity {{name: {name}{type_filter}{group_filter}}}) \
             RETURN n.id, n.name, n.entity_type, n.summary, n.group_id, n.created_at \
             LIMIT 1",
            name = escape_option_str(Some(name)),
        );
        let result: redis::Value = redis::cmd("GRAPH.QUERY")
            .arg(GRAPH_NAME)
            .arg(&q)
            .query_async(&mut self.conn)
            .await
            .context("FalkorDB get_entity failed")?;

        Ok(parse_entity_rows(result).into_iter().next())
    }

    /// Create a FACT edge between two entities (looked up by name+type+group_id).
    /// If invalidate_previous=true, sets invalid_at on all existing FACT edges
    /// with the same `name` between the same entity pair.
    /// Returns (fact_id, invalidated_count).
    pub async fn add_fact(
        &mut self,
        id: Uuid,
        subject_name: &str,
        subject_type: &str,
        object_name: &str,
        object_type: &str,
        group_id: &str,
        fact_name: &str,
        fact: &str,
        episode_id: Option<&str>,
        valid_at: &str,
        created_at: &str,
        invalidate_previous: bool,
    ) -> Result<(String, u32)> {
        let valid_at = normalize_ts(valid_at);
        let mut invalidated: u32 = 0;

        // Verify both entities exist in the same group before creating the fact
        let check_q = format!(
            "MATCH (a:Entity {{name: {sname}, entity_type: {stype}, group_id: {gid}}}), \
                   (b:Entity {{name: {oname}, entity_type: {otype}, group_id: {gid2}}}) \
             RETURN count(*) AS n",
            sname = escape_option_str(Some(subject_name)),
            stype = escape_option_str(Some(subject_type)),
            oname = escape_option_str(Some(object_name)),
            otype = escape_option_str(Some(object_type)),
            gid = escape_option_str(Some(group_id)),
            gid2 = escape_option_str(Some(group_id)),
        );
        let check_result: redis::Value = redis::cmd("GRAPH.QUERY")
            .arg(GRAPH_NAME)
            .arg(&check_q)
            .query_async(&mut self.conn)
            .await
            .context("FalkorDB add_fact entity check failed")?;

        if parse_count(check_result) < 1 {
            anyhow::bail!(
                "One or both entities ({} '{}', {} '{}') not found in group '{}'. \
                 Call add_entity first.",
                subject_type, subject_name, object_type, object_name, group_id
            );
        }

        // CREATE new fact first — if this fails, old facts are left intact (no silent data loss)
        let episode_lit = escape_option_str(episode_id);
        let q = format!(
            "MATCH (a:Entity {{name: {sname}, entity_type: {stype}, group_id: {gid}}}) \
             WITH a LIMIT 1 \
             MATCH (b:Entity {{name: {oname}, entity_type: {otype}, group_id: {gid2}}}) \
             WITH a, b LIMIT 1 \
             CREATE (a)-[:FACT {{ \
                 id: \"{id}\", \
                 name: {fname}, \
                 fact: {fact_val}, \
                 valid_at: {valid_at}, \
                 created_at: {created_at_val}, \
                 episode_id: {episode_id} \
             }}]->(b)",
            sname = escape_option_str(Some(subject_name)),
            stype = escape_option_str(Some(subject_type)),
            oname = escape_option_str(Some(object_name)),
            otype = escape_option_str(Some(object_type)),
            gid = escape_option_str(Some(group_id)),
            gid2 = escape_option_str(Some(group_id)),
            fname = escape_option_str(Some(fact_name)),
            fact_val = escape_option_str(Some(fact)),
            valid_at = escape_option_str(Some(&valid_at)),
            created_at_val = escape_option_str(Some(created_at)),
            episode_id = episode_lit,
        );
        redis::cmd("GRAPH.QUERY")
            .arg(GRAPH_NAME)
            .arg(&q)
            .query_async::<redis::Value>(&mut self.conn)
            .await
            .context("FalkorDB add_fact CREATE failed")?;

        // Invalidate old facts AFTER the new one is safely created.
        // Use valid_at (not created_at) so there is no gap or overlap in temporal validity.
        if invalidate_previous {
            let inv_q = format!(
                "MATCH (a:Entity {{name: {sname}, entity_type: {stype}, group_id: {gid}}})\
                 -[f:FACT]->\
                 (b:Entity {{name: {oname}, entity_type: {otype}, group_id: {gid2}}}) \
                 WHERE f.name = {fname} AND f.invalid_at IS NULL AND f.id <> \"{id}\" \
                 SET f.invalid_at = {now} \
                 RETURN count(f) AS n",
                sname = escape_option_str(Some(subject_name)),
                stype = escape_option_str(Some(subject_type)),
                oname = escape_option_str(Some(object_name)),
                otype = escape_option_str(Some(object_type)),
                gid = escape_option_str(Some(group_id)),
                gid2 = escape_option_str(Some(group_id)),
                fname = escape_option_str(Some(fact_name)),
                now = escape_option_str(Some(&valid_at)),
            );
            let inv_result: redis::Value = redis::cmd("GRAPH.QUERY")
                .arg(GRAPH_NAME)
                .arg(&inv_q)
                .query_async(&mut self.conn)
                .await
                .context("FalkorDB invalidate previous facts failed")?;
            invalidated = parse_count(inv_result);
        }

        Ok((id.to_string(), invalidated))
    }

    /// Create a MENTIONS edge from an Episode to an Entity (provenance link).
    pub async fn link_episode_to_entity(
        &mut self,
        episode_id: Uuid,
        entity_name: &str,
        entity_type: &str,
        group_id: &str,
    ) -> Result<()> {
        let q = format!(
            "MATCH (e:Episode {{id: \"{episode_id}\"}}), \
                   (n:Entity {{name: {ename}, entity_type: {etype}, group_id: {gid}}}) \
             MERGE (e)-[:MENTIONS]->(n)",
            ename = escape_option_str(Some(entity_name)),
            etype = escape_option_str(Some(entity_type)),
            gid = escape_option_str(Some(group_id)),
        );
        redis::cmd("GRAPH.QUERY")
            .arg(GRAPH_NAME)
            .arg(&q)
            .query_async::<redis::Value>(&mut self.conn)
            .await
            .context("FalkorDB link_episode_to_entity failed")?;
        Ok(())
    }

    /// Search facts by substring match, optionally filtered by group and validity.
    pub async fn query_facts(
        &mut self,
        query: &str,
        group_id: Option<&str>,
        limit: usize,
        valid_only: bool,
    ) -> Result<Vec<FactResult>> {
        let group_filter = group_id
            .map(|g| format!(" AND a.group_id = {}", escape_option_str(Some(g))))
            .unwrap_or_default();
        let valid_filter = if valid_only {
            let now_str = Utc::now().to_rfc3339();
            format!(
                " AND f.invalid_at IS NULL AND f.valid_at <= {}",
                escape_option_str(Some(&now_str))
            )
        } else {
            String::new()
        };
        let q_lit = escape_option_str(Some(query));

        let q = format!(
            "MATCH (a:Entity)-[f:FACT]->(b:Entity) \
             WHERE (toLower(f.fact) CONTAINS toLower({q_lit}) OR toLower(f.name) CONTAINS toLower({q_lit}) \
                    OR toLower(a.name) CONTAINS toLower({q_lit}) OR toLower(b.name) CONTAINS toLower({q_lit})) \
             {group_filter}{valid_filter} \
             RETURN a.name, a.entity_type, f.name, f.fact, b.name, b.entity_type, \
                    f.valid_at, f.invalid_at, f.episode_id, f.id \
             ORDER BY f.valid_at DESC \
             LIMIT {limit}",
        );
        let result: redis::Value = redis::cmd("GRAPH.QUERY")
            .arg(GRAPH_NAME)
            .arg(&q)
            .query_async(&mut self.conn)
            .await
            .context("FalkorDB query_facts failed")?;
        Ok(parse_fact_rows(result))
    }

    /// Return all facts that were valid at a specific ISO8601 timestamp.
    /// Valid = valid_at <= timestamp AND (invalid_at IS NULL OR invalid_at > timestamp)
    pub async fn query_at(
        &mut self,
        timestamp: &str,
        entity_name: Option<&str>,
        group_id: Option<&str>,
        limit: usize,
    ) -> Result<Vec<FactResult>> {
        let timestamp = normalize_ts(timestamp);
        let ts = escape_option_str(Some(&timestamp));
        let entity_filter = entity_name
            .map(|n| format!(
                " AND (a.name = {} OR b.name = {})",
                escape_option_str(Some(n)),
                escape_option_str(Some(n))
            ))
            .unwrap_or_default();
        let group_filter = group_id
            .map(|g| format!(" AND a.group_id = {}", escape_option_str(Some(g))))
            .unwrap_or_default();

        let q = format!(
            "MATCH (a:Entity)-[f:FACT]->(b:Entity) \
             WHERE f.valid_at <= {ts} \
               AND (f.invalid_at IS NULL OR f.invalid_at > {ts}) \
               {entity_filter}{group_filter} \
             RETURN a.name, a.entity_type, f.name, f.fact, b.name, b.entity_type, \
                    f.valid_at, f.invalid_at, f.episode_id, f.id \
             ORDER BY f.valid_at DESC \
             LIMIT {limit}",
        );
        let result: redis::Value = redis::cmd("GRAPH.QUERY")
            .arg(GRAPH_NAME)
            .arg(&q)
            .query_async(&mut self.conn)
            .await
            .context("FalkorDB query_at failed")?;
        Ok(parse_fact_rows(result))
    }

    /// Return all facts (current and historical) involving an entity by name.
    pub async fn get_entity_history(
        &mut self,
        entity_name: &str,
        group_id: Option<&str>,
        limit: usize,
    ) -> Result<Vec<FactResult>> {
        let name_lit = escape_option_str(Some(entity_name));
        let group_filter = group_id
            .map(|g| format!(" AND a.group_id = {}", escape_option_str(Some(g))))
            .unwrap_or_default();
        let group_filter_b = group_id
            .map(|g| format!(" AND b.group_id = {}", escape_option_str(Some(g))))
            .unwrap_or_default();

        // Outgoing facts (entity as subject)
        let q1 = format!(
            "MATCH (a:Entity {{name: {name_lit}}})-[f:FACT]->(b:Entity) \
             WHERE 1=1{group_filter} \
             RETURN a.name, a.entity_type, f.name, f.fact, b.name, b.entity_type, \
                    f.valid_at, f.invalid_at, f.episode_id, f.id \
             ORDER BY f.valid_at DESC \
             LIMIT {limit}",
        );
        let r1: redis::Value = redis::cmd("GRAPH.QUERY")
            .arg(GRAPH_NAME)
            .arg(&q1)
            .query_async(&mut self.conn)
            .await
            .context("FalkorDB get_entity_history outgoing failed")?;
        let mut facts = parse_fact_rows(r1);

        // Incoming facts (entity as object)
        let q2 = format!(
            "MATCH (a:Entity)-[f:FACT]->(b:Entity {{name: {name_lit}}}) \
             WHERE 1=1{group_filter_b} \
             RETURN a.name, a.entity_type, f.name, f.fact, b.name, b.entity_type, \
                    f.valid_at, f.invalid_at, f.episode_id, f.id \
             ORDER BY f.valid_at DESC \
             LIMIT {limit}",
        );
        let r2: redis::Value = redis::cmd("GRAPH.QUERY")
            .arg(GRAPH_NAME)
            .arg(&q2)
            .query_async(&mut self.conn)
            .await
            .context("FalkorDB get_entity_history incoming failed")?;
        facts.extend(parse_fact_rows(r2));

        facts.sort_by(|a, b| b.valid_at.cmp(&a.valid_at));
        facts.truncate(limit);
        Ok(facts)
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
            // FalkorDB bug: ANY() predicate in WHERE is silently dropped in cross-join queries;
            // use list comprehension + size() in a WITH clause instead. MERGE is idempotent
            // so we skip the NOT (a)-[:RELATED_TO]-(b) anti-pattern guard.
            let q2 = format!(
                "MATCH (a:Memory {{id: \"{id}\"}}), (b:Memory) \
                 WHERE b.id <> \"{id}\" \
                   AND (a.user_id = b.user_id OR (a.user_id IS NULL AND b.user_id IS NULL)) \
                 WITH a, b, [t IN a.tags WHERE t IN b.tags] AS common \
                 WHERE size(common) > 0 \
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
                       AND (a.user_id = b.user_id OR (a.user_id IS NULL AND b.user_id IS NULL)) \
                     WITH a, b, [t IN a.tags WHERE t IN b.tags] AS common \
                     WHERE size(common) > 0 \
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
             RETURN a.id AS from_id, b.id AS to_id, type(r) AS rel_type, r.relationship AS rel_name \
             LIMIT 5000"
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

fn parse_first_string(result: redis::Value) -> Option<String> {
    let outer = match result {
        redis::Value::Array(v) => v,
        _ => return None,
    };
    let rows = match outer.get(1) {
        Some(redis::Value::Array(r)) => r,
        _ => return None,
    };
    let first_row = match rows.first() {
        Some(redis::Value::Array(cols)) => cols,
        _ => return None,
    };
    first_row.first().and_then(extract_string)
}

fn parse_entity_rows(result: redis::Value) -> Vec<EntityInfo> {
    let outer = match result {
        redis::Value::Array(v) => v,
        _ => return vec![],
    };
    let rows = match outer.get(1) {
        Some(redis::Value::Array(r)) => r,
        _ => return vec![],
    };
    rows.iter().filter_map(|row| {
        let cols = match row {
            redis::Value::Array(c) => c,
            _ => return None,
        };
        if cols.len() < 6 { return None; }
        Some(EntityInfo {
            id: extract_string(&cols[0])?,
            name: extract_string(&cols[1])?,
            entity_type: extract_string(&cols[2]).unwrap_or_default(),
            summary: extract_string(&cols[3]),
            group_id: extract_string(&cols[4]).unwrap_or_default(),
            created_at: extract_string(&cols[5]).unwrap_or_default(),
        })
    }).collect()
}

fn parse_count(result: redis::Value) -> u32 {
    let outer = match result {
        redis::Value::Array(v) => v,
        _ => return 0,
    };
    let rows = match outer.get(1) {
        Some(redis::Value::Array(r)) => r,
        _ => return 0,
    };
    rows.first()
        .and_then(|row| match row {
            redis::Value::Array(cols) => cols.first().and_then(|v| extract_f32(v)),
            _ => None,
        })
        .unwrap_or(0.0) as u32
}

fn parse_fact_rows(result: redis::Value) -> Vec<FactResult> {
    let outer = match result {
        redis::Value::Array(v) => v,
        _ => return vec![],
    };
    let rows = match outer.get(1) {
        Some(redis::Value::Array(r)) => r,
        _ => return vec![],
    };
    rows.iter().filter_map(|row| {
        let cols = match row {
            redis::Value::Array(c) => c,
            _ => return None,
        };
        if cols.len() < 10 { return None; }
        let invalid_at = extract_string(&cols[7]);
        let is_current = invalid_at.as_deref()
            .map(|s| s.is_empty() || s == "null")
            .unwrap_or(true);
        Some(FactResult {
            subject_name: extract_string(&cols[0]).unwrap_or_default(),
            subject_type: extract_string(&cols[1]).unwrap_or_default(),
            relationship: extract_string(&cols[2]).unwrap_or_default(),
            fact: extract_string(&cols[3]).unwrap_or_default(),
            object_name: extract_string(&cols[4]).unwrap_or_default(),
            object_type: extract_string(&cols[5]).unwrap_or_default(),
            valid_at: extract_string(&cols[6]).unwrap_or_default(),
            invalid_at,
            episode_id: extract_string(&cols[8]),
            fact_id: extract_string(&cols[9]).unwrap_or_default(),
            is_current,
        })
    }).collect()
}

/// Parse an RFC3339 timestamp and normalize to UTC. Returns the original string on parse failure
/// so callers aren't broken by unusual formats — but logs a warning.
pub(crate) fn normalize_ts(ts: &str) -> String {
    use chrono::DateTime;
    ts.parse::<DateTime<Utc>>()
        .map(|dt| dt.to_rfc3339())
        .unwrap_or_else(|_| {
            warn!("normalize_ts: could not parse timestamp {:?}, using as-is", ts);
            ts.to_string()
        })
}
