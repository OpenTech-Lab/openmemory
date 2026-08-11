use super::helpers::{mermaid_escape, mermaid_id};
use super::*;

#[cfg(test)]
mod mermaid_tests {
    use super::*;

    fn result(id: Uuid, content: &str, summary: Option<&str>) -> SearchResult {
        SearchResult {
            id,
            content: content.to_string(),
            summary: summary.map(|s| s.to_string()),
            tags: vec![],
            importance_score: 0.5,
            created_at: Utc::now(),
            score: 0.5,
            via_graph: false,
        }
    }

    #[test]
    fn mermaid_escape_truncates_and_strips_special_chars() {
        let input = "a\"b[c]{d}|e\nf".to_string() + &"x".repeat(100);
        let escaped = mermaid_escape(&input);
        assert!(escaped.len() <= 60);
        assert!(!escaped.contains(['"', '[', ']', '{', '}', '|', '\n']));
    }

    #[test]
    fn mermaid_id_replaces_non_alphanumeric() {
        assert_eq!(mermaid_id("Alice O'Brien"), "Alice_O_Brien");
        assert_eq!(mermaid_id(""), "unknown");
    }

    #[test]
    fn build_mermaid_renders_nodes_and_edges() {
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let results = vec![
            result(a, "content A", Some("summary A")),
            result(b, "content B", None),
        ];
        let edges = vec![(a, b, "RELATED_TO".to_string())];
        let facts = vec![];

        let mermaid = build_mermaid(&results, &edges, &facts);

        assert!(mermaid.starts_with("graph TD\n"));
        assert!(mermaid.contains("summary A"));
        assert!(mermaid.contains("content B")); // falls back to content when summary is None
        assert!(mermaid.contains("---|RELATED_TO|"));
    }

    #[test]
    fn build_mermaid_includes_fact_edges_and_dedupes_entities() {
        let results = vec![];
        let edges = vec![];
        let facts = vec![
            falkordb::FactResult {
                fact_id: "f1".to_string(),
                subject_name: "Alice".to_string(),
                subject_type: "Person".to_string(),
                relationship: "member_of".to_string(),
                fact: "Alice is a member of Team".to_string(),
                object_name: "Team".to_string(),
                object_type: "Team".to_string(),
                valid_at: "2026-01-01T00:00:00Z".to_string(),
                invalid_at: None,
                episode_id: None,
                is_current: true,
            },
            falkordb::FactResult {
                fact_id: "f2".to_string(),
                subject_name: "Alice".to_string(),
                subject_type: "Person".to_string(),
                relationship: "leads".to_string(),
                fact: "Alice leads Team".to_string(),
                object_name: "Team".to_string(),
                object_type: "Team".to_string(),
                valid_at: "2026-01-01T00:00:00Z".to_string(),
                invalid_at: None,
                episode_id: None,
                is_current: true,
            },
        ];

        let mermaid = build_mermaid(&results, &edges, &facts);

        // Entity node lines should appear exactly once each despite two facts sharing them.
        assert_eq!(mermaid.matches("E_Alice[\"Alice\"]").count(), 1);
        assert_eq!(mermaid.matches("E_Team[\"Team\"]").count(), 1);
        assert!(mermaid.contains("-->|member_of|"));
        assert!(mermaid.contains("-->|leads|"));
    }
}
