# OpenMemory

Local-first memory, planning, knowledge graphs, and secure integrations for AI agents.

OpenMemory 0.2.0 combines persistent memory with project tasks, decision history, reusable workflows, registered resources, codebase graphs, design documents, cost forecasts, and credential-safe network tools. Data stays in your local services unless you explicitly configure an outbound workflow, LLM provider, HTTP request, or SSH action.

Current release: **v0.2.0** · [Release notes](version/0.2.0.md) · [License](LICENSE)

## What is included

| Capability | What it provides |
|---|---|
| Persistent memory | BM25 search, importance/recency ranking, tags, summaries, and explicit memory relationships |
| Temporal knowledge graph | Episodes, entities, time-valid facts, entity history, and graph-assisted retrieval |
| Environment parameters | AES-GCM encrypted settings and secrets with server-side credential use |
| Resource catalog | Discoverable local paths, URLs, tags, and linked account configuration |
| Projects and tasks | Roadmaps, subtasks, scheduling, routines, lessons, notes, and decision checkpoints |
| Project code graphs | Tree-sitter indexing, graph queries, node details, paths, hubs, and rebuilds |
| Reusable workflows | Stored HTTP and agent-assisted processes with resumable execution |
| Design workspace | Text, Mermaid, draw.io, React Flow, and OpenPencil documents with budget forecasts |
| Asset library | Searchable image, video, and live-code candidates, optionally scoped to projects |
| Session recording | Passive history for Claude Code, Gemini CLI, Codex CLI, and configurable JSONL agent paths |
| Web dashboard | Memory, agents, projects, files, source control, designs, lessons, workflows, and settings |

## Quick start

### Prerequisites

- Docker with Compose v2
- Rust toolchain (to build the MCP and watcher binaries)
- `curl` and `jq` for the `mem` CLI
- Node.js and pnpm only for non-Docker web development

### 1. Create local secrets

The API server and MCP process refuse to start without `OPENMEMORY_SECRET_KEY`. Keep the same value for both processes or encrypted environment values will be unreadable.

```bash
umask 077
OPENMEMORY_SECRET_KEY_VALUE=$(openssl rand -base64 48)
OPENMEMORY_API_TOKEN_VALUE=$(openssl rand -hex 32)
printf 'OPENMEMORY_SECRET_KEY=%s\nOPENMEMORY_API_TOKEN=%s\n' \
  "$OPENMEMORY_SECRET_KEY_VALUE" "$OPENMEMORY_API_TOKEN_VALUE" > .env
unset OPENMEMORY_SECRET_KEY_VALUE OPENMEMORY_API_TOKEN_VALUE
```

Do not commit `.env`.

### 2. Start storage

```bash
docker compose up -d
docker compose ps
```

This starts PostgreSQL, OpenSearch, Redis, and FalkorDB.

### 3. Start the API

Start only the backend and its dependencies:

```bash
docker compose --profile api up -d openmemory-server
curl -s http://localhost:18080/health
```

Expected response:

```json
{"status":"ok"}
```

The API listens on `127.0.0.1:18080` by default. The CLI uses the same default.

### 4. Use the CLI

```bash
export PATH="$PWD/scripts:$PATH"
set -a
source .env
set +a

mem save "The service uses Rust and PostgreSQL" \
  --importance 0.7 --tags openmemory,architecture
mem search "service architecture" --limit 5
mem list --limit 20
```

`mem` resolves its bearer token from `OPENMEMORY_API_TOKEN`, then `~/.openmemory/api_token`. Override the server with `OPENMEMORY_URL`.

### 5. Build and connect the MCP server

```bash
cargo build --release --bin openmemory-mcp
```

Configure an MCP-compatible client to run the binary with the same encryption secret as the API. This generic configuration loads the repository `.env` without copying the secret into the client configuration:

```json
{
  "mcpServers": {
    "openmemory": {
      "command": "/bin/bash",
      "args": [
        "-lc",
        "set -a; source /absolute/path/to/openmemory/.env; exec /absolute/path/to/openmemory/target/release/openmemory-mcp"
      ],
      "env": {
        "DATABASE_URL": "postgres://openmemory:openmemory@localhost:5432/openmemory",
        "OPENSEARCH_URL": "http://localhost:9201",
        "FALKORDB_URL": "redis://localhost:6380"
      }
    }
  }
}
```

Replace both absolute paths. Restart the client session after rebuilding; an existing stdio MCP process cannot hot-reload new tools.

## Web dashboard

The complete API profile serves:

- dashboard: <http://localhost:13000>
- API: <http://localhost:18080>
- local draw.io editor/viewer: <http://localhost:18081>
- local OpenPencil embed: <http://localhost:18082>

The full profile expects compatible sibling checkouts by default:

```text
parent/
├── openmemory/
├── drawio/
└── open-pencil/
```

Override their locations when necessary:

```bash
export DRAWIO_WEBAPP_PATH=/absolute/path/to/drawio/src/main/webapp
export OPEN_PENCIL_PATH=/absolute/path/to/open-pencil
export OPENMEMORY_ROOT="$PWD"
docker compose --profile api up -d --build
```

`NEXT_PUBLIC_DRAWIO_EDITOR_URL`, `NEXT_PUBLIC_DRAWIO_VIEWER_URL`, and `NEXT_PUBLIC_OPEN_PENCIL_URL` are compiled into the web bundle; rebuild the web image after changing them.

## Core workflows

### Persistent memory

Store only durable facts, preferences, decisions, and constraints. Do not manually save conversation transcripts; the watcher handles them.

```bash
mem save "Use rustls in deployment images because OpenSSL is unavailable" \
  --importance 0.8 --tags rust,deployment,decision \
  --summary "TLS dependency decision"

mem search "deployment TLS" --limit 5
mem get <uuid>
mem delete <uuid>
```

Use `mem save ... --auto` to fill only omitted importance, tags, or summary fields using the LLM configured under LLM Settings. Preview suggestions with:

```bash
mem autofill memory "<content>"
mem autofill task "<content>"
mem autofill resource "<content>"
```

Autofill is optional and never overrides explicitly supplied fields.

### Projects, tasks, and decisions

Projects can be planning-only containers or linked to a local repository. MCP tools manage tasks, subtasks, dates, labels, status, and priority. Task notes are append-only and support human/agent decision checkpoints:

- decisions may be open questions or contain up to six choices;
- selection mode may be `single` or `multiple`;
- answers may select options, include a custom reply, or both;
- re-answering preserves earlier answer history.

Use `project_list` to resolve a project ID, then `project_task_list`, `project_task_create`, `project_task_update`, and the `project_task_note_*` tools.

### Routines and lessons

Routines materialize recurring work as dated tasks. The API server checks due routines in the background every five minutes by default; `routine_check` also supports an explicit or dry-run check.

Lessons store per-project corrections and conventions. Reusing a normalized title increments its occurrence count rather than adding a duplicate. Archive superseded lessons instead of deleting them.

```bash
mem lessons --project <uuid> --query "authentication" --limit 20
```

Lesson writes use the MCP tools or authenticated REST routes; the CLI command is read-only.

### Resources and asset library

Resources register source material: local paths, websites, tags, and the environment keys needed for an account. Search before adding to prevent duplicate catalog entries.

```bash
mem resource-list --query "design" --tags ui,reference
mem resource-tags
mem resource-get <id-or-name>
mem resource-add docs --kind path --location /absolute/path/to/docs \
  --description "Project documentation" --tags project,docs
```

The asset library is for already-created image, video, or self-contained HTML/CSS/JS candidates. It catalogs and previews content; it does not generate or validate it.

### Project code graphs

Registering a project path indexes Rust, TypeScript, JavaScript, and Python with tree-sitter and records recognized files. MCP clients can:

- search a code graph with IDF-weighted, multi-hop traversal;
- inspect a node and its direct edges;
- find shortest paths and highly connected hubs;
- rebuild after code changes;
- delete the registered graph without deleting source files.

### Reusable workflows

Workflows are ordered HTTP and agent-assisted processes configured in **Settings → Workflows**.

1. Call `workflow_list` to discover an existing process.
2. Call `workflow_get` for its input schema.
3. Call `workflow_run` with the workflow name/ID and input.
4. If the result is `action_required`, perform the host-agent action and call `workflow_continue` with its structured result.
5. Repeat until `completed`; execution stops on failure.

Inputs support text, JSON, image, PDF, generic file, and unrestricted values. HTTP nodes run server-side, so referenced credentials remain inside OpenMemory.

### Project sync and source control

Projects linked to Git repositories can export database-backed project data to a `.openmemory/` bundle:

```text
.openmemory/
├── manifest.json
├── docs/
├── tasks/
├── routines/
└── lessons/
```

The bundle includes document metadata/content, tasks and decision history, routines, lessons, and design budgets. Import merges by stable ID and does not delete records absent from the bundle.

```bash
TOKEN="${OPENMEMORY_API_TOKEN:-$(tr -d '[:space:]' < ~/.openmemory/api_token)}"
BASE="${OPENMEMORY_URL:-http://localhost:18080}"

curl -s -X POST "$BASE/projects/<uuid>/sync" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"action":"export"}' | jq .

curl -s -X POST "$BASE/projects/<uuid>/sync" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"action":"import"}' | jq .
```

Inspect exported changes before committing. The web UI can create AI-assisted commit messages and commit/push selected files separately.

### Forecasts, designs, and budgets

Forecast profiles capture application type, user count, budget, stress tolerance, usage shape, engagement, planning horizon, and growth. Design budgets attach auditable service line items, conditions, confidence, and pricing basis to a project document. Monthly totals are derived from costs stored in cents.

The design workspace supports:

- Markdown/text with Mermaid preview;
- Mermaid source;
- draw.io XML through a self-hosted editor;
- native React Flow architecture diagrams with AWS icons;
- OpenPencil documents through the local embed;
- AI diagram and budget suggestions when an LLM is configured.

## MCP tool reference

OpenMemory 0.2.0 exposes 69 MCP tools:

| Group | Tools |
|---|---|
| Memory | `memory_save`, `memory_search`, `memory_graph_neighbors`, `memory_graph_relate` |
| Temporal graph | `graph_add_episode`, `graph_add_entity`, `graph_add_fact`, `graph_query_facts`, `graph_query_at`, `graph_get_entity_history`, `graph_get_entity` |
| Environment and secure actions | `env_set`, `env_get`, `env_rename`, `env_list`, `env_delete`, `env_http_request`, `env_http_download`, `env_sign_jwt`, `env_http_request_jwt`, `env_set_file`, `env_google_service_account_request`, `env_ssh_execute` |
| Resources | `resource_list`, `resource_tags`, `resource_get`, `resource_add`, `resource_update`, `resource_delete` |
| Asset library | `library_add`, `library_list`, `library_get`, `library_delete` |
| Project code graphs | `project_graph_list`, `project_graph_create`, `project_graph_query`, `project_graph_node_detail`, `project_graph_shortest_path`, `project_graph_god_nodes`, `project_graph_delete`, `project_graph_rebuild` |
| Workflows | `workflow_list`, `workflow_get`, `workflow_run`, `workflow_continue` |
| Forecasts | `forecast_list`, `forecast_create`, `forecast_update`, `forecast_delete` |
| Design budgets | `design_budget_list`, `design_budget_create`, `design_budget_update`, `design_budget_delete` |
| Projects and tasks | `project_list`, `project_create`, `project_task_list`, `project_task_create`, `project_task_note_list`, `project_task_note_create`, `project_task_note_decide`, `project_task_update`, `project_task_delete` |
| Lessons | `lesson_create`, `lesson_list`, `lesson_update`, `lesson_delete` |
| Routines | `routine_check`, `routine_list`, `routine_create` |

See [the bundled OpenMemory skill](skills/openmemory/SKILL.md) for agent operating guidance and safety rules.

## CLI reference

```text
mem save <content> [--importance N] [--tags a,b] [--summary TEXT] [--auto]
mem search <query> [--limit N]
mem list [--limit N]
mem get <uuid>
mem delete <uuid>

mem autofill memory|task|resource <content>

mem env-set <key> <value> [--secret] [--description TEXT]
mem env-rename <old-key> <new-key> [--value VALUE] [--secret|--normal]
mem env-get <key>
mem env-list
mem env-delete <key>

mem resource-list [--kind path|url] [--query TEXT] [--tags a,b]
mem resource-tags
mem resource-get <id-or-name>
mem resource-add <name> --kind path|url --location <location> [...]
mem resource-update <uuid> [...]
mem resource-delete <uuid>

mem lessons [--project <uuid>] [--query TEXT] [--limit N]

mem sessions [--limit N]
mem sessions <uuid>
mem sessions messages <uuid> [--limit N] [--after N]
```

Run `./scripts/mem --help` for every option.

## Session watcher

Start passive recording separately or with the API profile:

```bash
docker compose --profile watcher up -d
docker compose --profile api --profile watcher up -d
```

The watcher mounts supported log directories read-only. Set `WATCHER_POLL_INTERVAL_SEC=30` when filesystem events do not propagate through Docker bind mounts (common on Docker Desktop, macOS, and WSL).

```bash
mem sessions --limit 20
mem sessions messages <uuid> --limit 200
docker compose logs openmemory-watcher
```

## Architecture

```mermaid
flowchart LR
    Agent[MCP client] --> MCP[openmemory-mcp]
    CLI[mem CLI] --> API[openmemory-server]
    Web[Next.js dashboard] --> API
    Watcher[session watcher] --> PG[(PostgreSQL)]
    MCP --> PG
    API --> PG
    MCP --> OS[(OpenSearch)]
    API --> OS
    MCP --> FG[(FalkorDB)]
    API --> FG
    API --> Redis[(Redis cache)]
    API --> Blobs[(design/library volumes)]
```

| Store | Purpose |
|---|---|
| PostgreSQL 17 | metadata, environment parameters, sessions, projects, planning records, workflows |
| OpenSearch 2.18 | full memory content and BM25 search |
| Redis 7 | optional search-result cache |
| FalkorDB | temporal entities/facts and memory relationships |
| Docker volumes | design and uploaded library blobs |

## Security

### Network exposure

The API container publishes only to `127.0.0.1` by default. The backing PostgreSQL, OpenSearch, Redis, and FalkorDB mappings use development credentials and currently publish on all interfaces. On a shared or network-exposed machine, prefix those mappings with `127.0.0.1:` or put them behind equivalent network controls.

Authentication is applied per handler, not as global middleware. The health endpoint, legacy `/mcp` memory operations, and session-history reads are not bearer-gated. Project, workflow, library, design, agent-management, and other sensitive handlers enforce the API token individually; authenticated secret reads require it as well. Keep the API local and do not treat the bearer token as a substitute for network isolation.

### Encrypted parameters

Environment values are encrypted at rest with AES-256-GCM using a key derived from `OPENMEMORY_SECRET_KEY`. Secret values cannot be returned through MCP `env_get`; use their key names with server-side operations instead.

Use `env_set_file` for private keys, certificates, or service-account JSON so bytes never enter an agent tool call. Prefer:

- `env_http_request` for authenticated text/JSON responses;
- `env_http_download` for binary responses written to an absolute local path;
- `env_http_request_jwt` instead of returning a live token from `env_sign_jwt`;
- `env_google_service_account_request` for Google OAuth service accounts.

Set `OPENMEMORY_HTTP_ALLOWED_HOSTS` to constrain credential-bearing outbound HTTP requests.

### SSH controls

`env_ssh_execute` is fail-closed unless `OPENMEMORY_SSH_ALLOWED_HOSTS` permits the target. Pin each server with `<ssh_key_key>.host_key_fingerprint`; optionally bind a key further with `<ssh_key_key>.allowed_hosts`. SSH execution has no PTY, forwarding, agent forwarding, or password authentication.

`OPENMEMORY_SSH_ALLOW_UNKNOWN_HOST_KEY=1` is an emergency development bypass, not a production setting.

### Rotate the encryption key

Back up PostgreSQL first. Preview and then perform a transactional rotation:

```bash
OPENMEMORY_OLD_SECRET_KEY='<old>' \
OPENMEMORY_NEW_SECRET_KEY='<new>' \
DATABASE_URL='postgres://openmemory:openmemory@localhost:5432/openmemory' \
  cargo run --release --bin openmemory-server -- rotate-secret-key --dry-run

OPENMEMORY_OLD_SECRET_KEY='<old>' \
OPENMEMORY_NEW_SECRET_KEY='<new>' \
DATABASE_URL='postgres://openmemory:openmemory@localhost:5432/openmemory' \
  cargo run --release --bin openmemory-server -- rotate-secret-key
```

Update both the API and MCP configuration to the new key after rotation.

## Development

```bash
# Rust checks
cargo fmt --check
cargo test --workspace
cargo build --release

# Web checks
pnpm install
pnpm --filter web build

# Run the web workspace in development mode
pnpm dev
```

Repository layout:

```text
openmemory/
├── apps/server/           Rust API, MCP server, and watcher
├── apps/web/              Next.js dashboard
├── skills/openmemory/     bundled agent skill
├── scripts/mem            command-line client
├── docker/                local editor/embed support
├── docs/                  architecture, design, and implementation notes
├── version/               release summaries
└── docker-compose.yml     local service stack
```

## Backup and recovery

Back up the Docker volumes for PostgreSQL, OpenSearch, FalkorDB, design blobs, and library blobs. Redis is a cache and is not required for recovery. Preserve `OPENMEMORY_SECRET_KEY`; losing it makes encrypted environment values unrecoverable.

Project `.openmemory/` exports are useful Git-friendly mirrors of planning/design data, but they are not a complete database backup.

## Troubleshooting

### API does not start

```bash
docker compose --profile api ps
docker compose logs openmemory-server
curl -s http://localhost:18080/health
```

Confirm `.env` contains a non-empty `OPENMEMORY_SECRET_KEY`.

### MCP server is not recognized

- use absolute paths in client configuration;
- verify `cargo build --release --bin openmemory-mcp` succeeded;
- ensure MCP and API use the same `OPENMEMORY_SECRET_KEY`;
- verify PostgreSQL and OpenSearch are healthy;
- restart the MCP client session after rebuilding.

### Search fails

```bash
docker compose ps postgres opensearch
curl -s http://localhost:9201
docker compose logs opensearch
```

### Watcher records no sessions

- confirm the relevant host log directory exists;
- inspect `docker compose logs openmemory-watcher`;
- set `WATCHER_POLL_INTERVAL_SEC=30` when bind-mount notifications are unreliable;
- check container read permissions for the mounted directories.

## License

[MIT](LICENSE)
