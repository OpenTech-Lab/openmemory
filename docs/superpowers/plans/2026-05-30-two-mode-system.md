# Two-Mode System (MCP + API+CLI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add API+CLI mode alongside the existing MCP mode — containerize `openmemory-server` via Docker, provide a `scripts/mem` shell CLI, and ship a `skills/openmemory.md` skill file for Claude Code agents.

**Architecture:** Two independent binaries already exist (`openmemory-mcp` for stdio JSON-RPC, `openmemory-server` for HTTP REST). This plan containerizes the HTTP server, fixes three blocking issues (bind address, CORS, TLS), and adds the CLI + skill layer. No new Rust code is written — only config changes and additions.

**Tech Stack:** Rust (reqwest with rustls-tls), Docker multi-stage build (rust:slim + debian:slim), docker compose profiles, Bash shell script (requires `jq`, `curl`).

---

## File Map

| File | Action | Responsible for |
|------|--------|----------------|
| `apps/server/Cargo.toml` | Modify | Switch reqwest to rustls-tls (removes OpenSSL build dep) |
| `apps/server/src/main.rs` | Modify | Configurable bind host (`OPENMEMORY_HOST`); localhost-only CORS |
| `Dockerfile` | Create | Multi-stage build for `openmemory-server` |
| `.dockerignore` | Create | Keep Docker build context small (exclude `target/`, `.git/`) |
| `docker-compose.yml` | Modify | Add `openmemory-server` service (profile: api); profile `opensearch-dashboards` |
| `scripts/mem` | Create | Shell CLI: save/search/list/get/delete |
| `skills/openmemory.md` | Create | Copyable Claude Code skill for using OpenMemory |
| `README.md` | Modify | Document both modes |

---

## Task 1: Switch reqwest to rustls-tls

**Files:**
- Modify: `apps/server/Cargo.toml`

**Why:** `reqwest` with default TLS requires OpenSSL headers + `pkg-config` at build time. `rust:slim` does not have them. `rustls-tls` is pure Rust — no system deps needed, works in slim containers.

- [ ] **Step 1: Update Cargo.toml**

Open `apps/server/Cargo.toml`. Find the `reqwest` line and replace it:

```toml
# Before:
reqwest = { version = "0.12", features = ["json"] }

# After:
reqwest = { version = "0.12", features = ["json", "rustls-tls"], default-features = false }
```

`default-features = false` removes the implicit `native-tls` feature. `rustls-tls` is the pure-Rust replacement.

- [ ] **Step 2: Verify it compiles**

```bash
cd /home/toyofumi/projects/openmemory
cargo build --bin openmemory-server 2>&1 | tail -5
```

Expected: `Finished` line, no errors. If you see `Could not find directory of OpenSSL installation` — you still have native-tls somewhere; double-check `default-features = false` is present.

- [ ] **Step 3: Commit**

```bash
git add apps/server/Cargo.toml Cargo.lock
git commit -m "chore: switch reqwest to rustls-tls, remove OpenSSL build dependency"
```

---

## Task 2: Make bind address configurable

**Files:**
- Modify: `apps/server/src/main.rs` (around line 447–452)

**Why:** Server currently hardcodes `SocketAddr::from(([127, 0, 0, 1], port))`. When running inside Docker, the container needs to listen on `0.0.0.0` for port publishing to reach the host. The Docker compose service will set `OPENMEMORY_HOST=0.0.0.0`; local dev keeps the safe default of `127.0.0.1`.

- [ ] **Step 1: Replace the bind address block in main.rs**

Find this code (around line 447):

```rust
let addr = SocketAddr::from(([127, 0, 0, 1], port));
```

Replace with:

```rust
let host = std::env::var("OPENMEMORY_HOST")
    .unwrap_or_else(|_| "127.0.0.1".to_string());
let addr: SocketAddr = format!("{host}:{port}")
    .parse()
    .with_context(|| format!("invalid bind address {host}:{port}"))?;
```

No new imports needed — `SocketAddr` is already imported via `use std::net::SocketAddr;` and `with_context` via `use anyhow::Context;`.

- [ ] **Step 2: Build to verify**

```bash
cargo build --bin openmemory-server 2>&1 | tail -3
```

Expected: `Finished` line, no errors.

- [ ] **Step 3: Smoke-test bind address is read**

```bash
# Expect startup log to show 0.0.0.0:9999
OPENMEMORY_HOST=0.0.0.0 OPENMEMORY_PORT=9999 \
  DATABASE_URL=postgres://openmemory:openmemory@localhost:5432/openmemory \
  OPENSEARCH_URL=http://localhost:9201 \
  ./target/debug/openmemory-server &
SERVER_PID=$!
sleep 1
curl -sf http://0.0.0.0:9999/health && echo "PASS" || echo "FAIL (check infra is up)"
kill $SERVER_PID 2>/dev/null; wait $SERVER_PID 2>/dev/null; true
```

Expected: `{"status":"ok"}` and `PASS`. (Requires infra running; if not, the curl will fail but the important check is that the log line says `starting openmemory server addr=0.0.0.0:9999`.)

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/main.rs
git commit -m "feat: make bind host configurable via OPENMEMORY_HOST env var"
```

---

## Task 3: Restrict CORS to localhost origins

**Files:**
- Modify: `apps/server/src/main.rs` (around line 517–521)

**Why:** `CorsLayer::new().allow_origin(Any)` lets any browser page make credentialed requests to `localhost:8080`, enabling CSRF attacks from malicious websites. For a local-first tool, localhost origins are all that's needed. Users who need cross-origin access (e.g. a remote dashboard) can set `OPENMEMORY_CORS_ORIGINS`.

- [ ] **Step 1: Add HeaderValue import**

Find the existing import block in `main.rs`:

```rust
use axum::{
    extract::State,
    http::StatusCode,
    ...
};
```

Add `HeaderValue` to the `axum::http` import:

```rust
use axum::{
    extract::State,
    http::{HeaderValue, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
```

- [ ] **Step 2: Replace the CORS layer**

Find this line (around line 521):

```rust
.layer(CorsLayer::new().allow_origin(Any).allow_headers(Any).allow_methods(Any))
```

Replace the entire `.layer(CorsLayer...)` line with:

```rust
.layer({
    match std::env::var("OPENMEMORY_CORS_ORIGINS") {
        Ok(origins) => {
            let allowed: Vec<HeaderValue> = origins
                .split(',')
                .filter_map(|o| o.trim().parse().ok())
                .collect();
            CorsLayer::new()
                .allow_origin(allowed)
                .allow_headers(Any)
                .allow_methods(Any)
        }
        Err(_) => CorsLayer::new()
            .allow_origin([
                "http://localhost".parse::<HeaderValue>().unwrap(),
                "http://localhost:3000".parse::<HeaderValue>().unwrap(),
                "http://127.0.0.1".parse::<HeaderValue>().unwrap(),
            ])
            .allow_headers(Any)
            .allow_methods(Any),
    }
})
```

`http://localhost:3000` is included for the Next.js dashboard (port 3000 is its default).

- [ ] **Step 3: Build to verify**

```bash
cargo build --bin openmemory-server 2>&1 | tail -3
```

Expected: `Finished`, no errors. If you see a type error on `allow_origin`, check that `HeaderValue` is imported and the `Vec<HeaderValue>` is collected correctly.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/main.rs
git commit -m "fix: restrict CORS to localhost origins, add OPENMEMORY_CORS_ORIGINS override"
```

---

## Task 4: Create .dockerignore

**Files:**
- Create: `.dockerignore`

**Why:** Without this, `COPY . .` in the Dockerfile sends `target/` (gigabytes of Rust build artifacts) and `.git/` into Docker's build context, making every build slow even with layer caching.

- [ ] **Step 1: Create .dockerignore**

Create `/home/toyofumi/projects/openmemory/.dockerignore`:

```
# Rust build artifacts — largest contributor to slow build context
target/

# Git history — not needed in container
.git/

# Node artifacts
node_modules/
apps/web/node_modules/
apps/web/.next/

# Local env files — never copy secrets into images
.env
.env.*
*.local

# Docs and scripts don't affect the server binary
docs/
scripts/
*.md

# Editor and CI
.idea/
.vscode/
.github/
```

- [ ] **Step 2: Verify context is small**

```bash
# Measure what Docker would send (dry-run)
docker build --no-cache --dry-run . 2>&1 | head -5 || \
  tar -czh --exclude-from=.dockerignore . 2>/dev/null | wc -c | \
  awk '{printf "Build context: %.1f MB\n", $1/1024/1024}'
```

Expected: context under 5 MB (just source files, no `target/`). If still large, check `target/` is listed in `.dockerignore`.

- [ ] **Step 3: Commit**

```bash
git add .dockerignore
git commit -m "chore: add .dockerignore to exclude target/ and .git/ from Docker build context"
```

---

## Task 5: Create Dockerfile

**Files:**
- Create: `Dockerfile`

**Why:** Multi-stage build keeps the runtime image small. Builder stage compiles the binary; runtime stage copies only the binary and its runtime deps (just `ca-certificates` for rustls root cert validation).

- [ ] **Step 1: Create Dockerfile**

Create `/home/toyofumi/projects/openmemory/Dockerfile`:

```dockerfile
# ── Stage 1: build ──────────────────────────────────────────────────────────
FROM rust:1-slim-bookworm AS builder

# ca-certificates is needed by rustls at build time for cert chain validation
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY . .

RUN cargo build --release --bin openmemory-server

# ── Stage 2: runtime ────────────────────────────────────────────────────────
FROM debian:bookworm-slim

# ca-certificates is needed by rustls at runtime for outbound TLS (OpenSearch)
RUN apt-get update \
    && apt-get install -y ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /build/target/release/openmemory-server /usr/local/bin/openmemory-server

# Defaults suitable for Docker Compose (services communicate via hostname)
ENV OPENMEMORY_PORT=8080
ENV OPENMEMORY_HOST=0.0.0.0
ENV DATABASE_URL=postgres://openmemory:openmemory@postgres:5432/openmemory
ENV OPENSEARCH_URL=http://opensearch:9200
ENV REDIS_URL=redis://redis:6379
ENV FALKORDB_URL=redis://falkordb:6379

EXPOSE 8080

CMD ["openmemory-server"]
```

`curl` is included in the runtime image for the docker compose healthcheck (`curl -sf http://localhost:8080/health`).

- [ ] **Step 2: Build the image**

```bash
docker build -t openmemory-server:local .
```

Expected: `Successfully built` or `FINISHED` line. Build takes 2–5 minutes the first time (full Rust compile), ~30 seconds on repeat (layer cache).

If you see `error[E0433]: failed to resolve` or similar Rust errors, the source has a compilation problem — run `cargo build --release --bin openmemory-server` locally first to diagnose.

- [ ] **Step 3: Verify the image runs**

```bash
docker run --rm openmemory-server:local openmemory-server --help 2>&1 || \
  docker run --rm --entrypoint /bin/sh openmemory-server:local \
    -c "ls -la /usr/local/bin/openmemory-server && echo OK"
```

Expected: `OK` (binary exists at the expected path).

- [ ] **Step 4: Commit**

```bash
git add Dockerfile
git commit -m "feat: add multi-stage Dockerfile for openmemory-server (rustls, no OpenSSL)"
```

---

## Task 6: Update docker-compose.yml

**Files:**
- Modify: `docker-compose.yml`

**Changes:**
1. Add `openmemory-server` service under `profiles: [api]`
2. Add `profiles: [dashboard]` to `opensearch-dashboards` (it currently starts unconditionally)

- [ ] **Step 1: Add openmemory-server service**

Open `docker-compose.yml`. Add this service block after the `falkordb` service and before `volumes:`:

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

Note: `OPENSEARCH_URL` uses port `9200` (Docker internal network). The host-exposed port `9201` is for local access only and must not be used here.

- [ ] **Step 2: Profile opensearch-dashboards**

Find the `opensearch-dashboards` service. Add `profiles: [dashboard]` to it:

```yaml
  opensearch-dashboards:
    profiles: [dashboard]
    image: opensearchproject/opensearch-dashboards:2.18.0
    environment:
      OPENSEARCH_HOSTS: '["http://opensearch:9200"]'
      DISABLE_SECURITY_DASHBOARDS_PLUGIN: "true"
    ports:
      - "5601:5601"
    depends_on:
      opensearch:
        condition: service_healthy
```

- [ ] **Step 3: Verify plain docker compose up does not start api/dashboard services**

```bash
docker compose config --services
```

Expected output includes: `postgres`, `opensearch`, `opensearch-dashboards` (no — wait, it only shows non-profiled services by default).

Actually verify like this:
```bash
docker compose config --profiles
# Should show: api, dashboard as available profiles

docker compose up -d 2>&1 | grep -E "Starting|Creating|openmemory|dashboard" || echo "No api/dashboard services started (correct)"
```

Expected: `openmemory-server` and `opensearch-dashboards` do NOT start.

- [ ] **Step 4: Test API mode startup**

```bash
docker compose --profile api up -d
# Wait for health
sleep 10
docker compose --profile api ps
curl -sf http://localhost:8080/health && echo "API mode: PASS"
```

Expected: `{"status":"ok"}` and `API mode: PASS`.

- [ ] **Step 5: Tear down**

```bash
docker compose --profile api down
```

- [ ] **Step 6: Commit**

```bash
git add docker-compose.yml
git commit -m "feat: add openmemory-server Docker service (profile: api); profile opensearch-dashboards"
```

---

## Task 7: Create scripts/mem CLI

**Files:**
- Create: `scripts/mem`

**Requirements from spec:** `save`, `search`, `list`, `get`, `delete` subcommands. Reads `OPENMEMORY_URL`. Pretty-prints via `jq` if available. Non-JSON error fallback. Exits non-zero on HTTP errors.

**Requires:** `curl` and `jq` (for JSON building and parsing).

- [ ] **Step 1: Create scripts/mem**

Create `/home/toyofumi/projects/openmemory/scripts/mem`:

```bash
#!/usr/bin/env bash
# mem — OpenMemory CLI
# Requires: curl, jq
# Config:   OPENMEMORY_URL (default: http://localhost:8080)

set -euo pipefail

BASE_URL="${OPENMEMORY_URL:-http://localhost:8080}"
CMD="${1:-}"

_require_jq() {
    if ! command -v jq >/dev/null 2>&1; then
        echo "error: jq is required (brew install jq / apt install jq)" >&2
        exit 1
    fi
}

_post() {
    local payload="$1"
    local http_code body
    # Capture HTTP status code separately from body
    body=$(curl -s -w "\n__STATUS__%{http_code}" \
        -X POST "$BASE_URL/mcp" \
        -H 'content-type: application/json' \
        -d "$payload")
    http_code=$(echo "$body" | tail -1 | sed 's/__STATUS__//')
    body=$(echo "$body" | sed '$d' | sed 's/__STATUS__[0-9]*//')

    if [ "$http_code" -ge 400 ] 2>/dev/null; then
        # Try to extract error field; fall back to raw body
        local err
        err=$(echo "$body" | jq -r '.error // empty' 2>/dev/null)
        if [ -n "$err" ]; then
            echo "error: $err" >&2
        else
            echo "error (HTTP $http_code): $body" >&2
        fi
        exit 1
    fi

    echo "$body" | jq . 2>/dev/null || echo "$body"
}

_usage() {
    cat >&2 <<'EOF'
usage: mem <command> [args]

Commands:
  save <content> [--importance 0.5] [--tags tag1,tag2] [--summary TEXT]
  search <query> [--limit 5]
  list [--limit 20]
  get <uuid>
  delete <uuid>

Config:
  OPENMEMORY_URL  (default: http://localhost:8080)
EOF
    exit 1
}

case "$CMD" in

  save)
    _require_jq
    shift
    CONTENT="${1:?error: content required — usage: mem save <content> [--importance N] [--tags t1,t2] [--summary TEXT]}"
    shift
    IMPORTANCE="0.5"
    TAGS="[]"
    SUMMARY="null"
    while [ $# -gt 0 ]; do
        case "$1" in
            --importance) IMPORTANCE="$2"; shift 2 ;;
            --tags)
                TAGS=$(echo "$2" | tr ',' '\n' | jq -R . | jq -sc .)
                shift 2 ;;
            --summary)
                SUMMARY=$(jq -n --arg v "$2" '$v')
                shift 2 ;;
            *) echo "error: unknown flag $1" >&2; exit 1 ;;
        esac
    done
    PAYLOAD=$(jq -n \
        --arg content "$CONTENT" \
        --argjson importance "$IMPORTANCE" \
        --argjson tags "$TAGS" \
        --argjson summary "$SUMMARY" \
        '{type:"memory.save",content:$content,importance:$importance,tags:$tags,summary:$summary}')
    _post "$PAYLOAD"
    ;;

  search)
    _require_jq
    shift
    QUERY="${1:?error: query required — usage: mem search <query> [--limit N]}"
    shift
    LIMIT="5"
    while [ $# -gt 0 ]; do
        case "$1" in
            --limit) LIMIT="$2"; shift 2 ;;
            *) echo "error: unknown flag $1" >&2; exit 1 ;;
        esac
    done
    PAYLOAD=$(jq -n --arg q "$QUERY" --argjson l "$LIMIT" \
        '{type:"memory.search",query:$q,limit:$l}')
    _post "$PAYLOAD"
    ;;

  list)
    _require_jq
    shift
    LIMIT="20"
    while [ $# -gt 0 ]; do
        case "$1" in
            --limit) LIMIT="$2"; shift 2 ;;
            *) echo "error: unknown flag $1" >&2; exit 1 ;;
        esac
    done
    PAYLOAD=$(jq -n --argjson l "$LIMIT" '{type:"memory.list",limit:$l}')
    _post "$PAYLOAD"
    ;;

  get)
    _require_jq
    shift
    ID="${1:?error: uuid required — usage: mem get <uuid>}"
    PAYLOAD=$(jq -n --arg id "$ID" '{type:"memory.get",id:$id}')
    _post "$PAYLOAD"
    ;;

  delete)
    _require_jq
    shift
    ID="${1:?error: uuid required — usage: mem delete <uuid>}"
    PAYLOAD=$(jq -n --arg id "$ID" '{type:"memory.delete",id:$id}')
    _post "$PAYLOAD"
    ;;

  help|--help|-h|"")
    _usage
    ;;

  *)
    echo "error: unknown command '$CMD'" >&2
    _usage
    ;;

esac
```

- [ ] **Step 2: Make executable**

```bash
chmod +x /home/toyofumi/projects/openmemory/scripts/mem
```

- [ ] **Step 3: Test with live server**

Start API mode if not running:
```bash
docker compose --profile api up -d && sleep 10
```

Run the test sequence:
```bash
export OPENMEMORY_URL=http://localhost:8080

# Save
MEM_ID=$(./scripts/mem save "User prefers rustls over native-tls for Docker builds" \
  --importance 0.8 --tags rust,docker,tls | jq -r '.id')
echo "Saved ID: $MEM_ID"

# Search
./scripts/mem search "rustls docker" --limit 3

# List
./scripts/mem list --limit 5

# Get
./scripts/mem get "$MEM_ID"

# Delete
./scripts/mem delete "$MEM_ID"
echo "All commands: PASS"
```

Expected: Each command returns valid JSON. Delete returns `{"id":"...","deleted":true}`.

- [ ] **Step 4: Test error handling**

```bash
# Non-existent UUID should return error, not crash
./scripts/mem get "00000000-0000-0000-0000-000000000000" && echo "UNEXPECTED SUCCESS" || echo "Error handled: PASS"

# Bad URL should fail gracefully
OPENMEMORY_URL=http://localhost:9999 ./scripts/mem list && echo "UNEXPECTED" || echo "Connection error handled: PASS"
```

Expected: Both print an error message and exit 1.

- [ ] **Step 5: Commit**

```bash
git add scripts/mem
git commit -m "feat: add scripts/mem CLI for API+CLI mode (save/search/list/get/delete)"
```

---

## Task 8: Create skills/openmemory.md

**Files:**
- Create: `skills/openmemory.md`

**Purpose:** A file users copy into their AI agent's `.claude/` directory or paste into `CLAUDE.md`. Tells the agent when and how to use OpenMemory via the `mem` CLI.

- [ ] **Step 1: Create skills/ directory and skill file**

```bash
mkdir -p /home/toyofumi/projects/openmemory/skills
```

Create `/home/toyofumi/projects/openmemory/skills/openmemory.md`:

```markdown
# OpenMemory — Persistent Memory for AI Agents

OpenMemory gives you persistent, searchable memory across sessions. Use it to remember user preferences, project decisions, and important context.

## Setup

API mode must be running:
```bash
docker compose --profile api up -d   # from the openmemory project directory
```

The `mem` CLI must be in PATH, or set `OPENMEMORY_URL` for direct curl fallback.

```bash
# Add to PATH (run once)
export PATH="/path/to/openmemory/scripts:$PATH"

# Or set URL (if using curl fallback)
export OPENMEMORY_URL=http://localhost:8080
```

## When to Search

At the **start of a session**, search for relevant context if the user mentions a project, technology, or ongoing task you might have memory of:

```bash
mem search "TypeScript project setup" --limit 5
mem search "user preferences" --limit 10
```

Search is fast (<10ms). When in doubt, search — empty results cost nothing.

## When to Save

Save anything worth remembering **before ending a session**:
- User preferences ("prefers X over Y")
- Project decisions ("chose approach A because B")
- Constraints ("can't use library X due to license")
- Key facts ("server is at IP 192.168.1.5")

```bash
# Strong preference or decision → importance 0.8–0.9
mem save "User prefers rustls over native-tls for all Docker-based Rust projects" \
  --importance 0.9 --tags rust,docker,preference

# Useful context → importance 0.5–0.7
mem save "OpenMemory project lives at ~/projects/openmemory, uses port 8080" \
  --importance 0.6 --tags openmemory,project

# Minor note → importance 0.3–0.4
mem save "User timezone is JST (UTC+9)" \
  --importance 0.3 --tags user,timezone
```

## Commands

```bash
# Search (most common — use this to load context)
mem search "<topic>" [--limit 5]

# Save
mem save "<content>" [--importance 0.8] [--tags tag1,tag2] [--summary "brief label"]

# List recent memories
mem list [--limit 20]

# Get full content of a specific memory
mem get <uuid>

# Delete outdated or wrong memory
mem delete <uuid>
```

## Direct API Fallback (if mem is not in PATH)

```bash
# Search
curl -s -X POST "${OPENMEMORY_URL:-http://localhost:8080}/mcp" \
  -H 'content-type: application/json' \
  -d '{"type":"memory.search","query":"<topic>","limit":5}' | jq .

# Save
curl -s -X POST "${OPENMEMORY_URL:-http://localhost:8080}/mcp" \
  -H 'content-type: application/json' \
  -d '{"type":"memory.save","content":"<content>","importance":0.8,"tags":["tag"]}' | jq .
```

## Importance Score Guide

| Score | Use for |
|-------|---------|
| 0.9 | Critical preferences, hard constraints |
| 0.7–0.8 | Strong preferences, key decisions |
| 0.5–0.6 | Useful context, project facts |
| 0.3–0.4 | Minor notes |

## Security Note

The API has no authentication. `OPENMEMORY_PORT` (default 8080) must not be exposed publicly. It is localhost-only by default.
```

- [ ] **Step 2: Verify the file reads cleanly**

```bash
wc -l /home/toyofumi/projects/openmemory/skills/openmemory.md
# Expected: ~80 lines
```

- [ ] **Step 3: Commit**

```bash
git add skills/openmemory.md
git commit -m "feat: add skills/openmemory.md — copyable Claude Code skill for API+CLI mode"
```

---

## Task 9: Update README.md

**Files:**
- Modify: `README.md`

**Changes:** Replace the single "Quick Start" section with two labeled modes. Add skill file instructions.

- [ ] **Step 1: Replace the Quick Start section**

Open `README.md`. Replace the existing `## Quick Start` section (everything from `## Quick Start` through the end of the configure/use block) with:

```markdown
## Quick Start

### Mode 1: MCP (AI tool via stdio)

Best for: Claude Code, Cursor, any MCP-compatible AI tool.

```bash
# 1. Start infrastructure
docker compose up -d

# 2. Build MCP server
cargo build --release --bin openmemory-mcp

# 3. Configure your AI tool (~/.claude/settings.json)
```

```json
{
  "mcpServers": {
    "openmemory": {
      "command": "/PATH-TO-PROJECT/openmemory/target/release/openmemory-mcp",
      "env": {
        "DATABASE_URL": "postgres://openmemory:openmemory@localhost:5432/openmemory",
        "OPENSEARCH_URL": "http://localhost:9201",
        "REDIS_URL": "redis://localhost:6379"
      }
    }
  }
}
```

The AI now has `memory_save` and `memory_search` tools available automatically.

---

### Mode 2: API + CLI

Best for: shell scripts, CI pipelines, AI agents that prefer HTTP over MCP.

```bash
# 1. Start infrastructure + API server (first run compiles Rust, ~3 min)
docker compose --profile api up -d

# 2. Add CLI to PATH
export PATH="$PWD/scripts:$PATH"

# 3. Use it
mem save "User prefers TypeScript" --importance 0.8 --tags preference
mem search "TypeScript"
mem list --limit 10
```

> **For AI agents:** Copy `skills/openmemory.md` into your project's `.claude/` directory
> or paste it into `CLAUDE.md`. The skill tells the agent when and how to use memory.

---
```

- [ ] **Step 2: Add optional services note**

After the two mode sections, add before `## Development`:

```markdown
### Optional Services

```bash
# OpenSearch dashboard (browse memories at http://localhost:5601)
docker compose --profile dashboard up -d
```

---
```

- [ ] **Step 3: Verify README renders**

```bash
# Check for broken markdown (unmatched backtick fences etc.)
grep -n '```' README.md | awk -F: '{print NR": "$0}' | head -30
```

Expected: backtick fences are paired (even number of ``` lines per block).

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document MCP and API+CLI modes; add skill file instructions"
```

---

## Final Verification

- [ ] **Full API mode smoke test**

```bash
# Clean state
docker compose --profile api down -v 2>/dev/null; true
docker compose --profile api up -d

# Wait for healthy
echo "Waiting for server..."
for i in $(seq 1 20); do
  curl -sf http://localhost:8080/health >/dev/null 2>&1 && echo "Ready!" && break
  sleep 3
done

# Run full flow
OPENMEMORY_URL=http://localhost:8080
MEM_ID=$(./scripts/mem save "Integration test memory $(date)" \
  --importance 0.7 --tags test | jq -r '.id')
echo "Saved: $MEM_ID"
./scripts/mem search "Integration test" | jq '.results | length'
./scripts/mem get "$MEM_ID" | jq '.memory.id'
./scripts/mem delete "$MEM_ID" | jq '.deleted'

docker compose --profile api down
echo "Full smoke test: PASS"
```

Expected: save returns an ID, search returns ≥1 result, get returns the memory, delete returns `true`.

- [ ] **MCP mode unaffected**

```bash
cargo build --release --bin openmemory-mcp 2>&1 | tail -2
```

Expected: `Finished` — MCP binary still compiles cleanly.
