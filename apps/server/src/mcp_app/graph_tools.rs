use super::*;

impl McpServer {
    pub(super) async fn graph_add_episode(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let name = args["name"].as_str().context("missing name")?.to_string();
        let source = args["source"]
            .as_str()
            .context("missing source")?
            .to_string();
        let source_description = args["source_description"]
            .as_str()
            .context("missing source_description")?
            .to_string();
        let content = args["content"]
            .as_str()
            .context("missing content")?
            .to_string();
        let group_id = args["group_id"].as_str().unwrap_or("default").to_string();
        let id = Uuid::new_v4();
        let now = Utc::now();
        let valid_at = args["valid_at"]
            .as_str()
            .map(|s| s.to_string())
            .unwrap_or_else(|| now.to_rfc3339());

        let mut fdb = self
            .falkordb
            .as_ref()
            .context("Graph layer not configured (FALKORDB_URL not set)")?
            .clone();
        fdb.add_episode(
            id,
            &name,
            &source,
            &source_description,
            &content,
            &group_id,
            &now.to_rfc3339(),
            &valid_at,
        )
        .await?;

        Ok(
            json!({"content": [{"type": "text", "text": format!("Episode added: '{}' (id: {})", name, id)}]}),
        )
    }

    pub(super) async fn graph_add_entity(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let name = args["name"].as_str().context("missing name")?.to_string();
        let entity_type = args["entity_type"]
            .as_str()
            .context("missing entity_type")?
            .to_string();
        let group_id = args["group_id"].as_str().unwrap_or("default").to_string();
        let summary = args["summary"].as_str().map(|s| s.to_string());
        let episode_id = args["episode_id"].as_str().map(|s| s.to_string());
        let new_id = Uuid::new_v4();
        let now = Utc::now();

        let mut fdb = self
            .falkordb
            .as_ref()
            .context("Graph layer not configured (FALKORDB_URL not set)")?
            .clone();
        let (entity_id, created) = fdb
            .add_entity(
                new_id,
                &name,
                &entity_type,
                &group_id,
                summary.as_deref(),
                &now.to_rfc3339(),
            )
            .await?;

        if let Some(ep_id_str) = episode_id {
            let ep_uuid = Uuid::parse_str(&ep_id_str)
                .map_err(|_| anyhow::anyhow!("invalid episode_id UUID: {}", ep_id_str))?;
            if let Err(e) = fdb
                .link_episode_to_entity(ep_uuid, &name, &entity_type, &group_id)
                .await
            {
                warn!("link_episode_to_entity failed (entity still saved): {e}");
            }
        }

        let action = if created { "Created" } else { "Found existing" };
        Ok(
            json!({"content": [{"type": "text", "text": format!("{} entity '{}' ({}) id={}", action, name, entity_type, entity_id)}]}),
        )
    }

    pub(super) async fn graph_add_fact(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let subject = args["subject"]
            .as_str()
            .context("missing subject")?
            .to_string();
        let subject_type = args["subject_type"]
            .as_str()
            .context("missing subject_type")?
            .to_string();
        let object = args["object"]
            .as_str()
            .context("missing object")?
            .to_string();
        let object_type = args["object_type"]
            .as_str()
            .context("missing object_type")?
            .to_string();
        let name = args["name"].as_str().context("missing name")?.to_string();
        let fact = args["fact"].as_str().context("missing fact")?.to_string();
        let group_id = args["group_id"].as_str().unwrap_or("default").to_string();
        let episode_id = args["episode_id"].as_str().map(|s| s.to_string());
        let now = Utc::now();
        let now_str = now.to_rfc3339();
        let valid_at = args["valid_at"]
            .as_str()
            .map(|s| s.to_string())
            .unwrap_or_else(|| now_str.clone());
        let invalidate = args["invalidate_previous"].as_bool().unwrap_or(false);
        let id = Uuid::new_v4();

        let mut fdb = self
            .falkordb
            .as_ref()
            .context("Graph layer not configured (FALKORDB_URL not set)")?
            .clone();
        let (fact_id, invalidated) = fdb
            .add_fact(
                id,
                &subject,
                &subject_type,
                &object,
                &object_type,
                &group_id,
                &name,
                &fact,
                episode_id.as_deref(),
                &valid_at,
                &now_str,
                invalidate,
            )
            .await?;

        Ok(json!({"content": [{"type": "text", "text":
            format!("Fact added: '{}' -[{}]-> '{}' (id={}, invalidated: {})", subject, name, object, fact_id, invalidated)}]}))
    }

    pub(super) async fn graph_query_facts(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let query = args["query"].as_str().context("missing query")?.to_string();
        let group_id = args["group_id"].as_str().map(|s| s.to_string());
        let limit = args["limit"].as_u64().unwrap_or(10).clamp(1, 50) as usize;
        let valid_only = args["valid_only"].as_bool().unwrap_or(false);

        let mut fdb = match &self.falkordb {
            Some(f) => f.clone(),
            None => {
                return Ok(
                    json!({"content": [{"type": "text", "text": "No results (graph layer not configured)"}]}),
                )
            }
        };

        let facts = fdb
            .query_facts(&query, group_id.as_deref(), limit, valid_only)
            .await?;
        let text = format_facts(&facts, &format!("\"{}\"", query));
        Ok(json!({"content": [{"type": "text", "text": text}]}))
    }

    pub(super) async fn graph_query_at(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let timestamp = args["timestamp"]
            .as_str()
            .context("missing timestamp")?
            .to_string();
        let entity_name = args["entity_name"].as_str().map(|s| s.to_string());
        let group_id = args["group_id"].as_str().map(|s| s.to_string());
        let limit = args["limit"].as_u64().unwrap_or(20).clamp(1, 100) as usize;

        let mut fdb = match &self.falkordb {
            Some(f) => f.clone(),
            None => {
                return Ok(
                    json!({"content": [{"type": "text", "text": "No results (graph layer not configured)"}]}),
                )
            }
        };

        let facts = fdb
            .query_at(
                &timestamp,
                entity_name.as_deref(),
                group_id.as_deref(),
                limit,
            )
            .await?;
        let text = format_facts(&facts, &format!("at {}", timestamp));
        Ok(json!({"content": [{"type": "text", "text": text}]}))
    }

    pub(super) async fn graph_get_entity_history(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let entity_name = args["entity_name"]
            .as_str()
            .context("missing entity_name")?
            .to_string();
        let group_id = args["group_id"].as_str().map(|s| s.to_string());
        let limit = args["limit"].as_u64().unwrap_or(20).clamp(1, 100) as usize;

        let mut fdb = match &self.falkordb {
            Some(f) => f.clone(),
            None => {
                return Ok(
                    json!({"content": [{"type": "text", "text": "No history (graph layer not configured)"}]}),
                )
            }
        };

        let facts = fdb
            .get_entity_history(&entity_name, group_id.as_deref(), limit)
            .await?;
        let text = format_facts(&facts, &format!("history of '{}'", entity_name));
        Ok(json!({"content": [{"type": "text", "text": text}]}))
    }

    pub(super) async fn graph_get_entity(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let entity_name = args["entity_name"]
            .as_str()
            .context("missing entity_name")?
            .to_string();
        let entity_type = args["entity_type"].as_str().map(|s| s.to_string());
        let group_id = args["group_id"].as_str().map(|s| s.to_string());

        let mut fdb = match &self.falkordb {
            Some(f) => f.clone(),
            None => {
                return Ok(
                    json!({"content": [{"type": "text", "text": "Entity not found (graph layer not configured)"}]}),
                )
            }
        };

        match fdb
            .get_entity(&entity_name, entity_type.as_deref(), group_id.as_deref())
            .await?
        {
            None => Ok(
                json!({"content": [{"type": "text", "text": format!("Entity '{}' not found", entity_name)}]}),
            ),
            Some(e) => Ok(json!({"content": [{"type": "text", "text":
                format!("Entity: {} ({})\nID: {}\nGroup: {}\nSummary: {}\nCreated: {}",
                    e.name, e.entity_type, e.id, e.group_id,
                    e.summary.as_deref().unwrap_or("-"),
                    e.created_at)}]})),
        }
    }
}
