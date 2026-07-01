//! Integration tests for hybrid (BM25 + graph) memory_search.
//! Requires the full stack running: docker compose --profile api up -d
//! Run with: cargo test memory_search_graph -- --test-threads=1 --ignored

#[cfg(test)]
mod memory_search_graph {
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    const BASE: &str = "http://localhost:18080";

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

    fn unique(prefix: &str) -> String {
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .subsec_nanos();
        format!("{prefix}_{ts}")
    }

    async fn save_memory(content: &str, tag: &str) -> String {
        let resp = post(serde_json::json!({
            "type": "memory.save",
            "content": content,
            "tags": [tag]
        }))
        .await;
        resp["id"].as_str().expect("missing id").to_string()
    }

    #[tokio::test]
    #[ignore]
    async fn test_graph_recall_surfaces_untextually_matching_neighbor() {
        let tag = unique("gr_tag");
        let needle = unique("xylophone_zephyr");

        // A matches the search query in text; B only shares a tag with A (no text overlap).
        save_memory(&format!("Notes about {needle} and quarterly planning"), &tag).await;
        let id_b = save_memory("Completely unrelated content about lighthouse maintenance", &tag).await;

        // Let the async FalkorDB write (save_node) and OpenSearch refresh settle.
        tokio::time::sleep(Duration::from_millis(1500)).await;

        let resp = post(serde_json::json!({
            "type": "memory.search",
            "query": needle,
            "limit": 10
        }))
        .await;
        assert_eq!(resp["type"], "memory.search.result", "{resp}");
        let results = resp["results"].as_array().expect("results missing");

        let b_hit = results.iter().find(|r| r["id"].as_str() == Some(id_b.as_str()));
        assert!(
            b_hit.is_some(),
            "expected graph-linked memory B to be recalled even without a text match: {resp}"
        );
        assert_eq!(
            b_hit.unwrap()["via_graph"], true,
            "memory B should be flagged as recalled via the graph: {resp}"
        );
    }

    #[tokio::test]
    #[ignore]
    async fn test_proximity_boost_ranks_connected_hits_higher() {
        let tag = unique("pb_tag");
        let shared_term = unique("marmoset_glacier");

        // Both memories match the query text and share a tag (graph-connected).
        // A third, isolated memory also matches the text but shares no tag with anything.
        let id_connected_a = save_memory(&format!("{shared_term} report one"), &tag).await;
        let id_connected_b = save_memory(&format!("{shared_term} report two"), &tag).await;
        let isolated_tag = unique("pb_isolated_tag");
        let id_isolated = save_memory(&format!("{shared_term} report three"), &isolated_tag).await;

        tokio::time::sleep(Duration::from_millis(1500)).await;

        let resp = post(serde_json::json!({
            "type": "memory.search",
            "query": shared_term,
            "limit": 10
        }))
        .await;
        assert_eq!(resp["type"], "memory.search.result", "{resp}");
        let results = resp["results"].as_array().expect("results missing");

        let score_of = |id: &str| -> f64 {
            results
                .iter()
                .find(|r| r["id"].as_str() == Some(id))
                .and_then(|r| r["score"].as_f64())
                .unwrap_or_else(|| panic!("memory {id} missing from results: {results:?}"))
        };

        let connected_score = score_of(&id_connected_a).max(score_of(&id_connected_b));
        let isolated_score = score_of(&id_isolated);
        assert!(
            connected_score > isolated_score,
            "graph-connected hits should outrank an isolated hit with equal base score: connected={connected_score} isolated={isolated_score}"
        );
    }

    #[tokio::test]
    #[ignore]
    async fn test_graph_view_mermaid_omitted_unless_requested() {
        let tag = unique("gv_tag");
        let term = unique("kestrel_tundra");
        save_memory(&format!("{term} alpha"), &tag).await;
        save_memory(&format!("{term} beta"), &tag).await;
        tokio::time::sleep(Duration::from_millis(1500)).await;

        let default_resp = post(serde_json::json!({
            "type": "memory.search",
            "query": term,
            "limit": 10
        }))
        .await;
        assert!(
            default_resp.get("graph_view").is_none(),
            "graph_view should be omitted when not requested: {default_resp}"
        );

        let with_view = post(serde_json::json!({
            "type": "memory.search",
            "query": term,
            "limit": 10,
            "include_graph_view": true
        }))
        .await;
        let view = with_view["graph_view"].as_str().expect("graph_view missing when requested");
        assert!(view.starts_with("graph TD"), "expected a mermaid graph TD block: {view}");
        assert!(view.contains("---"), "expected an edge between the two tagged memories: {view}");
    }

    #[tokio::test]
    #[ignore]
    async fn test_related_facts_surfaced_in_search() {
        let subject = unique("Dana_facts");
        let object = unique("PlatformTeam");

        post(serde_json::json!({"type":"graph.add_entity","name":subject,"entity_type":"Person","group_id":"integration_test"})).await;
        post(serde_json::json!({"type":"graph.add_entity","name":object,"entity_type":"Team","group_id":"integration_test"})).await;
        post(serde_json::json!({
            "type": "graph.add_fact",
            "subject": subject, "subject_type": "Person",
            "object": object, "object_type": "Team",
            "name": "member_of",
            "fact": format!("{subject} is a member of the {object}"),
            "group_id": "integration_test",
            "valid_at": "2026-01-01T00:00:00Z"
        })).await;

        let resp = post(serde_json::json!({
            "type": "memory.search",
            "query": object,
            "limit": 5
        }))
        .await;
        assert_eq!(resp["type"], "memory.search.result", "{resp}");
        let facts = resp["related_facts"].as_array().expect("related_facts missing");
        assert!(
            facts.iter().any(|f| f["object_name"].as_str() == Some(object.as_str())),
            "expected related_facts to include the {object} fact: {resp}"
        );
    }
}
