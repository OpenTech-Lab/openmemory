use super::*;

impl McpServer {
    // ── Project graph helpers ────────────────────────────────────────────────

    /// Resolve a project row by project_id, name, or path.
    /// Returns (id, graph_data, graph_hash, path).
    pub(super) async fn resolve_project_graph_data(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<(Uuid, serde_json::Value, Option<String>, String)> {
        let row = if let Some(id_str) = args["project_id"].as_str() {
            let id = Uuid::parse_str(id_str).context("invalid project_id UUID")?;
            sqlx::query("SELECT id, graph_data, graph_hash, path FROM project_graphs WHERE id = $1")
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

    pub(super) async fn project_graph_list(
        &mut self,
        _args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let rows: Vec<project_graphs::ProjectGraphRow> = sqlx::query_as(
            r#"SELECT id, name, path, canonical_path, description, node_count, edge_count,
                      graph_hash, graph_file_size, imported_at, folder_id, created_at, updated_at,
                      version_status, version_status AS effective_version_status
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

    pub(super) async fn project_graph_create(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let name = args["name"].as_str().context("missing name")?.to_string();
        let path = args["path"].as_str().context("missing path")?.to_string();
        let description = args["description"].as_str().map(|s| s.to_string());

        let (data, hash, size, canonical) = indexer::index_project(&path).await?;
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

    pub(super) async fn project_graph_query(
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
                resp.nodes
                    .iter()
                    .find(|n| &n.id == sid)
                    .map(|n| n.label.clone())
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
                let seed_marker = if resp.seed_nodes.contains(&node.id) {
                    " *"
                } else {
                    ""
                };
                text.push_str(&format!(
                    "  {} ({}) id={}{}\n",
                    node.label, ft, node.id, seed_marker
                ));
                if !src.is_empty() {
                    text.push_str(&format!("    source: {}\n", src));
                }
            }
            text.push('\n');
        }

        // List edges
        if !resp.edges.is_empty() {
            // Build id→label map for readable edge output
            let id_to_label: std::collections::HashMap<String, String> = resp
                .nodes
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

    pub(super) async fn project_graph_node_detail(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let node_id = args["node_id"]
            .as_str()
            .context("missing node_id")?
            .to_string();
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

    pub(super) async fn project_graph_shortest_path(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let from_node = args["from_node"]
            .as_str()
            .context("missing from_node")?
            .to_string();
        let to_node = args["to_node"]
            .as_str()
            .context("missing to_node")?
            .to_string();
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

    pub(super) async fn project_graph_god_nodes(
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

    pub(super) async fn project_graph_delete(
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
            sqlx::query("DELETE FROM project_graphs WHERE name ILIKE $1 RETURNING name")
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
                let deleted_name: String = row
                    .try_get("name")
                    .context("failed to get project name from RETURNING")?;
                Ok(json!({
                    "content": [{
                        "type": "text",
                        "text": format!("Deleted project '{}'. Original files on disk are unchanged.", deleted_name)
                    }]
                }))
            }
        }
    }

    pub(super) async fn project_graph_rebuild(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let (id, _graph_data, current_hash, path) = self.resolve_project_graph_data(args).await?;

        let (new_data, new_hash, new_size, _canonical) = indexer::index_project(&path).await?;

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
}
