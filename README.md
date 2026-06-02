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

### Mode 1: MCP (AI tool integration via stdio)

Best for: Claude Code, Cursor, and any MCP-compatible AI tool.

**1. Start infrastructure**

```bash
docker compose up -d
```

**2. Build MCP server**

```bash
cargo build --release --bin openmemory-mcp
```

**3. Configure your AI tool**

Example for Claude Code (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "openmemory": {
      "command": "/PATH-TO-PROJECT/openmemory/target/release/openmemory-mcp",
      "env": {
        "DATABASE_URL": "postgres://openmemory:openmemory@localhost:5432/openmemory",
        "OPENSEARCH_URL": "http://localhost:9201",
        "REDIS_URL": "redis://localhost:6399"
      }
    }
  }
}
```

**4. Use it**

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

---

### Mode 2: API + CLI

Best for: shell scripts, CI pipelines, and AI agents that prefer HTTP over MCP.

**1. Start infrastructure + API server**

```bash
docker compose --profile api up -d
```

> First run compiles Rust inside Docker (~3 min). Subsequent starts use the build cache.

**2. Add CLI to PATH**

```bash
export PATH="$PWD/scripts:$PATH"
```

**3. Use it**

```bash
mem save "User prefers TypeScript" --importance 0.8 --tags preference
mem search "TypeScript"
mem list --limit 10
```

**For AI agents:** Copy `skills/openmemory/` into Claude Code so it knows when and how to use memory automatically.

```bash
# As a global skill (available in all projects, invokable via /openmemory)
cp -r skills/openmemory ~/.claude/skills/openmemory

# Project-level only (this repo)
mkdir -p .claude/skills && cp -r skills/openmemory .claude/skills/openmemory
```

---

### Mode 3: Session Watcher

Best for: passively recording AI agent conversations into PostgreSQL without any agent involvement — no MCP tools, no `memory_save` calls required.

The watcher tails JSONL log files written by supported tools, parses user/assistant events, and stores them in the `sessions` and `session_messages` tables automatically.

**Supported tools**

| Tool | Log path | Enabled by default |
|------|----------|--------------------|
| Claude Code | `~/.claude/projects/**/*.jsonl` | Yes |
| Gemini CLI | `~/.gemini/**/*.jsonl` | Yes |
| Codex CLI | `~/.codex/**/*.jsonl` | Yes |
| GitHub Copilot | `~/.config/github-copilot/` | No — no local JSONL logs |

Tools not installed on the host are silently skipped — no configuration needed. GitHub Copilot is listed in Agent Settings but disabled: it does not write local conversation logs. Enable it and set a custom path if you configure a local log exporter.

**1. Start infrastructure + watcher**

```bash
docker compose --profile watcher up -d
```

Or combine with the API server:

```bash
docker compose --profile api --profile watcher up -d
```

> First run compiles Rust inside Docker (~3 min). Subsequent starts use the build cache.

**2. Query recorded sessions via CLI**

```bash
# List recent sessions
mem sessions [--limit 50]

# Show details for a specific session
mem sessions <uuid>

# List messages in a session
mem sessions messages <uuid> [--limit 200] [--after N]
```

**3. Configure watcher agents via web UI**

Open the web dashboard and navigate to **Agent Settings** to enable/disable tools or add custom directory paths for the watcher to monitor.

**Environment variables**

| Variable | Default | Description |
|----------|---------|-------------|
| `WATCHER_POLL_INTERVAL_SEC` | _(unset)_ | Enable periodic re-scan fallback (recommended for Docker Desktop / macOS / WSL where inotify may miss events through bind mounts) |

> **Note:** Tool directories are mounted read-only. If you see permission errors, add `user: "${UID}:${GID}"` to the `openmemory-watcher` service in `docker-compose.yml`.

---

### Optional: OpenSearch dashboard

```bash
docker compose --profile dashboard up -d
# Dashboard available at http://localhost:5601
```

## Development

```bash
pnpm install
pnpm turbo run dev

# Just the web
pnpm --filter web dev
```

### Seed test data

```bash
cd scripts
source venv/bin/activate
python seed-data.py --count 1000
```

## License

MIT
