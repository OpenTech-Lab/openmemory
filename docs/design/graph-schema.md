# OpenMemory — Knowledge Graph Schema

The FalkorDB graph holds two logical layers that coexist in the same graph (`openmemory`):

1. **Memory layer** — legacy flat graph mirroring PostgreSQL Memory records (backward compatible)
2. **Temporal knowledge graph** — Graphiti-inspired Episode / Entity / Fact model

---

## Node Types

```mermaid
erDiagram
    MEMORY {
        string id PK
        string user_id
        string summary
        float  importance
        list   tags
        string created_at
    }

    EPISODE {
        string id PK
        string name
        string source
        string source_description
        string content
        string group_id
        string created_at
        string valid_at
    }

    ENTITY {
        string id PK
        string name
        string entity_type
        string group_id
        string summary
        string created_at
    }

    MEMORY ||--o{ MEMORY : "RELATED_TO (shared tags)"
    MEMORY ||--o{ MEMORY : "LINKED_TO (explicit, named)"
    EPISODE ||--o{ ENTITY : "MENTIONS (provenance)"
    ENTITY  ||--o{ ENTITY : "FACT (temporal)"
```

---

## Edge Types

### Memory Layer (legacy)

| Edge | From → To | Properties | Created by |
|------|-----------|------------|------------|
| `RELATED_TO` | Memory → Memory | — | Auto on save (shared tags) |
| `LINKED_TO` | Memory → Memory | `relationship: String` | `memory.graph_relate` |

### Temporal Knowledge Graph

| Edge | From → To | Properties | Created by |
|------|-----------|------------|------------|
| `MENTIONS` | Episode → Entity | — | `graph.add_entity` with `episode_id` |
| `FACT` | Entity → Entity | `id, name, fact, valid_at, invalid_at, created_at, episode_id` | `graph.add_fact` |

---

## FACT Edge — Temporal Semantics

```mermaid
timeline
    title Alice holds_role timeline
    2025-01-01 : FACT created
               : valid_at = 2025-01-01
               : invalid_at = NULL  (currently true)
    2026-06-01 : New FACT created (invalidate_previous=true)
               : OLD FACT gets invalid_at = 2026-06-01
               : NEW FACT valid_at = 2026-06-01
               : NEW FACT invalid_at = NULL
```

**Key rules:**
- `invalid_at = NULL` → fact is currently valid
- `invalid_at IS NOT NULL` → fact was superseded at that timestamp
- `valid_at` records when the fact became true in the real world (not when it was entered)
- `created_at` records wall-clock time of insertion

### Querying validity at time T:
```cypher
MATCH (a:Entity)-[f:FACT]->(b:Entity)
WHERE f.valid_at <= "T"
  AND (f.invalid_at IS NULL OR f.invalid_at > "T")
RETURN a.name, f.name, f.fact, b.name
```

---

## Full Graph Schema — Cypher notation

```mermaid
graph LR
    subgraph MemoryLayer["Memory Layer (legacy)"]
        M1([":Memory\nid, user_id, summary\nimportance, tags"])
        M2([":Memory"])
        M1 -- ":RELATED_TO" --> M2
        M1 -- ":LINKED_TO\n{relationship}" --> M2
    end

    subgraph KnowledgeGraph["Temporal Knowledge Graph"]
        EP([":Episode\nid, name, source\ncontent, group_id\nvalid_at, created_at"])
        EN1([":Entity\nid, name, entity_type\ngroup_id, summary"])
        EN2([":Entity"])

        EP -- ":MENTIONS" --> EN1
        EN1 -- ":FACT\n{id, name, fact\nvalid_at, invalid_at\ncreated_at, episode_id}" --> EN2
    end
```

---

## Indexes

Created by `init_indexes()` on startup (idempotent):

| Node | Property | Type |
|------|----------|------|
| `:Memory` | `id` | Exact |
| `:Episode` | `id` | Exact |
| `:Episode` | `group_id` | Exact |
| `:Entity` | `id` | Exact |
| `:Entity` | `name` | Exact |
| `:Entity` | `group_id` | Exact |

---

## Entity Deduplication

Entities are identified by the triple `(name, entity_type, group_id)`. Calling `graph.add_entity` twice with the same triple returns the existing entity ID and updates the summary — it does not create a duplicate node.

```mermaid
flowchart TD
    ADD["graph.add_entity(name, type, group)"]
    CHECK{"MATCH (n:Entity {name, type, group})\nRETURN n.id"}
    EXISTS["Returns (existing_id, created=false)\nOptionally updates summary"]
    CREATE["CREATE node with new UUID\nReturns (new_id, created=true)"]

    ADD --> CHECK
    CHECK -->|found| EXISTS
    CHECK -->|not found| CREATE
```
