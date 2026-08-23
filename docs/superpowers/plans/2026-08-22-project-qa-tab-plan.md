# Implementation Plan — Project QA Tab

Spec: `docs/superpowers/specs/2026-08-22-project-qa-tab-design.md`
Date: 2026-08-22
Status: awaiting user approval

Six phases, backend-first, each independently verifiable **without touching the
running containers**.

## Findings that changed the spec

All three were verified directly against source before the spec was amended.

1. **`openmemory-mcp` cannot reach the blob volume.** It is a separate `[[bin]]`
   from `openmemory-server` (`apps/server/Cargo.toml`), registered in
   `~/.claude.json` as a host-native stdio process whose env is exactly
   `DATABASE_URL`, `OPENSEARCH_URL`, `FALKORDB_URL`, `OPENMEMORY_SECRET_KEY`,
   `OPENMEMORY_SSH_ALLOWED_HOSTS`. No `/data` mount. `qa_evidence_add` therefore
   inserts the row in Postgres, then reads the file host-side and `PUT`s the bytes
   to the same blob endpoint the browser uses, rolling the row back if that fails.
2. **axum 0.7 path params are `:name`, not `{name}`.** Every route in `main.rs` is
   `/projects/:id/...`. Writing `{id}` registers a literal segment that silently
   never matches.
3. **qa-automation exposes no screenshots over MCP.** `qa_get_report`
   (`backend/mcp-server/src/server.ts`) selects only `id, status, summary,
   aiSummary, startedAt, finishedAt`. The worker uploads screenshots to MinIO and
   no MCP tool surfaces them. qa-automation supplies the verdict; the agent
   captures its own evidence.

Minor: the codebase uses `put` for partial updates everywhere and never imports
`patch`. Follow the spec (`PATCH` is semantically right) and add `patch` to the
`axum::routing` import at `main.rs:31`.

## Verification vehicle

A **side-car server**, never a container restart:
`cargo run --bin openmemory-server` with `OPENMEMORY_PORT=18090` against Postgres
on `localhost:5432` and a scratch `OPENMEMORY_QA_BLOB_DIR`. Phases 1–2 point it at
a throwaway database; Phase 5 points it at the live one so the browser fixture is
real. Frontend runs `pnpm --filter web dev -p 3100` with
`API_URL=http://127.0.0.1:18090`, so no web image rebuild is needed.

The `openmemory-server` and `openmemory-web` containers stay up, and the stdio MCP
server this session depends on is never killed.

---

## Phase 1 — Schema + blob module

**Delivers:** both tables, idempotent; blob path/limit/mime primitives, unit-tested;
Docker wired for the new volume.

**Creates** `apps/server/src/qa.rs` — pure DB/path layer, no axum. Modelled on
`library.rs:27-46` (blob trio) and `forecasts.rs:7-11` (validation constants).

- `ensure_qa_tables(db)` — the spec's two tables. Indexes `(project_id)`,
  `(task_id)`, `(project_id, started_at DESC)` on runs; `(run_id, sort_order)` on
  evidence. Follows `library::ensure_library_table` (`library.rs:73-127`):
  `.context(...)` on CREATE, `.ok()` on every index.
- `MAX_QA_BLOB_BYTES = 32 * 1024 * 1024`.
- `blob_root()` → `OPENMEMORY_QA_BLOB_DIR` or `/data/qa-blobs`.
- `blob_path` → `{evidence_id}.bin`; `temp_blob_path` → `{evidence_id}.{fresh Uuid}.bin.tmp`.
- `sniff_image_mime(&[u8])` — magic bytes only (`\x89PNG\r\n\x1a\n`, `\xFF\xD8\xFF`,
  `RIFF....WEBP`). The spec names three accepted mimes but not how to determine
  them; magic bytes are the one source both entry points share and that a client
  cannot lie about, so `mime_type` has a single origin. Anything else → 415.
- `QaRunView` / `QaEvidenceView` `FromRow` structs plus the CRUD functions that
  handlers and MCP tools both call.
- Unit tests mirroring `design_blobs.rs:170-215`.

**Modifies**

| file:line | change |
|---|---|
| `apps/server/src/main.rs:12` | `mod qa;` |
| `apps/server/src/main.rs:2145` | `qa::ensure_qa_tables(db).await?;` after `library::ensure_library_table` inside `run_migrations` — lands after `project_graphs` (`:1897`) and `project_tasks` (`:1943`), which the FKs require |
| `apps/server/src/mcp.rs:10` | `mod qa;` — **required**, separate binary crate with its own `mod` list |
| `apps/server/src/mcp_app/bootstrap.rs:231` | `qa::ensure_qa_tables(&db).await?;` — here, not at `:53-55`, because `project_tasks` is created at `:121` |
| `apps/server/src/mcp_app/mod.rs:28` | add `qa` to the `use crate::{...}` list |
| `docker-compose.yml:199` | `- qa-blobs:/data/qa-blobs` |
| `docker-compose.yml:212` | `OPENMEMORY_QA_BLOB_DIR: /data/qa-blobs` |
| `docker-compose.yml:274` | `qa-blobs:` in top-level `volumes:` |
| `Dockerfile:42` | `RUN mkdir -p /data/qa-blobs && chmod 0777 /data/qa-blobs` — **do not skip**; the comment at `Dockerfile:31-41` explains named volumes are root-owned 0755 while compose overrides the user to the host UID |

**Verify**

```bash
cargo test -p openmemory-server --bin openmemory-server qa::
cargo check --workspace     # BOTH binaries

PGPASSWORD=openmemory psql -h localhost -U openmemory -d postgres -c 'CREATE DATABASE qa_plan_check'
DATABASE_URL=postgres://openmemory:openmemory@localhost:5432/qa_plan_check \
OPENMEMORY_PORT=18090 OPENMEMORY_SECRET_KEY=x OPENMEMORY_QA_BLOB_DIR=/tmp/qa-blobs-check \
  cargo run --bin openmemory-server     # boot, Ctrl-C, run again — idempotency
psql -d qa_plan_check -c '\d project_qa_runs' -c '\d project_qa_evidence'
```

Pass = both boots log `PostgreSQL migrations complete`; both tables, both CHECK
constraints, all four indexes present.

**What could break** — FK typo (`project_graphs`, *not* `projects`) fails the first
boot loudly. `ensure_qa_tables` before `project_tasks` in either bootstrap fails
with `relation "project_tasks" does not exist`. A missing `mod qa;` in `mcp.rs`
appears only under `cargo check --workspace`, which is why it must be `--workspace`.
A missing Dockerfile chmod surfaces much later as a 500 on the first in-container
blob write.

---

## Phase 2 — HTTP routes

**Delivers:** all ten endpoints with cross-project isolation, atomic blob writes,
blob unlink on delete — curl-exercisable before any frontend exists.

**Creates** `apps/server/src/qa_blobs.rs` — axum handlers mirroring
`design_blobs.rs` including every safety property:

- `evidence_belongs_to_project(...)` — one `SELECT e.id FROM project_qa_evidence e
  JOIN project_qa_runs r ON r.id = e.run_id WHERE e.id = $1 AND r.project_id = $2`,
  called **before any file touch**, exactly as `design_exists` is at
  `design_blobs.rs:64-73` and `:130-139`. Missing or foreign → **404**, never 403,
  and no filesystem call happens.
- `get_qa_evidence_blob` — ownership check, `tokio::fs::read`, `Content-Type` from
  the row's stored `mime_type`.
- `put_qa_evidence_blob` — auth → size → ownership → `sniff_image_mime` (415 if
  `None`) → `create_dir_all` → **write temp, then rename** (`design_blobs.rs:158-172`)
  → best-effort temp cleanup on rename failure → `UPDATE ... SET mime_type, byte_size`.

**Modifies `apps/server/src/main.rs`** — `:13` `mod qa_blobs;`; `:31`
`routing::{get, patch, post}`; routes inserted at `:1644` after the design-assets
route:

```rust
.route("/projects/:id/qa/runs", get(list_project_qa_runs).post(create_project_qa_run))
.route("/projects/:id/qa/runs/:run_id",
       get(get_project_qa_run).patch(update_project_qa_run).delete(delete_project_qa_run))
.route("/projects/:id/qa/runs/:run_id/evidence", post(create_project_qa_evidence))
.route("/projects/:id/qa/evidence/:evidence_id",
       patch(update_project_qa_evidence).delete(delete_project_qa_evidence))
.route("/projects/:id/qa/evidence/:evidence_id/blob",
       get(qa_blobs::get_qa_evidence_blob)
           .put(qa_blobs::put_qa_evidence_blob)
           .layer(axum::extract::DefaultBodyLimit::max(qa::MAX_QA_BLOB_BYTES + 1024)))
```

Route-scoped `DefaultBodyLimit` for the reason at `main.rs:1633-1637`. Handler
bodies go next to `delete_project_design` (`main.rs:7403-7436`), the template for
delete-plus-unlink. Every handler opens with the `is_authenticated` guard
(`main.rs:5132`).

Two rules easy to miss:
- `delete_project_qa_run` must `SELECT id FROM project_qa_evidence WHERE run_id = $1`
  **before** deleting the run, then unlink each blob after the cascade. A missing
  file is not an error (`main.rs:7423-7427`).
- Evidence ordering is `ORDER BY sort_order ASC, captured_at ASC, created_at ASC`.
  `sort_order` defaults to 0 for every row, so without the tiebreak the timeline
  order is undefined and reshuffles between loads.

`finished_at`: status leaving `in_progress` sets `COALESCE(finished_at, now())`;
status set back to `in_progress` sets `NULL`.

**Verify** — throwaway DB, side-car on 18090, `T=$(tr -d '[:space:]' < ~/.openmemory/api_token)`:

1. Create projects A and B, a run under A, one text + one image evidence.
2. **Cross-project isolation** — `GET /projects/$B/qa/evidence/$EVIDENCE_IN_A/blob`
   → expect **404**; `ls /tmp/qa-blobs-check` unchanged (no file touched).
3. **Rejection** — `PUT` with `not-an-image` → 415; 34 MB body → 413.
4. **Round-trip** — `PUT` a PNG, `GET` it, `cmp` identical;
   `ls /tmp/qa-blobs-check | grep -c '\.tmp$'` → 0.
5. **Constraints/cascades** — `status='bogus'` and `kind='video'` both violate CHECK;
   deleting the linked task leaves the run with `task_id IS NULL`; deleting project A
   removes its runs and evidence.
6. **Unlink** — `DELETE` the run, then `ls /tmp/qa-blobs-check/$E.bin` → No such file.

**What could break** — a route typo panics at startup with a conflict message
(loud, immediate). Forgetting the pre-delete SELECT silently orphans blobs — step 6
catches it. Returning 403 instead of 404 leaks existence — step 2 catches it.

---

## Phase 3 — MCP tools

**Delivers:** seven tools declared, routed, implemented, consistent across all three files.

**Creates** `apps/server/src/mcp_app/qa_tools.rs` — `use super::*;` then
`impl McpServer`, matching `library_tools.rs` exactly in shape (arg extraction via
`args["x"].as_str().context("missing x")?`, UUID parse with `.context(...)`, return
`Ok(json!({ "content": [{ "type": "text", "text": ... }] }))`).

Six tools call `crate::qa::*` directly against `self.db`. `qa_evidence_add` is the
exception, per Finding 1:

1. `SELECT project_id FROM project_qa_runs WHERE id = $1` — the spec's arg list has
   `run_id` but no `project_id`, and the blob URL needs one.
2. `qa::add_evidence(...)` → `evidence_id`.
3. If `kind == "image"`: expand a leading `~` via `OPENMEMORY_HOME_DIR` then `HOME`
   — same precedence as `resolve_user_path` (`main.rs:2878-2891`); note
   `OPENMEMORY_HOME_DIR` is **not** set in the host MCP env, so the `HOME` fallback
   is the live path. Then `canonicalize` and require `starts_with` the canonicalised
   home root — canonicalise-then-compare is what rejects a symlink pointing outside.
   Read bytes, `PUT {base}/projects/{pid}/qa/evidence/{eid}/blob` via
   `HttpClient::new()` (`env_tools.rs:253`).
4. On any step-3 failure, `qa::delete_evidence(evidence_id)` and return the error.

`qa_api_base()` → `OPENMEMORY_URL` or `http://localhost:18080`; `qa_api_token()` →
`OPENMEMORY_API_TOKEN` else `~/.openmemory/api_token` trimmed — same order as
`scripts/mem:12-16` and `resolve_api_token` (`main.rs:2937-2956`).

**Modifies** `mcp_app/mod.rs:18` (`mod qa_tools;`), `mcp_app/dispatch.rs:88` (seven
arms before the `_ =>` fallthrough), `mcp_app/catalog.rs:1245` (seven schema
entries). Catalog descriptions must disambiguate from qa-automation's tools, e.g.
`qa_run_create`: "Record a QA run in OpenMemory's project QA log. This stores a
result; it does not execute tests — use qa-automation's `qa_run_test_plan` for that."

`README.md:295` gains a QA row; `README.md:279`'s tool count is corrected (it says
69; actual catalog entries are 71). Keep both edits in one commit so they never disagree.

**Verify — do not restart the stdio MCP server.** Recorded lesson, severity high:
compile-verify and exercise the equivalent logic over HTTP instead.

```bash
cargo check --workspace
cargo build --release --bin openmemory-mcp     # user restarts Claude Code to load it

grep -oE '"qa_[a-z_]+" =>' apps/server/src/mcp_app/dispatch.rs | sort > /tmp/d.txt
grep -oE '"name": "qa_[a-z_]+"' apps/server/src/mcp_app/catalog.rs | sort > /tmp/c.txt
# expect 7 in each, same name set
```

**What could break** — a name in `dispatch.rs` absent from `catalog.rs` compiles
fine and silently produces an invisible tool; the grep diff is the only check that
catches it.

---

## Phase 4 — Web API proxy routes

**Delivers:** the browser can reach every QA endpoint.

**Creates** five `route.ts` files under `apps/web/app/api/projects/[id]/qa/`, each
copying `apps/web/app/api/projects/[id]/lessons/route.ts` in structure (module-level
`API_URL`/`API_TOKEN`, local `authHeaders()`, local `proxy()`, `params` typed as a
`Promise` and awaited):

- `qa/runs/route.ts` — `GET` (forwards `req.nextUrl.search`), `POST`
- `qa/runs/[runId]/route.ts` — `GET`, `PATCH`, `DELETE`
- `qa/runs/[runId]/evidence/route.ts` — `POST`
- `qa/evidence/[evidenceId]/route.ts` — `PATCH`, `DELETE`
- `qa/evidence/[evidenceId]/blob/route.ts` — **does not use the JSON `proxy()`
  helper.** `GET` streams raw bytes, `PUT` forwards raw bytes, modelled on
  `apps/web/app/api/library/[entryId]/file/route.ts` and `.../library/upload/route.ts`.

Reuse `resolveApiToken()` from `apps/web/lib/api-token.ts`.

**Verify** — `npx tsc --noEmit && npx next lint`, then against the side-car:
`curl .../qa/runs | head -c 200` → JSON; `curl .../qa/evidence/$E/blob | file -` →
`PNG image data`. The blob route going through `proxy()` would mangle image bytes
into JSON; `file -` is what catches it.

---

## Phase 5 — QA panel + page wiring

**Delivers:** the rendered tab, verified against realistic data in a browser.

**Creates**

- `apps/web/lib/qa-meta.ts` — `QA_STATUSES` + `statusColor()`, following
  `lib/lesson-meta.ts` including its graceful-fallback comment.
- `apps/web/components/qa-panel.tsx` — `'use client'`,
  `export function QaPanel({ projectId }: { projectId: string })`.
  `components/lessons-panel.tsx` (817 lines) is the structural reference:
  fetch-in-`useCallback` + `useEffect` (`:146-179`), `toast.error` on failure,
  filter changes resetting `page` to 0, `Dialog` for create/edit, `AlertDialog` for delete.
  - Run list: status badge, title, target, `started_at`, evidence count, task chip
    when `task_id` is set, verdict filter.
  - Run detail: evidence timeline in `sort_order`, images and notes interleaved,
    each with `captured_at`.
  - Images: `<img src={`/api/projects/${projectId}/qa/evidence/${e.id}/blob`} />`
    with the `// eslint-disable-next-line @next/next/no-img-element` comment
    `library-gallery.tsx:248` requires.
  - Lightbox: `Dialog` + keydown listener stepping `ArrowLeft`/`ArrowRight`.
    **No existing lightbox to reuse** — `Expand` in `project-design-panel.tsx` is a
    different mechanism.
  - Upload: `<Input type="file" accept="image/png,image/jpeg,image/webp">` copying
    `library-gallery.tsx:429-433`, **plus** a drop zone. `grep dataTransfer` across
    `apps/web` returns only internal drag payloads — **no `dataTransfer.files`
    handling exists anywhere**, so the drop zone is genuinely new code. Two-step
    flow mirrors `library-gallery.tsx:340-355`: create row, then `PUT .../blob`
    with `await file.arrayBuffer()`.
  - Delete: `AlertDialog` copying `env-params-panel.tsx:654-694`. Skip the
    type-the-name-to-confirm input — that friction is calibrated to irreversible
    secret deletion, not a QA note.

**Two recorded high-severity project lessons apply:** read a shadcn primitive's base
`cn(...)` before passing `className`, matching the breakpoint prefix rather than
replacing defaults; and any flex/grid child holding unbounded text needs `min-w-0`
— which here means every run title, target, and caption cell.

**Modifies `apps/web/app/(sidebar)/projects/[id]/page.tsx`** — four surgical edits,
no QA logic inline: `:41` import; `:152` add `| 'qa'` to the union; `:188`/`:265`/`:277`
add `qaCount` state plus a badge-only `fetchQaCount` copying `fetchLessonCount`
(`:262-270`) and its `useEffect`; `:711` a nav button byte-identical in class string
to its siblings; `:1007` a render branch using the
`key={`${id}-${syncVersion}`}` remount pattern every sibling panel uses.

**Verify — `tsc --noEmit` and `eslint` are necessary but not sufficient.** The
recorded lesson *"Verify data-driven UI against realistic data, not empty state"*
makes the fixture mandatory.

Side-car against the **live** database with a scratch blob dir, web dev server on
3100. Seed against project `66e3dd3b-71fc-43c7-b1da-39d4806dd747`: four runs, one
per verdict; images and text interleaved at ascending `sort_order`; at least one run
linked to a real `project_tasks.id` and one with `task_id` NULL; one caption long
enough to test `min-w-0` wrapping; one run with three images so the lightbox arrows
have somewhere to go.

Confirm by eye: four distinct badge colours; thumbnails render (not broken-image
icons); notes and images interleave correctly; the task chip appears on exactly one
run; the filter narrows the list; the lightbox opens and arrow keys step; both
delete confirmations appear and cancel cleanly. Crop to the run list and to one
lightbox rather than screenshotting the whole page.

**Then delete the fixture** — `DELETE` each run through the API (cascades evidence,
unlinks blobs), confirm the list is empty and the scratch blob dir is empty, kill
both background processes.

**What could break** — the badge-count `useEffect` missing `activeTab` in its deps
leaves the count stale after a create (see the sibling comment at `:273-275`). A
`className` silently dropping a shadcn responsive default shows only in the browser,
never in `tsc`.

---

## Phase 6 — Skill + docs

**Creates** `skills/qa-run/SKILL.md` — YAML frontmatter then prose, matching
`skills/openmemory/SKILL.md` house style. Contents:

- The `qa` label + `assigned_to: agent` convention.
- Reading the task and drafting a test plan from it.
- Driving qa-automation through **its** MCP server, naming tools by their real
  names — `qa_list_projects`, `qa_create_test_plan`, `qa_run_test_plan`,
  `qa_get_report` — and stating these belong to qa-automation, distinct from
  OpenMemory's `qa_run_*`.
- **Where screenshots come from (Finding 3):** `qa_get_report` returns
  status/summary/aiSummary only; qa-automation exposes no artifact tool. The agent
  supplies its own screenshot files and passes those paths to `qa_evidence_add`.
- Writing the record back: `qa_run_create` → `qa_evidence_add` (× n) →
  `qa_run_update`, then moving the task to `done`.
- The hard rule: **a run left `in_progress` is a bug, not a valid end state.**
- `file_path` must be under the agent's home directory; symlinks out are rejected.

**Open question for the user:** whether a follow-up should add an artifact-path tool
to qa-automation's MCP server so run screenshots are recorded automatically.

---

## Reuse map

| Need | Reuse | Path |
|---|---|---|
| Blob root/path/temp trio | `library::blob_root/blob_path/temp_blob_path` | `apps/server/src/library.rs:27-46` |
| Ownership-before-file-touch, atomic write, temp-uuid race fix | `design_exists`, `put_design_blob` | `apps/server/src/design_blobs.rs:64-73`, `:158-172` |
| Blob-path unit-test shape | design blob tests | `apps/server/src/design_blobs.rs:170-215` |
| `CREATE TABLE IF NOT EXISTS` + idempotent ALTER | `library::ensure_library_table` | `apps/server/src/library.rs:73-127` |
| Delete-row-then-unlink-blob | `delete_project_design` | `apps/server/src/main.rs:7403-7436` |
| Auth guard | `is_authenticated` | `apps/server/src/main.rs:5132` |
| Route-scoped body limit | design blob route | `apps/server/src/main.rs:1630-1638` |
| Home-dir expansion precedence | `resolve_user_path` | `apps/server/src/main.rs:2878-2891` |
| API-token resolution order | `resolve_api_token`, `scripts/mem` | `apps/server/src/main.rs:2937-2956`, `scripts/mem:12-16` |
| MCP tool file shape | `library_tools.rs` | `apps/server/src/mcp_app/library_tools.rs` |
| MCP HTTP client pattern | `HttpClient::new()` per call | `apps/server/src/mcp_app/env_tools.rs:253` |
| DB-backed integration test shape | design blob cleanup test | `apps/server/tests/design_blob_cleanup_test.rs` |
| Next proxy route (JSON) | lessons routes | `apps/web/app/api/projects/[id]/lessons/route.ts` |
| Next proxy route (raw bytes) | library file / upload | `apps/web/app/api/library/[entryId]/file/route.ts` |
| Panel structure, filters, dialogs | `LessonsPanel` | `apps/web/components/lessons-panel.tsx` |
| Delete confirmation | `EnvParamsPanel` | `apps/web/components/env-params-panel.tsx:654-694` |
| Image display, file input, two-step upload | `LibraryGallery` | `apps/web/components/library-gallery.tsx:248-252`, `:340-355`, `:429-433` |
| Colour map + graceful fallback | `lib/lesson-meta.ts` | `apps/web/lib/lesson-meta.ts` |
| Token resolution (web) | `resolveApiToken` | `apps/web/lib/api-token.ts` |

## Risks & fallout

- **No existing test is invalidated.** `mcp_app/tests.rs` is mermaid-only; the four
  integration tests under `apps/server/tests/` are untouched. New tests are additive.
- **No saved-data format changes.** Both tables are new; no ALTERs to existing tables.
- **No version bump needed** — both `Cargo.toml` and `apps/web/package.json` are
  `0.2.0` and the change is additive.
- **Container rebuilds are the user's call, not this work's.** New HTTP routes reach
  the live UI only after `docker compose --profile api up -d --build openmemory-server web`;
  the seven MCP tools only after Claude Code restarts. Every verification step above
  avoids needing either.
- **The `qa-blobs` volume is fresh and empty** — no migration, no backfill.
- **`README.md`'s tool count is already stale** (says 69; 71 catalog entries).
  Correcting it is in scope.
- **Blob backup gap:** `qa-blobs` is not covered by README's "Backup and recovery",
  same as `design-blobs`/`library-blobs`. Pre-existing, worth one line while the
  implementer is already editing that file.

## Out of scope

Everything the spec's own "Out of scope" lists, plus: reworking existing blob
storage; adding an artifact tool to qa-automation's MCP server (raised as an open
question, not built); converting existing `PUT` partial-update routes to `PATCH`;
rebuilding or restarting any running container or the stdio MCP server.
