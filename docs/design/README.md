# Design Documentation

| Document | What it covers |
|----------|---------------|
| [architecture.md](./architecture.md) | System overview, service inventory, Docker profiles, storage responsibilities, security model |
| [primitives.md](./primitives.md) | Conceptual reference for every agent-facing primitive (memory, graph, env params, resources, tasks, lessons, workflows, ...): what it is, when to use it instead of its neighbors |
| [graph-schema.md](./graph-schema.md) | FalkorDB node/edge types, indexes, entity deduplication flow |
| [workflows.md](./workflows.md) | Sequence and flow diagrams for every major operation: save, search, add_fact, query_at, session watcher, neighbor traversal, env params |
| [temporal-model.md](./temporal-model.md) | Bi-temporal model, provenance chain, invalidation semantics, query patterns, MCP API reference |
| [meeting-summary-workflow.md](./meeting-summary-workflow.md) | Slice 1 recipe: transcript-in → summarize → save as a reusable `workflow` (fetch via `http` step, summarize/save via `agent` step); privacy callout |
