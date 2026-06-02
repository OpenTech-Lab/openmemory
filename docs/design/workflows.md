# OpenMemory — Operation Workflows

---

## 1. Memory Save (`memory.save`)

Persists content across three stores. FalkorDB write is fire-and-forget (non-blocking).

```mermaid
sequenceDiagram
    participant Agent
    participant Server
    participant PG as PostgreSQL
    participant OS as OpenSearch
    participant FK as FalkorDB

    Agent->>Server: POST /mcp {"type":"memory.save", content, tags, importance}
    Server->>PG: INSERT memory_index (id, summary, tags, importance, created_at)
    PG-->>Server: ok
    Server->>OS: PUT /memories/_doc/{id} (full content + metadata)
    OS-->>Server: ok
    Server-)FK: tokio::spawn save_node(id, tags) [non-blocking]
    Server-->>Agent: {"type":"memory.save.result", "id": "..."}
    FK-->>FK: MERGE Memory node + auto RELATED_TO edges
```

---

## 2. Memory Search (`memory.search`)

Hybrid BM25 + importance + recency scoring, with Redis cache.

```mermaid
sequenceDiagram
    participant Agent
    participant Server
    participant REDIS as Redis
    participant OS as OpenSearch
    participant PG as PostgreSQL

    Agent->>Server: POST /mcp {"type":"memory.search", "query":"..."}
    Server->>REDIS: GET cache_key
    alt cache hit
        REDIS-->>Server: cached results
        Server-->>Agent: SearchResult[]
    else cache miss
        REDIS-->>Server: nil
        Server->>OS: POST /memories/_search (multi_match BM25 + fuzzy)
        OS-->>Server: ranked docs
        Server->>PG: SELECT importance, created_at WHERE id = ANY(ids)
        PG-->>Server: metadata
        Server->>Server: score = importance*0.6 + recency*0.4
        Server->>REDIS: SET cache_key (TTL 5min)
        Server-->>Agent: SearchResult[] sorted by score
    end
```

---

## 3. Add Temporal Fact (full provenance flow)

The recommended pattern for an agent building a knowledge graph:

```mermaid
sequenceDiagram
    participant Agent
    participant Server
    participant FK as FalkorDB

    Note over Agent,FK: Step 1 — Record the source episode
    Agent->>Server: graph.add_episode(name, source, content, valid_at)
    Server->>FK: MERGE (:Episode {id, content, valid_at, ...})
    Server-->>Agent: {id: "ep-uuid"}

    Note over Agent,FK: Step 2 — Upsert entities (deduped)
    Agent->>Server: graph.add_entity(name="Alice", type="Person", episode_id="ep-uuid")
    Server->>FK: MATCH existing OR CREATE new :Entity
    FK->>FK: MERGE (:Episode)-[:MENTIONS]->(:Entity)
    Server-->>Agent: {id: "en-uuid", created: true}

    Agent->>Server: graph.add_entity(name="Manager", type="Role")
    Server-->>Agent: {id: "en-uuid-2", created: true}

    Note over Agent,FK: Step 3 — Assert temporal fact
    Agent->>Server: graph.add_fact(subject="Alice", object="Manager",\n  name="holds_role", valid_at="2026-06-01",\n  invalidate_previous=true)
    Server->>FK: Pre-flight: MATCH both entities, count ≥ 1
    Server->>FK: CREATE (:Entity)-[:FACT {valid_at, invalid_at=null}]->(:Entity)
    Server->>FK: SET old FACT.invalid_at = valid_at (where invalid_at IS NULL)
    Server-->>Agent: {id: "fact-uuid", invalidated_count: 1}
```

---

## 4. Time-Travel Query (`graph.query_at`)

Ask "what was true on a specific date?"

```mermaid
sequenceDiagram
    participant Agent
    participant Server
    participant FK as FalkorDB

    Agent->>Server: graph.query_at(timestamp="2025-07-01T00:00:00Z",\n  entity_name="Alice", group_id="default")
    Server->>Server: normalize_ts(timestamp) → UTC RFC3339
    Server->>FK: MATCH (a:Entity)-[f:FACT]->(b:Entity)\n  WHERE f.valid_at <= "2025-07-01"\n  AND (f.invalid_at IS NULL OR f.invalid_at > "2025-07-01")\n  AND a.name = "Alice"
    FK-->>Server: matching FACT rows
    Server->>Server: parse_fact_rows() → Vec<FactResult>
    Server-->>Agent: {type: "graph.query_at.result", facts: [...]}
```

---

## 5. Session Watcher (background ingestion)

Automatically saves AI conversation turns as memories.

```mermaid
flowchart TD
    FS["Host filesystem\n~/.claude/projects/**/*.jsonl\n~/.gemini/**/*.jsonl\n~/.codex/**/*.jsonl"]

    INOTIFY["inotify watcher\n(or polling fallback)"]
    PARSE["Parse JSONL line\nDeserialize event_type"]
    USER{"event_type\n= user?"}
    ASSISTANT{"event_type\n= assistant?"}
    SESSION["Upsert session row\nin PostgreSQL"]
    PEND["Buffer user text\nin PendingUserText map"]
    PAIR["Pair with pending user turn"]
    SAVE_MEM["POST /mcp memory.save\ncontent = user + assistant\ntags = [session, project_name]"]
    SAVE_MSG["INSERT session_messages\n(all event types)"]

    FS --> INOTIFY
    INOTIFY --> PARSE
    PARSE --> SESSION
    PARSE --> USER
    PARSE --> ASSISTANT
    USER --> PEND
    ASSISTANT --> PAIR
    PAIR --> SAVE_MEM
    PARSE --> SAVE_MSG
```

---

## 6. Graph Traversal — Neighbor Discovery

Find memories related to a known memory via shared tags or explicit links.

```mermaid
sequenceDiagram
    participant Agent
    participant Server
    participant FK as FalkorDB

    Agent->>Server: memory.graph_neighbors(id="uuid", hops=2, limit=10)
    Server->>FK: MATCH (a:Memory {id:"uuid"})\n  -[:RELATED_TO|LINKED_TO*1..2]-\n  (b:Memory)\n  RETURN b.id, b.summary, b.importance, b.tags\n  LIMIT 10
    FK-->>Server: neighbor rows
    Server-->>Agent: [{id, summary, importance, tags}, ...]
```

---

## 7. Env Param Storage (secrets)

Encrypted parameter store for API keys and secrets.

```mermaid
flowchart LR
    SET["env.set(key, value, is_secret=true)"]
    ENC["AES-GCM encrypt(value)\nkey = HKDF(OPENMEMORY_SECRET_KEY)"]
    PG_ENV[("PostgreSQL\nenv_params table\nvalue_encrypted BYTEA")]
    GET["env.get(key)"]
    AUTH{"Bearer token\ncheck"}
    DEC["AES-GCM decrypt"]
    RESP["Return plaintext value"]
    BLOCK["Return error:\n'secret param blocked'"]

    SET --> ENC --> PG_ENV
    GET --> AUTH
    AUTH -->|"valid token"| DEC
    AUTH -->|"no token"| BLOCK
    DEC --> PG_ENV
    PG_ENV --> RESP
```
