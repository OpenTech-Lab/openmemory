use super::*;

impl McpServer {
    pub(super) async fn library_add(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let project_id: Option<Uuid> = match args["project_id"].as_str() {
            Some(s) => Some(s.parse().context("invalid project_id UUID")?),
            None => None,
        };
        let label = args["label"].as_str().context("missing label")?;
        let kind = args["kind"].as_str().context("missing kind")?;
        let category = args["category"].as_str().context("missing category")?;
        let location = args["location"].as_str();
        let code = args["code"].as_str();
        let description = args["description"].as_str();
        let tags: Vec<String> = args["tags"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();

        let (id, warning) = library::add_entry(
            &self.db, project_id, label, kind, category, location, code, description, &tags,
        )
        .await?;

        let where_ = location.unwrap_or("<inline code>");
        let mut text = format!("Added library entry '{}' ({}/{}) → {} [{}]", label, kind, category, where_, id);
        if let Some(w) = warning {
            text.push_str(&format!("\n{}", w));
        }
        Ok(json!({ "content": [{ "type": "text", "text": text }] }))
    }

    pub(super) async fn library_list(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let project_id: Option<Uuid> = match args["project_id"].as_str() {
            Some(s) => Some(s.parse().context("invalid project_id UUID")?),
            None => None,
        };
        let tag = args["tag"].as_str();
        let category = args["category"].as_str();
        let entries = library::list_entries(&self.db, project_id, tag, category).await?;
        let text = library::format_list_text(&entries);
        Ok(json!({ "content": [{ "type": "text", "text": text }] }))
    }

    pub(super) async fn library_get(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let id_str = args["id"].as_str().context("missing id")?;
        let id = Uuid::parse_str(id_str).context("invalid library entry id")?;
        match library::get_entry(&self.db, id).await? {
            None => anyhow::bail!("Library entry '{}' not found", id),
            Some(e) => {
                let text = serde_json::to_string_pretty(&e)?;
                Ok(json!({ "content": [{ "type": "text", "text": text }] }))
            }
        }
    }

    pub(super) async fn library_delete(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let id_str = args["id"].as_str().context("missing id")?;
        let id = Uuid::parse_str(id_str).context("invalid library entry id")?;
        library::delete_entry(&self.db, id).await?;
        Ok(json!({
            "content": [{
                "type": "text",
                "text": format!("Deleted library entry {}", id)
            }]
        }))
    }
}
