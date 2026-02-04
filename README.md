# OpenMemory

A lightweight, local, shared memory system for AI tools and agents via MCP (Model Context Protocol).

OpenMemory provides persistent, searchable memory for AI assistants without the cost and latency of traditional RAG pipelines. It uses hybrid retrieval (BM25 + importance scoring) to deliver fast, token-efficient context.

## Features

- **Local-first** - All data stays on your machine
- **MCP-native** - Works with Claude, GPT, and other MCP-compatible tools
- **Fast retrieval** - BM25 search via OpenSearch (< 10ms)
- **Token-efficient** - Returns only relevant memories, not entire history
- **Privacy-first** - No cloud, no telemetry

## Architecture

```
┌─────────────────────────────┐
│  AI Tool (Claude/GPT/etc)   │
│       via MCP client        │
└─────────────┬───────────────┘
              │ MCP (stdio)
┌─────────────▼───────────────┐
│     OpenMemory MCP Server   │
│         (Rust/Axum)         │
├─────────────┬───────────────┤
│ PostgreSQL  │  OpenSearch   │
│  (metadata) │  (BM25 search)│
└─────────────┴───────────────┘
              │
       Next.js Dashboard
```

See [docs/DESIGN.md](docs/DESIGN.md) for detailed architecture and workflow diagrams.

## Quick Start

### 1. Start infrastructure

```bash
docker compose up -d
```

This starts:
- PostgreSQL (localhost:5432)
- OpenSearch (localhost:9200)
- OpenSearch Dashboards (localhost:5601)
- Redis (localhost:6379, optional caching)

### 2. Build and run the MCP server

```bash
cargo build --release --bin openmemory-mcp
```

### 3. Configure your AI tool

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "openmemory": {
      "command": "/absolute/path/to/openmemory/target/release/openmemory-mcp",
      "env": {
        "DATABASE_URL": "postgres://openmemory:openmemory@localhost:5432/openmemory",
        "OPENSEARCH_URL": "http://localhost:9200"
      }
    }
  }
}
```

**Claude Code** (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "openmemory": {
      "command": "/PATH-TO-PROJECT/openmemory/target/release/openmemory-mcp",
      "env": {
        "DATABASE_URL": "postgres://openmemory:openmemory@localhost:5432/openmemory",
        "OPENSEARCH_URL": "http://localhost:9200",
        "REDIS_URL": "redis://localhost:6379"
      }
    }
  }
}
```

### 4. Restart your AI tool

The AI now has access to:
- **memory_save** - Save important information
- **memory_search** - Retrieve relevant memories

## MCP Tools

### memory_save

Save important information for later recall.

```json
{
  "content": "User prefers TypeScript over JavaScript",
  "summary": "TypeScript preference",
  "importance": 0.8,
  "tags": ["preference", "coding"]
}
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `content` | string | Yes | The information to remember |
| `summary` | string | No | Brief summary |
| `importance` | number | No | 0.0-1.0 (default: 0.5) |
| `tags` | string[] | No | Categorization tags |

### memory_search

Search memories by keywords.

```json
{
  "query": "TypeScript preferences",
  "limit": 5
}
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Search keywords |
| `limit` | number | No | Max results (default: 5) |

## Development

### Prerequisites

- Rust 1.75+
- Node.js 20+
- pnpm 9+
- Docker

### Install dependencies

```bash
pnpm install
```

### Build everything

```bash
pnpm turbo run build
```

### Run in development mode

```bash
pnpm turbo run dev
```

### Seed test data

```bash
cd scripts
source venv/bin/activate  # or: uv venv venv && source venv/bin/activate
uv pip install -r requirements.txt
python seed-data.py --count 1000
```

## Project Structure

```
openmemory/
├── apps/
│   ├── server/           # Rust MCP server
│   └── web/              # Next.js dashboard
├── packages/
│   ├── sdk/              # TypeScript SDK (planned)
│   └── shared-types/     # Shared types (planned)
├── scripts/
│   ├── seed-data.py      # Demo data seeder
│   └── sample.sh         # API test script
├── docs/
│   ├── DESIGN.md         # Architecture & design
│   └── plan/             # Planning documents
├── docker-compose.yml
└── turbo.json
```

## How It Works

Unlike traditional RAG that embeds everything and performs expensive vector searches, OpenMemory uses:

1. **BM25 lexical search** - Fast full-text search via OpenSearch
2. **Importance scoring** - User-defined priority (0.0-1.0)
3. **Recency boost** - Recent memories rank higher
4. **Minimal context** - Returns only top 3-5 relevant memories

**Scoring formula:**
```
score = importance * 0.6 + recency * 0.4
```

| Method | Cost | Speed | Tokens |
|--------|------|-------|--------|
| Full RAG | High | Slow | High |
| Chat History | Medium | Medium | Very High |
| **OpenMemory** | **Low** | **Fast** | **Low** |

## Troubleshooting

### MCP tool shows as "failed"

1. Check logs: `tail -f ~/Library/Logs/Claude/mcp*.log` (macOS)
2. Verify the binary path is absolute
3. Ensure Docker services are running: `docker compose ps`
4. Test manually:
   ```bash
   echo '{"jsonrpc":"2.0","id":1,"method":"initialize"}' | ./target/release/openmemory-mcp
   ```

### Database connection errors

Make sure PostgreSQL and OpenSearch are healthy:
```bash
docker compose ps
curl http://localhost:9200  # Should return OpenSearch info
```

## License

MIT
