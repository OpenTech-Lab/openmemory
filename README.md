# 🧠 OpenMemory

**A lightweight, local-first shared memory system for AI agents.**

Give your AI tools persistent memory without the complexity and cost of traditional RAG systems. OpenMemory uses fast BM25 search (< 10ms) instead of expensive embeddings, keeping everything local and private.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## 🎯 Why OpenMemory?

Most AI tools either **forget everything** between sessions or require **expensive RAG pipelines** with embedding APIs. OpenMemory provides a better middle ground:

| Feature | Traditional RAG | OpenMemory |
|---------|----------------|------------|
| **Speed** | ~100ms+ per search | < 10ms with BM25 |
| **Cost** | Embedding API costs | Zero - fully local |
| **Privacy** | Cloud dependencies | 100% local storage |
| **Setup** | Complex pipelines | `docker compose up` |
| **Integration** | Custom per tool | Standard MCP protocol |

### Real-World Benefits

- **Persistent Context**: AI remembers your preferences, project decisions, and past conversations
- **Cross-Tool Memory**: Share context between Claude Code, Cursor, and other MCP-compatible tools
- **Smart Retrieval**: Importance scoring + recency weighting surfaces the most relevant memories
- **Privacy First**: All data stays on your machine - no external API calls
- **Developer Friendly**: Simple `memory_save` / `memory_search` API

---

## 📸 Screenshots

### Memory Graph Visualization
![Memory Graph](docs/images/graph.png)

### Memory Search Interface
![Memory Interface](docs/images/memory.png)

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

Your AI now has two new tools:

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

> 💡 **Pro Tip:** Before ending a conversation, ask: *"Please save anything important from our discussion"* to ensure key information is remembered.

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

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      AI Tool (MCP)                      │
│              (Claude Code, Cursor, etc.)                │
└──────────────────┬──────────────────────────────────────┘
                   │ stdio (MCP protocol)
                   ▼
┌─────────────────────────────────────────────────────────┐
│                  OpenMemory MCP Server                  │
│           (Rust binary: openmemory-mcp)                 │
└──────────────────┬──────────────────────────────────────┘
                   │
       ┌───────────┼───────────┐
       ▼           ▼           ▼
   PostgreSQL  OpenSearch   Redis
   (Storage)   (Search)   (Cache)
```

### How It Works

1. **Save**: AI calls `memory_save` → MCP server → PostgreSQL + OpenSearch index
2. **Search**: AI calls `memory_search` → MCP server → OpenSearch BM25 query → Redis cache → ranked results
3. **Score**: Results ranked by: `importance * 0.6 + recency * 0.4`

See [docs/MVP.md](docs/MVP.md) for detailed architecture and design decisions.

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

- **Project Context**: Save architectural decisions, coding preferences, and project conventions
- **Bug Tracking**: Remember past bugs, their solutions, and related code patterns
- **Refactoring History**: Track what was changed, why, and lessons learned

### For Researchers

- **Literature Notes**: Store key findings from papers and articles
- **Experiment Results**: Log outcomes, hypotheses, and insights
- **Research Questions**: Maintain evolving questions and answers

### For Writers

- **Character Details**: Remember character traits, backstories, and relationships
- **Plot Points**: Track story arcs, themes, and narrative decisions
- **Style Preferences**: Store voice, tone, and formatting guidelines

---

## 🔒 Privacy & Security

- **100% Local**: All data stays on your machine
- **No Telemetry**: Zero external network calls
- **No Cloud Dependencies**: Works completely offline
- **Open Source**: Full transparency - audit the code yourself

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
- [OpenSearch](https://opensearch.org/) - Fast BM25 search
- [PostgreSQL](https://www.postgresql.org/) - Reliable storage
- [Axum](https://github.com/tokio-rs/axum) - Rust web framework
- [React](https://react.dev/) - UI framework

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
