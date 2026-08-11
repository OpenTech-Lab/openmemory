use super::*;

impl McpServer {
    pub(super) async fn workflow_list(
        &mut self,
        _args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let items = workflows::list(&self.db).await?;
        let summaries: Vec<serde_json::Value> = items
            .into_iter()
            .map(|workflow| {
                json!({
                    "id": workflow.id,
                    "name": workflow.name,
                    "description": workflow.description,
                    "input_schema": workflow.input_schema,
                    "enabled": workflow.enabled,
                    "step_count": workflow.steps.as_array().map(|steps| steps.len()).unwrap_or(0),
                    "updated_at": workflow.updated_at,
                })
            })
            .collect();
        Ok(
            json!({"content": [{"type": "text", "text": serde_json::to_string_pretty(&summaries)?}]}),
        )
    }

    pub(super) async fn workflow_get(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let id_or_name = args["id_or_name"].as_str().context("missing id_or_name")?;
        let workflow = workflows::get(&self.db, id_or_name).await?;
        Ok(json!({"content": [{"type": "text", "text": serde_json::to_string_pretty(&workflow)?}]}))
    }

    pub(super) async fn workflow_run(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let id_or_name = args["id_or_name"].as_str().context("missing id_or_name")?;
        let input = args.get("input").cloned().unwrap_or_else(|| json!({}));
        let result = workflows::run(&self.db, &self.encryption_key, id_or_name, input).await?;
        Ok(json!({
            "content": [{"type": "text", "text": serde_json::to_string_pretty(&result)?}],
            "isError": result.status == "failed",
        }))
    }

    pub(super) async fn workflow_continue(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let run_id = Uuid::parse_str(args["run_id"].as_str().context("missing run_id")?)?;
        let action_result = args.get("result").cloned().context("missing result")?;
        let result =
            workflows::continue_run(&self.db, &self.encryption_key, run_id, action_result).await?;
        Ok(json!({
            "content": [{"type": "text", "text": serde_json::to_string_pretty(&result)?}],
            "isError": result.status == "failed",
        }))
    }
}
