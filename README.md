# Open Memory
As AI Common memory (OpenMemory-style local MCP memory) Local-first, shared memory for multiple AI tools/agents.

This repo is currently scaffolded from [docs/gpt-plan.md](docs/gpt-plan.md):

- Rust (Axum) server that accepts MCP-style JSON requests (`memory.save`, `memory.search`)
- Docker Compose skeleton for PostgreSQL + OpenSearch (infra)
- Monorepo wiring placeholders (Turborepo/pnpm) for a future Next.js dashboard

## Quick start (runnable sample)

### 0) Install JS deps (required for Turbo)

```bash
pnpm install
```

### Build everything from repo root (Turbo)

```bash
pnpm turbo run build
```

If you don't have pnpm on PATH, you can also run:

```bash
npx turbo run build
```

### Dev (run web + server together)

```bash
pnpm turbo run dev
```

### 1) Run the Rust server

```bash
cargo run -p openmemory-server
```

Server binds to `127.0.0.1:8080` by default. Override with `OPENMEMORY_PORT`.

### 2) Run the sample (save + search)

```bash
chmod +x scripts/sample.sh
./scripts/sample.sh
```

You should see:

- `GET /health` returning `{ "status": "ok" }`
- two `memory.save` calls
- one `memory.search` call returning scored results

## Infra (optional)

Bring up PostgreSQL + OpenSearch + Redis locally:

```bash
docker compose up -d
```

Services:
- PostgreSQL: `localhost:5432`
- OpenSearch: `localhost:9200`
- OpenSearch Dashboards: `localhost:5601`
- Redis: `localhost:6379`

Notes:

- The current server implementation uses an in-memory store (for a minimal working sample).
- Redis cache is optional; set `REDIS_URL=redis://localhost:6379` to enable caching.
- Wiring Postgres + OpenSearch is the next step.

## Integrate with AI tools (MCP)

### Step 1: Build the MCP binary

```bash
cargo build --release --bin openmemory-mcp
```

The binary will be at: `target/release/openmemory-mcp`

### Step 2: Configure Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%/Claude/claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "openmemory": {
      "command": "~/Project/ai-common-memory/target/release/openmemory-mcp",
      "env": {
        "REDIS_URL": "redis://localhost:6379"
      }
    }
  }
}
```

Or use the full absolute path like `/home/toyofumi/Project/ai-common-memory/target/release/openmemory-mcp`

### Step 3: Restart Claude Desktop

Quit and reopen Claude Desktop. You should see "openmemory" in the MCP tools list.

### Step 4: Use memory in conversations

The AI can now use two tools:
- **memory_save**: Save important facts, preferences, or context
- **memory_search**: Retrieve relevant information based on keywords

Example prompts:
- "Remember that I prefer docker compose for deployments"
- "What do you know about my docker setup?"

The system uses hybrid scoring (keyword matching + importance + recency) to return the most relevant memories.

### Troubleshooting

**If the tool shows as "failed" in Claude Desktop:**

1. Check logs: `tail -f ~/Library/Logs/Claude/mcp*.log` (macOS)
2. Verify the binary path is absolute and correct
3. Make sure Redis is running: `docker compose up -d redis`
4. Test the binary manually:
   ```bash
   echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | target/release/openmemory-mcp
   ```

## Repo layout

```text
apps/
	server/   # Rust Axum server (runnable)
	web/      # placeholder
packages/   # placeholder
docs/
scripts/
```
