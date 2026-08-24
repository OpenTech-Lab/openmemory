# QA Plans — Design

Status: approved, implemented 2026-08-24.
Extends `2026-08-22-project-qa-tab-design.md`, which this document assumes.

## Purpose

The QA tab records **results**: runs, verdicts, and the screenshot evidence behind
them. It has no home for the *input* to a run.

That gap is visible in the `qa-run` skill's own procedure, whose first step insists:

> Write down the concrete checks before running anything; a plan invented after
> seeing the results is not a test plan.

Today that written-down plan lives in one agent's context for one session and is
then lost. The next run over the same surface starts from nothing, and nothing
accumulates across runs.

QA Plans give it somewhere to live: named, editable test-script templates —
Jest unit tests, Playwright e2e scripts, Maestro flows — stored as source text and
scoped to a project.

A plan is **a template you adapt**. OpenMemory never executes one. That boundary
is the whole design constraint; see "Naming" below.

Plans were not listed under "Out of scope" in the original QA tab design, so this
extends that design rather than revisiting a decision it made.

## Naming

Two MCP tool families now sit one word apart and mean opposite things:

| Tool | Server | What it does |
|---|---|---|
| `qa_create_test_plan` | qa-automation | Registers checks that **will be executed** |
| `qa_plan_create` | OpenMemory | Saves a **template**; nothing runs it |

The original QA design already carried a disambiguation table for
`qa_run_test_plan` vs `qa_run_create`. This pair is closer and easier to confuse,
so every `qa_plan_*` tool description states explicitly that OpenMemory does not
execute plans, and `skills/qa-run/SKILL.md` carries a dedicated callout.

Rule of thumb, recorded there: *if you want a test to run, you want qa-automation;
if you want a script to still exist next week, you want OpenMemory.*

## Data model

### `project_qa_plans`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | `gen_random_uuid()` |
| `project_id` | UUID NOT NULL | → `project_graphs(id)` ON DELETE CASCADE |
| `name` | TEXT NOT NULL | `CHECK (length(btrim(name)) > 0)` |
| `kind` | TEXT NOT NULL | `jest \| playwright \| maestro \| other`, default `jest` |
| `language` | TEXT NOT NULL | `typescript \| javascript \| yaml \| python \| other`, default `typescript` |
| `description` | TEXT | nullable; the only tri-state-updatable field |
| `body` | TEXT NOT NULL | the script source, default `''` |
| `created_by` | TEXT NOT NULL | `agent \| human`, default `agent` |
| `created_at` / `updated_at` | TIMESTAMPTZ NOT NULL | `now()` |

One index: `(project_id, updated_at DESC)`.

Decisions worth preserving:

- **`language` is a column, not derived from `kind`.** Jest can be JS or TS;
  Playwright has a Python variant; Maestro is always YAML. Without it the UI
  cannot choose a file extension for Copy/Download.
- **`body` is `NOT NULL DEFAULT ''`**, mirroring `project_designs.source`. There
  is no meaningful distinction between "empty" and "not yet set".
- **Ordered by `updated_at`, not `created_at`.** Plans are living documents; a
  save bubbling a plan to the top of the list is the useful behaviour.
- **One index, not the three `project_qa_runs` carries.** Plans have no
  `task_id`/`event_id` filters and are a small per-project set — closer to
  `project_qa_events` in shape than to runs.
- **Omitted from v1**, each cheap to add later: `sort_order`, an archive/`status`
  flag, `task_id`/`event_id` links, `tags`. None were implied by the request.

No blob storage. Unlike evidence, a plan is text in a column — which is why
deletion is a single statement with no filesystem cleanup, and why the MCP
delete/update tools call the DB layer directly instead of routing through HTTP
the way `qa_run_delete` must.

## HTTP API

```
GET    /projects/:id/qa/plans?kind=     → {"plans": [...], "total": n}
POST   /projects/:id/qa/plans           → 201
GET    /projects/:id/qa/plans/:plan_id
PATCH  /projects/:id/qa/plans/:plan_id
DELETE /projects/:id/qa/plans/:plan_id
```

Same conventions as the rest of the QA surface: bearer-token guard returning 401,
400 on validation failure, 404 on a missing row, and the `project_id: Option<Uuid>`
scoping switch in the DB layer — `Some(id)` from these routes, `None` from MCP.

## MCP tools

`qa_plan_create`, `qa_plan_list`, `qa_plan_update`, `qa_plan_delete`.

No `qa_plan_get`, matching runs and events, neither of which exposes one —
single-record fetch is a web-UI concern served by the HTTP route.

## UI

The QA tab gains a **Runs | Plans** sub-tab switcher, built on the existing shadcn
`Tabs` primitive with `variant="line"` so it reads as sub-navigation beneath the
page's hand-rolled primary tab bar.

The switcher lives in a new `qa-section.tsx` wrapper rather than inside
`qa-panel.tsx` (whose first JSX is Runs-specific chrome, in a file already past
1400 lines with six dialogs) or in `page.tsx` (which would break the one-line
delegation shape every other tab follows). `page.tsx` changes by two lines.

`qa-plans-panel.tsx` mirrors the runs panel's shape — aside list plus detail pane,
create `Dialog`, delete `AlertDialog` — but carries none of its weight: no blobs,
no upload, no lightbox, no resizable pane.

**Editing is a monospace `Textarea`.** No syntax highlighter is installed in
`apps/web`, and none is added here; a `Textarea` for editing and a styled `<pre>`
for display is the established house pattern. Introducing Monaco or CodeMirror
would be the first editor dependency in the dashboard and is deliberately out of
scope.

**Layout hazard.** `qa-panel.tsx`'s header bleeds past its padding via
`-mx-4 … w-[calc(100%+2rem)]`, which assumes its immediate parent adds no
horizontal padding. `qa-section.tsx` must therefore add no `px-*`/`mx-*`. This is
a silent visual regression — only a screenshot catches it.

The primary QA tab badge stays wired to runs only. A static template count does
not fit a signal that otherwise reads as "things needing attention".

## Starter templates

Shipped as a static `apps/web/lib/qa-plan-templates.ts`, not seeded into the
database.

DB seeding was rejected on three counts: it would insert rows into every project
including those that will never use them; it would need a backfill story for
existing projects; and — decisively — the moment a user edits a seeded row it is
no longer "the template", which forces a second read-only-master vs mutable-copy
concept into the model purely to keep "reset to starter" meaningful.

The static file is the single source of truth. "New Plan" reads it once at
creation; after that the row is an ordinary, fully independent plan.

Consequence, accepted: `qa_plan_create` over MCP does not know the templates.
Its `body` argument is optional and defaults to `''`, on the assumption that an
agent calling it already has the code it wants to store. If that changes, the
snippets move to a shared JSON both Rust and TypeScript read.

## Testing

- `cargo test qa::` — validator unit tests for name, kind, and language, matching
  the existing `validates_run_status` style.
- `apps/web` has no test suite; `next build` is the correctness gate.
- Manual: create a plan, edit and save it, confirm it jumps to the top of the list
  (proving `updated_at` ordering), and confirm the Runs header still aligns under
  the new tab bar.

## Out of scope

- Executing plans. That is qa-automation's job and the reason for the naming section.
- Syntax highlighting or an embedded code editor.
- Linking a plan to a run, task, or event.
- Versioning or diffing plan bodies.
- Sharing a plan across projects, or a global template library.
