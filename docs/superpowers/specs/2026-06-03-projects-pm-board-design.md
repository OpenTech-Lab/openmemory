# Design: Route Restructure + Projects PM Board

**Date:** 2026-06-03
**Branch:** main
**Approach:** B — Full PM Board (reuse `project_graphs` table)

---

## Problem

The current navigation groups Memory Graph and Projects together under a "Graph" section, but they serve different purposes:

- **Memory Graph** (`/graph`) — visualizes the temporal knowledge graph of memories. It's a view of the Memory system.
- **Projects** (`/graph/projects`) — registers code folders for knowledge graph exploration. Currently graph-centric only: no tasks, no management, no AI agent integration.

Additionally, the Projects concept is artificially limited: you must have a `graphify-out/graph.json` file to register a project at all. This prevents Projects from being useful as a standalone PM container.

---

## Proposed Solution

### 1. Route Restructure

| Old | New | Reason |
|-----|-----|--------|
| `/graph` | `/memory/graph` | Memory graph is a memory view |
| `/graph/projects` | `/projects` | Projects is now top-level PM |
| `/graph/projects/[id]` | `/projects/[id]` | Follows parent route |

Old routes (`/graph`, `/graph/projects`) are deleted — no redirects needed (internal app, no external linking).

### 2. Sidebar Navigation Change

**Before:**
- Memory: Browse, Search
- **Graph: Memory Graph, Projects**
- Agents: Agents, Sessions
- Settings: LLM, Environment

**After:**
- Memory: Browse, Search, **Graph** (Memory Graph)
- **Projects: Projects** (new top-level)
- Agents: Agents, Sessions
- Settings: LLM, Environment

### 3. Projects Page Enhancement

**Path becomes optional.** When creating a project, folder path is optional. If provided, the graphify graph is loaded. If not, the project is created as a pure PM container (0 nodes, 0 edges).

**New "Add Project" dialog fields:**
- Name (required)
- Folder Path (optional — shows hint "for graph features, run `/graphify <path>` first")
- Description (optional)

**Two views (URL param `?view=list|board`, default list):**
- **List view** — existing DataTable with added task count badge per project
- **Board view** — kanban across all projects, filterable by project

**Board columns:** Todo | In Progress | Done (stored as `'todo'`, `'in_progress'`, `'done'`)

**Task card shows:** title (bold), priority badge (low/medium/high), assigned_to icon (`NULL`=no icon, `'human'`=person icon, `'agent'`=bot icon), project name (muted, when all-projects view)

**Board view filter:** Single-select dropdown "All Projects" (default) or a specific project. On `/projects/[id]`, the dropdown pre-selects that project.

**View state:** URL-only (`?view=list|board`); no localStorage persistence across sessions.

### 4. Task CRUD

**Add Task dialog fields:**
- Project (dropdown, pre-selected on project page)
- Title (required)
- Description (optional textarea)
- Status: Todo (default) / In Progress / Done
- Priority: Low / Medium / High
- Assigned to: Human / Agent / Unassigned
- Created by: set server-side (`'human'` for HTTP calls, `'agent'` for MCP calls); omitted from UI form

**Inline status toggle:** clicking a task card's status badge cycles Todo → In Progress → Done → Todo (wraps). Uses optimistic UI — card moves to the new column immediately; if the API call fails, a toast error appears and the card reverts.

### 5. Project Detail Page (`/projects/[id]`)

Layout depends on whether the project has a graph:
- **Has path/graph:** Two tabs — "Graph" (Sigma.js visualization, existing) and "Tasks" (task list). Tabs are rendered by a `<Tabs>` wrapper added around the existing full-screen graph component.
- **No path/graph:** Tasks panel full-width; Graph tab is hidden.

Task list scoped to this project. "Add task" button in the Tasks tab header. Task count badge on the Tasks tab label (e.g. "Tasks (3)").

**Rebuild button:** Hidden entirely on path-less projects; only rendered when `project.path != null`.

---

## Data Model

### `project_tasks` table (new)

```sql
CREATE TABLE IF NOT EXISTS project_tasks (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   UUID        NOT NULL REFERENCES project_graphs(id) ON DELETE CASCADE,
  title        TEXT        NOT NULL,
  description  TEXT,
  status       TEXT        NOT NULL DEFAULT 'todo',   -- 'todo' (UI: "Todo") | 'in_progress' | 'done'
  priority     TEXT        NOT NULL DEFAULT 'medium', -- 'low' | 'medium' | 'high'
  assigned_to  TEXT,                                  -- 'human' | 'agent' | NULL
  created_by   TEXT        NOT NULL DEFAULT 'human',  -- 'human' | 'agent'
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_project_tasks_project_id ON project_tasks(project_id);
```

### `project_graphs` table changes

```sql
-- Run AFTER the CREATE TABLE IF NOT EXISTS block in run_migrations()
ALTER TABLE project_graphs ALTER COLUMN path DROP NOT NULL;
ALTER TABLE project_graphs ALTER COLUMN canonical_path DROP NOT NULL;
```

Order matters: the `CREATE TABLE IF NOT EXISTS` block runs first (idempotent), then the `ALTER` makes path nullable. The UNIQUE constraints on `path` and `canonical_path` remain — PostgreSQL treats NULLs as distinct, so multiple path-less projects are allowed.

**This `ALTER TABLE` must be added to BOTH migration paths:**
1. `run_migrations()` in `apps/server/src/main.rs`
2. The migration block in `apps/server/src/mcp.rs` (the MCP binary has its own migration call)

### Rust struct changes required

`ProjectGraphRow` in `apps/server/src/project_graphs.rs`:
```rust
pub path: Option<String>,          // was String
pub canonical_path: Option<String>, // was String
```

`CreateProjectGraphPayload` in `apps/server/src/main.rs`:
```rust
pub path: Option<String>,  // was String
```

The `create_project_graph` handler must branch:
- `path = Some(p)`: run `load_graph_json(&p)`, insert with real node/edge counts
- `path = None`: insert with `node_count=0, edge_count=0, graph_data='{}'`, skip graph load

---

## API Routes

### Backend route renames + new routes (Rust/Axum in `main.rs`)

The existing `/graph/projects/*` backend routes are renamed to `/projects/*`:

```
GET    /projects              → list_project_graphs (renamed from /graph/projects)
POST   /projects              → create_project_graph (renamed)
GET    /projects/:id          → get_project_graph (renamed)
DELETE /projects/:id          → delete_project_graph (renamed)
POST   /projects/:id/rebuild  → rebuild_project_graph (renamed)
GET    /projects/:id/query    → query_project_graph (renamed)
```

New task routes:
```
GET    /projects/:id/tasks              → list tasks (supports ?status=&limit=50&offset=0)
POST   /projects/:id/tasks              → create task (backend sets created_by='human')
PUT    /projects/:id/tasks/:task_id     → update task (status, title, description, priority, assigned_to)
DELETE /projects/:id/tasks/:task_id     → delete task
```

**All-projects board:** Load `GET /projects` to get all projects, then call `GET /projects/:id/tasks` per project (acceptable given low project count — no cross-project tasks endpoint needed). Frontend merges the results into board columns, tagged by project.

### Next.js proxy routes (replace `api/project-graphs/` family)

All four existing `apps/web/app/api/project-graphs/*` proxy files are replaced:

```
apps/web/app/api/projects/route.ts                          → proxies to /projects (GET, POST)
apps/web/app/api/projects/[id]/route.ts                     → proxies to /projects/:id (GET, DELETE)
apps/web/app/api/projects/[id]/rebuild/route.ts             → proxies to /projects/:id/rebuild (POST)
apps/web/app/api/projects/[id]/query/route.ts               → proxies to /projects/:id/query (GET)
apps/web/app/api/projects/[id]/tasks/route.ts               → proxies to /projects/:id/tasks (GET, POST)
apps/web/app/api/projects/[id]/tasks/[taskId]/route.ts      → proxies to /projects/:id/tasks/:taskId (PUT, DELETE)
```

### MCP tools for AI agents (in `apps/server/src/mcp.rs`)

```
openmemory_list_project_tasks(project_id)
openmemory_create_project_task(project_id, title, description?, status?, priority?, assigned_to?)
openmemory_update_project_task(project_id, task_id, title?, description?, status?, priority?, assigned_to?)
openmemory_delete_project_task(project_id, task_id)
openmemory_list_projects()
openmemory_create_project(name, path?, description?)
```

---

## Files Changed

| File | Action |
|------|--------|
| `apps/web/app/(sidebar)/memory/graph/page.tsx` | Create (copy from `graph/page.tsx`) |
| `apps/web/app/(sidebar)/graph/` | Delete entire directory |
| `apps/web/app/(sidebar)/projects/page.tsx` | Create (enhanced from old `graph/projects/page.tsx`) |
| `apps/web/app/(sidebar)/projects/[id]/page.tsx` | Create (move + enhance from `graph/projects/[id]/page.tsx`; update all `router.push('/graph/projects')` back-links to `/projects`) |
| `apps/web/components/app-sidebar.tsx` | Update NAV_GROUPS; also update the `isActive` special-case from `'/graph/projects'` → `'/projects'` |
| `apps/web/app/api/project-graphs/` (all 4 files) | Delete (replaced by `api/projects/` family) |
| `apps/web/app/api/projects/route.ts` | Create (proxy GET/POST → `/projects`) |
| `apps/web/app/api/projects/[id]/route.ts` | Create (proxy GET/DELETE → `/projects/:id`) |
| `apps/web/app/api/projects/[id]/rebuild/route.ts` | Create (proxy POST → `/projects/:id/rebuild`) |
| `apps/web/app/api/projects/[id]/query/route.ts` | Create (proxy GET → `/projects/:id/query`) |
| `apps/web/app/api/projects/[id]/tasks/route.ts` | Create (proxy GET/POST → `/projects/:id/tasks`) |
| `apps/web/app/api/projects/[id]/tasks/[taskId]/route.ts` | Create (proxy PUT/DELETE → `/projects/:id/tasks/:taskId`) |
| `apps/server/src/main.rs` | Rename `/graph/projects/*` routes to `/projects/*`; add ALTER TABLE migration; update `CreateProjectGraphPayload.path` to `Option<String>`; add task CRUD handlers |
| `apps/server/src/project_graphs.rs` | Update `ProjectGraphRow`: `path` and `canonical_path` to `Option<String>` |
| `apps/server/src/mcp.rs` | Add ALTER TABLE migration in mcp's migration block; add 6 new MCP tools |

---

## Premises Agreed

1. Memory graph belongs under `/memory/graph` — it's a memory view.
2. Projects is top-level — it's now peer-level with Memory and Agents.
3. Folder path is optional — a project works without a graphify graph.
4. Tasks link to `project_graphs.id` — no separate projects table needed.
5. Both humans and AI agents can manage tasks via UI and MCP tools respectively.

## Approach Chosen

**B — Full PM Board**: reuse `project_graphs` table, add `project_tasks` table, deliver board + list views, expose MCP tools. Chosen over A (too thin) and C (extra migration complexity for same UX).
