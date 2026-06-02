//! Integration tests for the temporal knowledge graph.
//! Requires the full stack running: docker compose --profile api up -d
//! Run with: cargo test graph_temporal -- --test-threads=1 --ignored

#[cfg(test)]
mod graph_temporal {
    const BASE: &str = "http://localhost:8080";

    async fn post(body: serde_json::Value) -> serde_json::Value {
        let client = reqwest::Client::new();
        client
            .post(format!("{BASE}/mcp"))
            .json(&body)
            .send()
            .await
            .expect("request failed")
            .json()
            .await
            .expect("json parse failed")
    }

    #[tokio::test]
    #[ignore]
    async fn test_add_episode_returns_id() {
        let resp = post(serde_json::json!({
            "type": "graph.add_episode",
            "name": "test-episode-1",
            "source": "message",
            "source_description": "integration test",
            "content": "Alice was promoted to Engineering Manager on 2026-01-01",
            "group_id": "integration_test",
            "valid_at": "2026-01-01T00:00:00Z"
        }))
        .await;
        assert_eq!(resp["type"], "graph.add_episode.result", "unexpected response: {resp}");
        assert!(resp["id"].as_str().is_some(), "missing id in response: {resp}");
    }

    #[tokio::test]
    #[ignore]
    async fn test_add_entity_deduplication() {
        // Use a unique name per run so the first call always creates fresh,
        // even when the graph DB is persistent across test runs.
        use std::time::{SystemTime, UNIX_EPOCH};
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .subsec_nanos();
        let unique_name = format!("Alice_dedup_{ts}");

        // First add
        let r1 = post(serde_json::json!({
            "type": "graph.add_entity",
            "name": unique_name,
            "entity_type": "Person",
            "group_id": "integration_test"
        }))
        .await;
        assert_eq!(r1["type"], "graph.add_entity.result", "{r1}");
        assert_eq!(r1["created"], true, "first call should create: {r1}");

        // Second add — same name+type+group — must return same ID, created=false
        let r2 = post(serde_json::json!({
            "type": "graph.add_entity",
            "name": unique_name,
            "entity_type": "Person",
            "group_id": "integration_test"
        }))
        .await;
        assert_eq!(r2["type"], "graph.add_entity.result", "{r2}");
        assert_eq!(r2["created"], false, "second call must not create duplicate: {r2}");
        assert_eq!(r1["id"], r2["id"], "IDs must match on dedup: r1={r1} r2={r2}");
    }

    #[tokio::test]
    #[ignore]
    async fn test_add_fact_and_time_travel() {
        // Use unique entity names so this test is independent of run order
        post(serde_json::json!({"type":"graph.add_entity","name":"Alice_tt2","entity_type":"Person","group_id":"integration_test"})).await;
        post(serde_json::json!({"type":"graph.add_entity","name":"SeniorEng2","entity_type":"Role","group_id":"integration_test"})).await;

        // Fact 1: Alice_tt2 holds SeniorEng2 from 2025-01-01
        let f1 = post(serde_json::json!({
            "type": "graph.add_fact",
            "subject": "Alice_tt2", "subject_type": "Person",
            "object": "SeniorEng2", "object_type": "Role",
            "name": "holds_role",
            "fact": "Alice_tt2 holds the Senior Engineer role",
            "group_id": "integration_test",
            "valid_at": "2025-01-01T00:00:00Z"
        }))
        .await;
        assert_eq!(f1["type"], "graph.add_fact.result", "{f1}");

        // Fact 2: On the SAME subject-object pair, update the fact from 2026-06-01,
        // invalidating the prior fact. invalidate_previous applies to the same
        // (subject, object, fact_name) triple — the server scopes invalidation to the
        // exact edge, not across different objects.
        let f2 = post(serde_json::json!({
            "type": "graph.add_fact",
            "subject": "Alice_tt2", "subject_type": "Person",
            "object": "SeniorEng2", "object_type": "Role",
            "name": "holds_role",
            "fact": "Alice_tt2 holds the updated Senior Engineer role",
            "group_id": "integration_test",
            "valid_at": "2026-06-01T00:00:00Z",
            "invalidate_previous": true
        }))
        .await;
        assert_eq!(f2["type"], "graph.add_fact.result", "{f2}");
        assert!(f2["invalidated_count"].as_u64().unwrap_or(0) >= 1,
            "expected at least 1 invalidation: {f2}");

        // Time-travel: query at 2025-07-01 — fact 1 should be visible (valid_at<=ts, no invalid_at yet)
        let qt = post(serde_json::json!({
            "type": "graph.query_at",
            "timestamp": "2025-07-01T00:00:00Z",
            "entity_name": "Alice_tt2",
            "group_id": "integration_test"
        }))
        .await;
        assert_eq!(qt["type"], "graph.query_at.result", "{qt}");
        let facts = qt["facts"].as_array().expect("facts array missing");
        assert!(!facts.is_empty(), "should find fact at 2025-07-01: {qt}");
        let objects: Vec<&str> = facts.iter()
            .filter_map(|f| f["object_name"].as_str())
            .collect();
        assert!(objects.contains(&"SeniorEng2"),
            "expected SeniorEng2 at 2025-07-01, got: {objects:?}");

        // Time-travel: query at 2026-07-01 — should see the updated fact only
        let qt2 = post(serde_json::json!({
            "type": "graph.query_at",
            "timestamp": "2026-07-01T00:00:00Z",
            "entity_name": "Alice_tt2",
            "group_id": "integration_test"
        }))
        .await;
        assert_eq!(qt2["type"], "graph.query_at.result", "{qt2}");
        let facts2 = qt2["facts"].as_array().expect("facts array missing in qt2");
        assert!(!facts2.is_empty(), "should find fact at 2026-07-01: {qt2}");
        // The updated fact (valid from 2026-06-01) should be visible
        let current_facts: Vec<&str> = facts2.iter()
            .filter_map(|f| f["fact"].as_str())
            .collect();
        assert!(current_facts.iter().any(|f| f.contains("updated")),
            "expected updated fact at 2026-07-01, got: {current_facts:?}");
    }

    #[tokio::test]
    #[ignore]
    async fn test_entity_history_shows_all_facts() {
        // Reuses entities/facts written by test_add_fact_and_time_travel if run in sequence,
        // but creates its own to be independent
        post(serde_json::json!({"type":"graph.add_entity","name":"Bob_hist","entity_type":"Person","group_id":"integration_test"})).await;
        post(serde_json::json!({"type":"graph.add_entity","name":"ProjectX","entity_type":"Project","group_id":"integration_test"})).await;

        post(serde_json::json!({
            "type": "graph.add_fact",
            "subject": "Bob_hist", "subject_type": "Person",
            "object": "ProjectX", "object_type": "Project",
            "name": "works_on",
            "fact": "Bob_hist works on ProjectX",
            "group_id": "integration_test",
            "valid_at": "2026-01-01T00:00:00Z"
        })).await;

        let hist = post(serde_json::json!({
            "type": "graph.get_entity_history",
            "entity_name": "Bob_hist",
            "group_id": "integration_test",
            "limit": 10
        }))
        .await;
        assert_eq!(hist["type"], "graph.get_entity_history.result", "{hist}");
        let facts = hist["facts"].as_array().expect("facts missing");
        assert!(!facts.is_empty(), "history should not be empty: {hist}");
    }

    #[tokio::test]
    #[ignore]
    async fn test_query_facts_keyword_search() {
        post(serde_json::json!({"type":"graph.add_entity","name":"Carol_qs","entity_type":"Person","group_id":"integration_test"})).await;
        post(serde_json::json!({"type":"graph.add_entity","name":"DatabaseTeam","entity_type":"Team","group_id":"integration_test"})).await;

        post(serde_json::json!({
            "type": "graph.add_fact",
            "subject": "Carol_qs", "subject_type": "Person",
            "object": "DatabaseTeam", "object_type": "Team",
            "name": "member_of",
            "fact": "Carol_qs is a member of the DatabaseTeam",
            "group_id": "integration_test",
            "valid_at": "2026-01-01T00:00:00Z"
        })).await;

        let qf = post(serde_json::json!({
            "type": "graph.query_facts",
            "query": "DatabaseTeam",
            "group_id": "integration_test",
            "valid_only": true
        }))
        .await;
        assert_eq!(qf["type"], "graph.query_facts.result", "{qf}");
        let facts = qf["facts"].as_array().expect("facts missing");
        assert!(!facts.is_empty(), "should find DatabaseTeam fact: {qf}");
    }
}
