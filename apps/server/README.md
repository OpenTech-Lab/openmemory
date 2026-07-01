# openmemory-server

Minimal Rust (Axum) server that accepts MCP-style JSON requests at `POST /mcp`.

## Endpoints

- `GET /health`
- `POST /mcp`
  - `{"type":"memory.save", ...}`
  - `{"type":"memory.search", ...}` — hybrid retrieval: BM25 text search boosted/expanded via the FalkorDB
    knowledge graph (RELATED_TO/LINKED_TO proximity boost, 1-hop graph-recall from the top hit, and matching
    temporal facts returned in `related_facts`). Pass `"include_graph_view": true` to also get a `graph_view`
    field: a mermaid `graph TD` block showing how the returned memories/entities connect.

## Run

```bash
cargo run -p openmemory-server
```

By default it binds `127.0.0.1:18080`. Override with `OPENMEMORY_PORT`.
