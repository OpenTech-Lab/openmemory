# OpenMemory — System Architecture

## Overview

OpenMemory is a local, persistent memory system for AI agents. It runs entirely on the host machine via Docker and exposes two interfaces: an HTTP API and a stdio JSON-RPC MCP server. A background session watcher passively ingests AI tool conversation logs into memory.

---

## High-Level System Diagram

```mermaid
graph TB
    subgraph Clients
        CC[Claude Code / Agent]
        CLI[mem CLI script]
        WEB[Web UI :3000]
    end

    subgraph Interfaces
        MCP_STDIO[openmemory-mcp\nstdio JSON-RPC]
        HTTP[openmemory-server\nHTTP :8080]
    end

    subgraph Background
        WATCHER[openmemory-watcher\nSession Watcher]
    end

    subgraph Storage["Storage Layer (Docker)"]
        PG[(PostgreSQL :5432\nIndex + Metadata)]
        OS[(OpenSearch :9201\nFull-text Content)]
        REDIS[(Redis :6399\nSearch Cache)]
        FALKOR[(FalkorDB :6380\nKnowledge Graph)]
    end

    subgraph HostFS["Host Filesystem (read-only)"]
        JSONL[Agent roots\n~/.claude → projects/**/*.jsonl\n~/.gemini\n~/.codex → sessions/**/*.jsonl]
    end

    CC -->|stdio JSON-RPC| MCP_STDIO
    CC -->|HTTP POST /mcp| HTTP
    CLI -->|HTTP POST /mcp| HTTP
    WEB -->|HTTP /mcp| HTTP

    MCP_STDIO --> PG
    MCP_STDIO --> OS
    MCP_STDIO --> FALKOR

    HTTP --> PG
    HTTP --> OS
    HTTP --> REDIS
    HTTP --> FALKOR

    WATCHER -->|inotify / poll| JSONL
    WATCHER -->|save sessions| PG
    WATCHER -->|save memories| HTTP
```

---

## Service Inventory

| Service | Binary | Port | Role |
|---------|--------|------|------|
| `openmemory-server` | Rust / axum | 8080 | HTTP API — all MCP operations |
| `openmemory-mcp` | Rust / tokio | stdio | Stdio JSON-RPC for Claude Code settings.json |
| `openmemory-watcher` | Rust | — | Background session ingestion |
| `postgres` | PostgreSQL 17 | 5432 | Memory index, env params, session tables |
| `opensearch` | OpenSearch 2.18 | 9201 | Full-text BM25 search on memory content |
| `redis` | Redis 7 | 6399 | 5-minute search result cache |
| `falkordb` | FalkorDB latest | 6380 | Knowledge graph (Memory + Episode + Entity + Fact) |
| `web` | Next.js | 3000 | Browser dashboard (profile: api) |

---

## Docker Compose Profiles

```mermaid
graph LR
    BASE["docker compose up -d\n(always starts)"]
    API["--profile api\n(adds HTTP server + web UI)"]
    WATCHER["--profile watcher\n(adds session watcher)"]
    DASHBOARD["--profile dashboard\n(adds OpenSearch Dashboards)"]

    BASE --> PG2[(postgres)]
    BASE --> OS2[(opensearch)]
    BASE --> RD2[(redis)]
    BASE --> FK2[(falkordb)]

    API --> SRV[openmemory-server]
    API --> WEB2[web UI]

    WATCHER --> WCH[openmemory-watcher]
    DASHBOARD --> OSD[opensearch-dashboards :5601]
```

---

## Storage Responsibilities

Each store has a single, non-overlapping responsibility:

```mermaid
graph TD
    SAVE["memory.save(content)"]

    SAVE -->|"id, summary, tags,\nimportance, timestamps"| PG[(PostgreSQL\nIndex + Metadata)]
    SAVE -->|"id, full content,\nsummary, tags"| OS[(OpenSearch\nBM25 full-text)]
    SAVE -->|"Memory node\n(async, non-blocking)"| FK[(FalkorDB\nGraph Layer)]

    SEARCH["memory.search(query)"]
    SEARCH -->|"BM25 keyword\nmatch"| OS
    SEARCH -->|"importance score\n+ recency boost"| PG
    OS -->|merged + ranked| RESULT[SearchResult]
    PG --> RESULT

    CACHE["Redis Cache"]
    SEARCH -->|"check cache first\n(5 min TTL)"| CACHE
    RESULT -->|"write back"| CACHE
```

---

## Security Model

- All services bind to `localhost` by default; Docker internal networking used between containers
- `OPENMEMORY_API_TOKEN` gates secret `env.get` operations (Bearer auth)
- Env params stored AES-GCM encrypted (key derived from `OPENMEMORY_SECRET_KEY` via HKDF).
  `OPENMEMORY_SECRET_KEY` is required — both the HTTP server and stdio MCP binary
  refuse to start without it (`OPENMEMORY_ALLOW_INSECURE_DEV_KEY=1` opts into the
  well-known dev key for CI/tests only). Rotate it with
  `openmemory-server rotate-secret-key [--dry-run]`, which re-encrypts every
  `env_params` row from `OPENMEMORY_OLD_SECRET_KEY` to `OPENMEMORY_NEW_SECRET_KEY`
  in one transaction.
- FalkorDB and Redis have no auth — localhost-only exposure
- CORS restricted to `localhost` origins unless `OPENMEMORY_CORS_ORIGINS` is set
