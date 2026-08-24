# Project QA Tab — Design

Date: 2026-08-22
Status: approved and implemented; event grouping added 2026-08-24

## Purpose

Give each project in OpenMemory a durable, human-readable log of QA activity:
what was tested, what the verdict was, and the evidence — screenshots and
dated notes — that supports it.

The intended loop:

1. A human creates a task on the project board, labelled `qa`, assigned to `agent`.
2. An agent picks the task up and invokes the `qa-run` skill.
3. The skill drafts a test plan from the task, drives **qa-automation** through
   that project's own MCP server to execute the tests, and collects the verdict
   plus screenshot files.

   **Constraint on step 3, verified against qa-automation's source.** Its MCP
   server (`backend/mcp-server/src/server.ts`) exposes ten tools, of which
   `qa_get_report` is the only result reader — and it selects exactly `id`,
   `status`, `summary`, `aiSummary`, `startedAt`, `finishedAt`. Screenshots are
   uploaded to MinIO by the worker and are **not exposed through MCP at all**.
   So qa-automation supplies the *verdict*; the agent must capture its own
   screenshots (gstack `/browse`, or direct Playwright) to supply the *evidence*.
   Adding an artifact-listing tool to qa-automation's MCP server would remove this
   split — that is a change to the other repository and is out of scope here.
4. The skill writes a QA run and its evidence back into OpenMemory through new
   MCP tools, then moves the task to `done`.
5. The QA tab on `/projects/{id}` renders the log.

## Architecture

**OpenMemory owns the record. The agent is the integration.**

qa-automation (`/home/toyofumi/projects/qa-automation`, its own repository) stays
an independent service. There is no service-to-service call, no shared Docker
network, and no dependency on the project-identity or secrets federation seams.
The agent holds both MCP servers: qa-automation's to *run* tests, OpenMemory's to
*record* them.

Consequences, all of them intended:

- The QA tab works when the qa-automation stack is stopped.
- Evidence survives a reset of qa-automation's volumes.
- qa-automation is the first *producer*, not a hard dependency. A purely manual
  QA session, or a future different test runner, writes to the same log.
- `project_qa_runs.external_ref` holds qa-automation's `TestRun` id so a reader
  can drill back through to the live system when it is running.

## Data model

Created by `ensure_qa_tables(db)` in a new `apps/server/src/qa.rs`, following the
`CREATE TABLE IF NOT EXISTS` plus idempotent-`ALTER` convention used by
`library.rs`, `resources.rs`, and `forecasts.rs`. Called from the same bootstrap
path as the other `ensure_*_table` functions.

### `project_qa_runs`

| column | type | notes |
|---|---|---|
| `id` | `UUID PK DEFAULT gen_random_uuid()` | |
| `project_id` | `UUID NOT NULL` | `REFERENCES project_graphs(id) ON DELETE CASCADE` |
| `event_id` | `UUID NULL` | `REFERENCES project_qa_events(id) ON DELETE SET NULL`; groups runs under a release/deployment checkpoint |
| `task_id` | `UUID NULL` | `REFERENCES project_tasks(id) ON DELETE SET NULL` |
| `title` | `TEXT NOT NULL` | |
| `status` | `TEXT NOT NULL DEFAULT 'in_progress'` | `CHECK (status IN ('in_progress','passed','failed','blocked'))` |
| `summary` | `TEXT NULL` | agent's or human's prose verdict |
| `target` | `TEXT NULL` | what was tested: URL, build id, device |
| `external_ref` | `TEXT NULL` | qa-automation `TestRun` id |
| `created_by` | `TEXT NOT NULL DEFAULT 'agent'` | `CHECK (created_by IN ('agent','human'))` |
| `started_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | |
| `finished_at` | `TIMESTAMPTZ NULL` | set when status leaves `in_progress` |
| `created_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | |
| `updated_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | |

Indexes: `(project_id)`, `(event_id)`, `(task_id)`, `(project_id, started_at DESC)`.

`project_id` targets `project_graphs(id)` because that is OpenMemory's project
registry table — the same target `project_tasks.project_id` uses. It is not named
`projects`.

`task_id` is `ON DELETE SET NULL`, deliberately **not** `CASCADE`: deleting a task
must not destroy the evidence that the work was verified.

### `project_qa_events`

| column | type | notes |
|---|---|---|
| `id` | `UUID PK DEFAULT gen_random_uuid()` | |
| `project_id` | `UUID NOT NULL` | `REFERENCES project_graphs(id) ON DELETE CASCADE` |
| `name` | `TEXT NOT NULL` | Human-readable checkpoint name, e.g. `before deploy v1.0.0` |
| `created_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | |
| `updated_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | |

Deleting an event uses `ON DELETE SET NULL`: its QA runs and evidence remain
available in the ungrouped section. Existing runs are therefore backward
compatible and appear as ungrouped until an event is assigned.

### `project_qa_evidence`

| column | type | notes |
|---|---|---|
| `id` | `UUID PK DEFAULT gen_random_uuid()` | |
| `run_id` | `UUID NOT NULL` | `REFERENCES project_qa_runs(id) ON DELETE CASCADE` |
| `kind` | `TEXT NOT NULL` | `CHECK (kind IN ('image','text'))` |
| `caption` | `TEXT NULL` | shown under the thumbnail / beside the note |
| `body` | `TEXT NULL` | the note when `kind='text'`; `NULL` when `kind='image'` |
| `mime_type` | `TEXT NULL` | `kind='image'` only |
| `byte_size` | `BIGINT NULL` | `kind='image'` only |
| `sort_order` | `INT NOT NULL DEFAULT 0` | render order within a run |
| `captured_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | when the evidence was *taken* |
| `created_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | when the row was written |

Index: `(run_id, sort_order)`.

`captured_at` is separate from `created_at` on purpose. A screenshot's capture
time is not its upload time, and the log is ordered and read by capture time.

## Blob storage

A new `qa-blobs` Docker volume mounted at `/data/qa-blobs`, with
`OPENMEMORY_QA_BLOB_DIR` overriding the path for tests and local runs. Both are
declared in `docker-compose.yml` alongside the existing `design-blobs` and
`library-blobs` entries.

Implemented in a new `apps/server/src/qa_blobs.rs` mirroring `design_blobs.rs`:

- `blob_root()` reads `OPENMEMORY_QA_BLOB_DIR`, defaulting to `/data/qa-blobs`.
- `blob_path(root, evidence_id)` → `{evidence_id}.bin`. A `Uuid` renders only as
  hex and dashes, so path traversal is structurally impossible rather than filtered.
  The extension is fixed rather than derived from the mime type: `mime_type` is
  already stored on the row and is what `GET .../blob` sets `Content-Type` from, so
  encoding it in the filename too would create a second source of truth that can
  disagree with the first.
- `temp_blob_path(root, evidence_id)` includes a **fresh** `Uuid`, so two concurrent
  writes for the same evidence never share a temp path and cannot interleave into a
  corrupted file. Write to temp, then rename.
- Ownership is verified `evidence → run → project` with a single SQL check
  **before any file touch**, so blob URLs cannot probe or write across projects.

Limits:

- `MAX_QA_BLOB_BYTES = 32 * 1024 * 1024`. These are screenshots, not the 128 MB
  video budget `library.rs` needs.
- Accepted mime types: `image/png`, `image/jpeg`, `image/webp`. Rejected otherwise
  with 415.

**`library_entries` is deliberately not reused.** It is a curated, reusable,
globally-scoped asset library with categories and tags. QA evidence is run-scoped,
ordered, append-mostly log data with a different lifecycle and different deletion
semantics. The pattern is reused; the table is not.

## HTTP API

Registered in `apps/server/src/main.rs` alongside the existing `/projects/:id/...`
routes, behind the same `is_authenticated` gate as every other route.

**Path parameter syntax is axum 0.7's `:name`, not `{name}`.** The tables below use
`{id}` for readability, but the implementation must write `/projects/:id/qa/runs`,
`:run_id`, `:evidence_id`. Writing `{id}` registers a route matching the *literal*
segment `{id}` — it silently never matches, with no error at startup or compile time.

| method | path | purpose |
|---|---|---|
| `GET` | `/projects/{id}/qa/runs` | list runs, newest first; optional `?status=` filter |
| `POST` | `/projects/{id}/qa/runs` | create a run |
| `GET` | `/projects/{id}/qa/runs/{run_id}` | one run with its evidence |
| `PATCH` | `/projects/{id}/qa/runs/{run_id}` | edit title/status/summary/target/task_id |
| `DELETE` | `/projects/{id}/qa/runs/{run_id}` | delete run, cascade evidence, unlink blobs |
| `POST` | `/projects/{id}/qa/runs/{run_id}/evidence` | add a text note, or an image row awaiting its blob |
| `PATCH` | `/projects/{id}/qa/evidence/{evidence_id}` | edit caption/body/sort_order/captured_at |
| `DELETE` | `/projects/{id}/qa/evidence/{evidence_id}` | delete row and its blob |
| `PUT` | `/projects/{id}/qa/evidence/{evidence_id}/blob` | upload image bytes |
| `GET` | `/projects/{id}/qa/evidence/{evidence_id}/blob` | fetch image bytes |
| `GET` | `/projects/{id}/qa/events` | list named QA events |
| `POST` | `/projects/{id}/qa/events` | create an event |
| `PATCH` | `/projects/{id}/qa/events/{event_id}` | rename an event |
| `DELETE` | `/projects/{id}/qa/events/{event_id}` | delete the event and leave runs ungrouped |

Evidence routes are addressed by `evidence_id` directly rather than nested under
`/runs/{run_id}/`, because an evidence UUID is already globally unique and the
ownership check walks `evidence → run → project` regardless. `POST` is the one
exception — creating evidence needs its parent run in the path. This asymmetry is
intentional; do not "correct" it in one direction or the other.

Setting `status` to anything other than `in_progress` via `POST` or `PATCH` sets
`finished_at` to `now()` if it is currently `NULL`. Setting it back to
`in_progress` clears `finished_at`.

Deleting a run or evidence row removes the corresponding blob file. A missing blob
file is not an error on delete — the row is the source of truth.

## MCP tools

A new `apps/server/src/mcp_app/qa_tools.rs`, with schema entries in `catalog.rs`
and routing entries in `dispatch.rs` — the established three-file pattern used by
`lesson_create` and every other tool.

| tool | arguments |
|---|---|
| `qa_event_create` | `project_id`, `name` |
| `qa_event_list` | `project_id` |
| `qa_event_update` | `event_id`, `name` |
| `qa_event_delete` | `event_id` |
| `qa_run_create` | `project_id`, `title`, optional `event_id`, `task_id`, `status`, `summary`, `target`, `external_ref`, `created_by` |
| `qa_run_update` | `run_id`, any of `title`/`status`/`event_id`/`summary`/`target`/`task_id`/`external_ref` |
| `qa_run_list` | `project_id`, optional `status`, `event_id`, `task_id`, `limit` |
| `qa_run_delete` | `run_id` |
| `qa_evidence_add` | `run_id`, `kind`, optional `caption`, `body`, `file_path`, `captured_at`, `sort_order` |
| `qa_evidence_update` | `evidence_id`, any of `caption`/`body`/`sort_order`/`captured_at` |
| `qa_evidence_delete` | `evidence_id` |

**`qa_evidence_add` takes `file_path`, a local filesystem path, for images.**
Playwright and Maestro write screenshots to disk, and base64-encoding a 2 MB PNG
through an MCP call wastes an enormous amount of the agent's context.

**How the bytes actually reach the blob store.** `openmemory-mcp` is a *separate
binary* from `openmemory-server` (`apps/server/Cargo.toml` declares both) and is
registered in `~/.claude.json` as a host-native stdio process with only
`DATABASE_URL`, `OPENSEARCH_URL`, `FALKORDB_URL`, `OPENMEMORY_SECRET_KEY`, and
`OPENMEMORY_SSH_ALLOWED_HOSTS` in its environment. It has no `/data` mount, so it
cannot write to the `qa-blobs` Docker volume at all. Therefore:

1. `qa_evidence_add` inserts the evidence row directly in Postgres, as every other
   MCP tool does.
2. For `kind='image'` with a `file_path`, it resolves and canonicalises the path
   **host-side** — where the path actually means something — requires the result to
   stay inside the home root (so a symlink pointing outside is rejected), reads the
   bytes, and `PUT`s them to `/projects/{pid}/qa/evidence/{eid}/blob` — the same
   endpoint the browser uses.
3. If that PUT fails, the tool deletes the row it just inserted, so no image row is
   left permanently without a blob.

Server-side size and mime validation stay exactly where this spec puts them. Every
observable guarantee is preserved — `file_path` argument, containment after
canonicalisation, symlink rejection, one blob store, atomic write. Only *which
process calls `read()`* changes, and the process topology forces it.

The browser upload path uses `PUT .../blob` with raw bytes directly. Both write to
the same store through the same endpoint.

## UI

`apps/web/app/(sidebar)/projects/[id]/page.tsx` gains `'qa'` on the `activeTab`
union (line 152), one nav button matching the existing hand-rolled tab buttons
(lines 681-721), and one render branch delegating to a new component. That file is
already 1187 lines; QA content must not go inline.

New `apps/web/components/qa-panel.tsx`, following `components/lessons-panel.tsx` and
the project History panel's sidebar/timeline language:

- **Event index** — all runs, ungrouped runs, and named QA events with counts;
  events can be created, renamed, or deleted without deleting their runs.
- **Bulk grouping** — select several runs, move them to an existing event, or
  create a new event and move the selected runs into it in one action.
- **Run list** — verdict badge, title, target, `started_at`, evidence count, and a
  chip linking to the originating task when `task_id` is set. Filter control for
  verdict and event-scoped navigation.
- **Run detail** — evidence timeline in `sort_order`, image thumbnails and text
  notes interleaved, each showing `captured_at`.
- **Lightbox** — click a thumbnail for the full-size image with its caption and
  `captured_at`; left/right arrow keys step through that run's images.
- **Create / edit run** — dialog, matching the existing task and routine dialogs in
  the page file.
- **Add evidence** — drag-and-drop zone for images, plus a text-note form.
- **Delete** — runs and individual evidence items, each behind a confirmation
  dialog, matching the pattern already used by `EnvParamsPanel` and the project
  graph bulk rebuild.

Applicable existing lessons:

- Do not pass a `className` to a shadcn primitive without first reading its base
  `cn(...)` string; match the breakpoint prefix rather than replacing defaults.
- Any flex/grid child holding unbounded text needs `min-w-0`.

## Skill

`skills/qa-run/SKILL.md`, alongside the existing `skills/openmemory/SKILL.md`.

Contents: the `qa` label convention; how to read a task and draft a test plan from
it; how to drive qa-automation through its MCP server; how to collect screenshot
paths; how to write the run and evidence back with the tools above; and the
requirement to move the task to `done` and set a terminal verdict on the run.

The skill must state that a run left in `in_progress` is a bug, not a valid end
state — every invocation ends `passed`, `failed`, or `blocked`.

## Testing

**Rust** (`apps/server`):

- `ensure_qa_tables` is idempotent across repeated calls.
- Evidence belonging to project A is not readable or writable through project B's
  routes — must 404, not 403, and must not touch the filesystem.
- `file_path` outside `OPENMEMORY_HOME_DIR`, including via symlink, is rejected.
- The `status` and `kind` CHECK constraints reject invalid values.
- Deleting a task leaves its run intact with `task_id` `NULL`.
- Deleting a project removes its runs and evidence.
- Blob write is atomic: a failed write leaves no partial file at the final path.
- Oversized and wrong-mime uploads are rejected.

**Frontend** (`apps/web`): `tsc --noEmit` and `eslint` are necessary but not
sufficient. Seed a realistic fixture — several runs across all four verdicts, each
with images and text notes interleaved, at least one linked to a task and one not
— then load the tab in a browser and look at it before calling the work done. An
empty-state screenshot is not evidence the feature works. Delete the fixture
afterward.

## Out of scope

Deliberately excluded from this spec, to be reconsidered once the data model has
proven itself:

- Routine-driven dispatch that scans for `qa`-labelled tasks on a schedule.
- Reading qa-automation's live `TestRun` rows into the tab.
- The project-identity and secrets federation seams between the two systems.
- Any shared Docker network between the OpenMemory and qa-platform compose projects.
