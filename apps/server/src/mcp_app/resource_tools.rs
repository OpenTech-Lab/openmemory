use super::*;

impl McpServer {
    pub(super) async fn resource_list(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let kind = args["kind"].as_str();
        let tags: Option<Vec<String>> = args["tags"].as_array().map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        });
        let query = args["query"].as_str();
        let (resources, warnings) =
            resources::list_resources(&self.db, &self.encryption_key, kind, tags.as_deref(), query)
                .await?;
        let text = resources::format_list_text(&resources, &warnings);
        Ok(json!({ "content": [{ "type": "text", "text": text }] }))
    }

    pub(super) async fn resource_tags(
        &mut self,
        _args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let tags = resources::list_distinct_tags(&self.db).await?;
        let text = if tags.is_empty() {
            "No tags in use yet.".to_string()
        } else {
            let mut lines = vec![format!("Tags ({}):", tags.len())];
            for (tag, count) in &tags {
                lines.push(format!("• {} ({})", tag, count));
            }
            lines.join("\n")
        };
        Ok(json!({ "content": [{ "type": "text", "text": text }] }))
    }

    pub(super) async fn resource_get(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let id_or_name = args["id_or_name"].as_str().context("missing id_or_name")?;
        match resources::get_resource(&self.db, &self.encryption_key, id_or_name).await? {
            None => anyhow::bail!("Resource '{}' not found", id_or_name),
            Some(r) => {
                let text = serde_json::to_string_pretty(&r)?;
                Ok(json!({ "content": [{ "type": "text", "text": text }] }))
            }
        }
    }

    pub(super) async fn resource_add(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let name = args["name"].as_str().context("missing name")?;
        let kind = args["kind"].as_str().context("missing kind")?;
        let location = args["location"].as_str().context("missing location")?;
        let description = args["description"].as_str();
        let tags: Vec<String> = args["tags"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();
        let env_param_keys: Vec<String> = args["env_param_keys"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();

        let (id, warning) = resources::add_resource(
            &self.db,
            name,
            kind,
            location,
            description,
            &tags,
            &env_param_keys,
        )
        .await?;

        let mut text = format!(
            "Added resource '{}' ({}) → {} [{}]",
            name, kind, location, id
        );
        if let Some(w) = warning {
            text.push_str(&format!("\n{}", w));
        }
        Ok(json!({ "content": [{ "type": "text", "text": text }] }))
    }

    pub(super) async fn resource_update(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let id_str = args["id"].as_str().context("missing id")?;
        let id = Uuid::parse_str(id_str).context("invalid resource id")?;
        let name = args["name"].as_str();
        let kind = args["kind"].as_str();
        let location = args["location"].as_str();
        let tags: Option<Vec<String>> = args.get("tags").and_then(|v| {
            v.as_array().map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                    .collect()
            })
        });

        let description: Option<Option<&str>> = if args["clear_description"].as_bool() == Some(true)
        {
            Some(None)
        } else if args.get("description").and_then(|v| v.as_str()).is_some() {
            Some(args["description"].as_str())
        } else {
            None
        };

        let env_param_keys: Option<Vec<String>> = args.get("env_param_keys").and_then(|v| {
            v.as_array().map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                    .collect()
            })
        });

        let warning = resources::update_resource(
            &self.db,
            id,
            name,
            kind,
            location,
            description,
            tags.as_deref(),
            env_param_keys.as_deref(),
        )
        .await?;

        let mut text = format!("Updated resource {}", id);
        if let Some(w) = warning {
            text.push_str(&format!("\n{}", w));
        }
        Ok(json!({ "content": [{ "type": "text", "text": text }] }))
    }

    pub(super) async fn resource_delete(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let id_str = args["id"].as_str().context("missing id")?;
        let id = Uuid::parse_str(id_str).context("invalid resource id")?;
        resources::delete_resource(&self.db, id).await?;
        Ok(json!({
            "content": [{
                "type": "text",
                "text": format!("Deleted resource {}", id)
            }]
        }))
    }
}
