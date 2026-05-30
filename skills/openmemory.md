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
