use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use std::collections::{HashMap, HashSet, VecDeque};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Structs
// ---------------------------------------------------------------------------

/// Lightweight row used for list queries (omits graph_data blob).
#[derive(Debug, Serialize, Deserialize, FromRow)]
pub struct ProjectGraphRow {
    pub id: Uuid,
    pub name: String,
    pub path: Option<String>,
    pub canonical_path: Option<String>,
    pub description: Option<String>,
    pub node_count: i32,
    pub edge_count: i32,
    pub graph_hash: Option<String>,
    pub graph_file_size: Option<i64>,
    pub imported_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// A single node in a knowledge graph.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphNode {
    pub id: String,
    pub label: String,
    pub file_type: Option<String>,
    pub community: Option<i64>,
    pub source_file: Option<String>,
    pub source_location: Option<String>,
    /// Commit author name — only present on `file_type: "commit"` nodes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    /// Commit author date (ISO 8601) — only present on `file_type: "commit"` nodes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
}

/// A directed edge between two nodes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphEdge {
    pub source: String,
    pub target: String,
    pub relation: String,
    pub weight: Option<f64>,
}

/// Response returned by a BFS keyword query.
#[derive(Debug, Serialize, Deserialize)]
pub struct GraphQueryResponse {
    pub query: String,
    pub seed_nodes: Vec<String>,
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub hops: u8,
    pub truncated: bool,
}

// ---------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------

/// Validate that `path` exists and is a directory, then return its canonical form.
pub async fn canonicalize_project_path(path: &str) -> Result<String> {
    let canonical = tokio::fs::canonicalize(path).await
        .with_context(|| format!("Path does not exist or is not accessible: {path}"))?;
    if !canonical.is_dir() {
        anyhow::bail!("Path is not a directory: {}", canonical.display());
    }
    Ok(canonical.to_string_lossy().to_string())
}

/// Count nodes and edges in a NetworkX node-link JSON object.
pub fn count_nodes_edges(data: &serde_json::Value) -> (i32, i32) {
    let nodes = data["nodes"].as_array().map(|a| a.len()).unwrap_or(0) as i32;
    // Primary key is "links"; fall back to "edges"
    let edges = data["links"]
        .as_array()
        .or_else(|| data["edges"].as_array())
        .map(|a| a.len())
        .unwrap_or(0) as i32;
    (nodes, edges)
}

/// Build an undirected adjacency map: node_id → [(neighbor_id, edge_value)].
pub fn build_adjacency(
    data: &serde_json::Value,
) -> HashMap<String, Vec<(String, serde_json::Value)>> {
    let mut adj: HashMap<String, Vec<(String, serde_json::Value)>> = HashMap::new();

    let links = data["links"]
        .as_array()
        .or_else(|| data["edges"].as_array());

    if let Some(edges) = links {
        for edge in edges {
            let src = match edge["source"].as_str() {
                Some(s) => s.to_owned(),
                None => continue,
            };
            let tgt = match edge["target"].as_str() {
                Some(s) => s.to_owned(),
                None => continue,
            };

            adj.entry(src.clone())
                .or_default()
                .push((tgt.clone(), edge.clone()));
            adj.entry(tgt).or_default().push((src, edge.clone()));
        }
    }

    adj
}

/// IDF-weighted BFS search over a graph.
pub fn bfs_query(
    data: &serde_json::Value,
    keyword: &str,
    hops: u8,
    limit: usize,
) -> GraphQueryResponse {
    let empty_vec = vec![];
    let nodes_arr = data["nodes"].as_array().unwrap_or(&empty_vec);
    let total_nodes = nodes_arr.len();

    // ── 1. Collect node labels ────────────────────────────────────────────
    let node_labels: Vec<(String, String)> = nodes_arr
        .iter()
        .filter_map(|n| {
            let id = n["id"].as_str()?.to_owned();
            let label = n["label"].as_str().unwrap_or("").to_lowercase();
            Some((id, label))
        })
        .collect();

    // ── 2. Compute IDF ────────────────────────────────────────────────────
    let kw_lower = keyword.to_lowercase();
    let tokens: Vec<&str> = kw_lower.split_whitespace().collect();

    let mut word_doc_count: HashMap<&str, usize> = HashMap::new();
    for token in &tokens {
        let count = node_labels
            .iter()
            .filter(|(_, lbl)| lbl.contains(*token))
            .count();
        word_doc_count.insert(token, count);
    }

    let idf = |token: &&str| -> f64 {
        let count = *word_doc_count.get(token).unwrap_or(&0);
        if count == 0 || total_nodes == 0 {
            return 0.0;
        }
        let ratio = count as f64 / total_nodes as f64;
        let raw = (total_nodes as f64 / count as f64).ln();
        // Stop-word penalty: >20% of nodes contain this term
        if ratio > 0.20 { raw * 0.1 } else { raw }
    };

    // ── 3. Score nodes ────────────────────────────────────────────────────
    let mut scored: Vec<(f64, String)> = node_labels
        .iter()
        .filter_map(|(id, lbl)| {
            let score: f64 = tokens
                .iter()
                .filter(|t| lbl.contains(**t))
                .map(|t| idf(&t))
                .sum();
            if score > 0.0 {
                Some((score, id.clone()))
            } else {
                None
            }
        })
        .collect();

    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));

    // ── 4. Pick up to 5 seeds ─────────────────────────────────────────────
    let adj = build_adjacency(data);

    let candidates: Vec<String> = scored
        .iter()
        .take(10) // consider top-10 before hub filtering
        .map(|(_, id)| id.clone())
        .collect();

    // ── 5. Hub avoidance ─────────────────────────────────────────────────
    let seed_nodes: Vec<String> = {
        let degrees: Vec<(usize, &String)> = candidates
            .iter()
            .map(|id| (adj.get(id).map(|v| v.len()).unwrap_or(0), id))
            .collect();

        let has_low_degree = degrees.iter().any(|(deg, _)| *deg <= 50);

        let mut seeds = Vec::new();
        for (deg, id) in &degrees {
            if seeds.len() >= 5 {
                break;
            }
            // Skip hubs when lower-degree alternatives exist
            if *deg > 50 && has_low_degree {
                continue;
            }
            seeds.push((*id).clone());
        }

        // Fallback: if all were hubs, just take the top matches
        if seeds.is_empty() {
            candidates.into_iter().take(5).collect()
        } else {
            seeds
        }
    };

    // ── 6. BFS ────────────────────────────────────────────────────────────
    let mut visited: HashSet<String> = HashSet::new();
    let mut queue: VecDeque<(String, u8)> = VecDeque::new();
    let mut truncated = false;

    for seed in &seed_nodes {
        if !visited.contains(seed) {
            visited.insert(seed.clone());
            queue.push_back((seed.clone(), 0));
        }
    }

    while let Some((node_id, depth)) = queue.pop_front() {
        if depth >= hops {
            continue;
        }
        if let Some(neighbors) = adj.get(&node_id) {
            for (neighbor, _) in neighbors {
                if !visited.contains(neighbor) {
                    if visited.len() >= limit {
                        truncated = true;
                        break;
                    }
                    visited.insert(neighbor.clone());
                    queue.push_back((neighbor.clone(), depth + 1));
                }
            }
        }
        if truncated {
            break;
        }
    }

    // ── 7. Collect edges ──────────────────────────────────────────────────
    let links = data["links"]
        .as_array()
        .or_else(|| data["edges"].as_array());

    let mut seen_edges: HashSet<(String, String)> = HashSet::new();
    let mut edges: Vec<GraphEdge> = Vec::new();

    if let Some(link_arr) = links {
        for e in link_arr {
            let src = match e["source"].as_str() {
                Some(s) => s.to_owned(),
                None => continue,
            };
            let tgt = match e["target"].as_str() {
                Some(s) => s.to_owned(),
                None => continue,
            };

            if visited.contains(&src) && visited.contains(&tgt) {
                // Canonical dedup key
                let key = if src <= tgt {
                    (src.clone(), tgt.clone())
                } else {
                    (tgt.clone(), src.clone())
                };
                if seen_edges.insert(key) {
                    edges.push(GraphEdge {
                        source: src,
                        target: tgt,
                        relation: e["relation"]
                            .as_str()
                            .unwrap_or("related")
                            .to_owned(),
                        weight: e["weight"].as_f64(),
                    });
                }
            }
        }
    }

    // ── 8. Build node list ────────────────────────────────────────────────
    let node_map: HashMap<&str, &serde_json::Value> = nodes_arr
        .iter()
        .filter_map(|n| n["id"].as_str().map(|id| (id, n)))
        .collect();

    let nodes: Vec<GraphNode> = visited
        .iter()
        .filter_map(|id| node_map.get(id.as_str()).map(|v| node_from_json(id, v)))
        .collect();

    GraphQueryResponse {
        query: keyword.to_string(),
        seed_nodes,
        nodes,
        edges,
        hops,
        truncated,
    }
}

/// Return the top `top_n` nodes by degree (most connected).
pub fn god_nodes(data: &serde_json::Value, top_n: usize) -> Vec<GraphNode> {
    let adj = build_adjacency(data);

    let empty_vec = vec![];
    let nodes_arr = data["nodes"].as_array().unwrap_or(&empty_vec);

    let node_map: HashMap<&str, &serde_json::Value> = nodes_arr
        .iter()
        .filter_map(|n| n["id"].as_str().map(|id| (id, n)))
        .collect();

    let mut degrees: Vec<(usize, &str)> = node_map
        .keys()
        .map(|id| {
            let deg = adj.get(*id).map(|v| v.len()).unwrap_or(0);
            (deg, *id)
        })
        .collect();

    degrees.sort_by(|a, b| b.0.cmp(&a.0));

    degrees
        .into_iter()
        .take(top_n)
        .filter_map(|(_, id)| node_map.get(id).map(|v| node_from_json(id, v)))
        .collect()
}

/// BFS shortest path between two node IDs. Returns None if unreachable.
pub fn shortest_path(
    data: &serde_json::Value,
    from_id: &str,
    to_id: &str,
) -> Option<Vec<GraphNode>> {
    let adj = build_adjacency(data);

    // Verify both nodes exist
    let empty_vec = vec![];
    let nodes_arr = data["nodes"].as_array().unwrap_or(&empty_vec);
    let node_map: HashMap<&str, &serde_json::Value> = nodes_arr
        .iter()
        .filter_map(|n| n["id"].as_str().map(|id| (id, n)))
        .collect();

    if !node_map.contains_key(from_id) || !node_map.contains_key(to_id) {
        return None;
    }

    if from_id == to_id {
        return node_map
            .get(from_id)
            .map(|v| vec![node_from_json(from_id, v)]);
    }

    // BFS with parent tracking
    let mut visited: HashSet<String> = HashSet::new();
    let mut parent: HashMap<String, String> = HashMap::new();
    let mut queue: VecDeque<String> = VecDeque::new();

    visited.insert(from_id.to_owned());
    queue.push_back(from_id.to_owned());

    while let Some(current) = queue.pop_front() {
        if let Some(neighbors) = adj.get(&current) {
            for (neighbor, _) in neighbors {
                if !visited.contains(neighbor) {
                    visited.insert(neighbor.clone());
                    parent.insert(neighbor.clone(), current.clone());

                    if neighbor == to_id {
                        // Reconstruct path
                        let mut path = vec![to_id.to_owned()];
                        let mut cur = to_id.to_owned();
                        while let Some(p) = parent.get(&cur) {
                            path.push(p.clone());
                            cur = p.clone();
                        }
                        path.reverse();

                        return Some(
                            path.iter()
                                .filter_map(|id| {
                                    node_map.get(id.as_str()).map(|v| node_from_json(id, v))
                                })
                                .collect(),
                        );
                    }

                    queue.push_back(neighbor.clone());
                }
            }
        }
    }

    None // No path found
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Strip ANSI escape codes, replace newlines with space, truncate to 512 chars.
fn sanitize_string(s: &str) -> String {
    // Remove ANSI escape sequences: ESC [ ... m
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == 0x1b && bytes.get(i + 1) == Some(&b'[') {
            // Skip until we find a letter terminator
            i += 2;
            while i < bytes.len() {
                let b = bytes[i];
                i += 1;
                if b.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            let ch = s[i..].chars().next().unwrap();
            if ch == '\n' || ch == '\r' {
                out.push(' ');
            } else {
                out.push(ch);
            }
            i += ch.len_utf8();
        }
    }

    // Truncate to 512 characters (Unicode-safe)
    out.chars().take(512).collect()
}

/// Build a `GraphNode` from a JSON value, sanitizing all string fields.
pub fn node_from_json(id: &str, node_val: &serde_json::Value) -> GraphNode {
    GraphNode {
        id: id.to_owned(),
        label: node_val["label"]
            .as_str()
            .map(sanitize_string)
            .unwrap_or_else(|| id.to_owned()),
        file_type: node_val["file_type"].as_str().map(sanitize_string),
        community: node_val["community"].as_i64(),
        source_file: node_val["source_file"].as_str().map(sanitize_string),
        source_location: node_val["source_location"].as_str().map(sanitize_string),
        author: node_val["author"].as_str().map(sanitize_string),
        date: node_val["date"].as_str().map(sanitize_string),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ── sanitize_string ───────────────────────────────────────────────────

    #[test]
    fn sanitize_strips_ansi_codes() {
        let input = "\x1b[31mRed text\x1b[0m";
        let result = sanitize_string(input);
        assert_eq!(result, "Red text");
    }

    #[test]
    fn sanitize_replaces_newlines() {
        let input = "line one\nline two\r\nline three";
        let result = sanitize_string(input);
        assert_eq!(result, "line one line two  line three");
    }

    #[test]
    fn sanitize_truncates_long_strings() {
        let long_input: String = "a".repeat(600);
        let result = sanitize_string(&long_input);
        assert_eq!(result.chars().count(), 512);
    }

    #[test]
    fn sanitize_short_string_unchanged() {
        let input = "hello world";
        let result = sanitize_string(input);
        assert_eq!(result, "hello world");
    }

    // ── count_nodes_edges ─────────────────────────────────────────────────

    #[test]
    fn count_nodes_edges_basic() {
        let data = json!({
            "nodes": [{"id": "a"}, {"id": "b"}],
            "links": [{"source": "a", "target": "b"}]
        });
        let (nodes, edges) = count_nodes_edges(&data);
        assert_eq!(nodes, 2);
        assert_eq!(edges, 1);
    }

    #[test]
    fn count_nodes_edges_uses_edges_fallback() {
        let data = json!({
            "nodes": [{"id": "a"}, {"id": "b"}, {"id": "c"}],
            "edges": [
                {"source": "a", "target": "b"},
                {"source": "b", "target": "c"}
            ]
        });
        let (nodes, edges) = count_nodes_edges(&data);
        assert_eq!(nodes, 3);
        assert_eq!(edges, 2);
    }

    #[test]
    fn count_nodes_edges_empty() {
        let data = json!({});
        let (nodes, edges) = count_nodes_edges(&data);
        assert_eq!(nodes, 0);
        assert_eq!(edges, 0);
    }

    // ── bfs_query ─────────────────────────────────────────────────────────

    #[test]
    fn bfs_query_finds_seed_and_neighbors() {
        // Graph: alpha -- beta -- gamma -- delta
        let data = json!({
            "nodes": [
                {"id": "alpha", "label": "alpha module"},
                {"id": "beta",  "label": "beta module"},
                {"id": "gamma", "label": "gamma module"},
                {"id": "delta", "label": "delta module"}
            ],
            "links": [
                {"source": "alpha", "target": "beta",  "relation": "imports"},
                {"source": "beta",  "target": "gamma", "relation": "imports"},
                {"source": "gamma", "target": "delta", "relation": "imports"}
            ]
        });

        // Search for "alpha" with 1 hop — should return alpha + beta
        let resp = bfs_query(&data, "alpha", 1, 50);
        assert!(resp.seed_nodes.contains(&"alpha".to_string()),
            "seed_nodes should contain alpha, got {:?}", resp.seed_nodes);
        let node_ids: Vec<&str> = resp.nodes.iter().map(|n| n.id.as_str()).collect();
        assert!(node_ids.contains(&"alpha"), "nodes should include alpha");
        assert!(node_ids.contains(&"beta"),  "nodes should include beta (1 hop away)");
    }

    #[test]
    fn bfs_query_no_match_returns_empty() {
        let data = json!({
            "nodes": [
                {"id": "foo", "label": "foo"},
                {"id": "bar", "label": "bar"}
            ],
            "links": [{"source": "foo", "target": "bar", "relation": "ref"}]
        });

        let resp = bfs_query(&data, "zzznomatch", 2, 50);
        assert!(resp.seed_nodes.is_empty(), "no seed nodes expected for unmatched keyword");
        assert!(resp.nodes.is_empty(), "no nodes expected for unmatched keyword");
    }

    #[test]
    fn bfs_query_multi_hop() {
        // Linear chain: a - b - c - d
        let data = json!({
            "nodes": [
                {"id": "a", "label": "alpha"},
                {"id": "b", "label": "bravo"},
                {"id": "c", "label": "charlie"},
                {"id": "d", "label": "delta"}
            ],
            "links": [
                {"source": "a", "target": "b", "relation": "r"},
                {"source": "b", "target": "c", "relation": "r"},
                {"source": "c", "target": "d", "relation": "r"}
            ]
        });

        // 2 hops from "alpha" should reach a, b, c but not d
        let resp = bfs_query(&data, "alpha", 2, 50);
        let node_ids: Vec<&str> = resp.nodes.iter().map(|n| n.id.as_str()).collect();
        assert!(node_ids.contains(&"a"), "should contain a");
        assert!(node_ids.contains(&"b"), "should contain b");
        assert!(node_ids.contains(&"c"), "should contain c");
        assert!(!node_ids.contains(&"d"), "should NOT contain d at 2 hops");
    }
}
