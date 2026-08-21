---
name: openmemory
description: Use OpenMemory 0.2.0 to persist and retrieve durable agent context; manage projects, tasks, decision notes, routines, lessons, resources, secrets, workflows, project code graphs, asset-library entries, forecast profiles, and design budgets; or invoke credential-safe HTTP, download, JWT, Google service-account, and SSH operations. Trigger when work should survive across sessions, when registered project context or integrations may exist, or when the user asks to use OpenMemory or its mem CLI.
---

# OpenMemory 0.2.0

Use OpenMemory as durable, local infrastructure for agent memory, planning, registered resources, and credential-safe integrations. Prefer native `openmemory` MCP tools when available. Use `mem` for shell workflows and the authenticated REST API only when an operation has no MCP or CLI equivalent.

## Start a work session

1. Search for relevant durable context:

   ```bash
   mem search "<project or topic>" --limit 10
   ```

2. Call `project_list` when the work may belong to a tracked project. Use its ID for tasks, lessons, and project-scoped tools.
3. Call `lesson_list` for the selected project before making changes.
4. Call `routine_check` when the project uses repeating work.
5. Call `resource_list` when the task may depend on registered files, websites, datasets, or accounts. Call `resource_tags` before filtering by unfamiliar tags.
6. Call `workflow_list` before rebuilding a recurring integration sequence manually.
7. Call `forecast_list` before architecture or cost-planning work.

Do not fail the user's task merely because one of these searches returns no results.

## Persist durable memory

Save facts that remain useful in future sessions:

- user preferences and corrections;
- architectural decisions and their reasons;
- stable constraints, locations, and project conventions;
- durable research conclusions.

Never save chat logs, turn-by-turn summaries, routine progress reports, secrets, credentials, or content whose only value is in the current conversation. The session watcher already records supported agent conversations; duplicating them pollutes retrieval.

Use a concise, standalone statement that remains understandable without the current transcript:

```bash
mem save "The API uses rustls because deployment images omit OpenSSL." \
  --importance 0.8 --tags api,rust,decision \
  --summary "API TLS dependency"

mem search "API TLS decision" --limit 5
mem list --limit 20
mem get <uuid>
mem delete <uuid>
```

Use `memory_save` and `memory_search` when MCP tools are available. Use the following importance scale:

| Score | Use |
|---|---|
| `0.9` | hard constraints and critical preferences |
| `0.7`–`0.8` | decisions, strong preferences, important conventions |
| `0.5`–`0.6` | useful project facts |
| `0.3`–`0.4` | minor durable notes |

Use `mem save ... --auto` only when LLM Settings are configured and automatic suggestions are useful. Explicit `--importance`, `--tags`, and `--summary` values always take precedence. Preview without saving with `mem autofill memory "<content>"`; `mem autofill task` and `mem autofill resource` preview the corresponding metadata. Agents should normally select these fields themselves.

Use `memory_graph_relate` to add an explicit named relationship between two memories and `memory_graph_neighbors` to traverse related memories. Use the temporal `graph_*` tools for entities and time-varying facts rather than ordinary preference/project memory:

- `graph_add_episode` records immutable source material;
- `graph_add_entity` upserts an entity;
- `graph_add_fact` adds a relationship and may invalidate an older fact;
- `graph_query_facts`, `graph_query_at`, `graph_get_entity`, and `graph_get_entity_history` retrieve current or historical knowledge.

## Manage projects and work

Use `project_list` to resolve project IDs and `project_create` to create a planning-only project or register a project path. Track scoped, actionable work with `project_task_list`, `project_task_create`, `project_task_update`, and `project_task_delete`.

- Move active work through `todo` → `in_progress` → `done`.
- Use `cancelled`, not `done`, for dropped or superseded work.
- Use `parent_id` for subtasks and `start_date`/`due_date` for scheduling.
- Use `limit` and `offset` when listing large task sets.
- Avoid creating tasks for incidental actions that do not need durable tracking.

### Record notes and decisions

Use append-only task notes for implementation findings, handoffs, and decisions:

1. Call `project_task_note_create` with `note_type: "message"` for a finding or handoff.
2. Use `note_type: "decision"` for a checkpoint requiring an answer.
3. Provide up to six unique `decision_options`. Omit them for an open question.
4. Set `decision_selection_mode` to `single` (default) or `multiple`.
5. Call `project_task_note_decide` with exact option strings and/or a custom `reply`.
6. Call `project_task_note_list` to read the full answer history. Re-answering records a new answer without deleting earlier ones.

### Check routines

The API server checks routines in the background every five minutes by default. `routine_check` can also materialize due routines as dated tasks explicitly or preview them with `dry_run: true`:

- daily: no task created today;
- weekly: no task created in the last seven days;
- monthly: no task created in the current calendar month.

Use `routine_list` and `routine_create` to inspect and define templates. MCP-only operation has no independent scheduler, so call `routine_check` when the API server is not running.

### Record lessons

Call `lesson_list` at the start of project work. After a user correction or durable discovery, call `lesson_create` with a short title and an actionable rule; include context, category, severity, and tags when useful.

- Reusing the same normalized title in a project increments `occurrences` instead of duplicating the lesson.
- Categories: `correction`, `discovery`, `convention`, `pitfall`.
- Severities: `low`, `medium`, `high`.
- Archive superseded lessons with `lesson_update` and `status: "archived"`; use `lesson_delete` only when permanent removal is intended.

The CLI is read-only for lessons:

```bash
mem lessons --project <uuid> --query "<topic>" --limit 20
```

## Discover resources and assets

Use the resource catalog for source material and account configuration:

- `resource_list`, `resource_tags`, and `resource_get` discover local paths and URLs.
- `resource_add` registers a path or URL; check for duplicates first.
- `resource_update` replaces supplied fields; pass an empty `env_param_keys` array to clear credential links.
- `resource_delete` removes only manual catalog entries. Change env-backed `RESOURCE_PATH.*` and `RESOURCE_URL.*` entries through `env_set`/`env_delete`.

CLI equivalents are available as `mem resource-list`, `resource-tags`, `resource-get`, `resource-add`, `resource-update`, and `resource-delete`. `resource-add --auto` can suggest description and tags without overriding explicit values.

Use the global visual library for already-created candidates, not source materials:

- `library_add` catalogs an existing image, video, or self-contained HTML/CSS/JS preview;
- `library_list` filters by project, tag, or category;
- `library_get` and `library_delete` retrieve or remove entries.

The library does not generate, copy, or validate media and has no review-state workflow.

## Use environment parameters safely

Call `env_list` to discover keys and descriptions. Use `env_get` only for non-secret values, `env_rename` to rename a key while preserving its value, and `env_delete` to remove obsolete entries. Never attempt to reveal a secret or echo a retrieved value in chat, logs, commands, or memory.

```bash
mem env-list
mem env-set <key> <value> [--secret] [--description TEXT]
mem env-rename <old-key> <new-key> [--value VALUE] [--secret|--normal]
mem env-get <key>     # non-secret values only
mem env-delete <key>
```

Prefer the server-side credential tools so sensitive values never enter the agent transcript:

| Need | Tool |
|---|---|
| authenticated JSON/text HTTP request | `env_http_request` |
| binary download to an absolute local path | `env_http_download` |
| JWT-authenticated HTTP request | `env_http_request_jwt` |
| Google service-account request | `env_google_service_account_request` |
| store a credential file without reading its bytes | `env_set_file` |
| return a short-lived signed token only when unavoidable | `env_sign_jwt` |
| execute a non-interactive remote command | `env_ssh_execute` |

Use `env_http_download` for every binary response; `env_http_request` decodes responses as text and corrupts binary bytes. For HTTP secrets, select header, full-URL, or query-parameter injection as required. Respect `OPENMEMORY_HTTP_ALLOWED_HOSTS`.

Prefer `env_http_request_jwt` over exposing a token from `env_sign_jwt`. Store certificate, key, and service-account files with `env_set_file`; set `key_from_file: true` where required.

`env_ssh_execute` is fail-closed unless `OPENMEMORY_SSH_ALLOWED_HOSTS` permits the target. Require a pinned `<ssh_key_key>.host_key_fingerprint`; optionally constrain the key with `<ssh_key_key>.allowed_hosts`. It supports no PTY, forwarding, or password authentication. Treat remote writes and destructive commands with the same confirmation requirements as local ones.

## Query project code graphs

Use project graphs for codebase orientation and dependency questions:

1. Call `project_graph_list` to locate the registered project.
2. Call `project_graph_create` to index a local project path if none exists.
3. Use `project_graph_query` for keyword-centered, multi-hop exploration.
4. Use `project_graph_node_detail` to inspect a result, `project_graph_shortest_path` to connect two nodes, and `project_graph_god_nodes` to find hubs.
5. Call `project_graph_rebuild` after material code changes; unchanged graphs are skipped.

`project_graph_delete` removes only the registered graph, not the source files.

## Run reusable workflows

Prefer an existing workflow over reconstructing the same integration sequence:

1. Call `workflow_list`.
2. Call `workflow_get` for its `input_schema`.
3. Call `workflow_run` with its UUID/name and an input object.
4. If the result is `action_required`, perform exactly the returned host-agent action and call `workflow_continue` with the `run_id` and structured result.
5. Repeat until `completed`. Treat `failed` as terminal; later steps do not execute.

Templates can reference `{{input.name}}` and earlier results such as `{{steps.lookup.body.id}}`. File-like workflow inputs accept an absolute host-visible path or an object with `path`; image and PDF inputs must have matching file types. OpenMemory executes HTTP nodes server-side but never executes host commands itself.

### Recipe: Summarize a meeting

A reusable `http` (fetch transcript) → `agent` (summarize + save) workflow — transcript-in,
summary-out, no audio capture or transcription provider baked in. See
[`docs/design/meeting-summary-workflow.md`](../../docs/design/meeting-summary-workflow.md) for
the concrete `workflow` definition, the one-time `env_set` credential setup, and a mandatory
privacy callout (summarizing sends transcript content to whatever LLM backs the agent step).

## Plan forecasts and design budgets

Use `forecast_list` before designing for scale or estimating cost. Manage reusable assumptions with `forecast_create`, `forecast_update`, and `forecast_delete`. Profiles capture application type, user count, monthly budget, stress tolerance, usage pattern, engagement, planning horizon, and growth.

Use `design_budget_list`, `design_budget_create`, `design_budget_update`, and `design_budget_delete` for per-design monthly forecasts. Supply service line items in cents; OpenMemory derives the monthly total. Record the forecast profile or custom conditions, confidence, and pricing basis so estimates remain auditable.

The 0.2.0 web UI also supports project documents/designs in text, Mermaid, draw.io, React Flow, and OpenPencil formats, plus AI diagram/budget suggestions and selective source-control commits/pushes. These are REST/UI features rather than general MCP authoring tools.

## Synchronize a project bundle

For a project linked to a Git repository, the authenticated REST route `POST /projects/<id>/sync` exports or imports a Git-friendly `.openmemory/` bundle containing documents, tasks and decision history, routines, lessons, and budgets.

```bash
TOKEN=$(tr -d '[:space:]' < ~/.openmemory/api_token)
BASE="${OPENMEMORY_URL:-http://localhost:18080}"

# Export database-backed project data into the repository
curl -s -X POST "$BASE/projects/<uuid>/sync" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"action":"export"}' | jq .

# Import the checked-out bundle; missing records are not deleted
curl -s -X POST "$BASE/projects/<uuid>/sync" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"action":"import"}' | jq .
```

Inspect the repository diff before committing an export. Import only from a trusted checkout. Import merges by stable IDs and does not delete database records absent from the bundle.

## Inspect recorded sessions

The watcher records supported Claude Code, Gemini CLI, and Codex CLI sessions without agent-side saves. Use the CLI for read-only inspection:

```bash
mem sessions --limit 50
mem sessions <uuid>
mem sessions messages <uuid> --limit 200 --after 0
```

Do not copy session transcripts back into durable memory unless extracting a genuinely lasting fact.

## Fallback and health checks

The default API URL in 0.2.0 is `http://localhost:18080`:

```bash
curl -s http://localhost:18080/health
docker compose --profile api up -d
export OPENMEMORY_URL=http://localhost:18080
export PATH="/path/to/openmemory/scripts:$PATH"
```

For memory operations only, use the legacy `/mcp` REST enum when MCP and `mem` are unavailable:

```bash
curl -s -X POST "$OPENMEMORY_URL/mcp" -H 'content-type: application/json' \
  -d '{"type":"memory.search","query":"<topic>","limit":5}' | jq .
```

Projects, tasks, notes, routines, lessons, workflows, forecasts, designs, and sync are not legacy `/mcp` request types. Use their MCP tools or authenticated REST routes.

Keep the API bound to localhost. Resolve the HTTP API token from `OPENMEMORY_API_TOKEN` or `~/.openmemory/api_token`; do not expose it. Restart the MCP client session after rebuilding the MCP binary because a running stdio process cannot hot-reload new tools.
