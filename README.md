# 🧠 OpenMemory

**A complete local memory infrastructure for AI agents.**

OpenMemory provides **persistent memory**, **environment configuration**, **knowledge graphs**, and **automatic conversation recording** - all local, all fast, all private.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## 🚀 Quick Start (3 commands)

```bash
# 1. Start infrastructure
docker compose up -d

# 2. Build MCP server
cargo build --release --bin openmemory-mcp

# 3. Add to ~/.claude/settings.json
{
  "mcpServers": {
    "openmemory": {
      "command": "/absolute/path/to/openmemory/target/release/openmemory-mcp",
      "env": {
        "DATABASE_URL": "postgres://openmemory:openmemory@localhost:5432/openmemory",
        "OPENSEARCH_URL": "http://localhost:9201",
        "REDIS_URL": "redis://localhost:6399"
      }
    }
  }
}
```

See [detailed setup instructions](#-quick-start) below for all integration modes.

---

## ✨ Core Features

### 1. 💾 Persistent Memory
Save and search important information across sessions. No embeddings, no API costs - just fast BM25 search (<10ms).

```bash
mem save "User prefers TypeScript" --importance 0.8 --tags preference
mem search "typescript" --limit 5
```

### 2. 🔐 Environment Parameters
Secure key-value store for configuration and secrets with agent access control. Store API keys, endpoints, and preferences that AI agents can reference safely.

```bash
mem env-set OPENAI_API_KEY "sk-..." --secret
mem env-set DEFAULT_MODEL "gpt-4o" --description "Preferred LLM model"
```

### 3. 🕸️ Knowledge Graph
Temporal knowledge graph (powered by FalkorDB) automatically builds entity relationships and tracks how facts evolve over time. Uses Graphiti-inspired Episode/Entity/Fact model.

```bash
# Entities and relationships are extracted automatically from saved memories
# Query via web UI or direct Cypher queries
```

### 4. 📝 Automatic Session Recording
Passive session watcher tails conversation logs from Claude Code, Gemini CLI, and Codex CLI - no agent involvement needed. All conversations are automatically stored and searchable.

```bash
mem sessions --limit 10              # List recent sessions
mem sessions messages <uuid>         # View conversation history
```

### 5. 📚 Lessons Learned
Structured, per-project store for corrections and conventions — queryable instead of scattered `tasks/lessons.md` files. Agents record a lesson (title, context, rule) after a correction, load them all back at session start, and re-recording the same title bumps an occurrence count instead of duplicating.

```bash
mem lessons --project <uuid> --query "shadcn"   # read-only CLI; writes go through the agent via MCP
```

Browsable, editable web UI at `/lessons` in the web app (also as a tab on each project's detail page).

---

## 🎯 Why OpenMemory?

Most AI tools either **forget everything** between sessions or require **expensive RAG pipelines** with embedding APIs. OpenMemory provides a better, integrated solution:

| Feature | Traditional RAG | OpenMemory |
|---------|----------------|------------|
| **Speed** | ~100ms+ per search | < 10ms with BM25 |
| **Cost** | Embedding API costs | Zero - fully local |
| **Privacy** | Cloud dependencies | 100% local storage |
| **Setup** | Complex pipelines | `docker compose up` |
| **Integration** | Custom per tool | Standard MCP protocol |
| **Configuration** | Manual env vars | Secure parameter store |
| **Knowledge** | Flat documents | Temporal graph |
| **Sessions** | Manual logging | Automatic recording |

### Real-World Benefits

- **Persistent Context**: AI remembers your preferences, project decisions, and past conversations
- **Secure Configuration**: Store API keys and secrets that agents can reference but not leak
- **Knowledge Evolution**: Track how facts and relationships change over time
- **Automatic History**: All conversations recorded passively - no manual saving needed
- **Cross-Tool Memory**: Share context between Claude Code, Cursor, and other MCP-compatible tools
- **Smart Retrieval**: Importance scoring + recency weighting + graph relationships surface the most relevant information
- **Privacy First**: All data stays on your machine - no external API calls
- **Developer Friendly**: Simple `memory_save` / `memory_search` / `env_set` / `sessions` APIs

---

## 📸 Screenshots

### Memory Graph Visualization
![Memory Graph](docs/images/graph.png)

### Memory Search Interface
![Memory Interface](docs/images/memory.png)

---

## 🎁 What You Get

OpenMemory is a **complete memory infrastructure** in one package:

| Component | What It Does | Why It Matters |
|-----------|--------------|----------------|
| **Memory Store** | Save and search facts, preferences, and decisions | AI remembers context across sessions |
| **Environment Params** | Secure key-value store for config and secrets | No more hardcoded API keys or env files |
| **Knowledge Graph** | Temporal entity/fact relationships with FalkorDB | Track how knowledge evolves over time |
| **Session Recorder** | Automatic conversation logging from AI tools | Complete audit trail, searchable history |
| **Web Dashboard** | Visual interface for all features | Manage and explore your data easily |
| **CLI Tools** | Command-line access to all operations | Script and automate memory operations |
| **MCP Integration** | Standard protocol support | Works with Claude Code, Cursor, any MCP tool |
| **Fast Search** | BM25 full-text via OpenSearch (<10ms) | No embedding costs, instant results |
| **Privacy First** | 100% local, no external calls | Your data never leaves your machine |

### Storage Layer

- **PostgreSQL**: Metadata, indexes, env params, session tables
- **OpenSearch**: Full-text BM25 search on memory content
- **Redis**: 5-minute search result cache
- **FalkorDB**: Temporal knowledge graph with Cypher queries

---

## 🚀 Quick Start

Choose your integration mode based on your use case:

### Mode 1: MCP Server (Recommended for AI Tools)

**Best for:** Claude Code, Cursor, and any MCP-compatible AI tool.

#### Step 1: Start Infrastructure

```bash
docker compose up -d
```

This starts:
- PostgreSQL (persistent storage)
- OpenSearch (fast BM25 search)
- Redis (caching)

#### Step 2: Build MCP Server

```bash
cargo build --release --bin openmemory-mcp
```

First build takes ~2-3 minutes. Subsequent builds are cached.

#### Step 3: Configure Your AI Tool

Add to your AI tool's MCP configuration. For **Claude Code**, edit `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "openmemory": {
      "command": "/absolute/path/to/openmemory/target/release/openmemory-mcp",
      "env": {
        "DATABASE_URL": "postgres://openmemory:openmemory@localhost:5432/openmemory",
        "OPENSEARCH_URL": "http://localhost:9201",
        "REDIS_URL": "redis://localhost:6399"
      }
    }
  }
}
```

> **Note:** Replace `/absolute/path/to/openmemory` with your actual project path. Use `pwd` to get it.

For **Cursor** or other tools, consult their MCP configuration documentation.

#### Step 4: Use It

Your AI now has comprehensive memory capabilities:

**💾 Memory Operations**

**`memory_save`** - Save important information
```json
{
  "content": "User prefers TypeScript over JavaScript",
  "importance": 0.8,
  "tags": ["preference", "typescript"]
}
```

**`memory_search`** - Find relevant memories
```json
{
  "query": "typescript preferences",
  "limit": 5
}
```

**🔐 Environment Parameters**

**`env_set`** - Store configuration and secrets
```json
{
  "key": "OPENAI_API_KEY",
  "value": "sk-...",
  "is_secret": true,
  "description": "OpenAI API key for GPT-4"
}
```

**`env_list`** - List available parameters (agents can call this to discover config)
```json
{}
```

**`env_get`** - Get normal parameter values (secrets blocked for agents)
```json
{
  "key": "DEFAULT_MODEL"
}
```

**🕸️ Knowledge Graph**

Graph operations happen automatically as you save memories. Query via web UI or direct Cypher:

**`graph.add_entity`** - Create/update entities
```json
{
  "name": "TypeScript",
  "entity_type": "Technology",
  "group_id": "default",
  "summary": "Typed superset of JavaScript"
}
```

**`graph.add_fact`** - Create relationships between entities
```json
{
  "source_entity_id": "uuid-1",
  "target_entity_id": "uuid-2",
  "name": "replaces",
  "fact": "TypeScript replaces JavaScript in modern projects",
  "valid_at": "2025-01-01T00:00:00Z"
}
```

**📝 Session Recording**

Sessions are recorded automatically. Query via CLI:

```bash
# List recent sessions
mem sessions --limit 10

# View session messages
mem sessions messages <session-uuid>
```

> 💡 **Pro Tip:** Before ending a conversation, ask: *"Please save anything important from our discussion"* to ensure key information is explicitly remembered with proper importance scoring.

---

### Mode 2: HTTP API + CLI

**Best for:** Shell scripts, CI pipelines, custom integrations, and AI agents that prefer HTTP over MCP.

#### Step 1: Start Infrastructure + API Server

```bash
docker compose --profile api up -d
```

> First run compiles Rust inside Docker (~3 min). Subsequent starts use the build cache.

The API server runs at `http://localhost:8080` with health check at `/health`.

#### Step 2: Use the CLI

Add the CLI to your PATH:

```bash
export PATH="$PWD/scripts:$PATH"
```

Or use it directly:

```bash
# Save a memory
./scripts/mem save "User prefers dark mode" --importance 0.7 --tags preference,ui

# Search memories
./scripts/mem search "dark mode"

# List recent memories
./scripts/mem list --limit 10

# Get memory details
./scripts/mem get <memory-id>
```

#### Step 3: Enable AI Agent Integration (Optional)

Install the OpenMemory skill so Claude Code automatically knows when and how to use memory:

```bash
# Global installation (available in all projects, invoke via /openmemory)
cp -r skills/openmemory ~/.claude/skills/openmemory

# Project-level only
mkdir -p .claude/skills && cp -r skills/openmemory .claude/skills/openmemory
```

---

### Mode 3: Session Watcher (Passive Recording)

**Best for:** Automatically recording AI conversations without requiring agent involvement.

The session watcher passively tails JSONL log files from supported AI tools and stores conversation history in PostgreSQL - no MCP integration or `memory_save` calls needed.

#### Supported Tools

| Tool | Log Path | Auto-Detected |
|------|----------|---------------|
| **Claude Code** | `~/.claude/projects/**/*.jsonl` | ✅ Yes |
| **Gemini CLI** | `~/.gemini/**/*.jsonl` | ✅ Yes |
| **Codex CLI** | `~/.codex/**/*.jsonl` | ✅ Yes |
| **GitHub Copilot** | N/A (no local logs) | ❌ No |

Tools not installed are automatically skipped - no configuration needed.

#### Setup

```bash
# Start infrastructure + watcher
docker compose --profile watcher up -d

# Or combine with API server
docker compose --profile api --profile watcher up -d
```

#### Query Recorded Sessions

```bash
# List recent sessions
mem sessions --limit 50

# Show session details
mem sessions <session-uuid>

# View messages in a session
mem sessions messages <session-uuid> --limit 200
```

#### Configure via Web UI

Open the dashboard at `http://localhost:3000` and navigate to **Agent Settings** to:
- Enable/disable specific tools
- Add custom directory paths to monitor
- Adjust polling intervals

#### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `WATCHER_POLL_INTERVAL_SEC` | _(unset)_ | Enable periodic re-scan fallback. Recommended for Docker Desktop / macOS / WSL where inotify may miss events. |

> **Permission Issues?** Add `user: "${UID}:${GID}"` to the `openmemory-watcher` service in `docker-compose.yml`.

---

### Optional: OpenSearch Dashboard

Explore your memory index directly:

```bash
docker compose --profile dashboard up -d
# Dashboard available at http://localhost:5601
```

---

## ✅ Setup Verification

After setup, verify everything is working:

### 1. Check Infrastructure Health

```bash
# All containers should be running
docker compose ps

# Check health status
curl http://localhost:8080/health        # Should return {"status":"ok"}
curl http://localhost:9201               # OpenSearch info
redis-cli -p 6399 PING                   # Should return "PONG"
```

### 2. Test Memory Operations

```bash
# Save a test memory
mem save "Test memory from setup" --importance 0.5 --tags test

# Search for it
mem search "test setup"

# List recent memories (should include your test)
mem list --limit 5
```

### 3. Test Environment Parameters

```bash
# Set a test parameter
mem env-set TEST_KEY "test_value" --description "Test parameter"

# List parameters
mem env-list

# Get the value back
mem env-get TEST_KEY

# Clean up
mem env-delete TEST_KEY
```

### 4. Check Session Recording (if using watcher profile)

```bash
# Generate some conversation in Claude Code, then check:
mem sessions --limit 5

# If no sessions appear:
# - Check watcher logs: docker compose logs openmemory-watcher
# - Verify conversation logs exist: ls ~/.claude/projects/
```

### 5. Test MCP Integration (if using Mode 1)

In Claude Code or your MCP-compatible tool, try:
- Ask the AI to search memory: "Search memory for 'test'"
- Ask it to save something: "Save this to memory: I prefer concise responses"
- Ask it to list env params: "What environment parameters are available?"

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      AI Tool (MCP)                      │
│              (Claude Code, Cursor, etc.)                │
└──────────────────┬──────────────────────────────────────┘
                   │ stdio (MCP protocol) or HTTP
                   ▼
┌─────────────────────────────────────────────────────────┐
│              OpenMemory MCP/HTTP Server                 │
│         (Rust binaries: openmemory-mcp/server)          │
└──────────────────┬──────────────────────────────────────┘
                   │
       ┌───────────┼────────────┬──────────────┐
       ▼           ▼            ▼              ▼
   PostgreSQL  OpenSearch    Redis        FalkorDB
   (Storage)   (BM25 Search) (Cache)  (Knowledge Graph)
       ▲
       │ inotify/poll
┌──────┴────────────────────────────────────────────────┐
│               Session Watcher                         │
│  Monitors: ~/.claude/**, ~/.gemini/**, ~/.codex/**    │
└───────────────────────────────────────────────────────┘
```

### How It Works

#### Memory Storage & Search
1. **Save**: AI calls `memory_save` → MCP/HTTP server → PostgreSQL (metadata) + OpenSearch (full-text index) + FalkorDB (graph node)
2. **Search**: AI calls `memory_search` → Check Redis cache → OpenSearch BM25 query → Merge with PostgreSQL importance scores → Return ranked results
3. **Score**: Results ranked by: `importance * 0.6 + recency * 0.4`

#### Environment Parameters
1. **Set**: `env_set` → AES-GCM encrypt value → Store in PostgreSQL `env_params` table
2. **Get**: `env_get` → Decrypt if normal param → Return value (secrets require API token)
3. **List**: `env_list` → Return all keys + types (no values for secrets)

#### Knowledge Graph
1. **Entities**: Extracted from saved memories → Deduplicated by (name, type, group_id) → Stored as FalkorDB nodes
2. **Facts**: Entity relationships with temporal validity → `FACT` edges with `valid_at` / `invalid_at` timestamps
3. **Episodes**: Conversation chunks that mention entities → Provenance tracking via `MENTIONS` edges
4. **Query**: Cypher queries at specific time points → Returns facts valid at that moment

#### Session Recording
1. **Watch**: Watcher monitors `~/.claude/projects/**/*.jsonl` and similar paths (inotify + fallback polling)
2. **Parse**: Extracts user/assistant messages from JSONL events
3. **Store**: Saves to `sessions` and `session_messages` tables in PostgreSQL
4. **Query**: Via `mem sessions` CLI or web UI

See [docs/design/architecture.md](docs/design/architecture.md) and [docs/design/graph-schema.md](docs/design/graph-schema.md) for detailed architecture.

---

## 📋 CLI Reference

The `mem` CLI provides access to all OpenMemory features:

### Memory Operations

```bash
# Save a memory
mem save "User prefers dark mode" --importance 0.8 --tags preference,ui

# Search memories
mem search "dark mode" --limit 5

# List recent memories
mem list --limit 20

# Get specific memory details
mem get <memory-uuid>

# Delete a memory
mem delete <memory-uuid>
```

### Environment Parameters

```bash
# List all parameters (shows keys + types, no secret values)
mem env-list

# Set normal parameter (agent can read)
mem env-set DEFAULT_MODEL "gpt-4o" --description "Preferred LLM model"

# Set secret parameter (agent cannot read)
mem env-set OPENAI_API_KEY "sk-..." --secret

# Get parameter value (only works for normal params)
mem env-get DEFAULT_MODEL

# Delete parameter
mem env-delete OLD_KEY
```

### Session History

```bash
# List recent sessions
mem sessions --limit 50

# Show session details
mem sessions <session-uuid>

# View messages in a session
mem sessions messages <session-uuid> --limit 200

# View messages after a specific message number
mem sessions messages <session-uuid> --after 10
```

### Graph Operations

Graph queries are currently available via web UI or direct Cypher queries to FalkorDB. CLI support coming soon.

---

## 🛠️ Development

### Prerequisites

- **Rust** 1.75+ (for MCP server)
- **Node.js** 18+ (for web UI)
- **pnpm** 9+ (package manager)
- **Docker** & Docker Compose (for infrastructure)

### Local Development

```bash
# Install dependencies
pnpm install

# Start all services (web UI + API)
pnpm turbo run dev

# Or just the web UI
pnpm --filter web dev
```

### Project Structure

```
openmemory/
├── apps/
│   ├── server/          # Rust API server (Axum)
│   └── web/             # React web dashboard
├── packages/            # Shared TypeScript packages
├── scripts/
│   └── mem              # CLI tool (Python)
├── skills/
│   └── openmemory/      # Claude Code skill definition
├── src/
│   ├── mcp/             # MCP server implementation
│   ├── watcher/         # Session watcher
│   └── lib.rs           # Shared Rust library
├── docker-compose.yml   # Infrastructure services
└── Cargo.toml           # Rust workspace
```

### Seed Test Data

```bash
cd scripts
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python seed-data.py --count 1000
```

### Run Tests

```bash
cargo test
pnpm test
```

---

## 📖 Use Cases

### For Developers

**Memory:**
- Save architectural decisions, coding preferences, and project conventions
- Remember past bugs, their solutions, and related code patterns
- Track refactoring history - what was changed, why, and lessons learned

**Configuration:**
- Store API keys, database URLs, and service endpoints securely
- Share configuration across projects without hardcoding
- Different secrets for dev/staging/prod environments

**Knowledge Graph:**
- Track which libraries depend on which frameworks
- Map code ownership and component relationships
- Understand how system architecture evolved over time

**Session History:**
- Review past debugging sessions and solutions
- Search previous conversations for similar problems
- Track project timeline and decision history

### For Researchers

**Memory:**
- Store key findings from papers and articles
- Log experiment results and hypotheses
- Maintain evolving research questions and answers

**Configuration:**
- Manage API keys for different research services
- Store model parameters and hyperparameters
- Track compute cluster endpoints and credentials

**Knowledge Graph:**
- Map paper citations and author relationships
- Track concept evolution across papers
- Connect experiments to theoretical foundations

**Session History:**
- Review data analysis conversations
- Track experimental methodology discussions
- Document hypothesis evolution

### For Writers

**Memory:**
- Remember character details, traits, backstories, and relationships
- Track plot points, story arcs, themes, and narrative decisions
- Store voice, tone, and formatting guidelines

**Configuration:**
- Store API keys for research services and tools
- Manage publication submission credentials
- Track submission guidelines for different venues

**Knowledge Graph:**
- Map character relationships and interactions
- Track plot thread dependencies
- Connect themes across chapters/stories

**Session History:**
- Review past writing sessions and decisions
- Search for previous character development discussions
- Track story evolution and alternative paths considered

---

## 🔒 Privacy & Security

- **100% Local**: All data stays on your machine
- **No Telemetry**: Zero external network calls
- **No Cloud Dependencies**: Works completely offline
- **Open Source**: Full transparency - audit the code yourself

### Env Parameter Auth

`env.set` and `env.delete` on the HTTP API (`/mcp`) require the API bearer token —
same token used for `env.get` on secret params. The `mem` CLI reads it automatically
from `OPENMEMORY_API_TOKEN` or `~/.openmemory/api_token`; no extra setup needed.

### `env_http_request` Host Allowlist

The `env_http_request` MCP tool injects a decrypted secret into an outbound HTTP
request without exposing the value to the agent. Because the agent chooses the
destination URL, a compromised or prompt-injected agent could otherwise point this
at an arbitrary host to exfiltrate the secret. Set `OPENMEMORY_HTTP_ALLOWED_HOSTS`
(comma-separated hostnames) on the `openmemory-mcp` process to restrict which hosts
it's allowed to call — requests to any other host are rejected before the secret is
resolved. Unset by default (any host allowed) for backward compatibility.

### Encryption Key

Env-param secret values are encrypted at rest with a key derived from
`OPENMEMORY_SECRET_KEY`. If unset, the server falls back to a well-known dev key —
fine for local experimentation, but anyone with DB access can decrypt secrets in
that mode. Set `OPENMEMORY_SECRET_KEY` to a random value before storing anything
sensitive.

---

## 🤝 Contributing

Contributions are welcome! Please:

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Development Guidelines

- Write tests for new features
- Follow existing code style
- Update documentation as needed
- Keep commits atomic and well-described

---

## 📝 License

MIT License - see [LICENSE](LICENSE) for details.

---

## 🙏 Acknowledgments

Built with:
- [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) - Standard AI tool integration
- [OpenSearch](https://opensearch.org/) - Fast BM25 full-text search
- [PostgreSQL](https://www.postgresql.org/) - Reliable relational storage
- [FalkorDB](https://www.falkordb.com/) - High-performance graph database for knowledge graphs
- [Redis](https://redis.io/) - In-memory caching
- [Axum](https://github.com/tokio-rs/axum) - Rust async web framework
- [React](https://react.dev/) - UI framework
- [Graphiti](https://github.com/getzep/graphiti) - Temporal knowledge graph inspiration

---

## ❓ FAQ

### How is this different from RAG?

Traditional RAG embeds documents and uses vector search. OpenMemory uses BM25 keyword search (no embeddings needed) + importance scoring + temporal knowledge graphs. It's faster, cheaper, and captures structured relationships.

### Can I use this with tools other than Claude Code?

Yes! Any tool that supports MCP (Model Context Protocol) can use the MCP server. For non-MCP tools, use the HTTP API via the CLI or direct HTTP calls.

### Is my data encrypted?

Environment parameters marked as `secret` are encrypted at rest using AES-GCM. Regular memories and session data are stored in plaintext in PostgreSQL (since they're on your local machine). All services bind to localhost only.

### What happens if I lose my data?

All data is stored in Docker volumes. Back them up regularly:
```bash
docker volume ls  # List volumes
docker run --rm -v openmemory_postgres_data:/data -v $(pwd):/backup alpine tar czf /backup/postgres-backup.tar.gz /data
```

### Can I run this in production?

OpenMemory is designed for local development. For production, you'd need to:
- Add authentication (currently localhost-only)
- Configure TLS for external access
- Set up proper backups
- Review security model for your use case

### How much disk space does it use?

Depends on usage. Typical storage:
- Memory: ~1KB per memory
- Sessions: ~500 bytes per message
- Graph: ~2KB per entity, ~1KB per fact
- OpenSearch: ~3x memory content size (indexed)

### What's the performance like?

- Memory search: <10ms (BM25 + cache)
- Memory save: ~50ms (Postgres + OpenSearch + graph)
- Env param operations: <5ms
- Session recording: No impact (async background watcher)

---

## 🔧 Troubleshooting

### Docker containers won't start

```bash
# Check Docker is running
docker ps

# Check logs
docker compose logs postgres
docker compose logs opensearch

# Restart all services
docker compose down && docker compose up -d
```

### MCP server not recognized in Claude Code

1. Verify the binary exists: `ls -la target/release/openmemory-mcp`
2. Check the path in `~/.claude/settings.json` is absolute
3. Restart Claude Code after config changes
4. Check MCP server logs (Claude Code shows these in the UI)

### API health check fails

```bash
# Check if API server is running
curl http://localhost:8080/health

# If it fails, check if containers are up
docker compose --profile api ps

# Restart API server
docker compose --profile api restart openmemory-server

# Check logs
docker compose logs openmemory-server
```

### Session watcher not recording conversations

1. Verify watcher is running: `docker compose ps | grep watcher`
2. Check paths are correct: Sessions only record from `~/.claude/projects/`, `~/.gemini/`, `~/.codex/`
3. Check logs: `docker compose logs openmemory-watcher`
4. For Docker Desktop/macOS/WSL, set `WATCHER_POLL_INTERVAL_SEC=60` in docker-compose.yml (inotify may not work across bind mounts)

### OpenSearch out of memory

Edit docker-compose.yml and increase heap size:
```yaml
environment:
  OPENSEARCH_JAVA_OPTS: "-Xms1g -Xmx1g"  # Increase from 512m
```

### Permission errors in watcher

Add user mapping to docker-compose.yml:
```yaml
services:
  openmemory-watcher:
    user: "${UID}:${GID}"
```

Then restart: `docker compose --profile watcher restart openmemory-watcher`

---

## 📚 Documentation

- [Architecture & Design](docs/MVP.md)
- [MCP Server Implementation](src/mcp/)
- [CLI Tool Documentation](scripts/README.md)
- [Web Dashboard](apps/web/README.md)

---

## 💬 Support

- **Issues**: [GitHub Issues](https://github.com/yourusername/openmemory/issues)
- **Discussions**: [GitHub Discussions](https://github.com/yourusername/openmemory/discussions)

---

**Made with ❤️ for the AI agent community**
