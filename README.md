# OpenMemory

A lightweight, local, shared memory system for AI tools and agents via MCP.

## Why OpenMemory?

Most AI tools either forget everything, or use expensive RAG pipelines. OpenMemory provides a middle ground:

- **Fast** - BM25 search via OpenSearch (< 10ms)
- **Cheap** - No embedding API calls needed
- **Local** - All data stays on your machine
- **Simple** - Just `memory_save` and `memory_search`

See [docs/DESIGN.md](docs/DESIGN.md) for architecture details.

## Quick Start

### 1. Start infrastructure

```bash
docker compose up -d
```

### 2. Build MCP server

```bash
cargo build --release --bin openmemory-mcp
```

### 3. Configure your AI tool

Example for Claude Code (`~/.claude/settings.json`):

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

### 4. Use it

The AI now has two tools:

**memory_save** - Save important information
```json
{
  "content": "User prefers TypeScript",
  "importance": 0.8,
  "tags": ["preference"]
}
```

**memory_search** - Find relevant memories
```json
{
  "query": "TypeScript",
  "limit": 5
}
```

> **Tip:** The AI won't automatically save everything. Before ending a conversation, ask: *"Please save anything important from our discussion"* to ensure key information is remembered for next time.

## Development

```bash
pnpm install
pnpm turbo run dev
```

### Seed test data

```bash
cd scripts
source venv/bin/activate
python seed-data.py --count 1000
```

## License

MIT
