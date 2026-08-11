use super::*;

impl McpServer {
    pub(super) async fn memory_save(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let content = args["content"]
            .as_str()
            .context("missing content")?
            .to_string();
        let summary = args["summary"].as_str().map(|s| s.to_string());
        let importance = args["importance"].as_f64().unwrap_or(0.5) as f32;
        let importance = importance.clamp(0.0, 1.0);
        let tags: Vec<String> = args["tags"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
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
                let excluded =
                    frequent_tags(&db_c, Some(&tags_c), AUTO_LINK_TAG_MAX_FRACTION).await;
                if let Err(e) = fdb
                    .save_node(
                        id,
                        None,
                        sum_c.as_deref(),
                        importance,
                        &tags_c,
                        &ts,
                        &excluded,
                    )
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

    pub(super) async fn memory_search(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let query = args["query"].as_str().context("missing query")?.to_string();
        let limit = args["limit"].as_u64().unwrap_or(5) as usize;
        let limit = limit.clamp(1, 20);

        // Search in OpenSearch
        let docs = self
            .opensearch
            .search(&query, limit * 2)
            .await
            .unwrap_or_default();

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

        results.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

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
                    results.sort_by(|a, b| {
                        b.score
                            .partial_cmp(&a.score)
                            .unwrap_or(std::cmp::Ordering::Equal)
                    });
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
                            let neighbor_docs = self
                                .opensearch
                                .get_by_ids(&new_ids)
                                .await
                                .unwrap_or_default();
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
                                let Some(doc) =
                                    neighbor_docs.iter().find(|d| d.id == n.id.to_string())
                                else {
                                    continue;
                                };
                                let index = neighbor_index.iter().find(|i| i.id == n.id);
                                let created_at =
                                    index.map(|i| i.created_at).unwrap_or_else(Utc::now);
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
                            results.sort_by(|a, b| {
                                b.score
                                    .partial_cmp(&a.score)
                                    .unwrap_or(std::cmp::Ordering::Equal)
                            });
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

    pub(super) async fn memory_graph_all(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let user_id = args["user_id"].as_str().map(|s| s.to_string());
        let edges = match &self.falkordb {
            None => vec![],
            Some(fdb) => {
                let mut fdb = fdb.clone();
                fdb.get_all_edges(user_id.as_deref())
                    .await
                    .unwrap_or_default()
            }
        };
        Ok(json!({ "type": "memory.graph_all.result", "edges": edges }))
    }

    pub(super) async fn memory_graph_data(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let user_id = args["user_id"].as_str().map(|s| s.to_string());
        // No limit → all memories (the web graph page requests everything by default).
        // An explicit limit is still honored for callers that want a bounded page.
        let limit = args["limit"]
            .as_u64()
            .map(|l| l.max(1) as i64)
            .unwrap_or(i64::MAX);

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
            let docs = self
                .opensearch
                .get_by_ids(&unlabeled_ids)
                .await
                .unwrap_or_default();
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
                fdb.get_all_edges(user_id.as_deref())
                    .await
                    .unwrap_or_default()
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
            .map(|m| {
                json!({
                    "id": m.id,
                    "summary": m.summary,
                    "importance_score": m.importance_score,
                    "tags": m.tags,
                    "created_at": m.created_at,
                })
            })
            .collect();

        Ok(json!({ "type": "memory.graph_data.result", "memories": nodes, "edges": edges }))
    }

    pub(super) async fn memory_graph_rebuild(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let mut fdb = match &self.falkordb {
            Some(f) => f.clone(),
            None => return Ok(json!({ "type": "memory.graph_rebuild.result", "rebuilt": 0 })),
        };

        let user_id = args["user_id"].as_str().map(|s| s.to_string());
        // Rebuild is a one-time maintenance backfill, not a live render — unlike
        // memory_graph_data it should cover everything by default, not just a page.
        // An explicit limit is still honored (e.g. to rebuild only the newest N).
        let limit = args["limit"]
            .as_u64()
            .map(|l| l.max(1) as i64)
            .unwrap_or(i64::MAX);

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
        if let Err(e) = fdb
            .relink_all_tag_edges(user_id.as_deref(), &excluded)
            .await
        {
            warn!("memory_graph_rebuild: relink_all_tag_edges failed: {e}");
        }

        Ok(json!({ "type": "memory.graph_rebuild.result", "rebuilt": rebuilt }))
    }

    pub(super) async fn memory_graph_neighbors(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
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

        let neighbors = fdb
            .get_neighbors(id, user_id.as_deref(), hops, limit)
            .await?;

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

    pub(super) async fn memory_graph_relate(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let from_id = uuid::Uuid::parse_str(args["from_id"].as_str().context("missing from_id")?)
            .context("invalid from_id")?;
        let to_id = uuid::Uuid::parse_str(args["to_id"].as_str().context("missing to_id")?)
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
}
