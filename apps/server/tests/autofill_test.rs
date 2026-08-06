//! Integration tests for ai.autofill.
//! Requires the full stack running: docker compose --profile api up -d
//! Run with: cargo test autofill -- --test-threads=1 --ignored

#[cfg(test)]
mod autofill {
    const BASE: &str = "http://localhost:18080";

    async fn post(body: serde_json::Value, token: Option<&str>) -> reqwest::Response {
        let client = reqwest::Client::new();
        let mut req = client.post(format!("{BASE}/mcp")).json(&body);
        if let Some(t) = token {
            req = req.header("authorization", format!("Bearer {t}"));
        }
        req.send().await.expect("request failed")
    }

    fn api_token() -> String {
        std::env::var("OPENMEMORY_API_TOKEN")
            .expect("set OPENMEMORY_API_TOKEN to run autofill integration tests")
    }

    #[tokio::test]
    #[ignore]
    async fn test_unauthorized_without_bearer_returns_401() {
        let resp = post(
            serde_json::json!({"type": "ai.autofill", "kind": "memory", "content": "x"}),
            None,
        )
        .await;
        assert_eq!(resp.status(), 401, "expected 401 without Authorization header");
    }

    #[tokio::test]
    #[ignore]
    async fn test_unknown_kind_returns_400() {
        let token = api_token();
        let resp = post(
            serde_json::json!({"type": "ai.autofill", "kind": "bogus", "content": "x"}),
            Some(&token),
        )
        .await;
        assert_eq!(resp.status(), 400, "expected 400 for an unknown kind");
    }

    #[tokio::test]
    #[ignore]
    async fn test_happy_path_each_kind_returns_only_own_fields() {
        let token = api_token();

        let mem = post(
            serde_json::json!({
                "type": "ai.autofill",
                "kind": "memory",
                "content": "Met with the platform team today to discuss the Q3 migration plan. This is a high-priority initiative that affects billing."
            }),
            Some(&token),
        )
        .await;
        assert_eq!(mem.status(), 200, "memory autofill should succeed when LLM is configured");
        let mem_body: serde_json::Value = mem.json().await.expect("json");
        let mem_sugg = &mem_body["suggestion"];
        assert!(mem_sugg.get("description").is_none(), "memory suggestion must not include description: {mem_sugg}");
        assert!(mem_sugg.get("labels").is_none(), "memory suggestion must not include labels: {mem_sugg}");
        assert!(mem_sugg.get("priority").is_none(), "memory suggestion must not include priority: {mem_sugg}");

        let task = post(
            serde_json::json!({
                "type": "ai.autofill",
                "kind": "task",
                "content": "Fix the login button not responding on mobile Safari"
            }),
            Some(&token),
        )
        .await;
        assert_eq!(task.status(), 200, "task autofill should succeed when LLM is configured");
        let task_body: serde_json::Value = task.json().await.expect("json");
        let task_sugg = &task_body["suggestion"];
        assert!(task_sugg.get("summary").is_none(), "task suggestion must not include summary: {task_sugg}");
        assert!(task_sugg.get("tags").is_none(), "task suggestion must not include tags: {task_sugg}");
        assert!(task_sugg.get("importance").is_none(), "task suggestion must not include importance: {task_sugg}");

        let resource = post(
            serde_json::json!({
                "type": "ai.autofill",
                "kind": "resource",
                "content": "name: Staging DB, location: postgres://staging.internal:5432/app"
            }),
            Some(&token),
        )
        .await;
        assert_eq!(resource.status(), 200, "resource autofill should succeed when LLM is configured");
        let resource_body: serde_json::Value = resource.json().await.expect("json");
        let resource_sugg = &resource_body["suggestion"];
        assert!(resource_sugg.get("summary").is_none(), "resource suggestion must not include summary: {resource_sugg}");
        assert!(resource_sugg.get("labels").is_none(), "resource suggestion must not include labels: {resource_sugg}");
        assert!(resource_sugg.get("importance").is_none(), "resource suggestion must not include importance: {resource_sugg}");
        assert!(resource_sugg.get("priority").is_none(), "resource suggestion must not include priority: {resource_sugg}");
    }
}
