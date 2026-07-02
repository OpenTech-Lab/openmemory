# Project Edit + Icon Actions — Design

Date: 2026-07-02

## Goal

On the `/projects` list view, let users edit a project's Name, Path, and
Description from the table row. Changing the Path invalidates the indexed
knowledge graph (it was built from the old filesystem location), so the UI
must warn before committing that change. Also convert the row's action
buttons (View / Rebuild / Delete, plus the new Edit) to icon-only buttons for
a more compact, consistent row.

## Non-goals

- No changes to task/routine edit flows (already icon-based via Pencil/Trash2
  on the board cards).
- No automatic re-indexing on save — Rebuild remains a separate, explicit
  action.
- Tasks are not affected by a path change (they're linked by `project_id`,
  which never changes).

## Backend (`apps/server/src/main.rs`)

### Route

Add PUT to the existing route:

```rust
.route("/projects/:id", get(get_project_graph).put(update_project_graph).delete(delete_project_graph))
```

### Handler: `update_project_graph`

Request body (all optional, at least one required):

```json
{ "name": "string?", "path": "string? | null", "description": "string? | null" }
```

Behavior:

1. Auth check via `is_authenticated`, same as siblings.
2. Load the current row (`path`, `canonical_path`) to compare against the
   incoming `path`.
3. **Name / description**: if present in the payload, update directly. Empty
   string name is rejected (400), matching `create_project_graph`'s
   validation.
4. **Path**, three cases:
   - **Omitted from payload**: leave `path`/`canonical_path`/graph fields
     untouched.
   - **Present and unchanged** (canonicalizes to the same `canonical_path`
     already stored): treated as a no-op for graph fields.
   - **Present and different (including `null`/empty → clearing it)**:
     - If non-empty: canonicalize via `project_graphs::canonicalize_project_path`.
       On failure, return 400 with the error message (bad path).
     - Check the new `canonical_path` isn't already used by a *different*
       project (`SELECT id FROM project_graphs WHERE canonical_path = $1 AND
       id != $2`). If found, return **409 Conflict**
       (`{"error": "another project already uses this path"}`).
     - Update `path`, `canonical_path`, and clear `graph_data` (`{}`),
       `graph_hash` (`NULL`), `graph_file_size` (`0`), `node_count` (`0`),
       `edge_count` (`0`), and `imported_at` (`NULL` — there is no current
       import against the new path).
     - If clearing to no path: same, but `path`/`canonical_path` become
       `NULL`.
5. Catch a raw unique-violation from the `path` column too (defensive, in
   case canonicalization produces a value that collides on `path` but not
   `canonical_path` — shouldn't normally happen since canonicalize derives
   from path, but the DB constraint is the real backstop): map to 409.
6. Return the updated row in the same JSON shape as `get_project_graph`
   (without `graph_data`).

### SQL sketch

```sql
UPDATE project_graphs
SET name = COALESCE($1, name),
    description = CASE WHEN $2::bool THEN $3 ELSE description END,
    path = CASE WHEN $4::bool THEN $5 ELSE path END,
    canonical_path = CASE WHEN $4::bool THEN $6 ELSE canonical_path END,
    graph_data = CASE WHEN $4::bool THEN '{}'::jsonb ELSE graph_data END,
    graph_hash = CASE WHEN $4::bool THEN NULL ELSE graph_hash END,
    graph_file_size = CASE WHEN $4::bool THEN 0 ELSE graph_file_size END,
    node_count = CASE WHEN $4::bool THEN 0 ELSE node_count END,
    edge_count = CASE WHEN $4::bool THEN 0 ELSE edge_count END,
    imported_at = CASE WHEN $4::bool THEN NULL ELSE imported_at END,
    updated_at = NOW()
WHERE id = $7
RETURNING id, name, path, canonical_path, description, node_count, edge_count,
          graph_hash, graph_file_size, imported_at, created_at, updated_at
```

(`$4` = "path field was present in the request and differs from current",
computed in Rust before binding — simpler than expressing the diff in SQL.)

Exact parameter binding is an implementation detail for the coding step;
this sketch establishes the update semantics.

## Web proxy (`apps/web/app/api/projects/[id]/route.ts`)

Add:

```ts
export async function PUT(req: Request, { params }: Params) {
  const { id } = await params;
  const body = await req.json();
  return proxy(`${API_URL}/projects/${id}`, 'PUT', body);
}
```

Same pass-through pattern as GET/DELETE — status codes (400/409/500) flow
through unchanged.

## Frontend (`apps/web/app/(sidebar)/projects/page.tsx`)

### New state

```ts
const [editingProject, setEditingProject] = useState<Project | null>(null);
const [projectEditForm, setProjectEditForm] = useState({ name: '', path: '', description: '' });
const [isSavingProject, setIsSavingProject] = useState(false);
const [confirmPathChange, setConfirmPathChange] = useState(false);
```

### Open edit dialog

`openProjectEdit(project)`: sets `editingProject` and seeds
`projectEditForm` from `project.name` / `project.path ?? ''` /
`project.description ?? ''`.

### Save flow

`handleSaveProject()`:
- If `projectEditForm.path.trim() !== (editingProject.path ?? '')`: don't
  save yet — set `confirmPathChange = true` to show the warning
  `AlertDialog`.
- Else: PUT directly (`commitProjectSave()`).

`commitProjectSave()` (called directly, or after confirming the path-change
dialog):
- `PUT /api/projects/${editingProject.id}` with `{ name, path: path || null,
  description: description || null }`.
- On non-2xx response: parse `{ error }` and toast it (surfaces the 409 path
  collision message and 400 bad-path message distinctly, not a generic
  failure).
- On success: close dialog, `fetchProjects()`, toast success.

### Edit Dialog UI

New `Dialog` (mirrors the existing "New Project" dialog structure):

```
Title: Edit Project
Fields: Name (Input), Folder Path (Input, optional, font-mono), Description (Textarea, optional)
Footer: Cancel | Save
```

### Path-change warning AlertDialog

Triggered from `handleSaveProject` when path differs:

```
Title: Change project path?
Description: Changing the path clears the indexed knowledge graph for this
             project — you'll need to run Rebuild afterward to re-index the
             new location. Tasks are not affected.
Actions: Cancel | Continue (destructive style) → commitProjectSave()
```

### Row actions → icon buttons

Replace the `actions` column cell and the `graph` column cell:

- **Edit**: `Pencil` icon, ghost button, `title="Edit project"`, calls
  `openProjectEdit(row.original)`. Always shown.
- **Rebuild**: `RefreshCw` icon (spinning when `rebuildingId === id`), ghost
  button, `title="Rebuild graph"`. Shown only when `row.original.path` is
  set (existing condition).
- **Delete**: `Trash2` icon, ghost button, `text-destructive`,
  `title="Delete project"`. Always shown.
- **View** (Graph column): `Eye` icon, ghost/outline button, `title="View
  graph"`, `<Link href={/projects/${id}}>`. Shown only when `node_count > 0`
  (existing condition) — column otherwise renders nothing, unchanged.

All buttons use `size="sm"` icon-only sizing (`h-7 w-7 p-0` or similar,
matching the existing compact row height) with `lucide-react` icons already
imported (`Pencil`, `RefreshCw`, `Trash2`) plus a new `Eye` import.

## Error handling summary

| Case | Backend status | Frontend behavior |
|---|---|---|
| Empty name | 400 | toast error message from response |
| Invalid/nonexistent path | 400 | toast error message from response |
| Path collides with another project | 409 | toast error message from response |
| Success, path unchanged | 200 | toast "Project updated", graph fields untouched |
| Success, path changed/cleared | 200 | toast "Project updated", graph fields reset client-side via refetch |

## Testing plan

- Backend: manual curl against a running server — rename only, path-only
  change (existing dir), path change to invalid dir (expect 400), path
  change colliding with another project's path (expect 409), clearing path
  to null.
- Frontend: dev server, exercise edit dialog for a path-less project
  (rename only, no warning dialog appears), a project with a path (change
  path → warning appears → confirm → graph fields drop to 0 in the table),
  cancel out of the warning (no request sent, dialog stays open with edited
  values intact).
- Visual check: action column renders four icon buttons at correct sizes in
  both light/dark theme, tooltips appear on hover.
