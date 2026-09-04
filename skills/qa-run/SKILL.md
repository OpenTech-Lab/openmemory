---
name: qa-run
description: Run a QA pass against a project task and record the result in OpenMemory's project QA log — draft a test plan from the task, execute browser and native Android checks through qa-automation's MCP server, capture screenshots, then write the run and its evidence back with qa_run_create / qa_evidence_add / qa_run_update. Unit, integration, API and load results are not executed by qa-automation at all; they reach the log through `pnpm test:record` or qa_results_import, then trend via qa_case_history. Trigger when a task is labelled `qa`, when asked to QA or verify a build, when test results need recording, or when a recorded QA run needs updating.
---

# QA Run

Two different MCP servers are involved and their tools have deliberately similar
names. Keep them straight:

| Server | Tools | Role |
|---|---|---|
| **qa-automation** | `qa_list_projects`, `qa_create_test_plan`, `qa_run_test_plan`, `qa_get_report`, … | **Executes** tests and returns a verdict |
| **OpenMemory** | `qa_event_create`, `qa_event_list`, `qa_event_update`, `qa_event_delete`, `qa_run_create`, `qa_run_update`, `qa_run_list`, `qa_run_delete`, `qa_evidence_add`, `qa_evidence_update`, `qa_evidence_delete` | **Records** what was tested, the verdict, the event grouping, and the evidence |
| **OpenMemory** | `qa_plan_create`, `qa_plan_list`, `qa_plan_update`, `qa_plan_delete` | **Stores** reusable test-script templates as source text. Never executes them. |
| **OpenMemory** | `qa_results_import`, `qa_case_history` | **Records** per-case results a runner produced somewhere else, and traces one case across runs. Never executes them either. |

`qa_run_test_plan` (qa-automation) starts a test. `qa_run_create` (OpenMemory)
files a record. They are not the same operation and neither substitutes for the
other.

The same trap exists one word apart for plans, and it is the easier of the two to
fall into:

- **`qa_create_test_plan`** (qa-automation) registers checks that will actually be
  **executed** by the worker.
- **`qa_plan_create`** (OpenMemory) saves a **template** — Jest, Playwright or
  Maestro source text — into the project's QA tab. Nothing runs it, ever.

If you want a test to run, you want qa-automation. If you want a script to still
exist next week, you want OpenMemory. Reaching for `qa_plan_create` and then
waiting for a verdict is the specific mistake this table exists to prevent.

## What qa-automation can and cannot run

**qa-automation executes browser and native Android tests only.** Nothing else.
It has no runner for unit tests, no runner for API or contract tests, and no load
generator, and it exposes no ingestion tool — there is no way to hand it results
that something else produced.

So for every other kind of test, the sequence in §2 below does not apply and
`qa_run_test_plan` is the wrong tool. Unit, integration, API and load results
reach the QA log by one of two paths, both of which record results rather than
produce them:

- **Automatic capture** — the preferred path, and the one that needs no agent at
  all. `pnpm test:record` in `apps/web` or `apps/server` runs the suite, writes
  JUnit XML, and posts every case to the project's QA log via
  `scripts/qa-ingest.mjs`. The test command's exit status is preserved, and a
  failed ingest never turns a red suite green.
- **`qa_results_import`** — for a runner not yet wired to `test:record`, or for
  results produced on another machine. Write the normalized JSON envelope to a
  file under `$HOME` and pass its path. Like `qa_evidence_add`, `file_path` is
  canonicalised and must resolve under the home directory.

Per-case rows exist **only** through ingest. There is no `qa_case_create`, and
`qa_run_create` records a run without any cases attached. Once cases are in,
`qa_case_history` answers "when did this test start failing" for a single
`case_key` (`file::suite::name`).

## The convention

A task carrying the label `qa` with `assigned_to: agent` is a QA request. Pick it
up like any other task: move it to `in_progress`, do the work, move it to `done`.
The difference is that a QA task's deliverable is a **recorded run with evidence**,
not a code change.

## Procedure

### 1. Read the task and draft a test plan

Fetch the task (`project_task_list` filtered to the project, or the task id you
were given). The test plan comes from the task's own description — what changed,
what surface it touches, what "working" means for it. Write down the concrete
checks before running anything; a plan invented after seeing the results is not a
test plan.

Check `qa_plan_list` first: the project may already hold a template for this
surface, in which case adapt it rather than writing one from scratch. If you end
up writing something reusable, save it with `qa_plan_create` so the next run
starts from it instead of from nothing. These are stored templates only — see the
table above before expecting one to execute.

### 2. Execute through qa-automation

**Only if the pass is a browser or native Android test.** For anything else, skip
to "What qa-automation can and cannot run" above and record the results instead.

Drive qa-automation's MCP server, not your own ad-hoc scripting:

1. `qa_list_projects` — find the qa-automation project matching the work.
2. `qa_create_test_plan` — register the checks from step 1.
3. `qa_run_test_plan` — start the run. Keep the returned run id.
4. `qa_get_report` — poll for `status`, `summary`, `aiSummary`.

Store that run id in the OpenMemory run's `external_ref` so the two systems can be
correlated later.

### 3. Capture your own screenshots

**qa-automation exposes no artifact tool.** `qa_get_report` selects only `id`,
`status`, `summary`, `aiSummary`, `startedAt`, `finishedAt` — the worker uploads
screenshots to its own object storage and no MCP tool surfaces them. So the
verdict comes from qa-automation; the *evidence* is yours to capture.

Take the screenshots yourself (the `browse` skill, or whatever the surface under
test needs), save them to disk, and pass those paths to `qa_evidence_add`.

### 4. Write the record back

If several checks belong to one release or deployment checkpoint, create one
QA event first and pass its `event_id` to every run. For example:

```json
qa_event_create { "project_id": "<uuid>", "name": "before deploy v1.0.0" }
```

Then include the returned event id when creating each run:

```json
qa_run_create {
  "project_id": "<uuid>",
  "event_id": "<qa-event-uuid>",
  "title": "Checkout flow smoke test",
  "task_id": "<uuid of the qa task>",
  "target": "https://staging.example.com/checkout",
  "external_ref": "<qa-automation run id>",
  "status": "in_progress"
}
```

`qa_run_create → qa_evidence_add (× n) → qa_run_update`

**Create the run first**, at the start of the pass, not at the end:

```json
qa_run_create {
  "project_id": "<uuid>",
  "event_id": "<qa-event-uuid>",
  "title": "Checkout flow after payment-provider swap",
  "task_id": "<uuid of the qa task>",
  "target": "https://staging.example.com/checkout",
  "external_ref": "<qa-automation run id>",
  "status": "in_progress"
}
```

Attach evidence as you go, interleaving screenshots and notes in the order a
reader should see them. `sort_order` controls that order — set it explicitly and
ascending, because it defaults to `0` for every row and ties fall back to
`captured_at`:

```json
qa_evidence_add { "run_id": "<uuid>", "kind": "text",  "caption": "Preconditions", "body": "Seeded cart with 2 items…", "sort_order": 0 }
qa_evidence_add { "run_id": "<uuid>", "kind": "image", "caption": "Card form renders", "file_path": "~/shots/checkout-01.png", "sort_order": 1 }
```

Then close the run with the verdict:

```json
qa_run_update { "run_id": "<uuid>", "status": "failed", "summary": "3DS challenge never returns to the merchant page." }
```

Finally move the task to `done`.

## Hard rules

- **A run left `in_progress` is a bug, not a valid end state.** Every run you
  create must end at `passed`, `failed`, or `blocked`. If you cannot finish the
  pass — environment down, dependency missing, ambiguous requirements — close it
  as `blocked` with a summary saying what stopped you. Never abandon a run mid
  flight; an unclosed run reads as "still running" forever.
- **`file_path` must resolve under the agent's home directory.** The path is
  canonicalised and checked, so a symlink pointing outside home is rejected. Save
  screenshots somewhere under `$HOME` before attaching them.
- **Do not base64 image bytes into an argument.** `qa_evidence_add` reads the file
  from disk and uploads it for you. Pass a path.
- **Only `png`, `jpeg`, and `webp` are accepted**, determined by magic bytes, not
  by the file extension. A `.png` that is really a PDF is rejected with 415.
- **Record the verdict qa-automation actually returned.** If `qa_get_report` says
  the run failed, the OpenMemory run is `failed` — do not soften it to `blocked`
  because the failure looks environmental. Explain the nuance in `summary`.
- **Never route a unit, API or load pass through qa-automation.** It cannot run
  them and has no way to accept results from something that can. Run the suite
  where it lives and record what came back — `pnpm test:record`, or
  `qa_results_import` for a runner that is not wired up yet.

## Reading and correcting past runs

- `qa_event_list` with `project_id` — find existing release/deployment checkpoints.
- `qa_run_list` with `project_id` (optionally `status`, `event_id`, or `task_id`) — newest first.
- `qa_run_update` with `event_id` (or `event_id: null`) — move an existing run into or out of an event.
- `qa_evidence_update` — fix a caption, note text, `sort_order`, or `captured_at`.
- `qa_evidence_delete` / `qa_run_delete` — permanent, and they unlink the blob
  files from disk. There is no undo and no separate backup of the blob volume.

Everything recorded here is visible in the web UI under the project's **QA** tab.
