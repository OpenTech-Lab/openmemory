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

## What NOT to Save

**Never write conversation content, chat logs, or turn-by-turn dialogue into memory.** The session watcher handles that automatically — writing it again creates duplicates and pollutes search results.

Do not save:
- Summaries of what you just said or did in this conversation
- Paraphrases of the user's messages
- Progress updates like "implemented feature X in this session"
- Anything that describes *the conversation itself* rather than a lasting fact

## When to Save

Save durable facts worth knowing in **future** sessions:
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

## Environment Parameters

Store configuration values and secrets so AI agents can access them during tasks — without pasting credentials into chat.

### Two types

| Type | Agent can write? | Agent can read? | Web UI can read? |
|------|-----------------|-----------------|-----------------|
| **Normal** (`is_secret=false`) | Yes | Yes | Yes |
| **Secret** (`is_secret=true`) | Yes | No — blocked | Yes |

Agents should call `env.list` to discover what parameters exist, then use normal values directly and reference secret keys by name (e.g., pass to a tool) without reading them.

### Commands

```bash
# List all parameters (keys + type + description, no values)
curl -s -X POST "${OPENMEMORY_URL:-http://localhost:8080}/mcp" \
  -H 'content-type: application/json' \
  -d '{"type":"env.list"}' | jq .

# Set a normal parameter (agent can read back)
curl -s -X POST "${OPENMEMORY_URL:-http://localhost:8080}/mcp" \
  -H 'content-type: application/json' \
  -d '{"type":"env.set","key":"OPENROUTER_MODEL","value":"openai/gpt-4o","is_secret":false,"description":"Default model for OpenRouter calls"}'

# Set a secret parameter (agent CANNOT read back)
curl -s -X POST "${OPENMEMORY_URL:-http://localhost:8080}/mcp" \
  -H 'content-type: application/json' \
  -d '{"type":"env.set","key":"OPENAI_API_KEY","value":"sk-...","is_secret":true}'

# Get a normal parameter value
curl -s -X POST "${OPENMEMORY_URL:-http://localhost:8080}/mcp" \
  -H 'content-type: application/json' \
  -d '{"type":"env.get","key":"OPENROUTER_MODEL"}' | jq .value

# Delete a parameter
curl -s -X POST "${OPENMEMORY_URL:-http://localhost:8080}/mcp" \
  -H 'content-type: application/json' \
  -d '{"type":"env.delete","key":"OLD_KEY"}'
```

### CLI shorthand

```bash
mem env-list
mem env-set <key> <value> [--secret] [--description TEXT]
mem env-get <key>          # only works for normal params
mem env-delete <key>
```

### When to use

- At session start, call `env.list` or `mem env-list` to see available config values
- Read normal params (e.g. `OPENROUTER_MODEL`, `API_BASE_URL`) to configure your tools
- For secret params, use `env.list` to confirm existence, then pass the **key name** to whatever tool or script needs it — do not attempt to read the value
- Never echo or include a retrieved value in your response text

## Project & Task Management

Track work items alongside memories. Projects can be pure task-management containers (no folder path required) or linked to a code knowledge graph.

### MCP tools (via `mcp` request type)

```bash
# List all projects with task counts
curl -s -X POST "${OPENMEMORY_URL:-http://localhost:8080}/mcp" \
  -H 'content-type: application/json' \
  -d '{"type":"project_list"}'

# Create a project (path optional)
curl -s -X POST "${OPENMEMORY_URL:-http://localhost:8080}/mcp" \
  -H 'content-type: application/json' \
  -d '{"type":"project_create","name":"my-project","description":"optional"}'

# List tasks for a project (use project_id from project_list)
curl -s -X POST "${OPENMEMORY_URL:-http://localhost:8080}/mcp" \
  -H 'content-type: application/json' \
  -d '{"type":"project_task_list","project_id":"<uuid>","status":"todo"}'

# Create a task (created_by is set to 'agent' automatically via MCP)
curl -s -X POST "${OPENMEMORY_URL:-http://localhost:8080}/mcp" \
  -H 'content-type: application/json' \
  -d '{"type":"project_task_create","project_id":"<uuid>","title":"Fix the auth bug","priority":"high","assigned_to":"agent"}'

# Update a task (only provided fields change)
curl -s -X POST "${OPENMEMORY_URL:-http://localhost:8080}/mcp" \
  -H 'content-type: application/json' \
  -d '{"type":"project_task_update","project_id":"<uuid>","task_id":"<uuid>","status":"in_progress"}'

# Delete a task
curl -s -X POST "${OPENMEMORY_URL:-http://localhost:8080}/mcp" \
  -H 'content-type: application/json' \
  -d '{"type":"project_task_delete","project_id":"<uuid>","task_id":"<uuid>"}'
```

### Task fields

| Field | Values | Default |
|-------|--------|---------|
| `status` | `todo` \| `in_progress` \| `done` | `todo` |
| `priority` | `low` \| `medium` \| `high` | `medium` |
| `assigned_to` | `human` \| `agent` \| null | null |
| `created_by` | set automatically | `agent` via MCP, `human` via UI |

### When to use

- Use `project_list` at session start to discover active projects and their IDs
- Create tasks when you identify work items during analysis or planning
- Update task status as work progresses (`todo` → `in_progress` → `done`)
- Humans can view and manage the same tasks at `/projects` in the web UI

## Routine Tasks

Routines are repeating task templates. They do **not** run on a timer — they generate a new task when an agent calls `routine_check`. This is the intended workflow:

1. Human defines a routine: "Research top news" (daily, assigned to agent)
2. At the start of a work session, agent calls `routine_check`
3. If the routine is due (hasn't run today), a task is created: `"Research top news — 2026-06-03"`
4. Agent handles the task, moves it `in_progress` → `done`

```bash
# Check which routines are due and create tasks for them
curl -s -X POST "${OPENMEMORY_URL:-http://localhost:8080}/mcp" \
  -H 'content-type: application/json' \
  -d '{"type":"routine_check"}'                       # all projects

# Scope to one project
curl -s -X POST "${OPENMEMORY_URL:-http://localhost:8080}/mcp" \
  -H 'content-type: application/json' \
  -d '{"type":"routine_check","project_id":"<uuid>"}'

# Preview without creating (dry run)
curl -s -X POST "${OPENMEMORY_URL:-http://localhost:8080}/mcp" \
  -H 'content-type: application/json' \
  -d '{"type":"routine_check","dry_run":true}'

# List routines for a project
curl -s -X POST "${OPENMEMORY_URL:-http://localhost:8080}/mcp" \
  -H 'content-type: application/json' \
  -d '{"type":"routine_list","project_id":"<uuid>"}'

# Create a routine
curl -s -X POST "${OPENMEMORY_URL:-http://localhost:8080}/mcp" \
  -H 'content-type: application/json' \
  -d '{"type":"routine_create","project_id":"<uuid>","title":"Research top news","frequency":"daily","assigned_to":"agent"}'
```

### Routine fields

| Field | Values | Default |
|-------|--------|---------|
| `frequency` | `daily` \| `weekly` \| `monthly` | `daily` |
| `priority` | `low` \| `medium` \| `high` | `medium` |
| `assigned_to` | `human` \| `agent` \| null | null |

### Due logic
- **daily**: no task created today yet
- **weekly**: no task created in the last 7 days
- **monthly**: no task created this calendar month

Tasks generated from routines have `created_by = 'agent'` and include the date in the title. Humans manage routines at `/projects/[id]` → Routines tab.

## Security Note

`OPENMEMORY_PORT` (default 8080) must not be exposed publicly — it is localhost-only by default. Memory read/write operations have no authentication.

**Secret parameters and the API token:**

`env.get` for `is_secret=true` parameters requires `Authorization: Bearer <token>` on the HTTP API. The token is resolved in this order:

1. `OPENMEMORY_API_TOKEN` env var (preferred for Docker/CI)
2. `~/.openmemory/api_token` file (auto-created on first run with a random UUID)

On first run with no env var set, a secure random token is generated and saved to `~/.openmemory/api_token` — check server logs for it. Agents cannot read secret values without this token.
