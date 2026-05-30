# Two-Mode System Design: MCP + API+CLI

**Date:** 2026-05-30  
**Status:** Approved for implementation (post Codex review)

---

## Overview

OpenMemory currently runs in one mode: docker compose for infrastructure, a locally-built `openmemory-mcp` binary piped into AI tools via stdio. This design adds a second mode — API+CLI — where the HTTP server runs as a Docker container and users interact via a `mem` shell script CLI. A copyable Claude Code skill file ships alongside.

---

## Modes

### Mode 1: MCP (current, unchanged)

```bash
docker compose up -d                                   # start infra
cargo build --release --bin openmemory-mcp             # build binary
# configure ~/.claude/settings.json → mcpServers block
```

The `openmemory-mcp` binary communicates via stdin/stdout JSON-RPC. No changes to this path.

### Mode 2: API + CLI

```bash
docker compose --profile api up -d    # start infra + openmemory-server container
mem save "content" --importance 0.8   # use CLI
```

Infrastructure services (postgres, opensearch, redis, falkordb) always start with plain `docker compose up -d`. The `openmemory-server` service only starts when `--profile api` is given.

---

## Files to Create / Modify

| File | Action | Purpose |
|------|--------|---------|
| `Dockerfile` | Create | Multi-stage build for `openmemory-server` |
| `.dockerignore` | Create | Exclude `target/`, `.git/`, `node_modules/` from build context |
| `docker-compose.yml` | Update | Add `openmemory-server` service under `profiles: [api]`; profile `opensearch-dashboards` |
| `apps/server/src/main.rs` | Update | Bind to configurable host (`OPENMEMORY_HOST`); restrict CORS to localhost |
| `apps/server/Cargo.toml` | Update | Switch `reqwest` to `rustls-tls` (eliminates OpenSSL build deps) |
| `scripts/mem` | Create | Shell CLI wrapping the HTTP API |
| `skills/openmemory.md` | Create | Copyable Claude Code skill |
| `README.md` | Update | Document both modes |

---

## Code Changes (Rust)

### 1. Bind address — `apps/server/src/main.rs`

**Problem (Codex P1):** Server currently binds to `127.0.0.1`, making Docker port publishing silently useless.

**Fix:** Read `OPENMEMORY_HOST` env var; default to `127.0.0.1` for local safety. The Docker compose service sets `OPENMEMORY_HOST=0.0.0.0`.

```rust
let host = std::env::var("OPENMEMORY_HOST")
    .unwrap_or_else(|_| "127.0.0.1".to_string());
let addr: SocketAddr = format!("{host}:{port}").parse()?;
```

### 2. CORS — `apps/server/src/main.rs`

**Problem (Codex P1):** `CorsLayer::new().allow_origin(Any)` allows arbitrary browser pages to read/write/delete memories via CORS — not just a public-exposure risk.

**Fix:** When running locally (default), restrict CORS to localhost origins. Add `OPENMEMORY_CORS_ORIGINS` env var for users who need cross-origin access:

```rust
let cors = match std::env::var("OPENMEMORY_CORS_ORIGINS") {
    Ok(origins) => {
        let allowed: Vec<_> = origins.split(',')
            .filter_map(|o| o.trim().parse::<HeaderValue>().ok())
            .collect();
        CorsLayer::new().allow_origin(allowed).allow_headers(Any).allow_methods(Any)
    }
    Err(_) => CorsLayer::new()
        .allow_origin([
            "http://localhost".parse::<HeaderValue>().unwrap(),
            "http://127.0.0.1".parse::<HeaderValue>().unwrap(),
        ])
        .allow_headers(Any)
        .allow_methods(Any),
};
```

### 3. TLS — `apps/server/Cargo.toml`

**Problem (Codex P1):** `reqwest` with default TLS (native-tls) requires OpenSSL headers + `pkg-config` at build time. `rust:slim` does not have them.

**Fix:** Switch to `rustls` — pure Rust TLS, no system OpenSSL needed at all:

```toml
reqwest = { version = "0.12", features = ["json", "rustls-tls"], default-features = false }
```

This removes the need for `libssl-dev` and `pkg-config` in the Dockerfile builder stage entirely.

---

## Dockerfile

```dockerfile
# Stage 1: builder
FROM rust:1-slim-bookworm AS builder
WORKDIR /build
# Only need ca-certificates for rustls root store at build time
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
COPY . .
RUN cargo build --release --bin openmemory-server

# Stage 2: runtime
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=builder /build/target/release/openmemory-server /usr/local/bin/
EXPOSE 8080
ENV OPENMEMORY_PORT=8080
ENV OPENMEMORY_HOST=0.0.0.0
ENV DATABASE_URL=postgres://openmemory:openmemory@postgres:5432/openmemory
ENV OPENSEARCH_URL=http://opensearch:9200
ENV REDIS_URL=redis://redis:6379
ENV FALKORDB_URL=redis://falkordb:6379
CMD ["openmemory-server"]
```

Notes:
- `rustls-tls` requires `ca-certificates` at runtime (for root cert validation), but not `libssl3`
- `OPENSEARCH_URL` uses internal Docker port `9200`; host-exposed port `9201` is for local access only
- `OPENMEMORY_HOST=0.0.0.0` is set here so the container listens on all interfaces

---

## `.dockerignore`

```
target/
.git/
node_modules/
apps/web/node_modules/
apps/web/.next/
*.md
docs/
scripts/
.env
.env.*
```

Prevents sending `target/` (gigabytes of Rust artifacts) and `.git/` into Docker build context.

---

## `docker-compose.yml` Changes

### New `openmemory-server` service

```yaml
openmemory-server:
  profiles: [api]
  build:
    context: .
    dockerfile: Dockerfile
  ports:
    - "${OPENMEMORY_PORT:-8080}:8080"
  environment:
    OPENMEMORY_HOST: "0.0.0.0"
    DATABASE_URL: postgres://openmemory:openmemory@postgres:5432/openmemory
    OPENSEARCH_URL: http://opensearch:9200
    REDIS_URL: redis://redis:6379
    FALKORDB_URL: redis://falkordb:6379
  depends_on:
    postgres:
      condition: service_healthy
    opensearch:
      condition: service_healthy
    redis:
      condition: service_healthy
    falkordb:
      condition: service_healthy
  healthcheck:
    test: ["CMD-SHELL", "curl -sf http://localhost:8080/health || exit 1"]
    interval: 5s
    timeout: 5s
    retries: 10
  restart: unless-stopped
```

### Profile `opensearch-dashboards`

**Problem (Codex P2):** `opensearch-dashboards` currently has no profile and starts with plain `docker compose up -d`, consuming ~300MB RAM unnecessarily for most users.

**Fix:** Add `profiles: [dashboard]` to `opensearch-dashboards`. Users who want the dashboard run:
```bash
docker compose --profile dashboard up -d
```

---

## `scripts/mem` Shell CLI

```bash
#!/usr/bin/env bash
# mem — OpenMemory CLI
# Usage: mem save|search|list|get|delete [args]
# Config: OPENMEMORY_URL (default: http://localhost:8080)
```

**Subcommands (v1):**

| Command | Maps to API |
|---------|------------|
| `mem save "content" [--importance N] [--tags t1,t2] [--summary "..."]` | `memory.save` |
| `mem search "query" [--limit N]` | `memory.search` |
| `mem list [--limit N]` | `memory.list` |
| `mem get <uuid>` | `memory.get` |
| `mem delete <uuid>` | `memory.delete` |

Graph commands (`graph_all`, `graph_neighbors`, `graph_relate`) are intentionally deferred to v2 of the CLI — they require UUIDs from prior saves and are less useful from a shell one-liner.

**Error handling:**
- Parse `{"error": "..."}` from JSON responses for user-friendly errors
- Fall back to raw response body if not valid JSON (Axum extractor errors, etc.)
- Exit code `1` on HTTP 4xx/5xx, exit code `0` on success
- `jq` used for pretty output if available; raw JSON otherwise

**Default expansion fix:**
```bash
BASE_URL="${OPENMEMORY_URL:-http://localhost:8080}"
```

---

## `skills/openmemory.md` — Claude Code Skill

Designed to be copied into `.claude/` or pasted into `CLAUDE.md`. Content:

**When to search:** At session start, run `mem search "<topic>"` to pull relevant past context if the conversation involves a known project, user, or ongoing work.

**When to save:** After learning something worth keeping (preferences, decisions, project constraints), run `mem save` before the session ends.

**Commands:**

```bash
# Search
mem search "TypeScript preferences" --limit 5

# Save (use importance 0.7–0.9 for strong preferences/decisions)
mem save "User prefers docker compose over direct docker run" \
  --importance 0.8 --tags docker,preference

# List recent
mem list --limit 10

# Get full content
mem get <uuid>

# Delete outdated
mem delete <uuid>
```

**Direct API fallback** (if `mem` is not in PATH):

```bash
curl -s -X POST "${OPENMEMORY_URL:-http://localhost:8080}/mcp" \
  -H 'content-type: application/json' \
  -d '{"type":"memory.search","query":"TypeScript","limit":5}'
```

**Security note:** The API has no authentication. Never expose `OPENMEMORY_PORT` publicly without adding auth middleware.

---

## Known Limitations (documented, not fixed in this iteration)

**Silent empty results on backend failure:** Several paths in `main.rs` use `unwrap_or_default()` on OpenSearch/Postgres errors, returning HTTP 200 with empty results rather than a 5xx. The CLI will exit 0 with no output when the backend is down. Fixing this requires changes to the server error handling that are out of scope for this feature.

---

## README Structure After Changes

```
## Quick Start

### Mode 1: MCP (AI tool integration via stdio)
[existing setup steps, now labeled]

### Mode 2: API + CLI (HTTP server + shell commands)
1. docker compose --profile api up -d
2. Install/use scripts/mem  
3. Optionally copy skills/openmemory.md into your AI agent

## Adding Memory to Your AI Agent (Skill File)
[instructions for copying skills/openmemory.md]
```
