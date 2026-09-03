# Implementation Plan — Test History & Content Ingestion

Date: 2026-09-03
Status: **approved 2026-09-03** — stage 0 in progress; stages 1-5 not started

User decisions: build **stage 0 only** for now · **add `cargo nextest`** when
stage 3 lands · passed-case retention **90 days** (failures never pruned)
Extends: `docs/superpowers/specs/2026-08-22-project-qa-tab-design.md`,
`docs/superpowers/specs/2026-08-24-qa-plans-design.md`

## Problem

The QA feature records one prose row per QA pass. It cannot answer "when did test
X start failing", "which tests are flaky", or "did p95 regress" — and nothing
captures the tests a developer actually runs.

The evidence that this matters is the feature's own adoption. Live production
data as of 2026-09-03:

| Table | Rows |
|---|---|
| `project_qa_runs` | 5 |
| `project_qa_evidence` | 19 |
| `project_qa_plans` | **0** |
| `project_qa_events` | **0** |

All five runs are agent-authored MVP smoke tests dated 2026-08-23/24 — the two
days the feature was built. Nothing since. The Plans feature shipped 2026-08-24
and has never been used. Meanwhile the repo ran ~343 unit tests continuously over
the same window and captured none of them.

The recording layer is not low quality; it is well engineered. The bottleneck is
that recording requires a human to remember to ask an agent to call MCP tools.

## Gaps

1. **No per-case granularity.** A 161-test run collapses to one row plus prose.
2. **No ingestion.** No CLI, no endpoint, no hook. `scripts/mem` (608 lines) has
   zero QA commands, so the only way to record anything is an MCP call from
   inside an agent session.
3. **No run-kind taxonomy.** `plans.kind` distinguishes jest/playwright/maestro;
   `runs` has nothing.
4. **No numeric metrics.** Evidence is `image|text` only. A load test's real
   output — p50/p95/p99, RPS, error rate — has nowhere to live but prose.
5. **No link between test content and result.** `project_qa_plans` has no FK to
   `project_qa_runs` and no content hash, so you cannot tell which version of a
   test produced a given result.
6. **`create_run` cannot set timestamps.** `started_at`/`finished_at` are
   `now()`-driven (`qa.rs`), so an already-finished run cannot be ingested with
   its real duration.

## Approach

**OpenMemory owns the ingestion pipeline. This is the only option, not a
preference.**

Recon against `/home/toyofumi/projects/qa-automation` established three facts:

1. **It has no ingestion path at all.** Its only route to a result row is
   executing a TestPlan itself from its own TestStep DSL. "Run tests elsewhere,
   hand qa-platform the results" does not exist.
2. **It can only run browser and native Android** — Playwright (chromium/firefox,
   raw API, not `@playwright/test`) and Maestro over adb. No API runner, no load
   runner. A `test.api` queue type sits in its shared types with no producer and
   no consumer.
3. **It already stores the granularity OpenMemory lacks, and hides it.**
   `TestRun → TestResult (scenarioId, status, durationMs, errorMessage,
   stepResults) → Artifact`. But `qa_get_report` returns only
   `{id, status, summary, aiSummary, startedAt, finishedAt}` and no MCP tool
   exposes artifacts or per-case rows — they are REST+JWT only.

Consequence for the `kind` taxonomy below: of
`manual|unit|integration|api|e2e|load|other`, qa-automation can produce results
for **`e2e` only**. `unit`, `integration`, `api` and `load` have exactly one
route into OpenMemory — the ingest endpoint. That sentence belongs in the module
doc comment of `apps/server/src/qa_ingest.rs`, because it is the reason the
module exists.

Also relevant: qa-automation's `aiSummary` is **deterministic string templating**
(counts plus the first three failures), not an LLM call. The calling agent is
expected to be the analysis layer.

### Ingest contract: normalized JSON envelope, parsed client-side

One universal ingest endpoint fed by a normalized JSON envelope; JUnit XML is
parsed into that envelope by the ingester, not by the server.

Parsing JUnit XML server-side would need a new Rust XML dependency (`Cargo.lock`
has none — no `quick-xml`, `roxmltree`, or `xml-rs`) and would pin the server to
one format. Parsing in the ingester keeps the server contract format-agnostic, so
k6, a custom harness, or a future runner needs no server change.

The repo already has the parser to copy: `apps/web/lib/drawio-graph.ts` is a
hand-rolled, dependency-free XML micro-parser whose header comment states the
same rationale (`DOMParser` is `undefined` under plain Node, verified on v26.1.0).
Its `decodeXmlEntities` (line 33) and `parseAttrs` (line 57) are directly
reusable; JUnit XML is flatter than mxfile XML.

**Verified:** `node --test --test-reporter=junit` works on Node v26.1.0. Two
quirks the parser must handle: node's junit reporter emits `classname="test"` as
a **constant** (identity lives in the `file` attribute), and emits `<testcase>`
directly under `<testsuites>` when no `describe` is used. Also verified: Node 26
strips types natively, so `scripts/qa-ingest.mjs` can `import` a `.ts` parser
with no build step.

Format coverage:

| Runner | Path | Status |
|---|---|---|
| `node:test` (web unit) | `--test-reporter=junit` | verified working |
| `cargo` (Rust) | `cargo nextest run` | stable, needs nextest |
| Playwright (e2e) | built-in `junit` reporter | when e2e exists |
| pytest (api) | `--junitxml` | when api tests exist |
| k6 (load) | `--summary-export` JSON | metrics path, not case path |

Load tests need a separate metrics path because their output is numbers, not
pass/fail cases. That split is reflected in the schema.

### Content↔result link

A content-addressed source table keyed by sha256 of the **file**. N runs of an
unchanged test cost one row; when the file changes a new sha appears, and you can
diff the two versions against the run where results changed. Per-test-body
extraction (the server already depends on `tree-sitter-typescript`/`-rust`/
`-javascript` for `indexer.rs`) is deliberately follow-up work.

### Ingest leaves `summary` NULL — deliberately

Given that qa-automation's `aiSummary` is deterministic templating, the ingest
path must not manufacture an equivalent. `project_qa_runs.summary` stays what it
has always been: agent or human prose. The counters, case rows and metrics carry
the machine-readable story; a templated sentence posing as analysis would be
strictly worse than an empty field and would erode the one column a reader
currently trusts to be considered. If a summary is wanted, the calling agent
writes it via `qa_run_update` — the same division of labour qa-automation assumes.

### Zero-friction capture — two options evaluated

| | Coverage | Fragility | Where it lives |
|---|---|---|---|
| **A. Claude Code `PostToolUse` hook on `Bash`** | Only tests *Claude* runs — not the developer's terminal, not CI | High: must scrape human/TAP stdout, since the dev's command never asked for a report file | `~/.claude/hooks/`, unversioned, unshippable with the repo |
| **B. The project's own test command does the capture** | Every `pnpm test` / `turbo test` from any terminal, from Claude, and from CI | Low: the runner emits a real report file | `apps/web/package.json`, `apps/server/package.json`, `scripts/qa-ingest.mjs` — versioned |

**Recommendation: B.** It is the developer's actual entry point, and it lands on
the same two lines stage 0 has to edit anyway. The ingest step must never fail
the test run — `|| true` belongs on the *ingest* call and nowhere else, the exact
inverse of the stage-0 bug.

## 1. Schema

All DDL lives in **`ensure_qa_tables`, `apps/server/src/qa.rs:167`** — the
existing `CREATE TABLE IF NOT EXISTS` + idempotent-`ALTER` function, already
called from both bootstrap paths (`main.rs:2335`, `mcp_app/bootstrap.rs:293`).
No new `ensure_*` entry point, no migration file.

### 1a. `project_qa_runs` — altered

Existing 5 rows and the 4 statuses are untouched: every new column is `DEFAULT`ed,
`status`'s CHECK is not modified, and `created_by` is not extended.

| column | type | notes |
|---|---|---|
| `kind` | `TEXT NOT NULL DEFAULT 'manual'` | `CHECK (kind IN ('manual','unit','integration','api','e2e','load','other'))` |
| `runner` | `TEXT NULL` | `node:test`, `cargo nextest`, `playwright`, `k6` |
| `total_cases` | `INT NOT NULL DEFAULT 0` | denormalized at ingest, immutable after |
| `passed_cases` | `INT NOT NULL DEFAULT 0` | |
| `failed_cases` | `INT NOT NULL DEFAULT 0` | |
| `skipped_cases` | `INT NOT NULL DEFAULT 0` | |
| `duration_ms` | `BIGINT NULL` | wall time |
| `commit_sha` | `TEXT NULL` | `git rev-parse HEAD` at ingest |
| `branch` | `TEXT NULL` | `git rev-parse --abbrev-ref HEAD` |

Upgrade path — inline CHECK on the `CREATE TABLE` for fresh installs, then for
existing ones one `ADD COLUMN IF NOT EXISTS ... .ok()` per column (matching the
existing `event_id` ALTER at `qa.rs:213`), followed by a
`DO $$ … pg_constraint … END $$` guard that adds
`project_qa_runs_kind_check` only if absent. That guard idiom is copied from the
one already in the tree at **`apps/server/src/main.rs:2106-2119`**, so fresh and
upgraded installs converge on the same constraint.

New index:
`idx_project_qa_runs_project_kind_started ON project_qa_runs(project_id, kind, started_at DESC)`.

**Why `created_by` is not extended with `'ci'`:** relaxing that CHECK requires
DROP+ADD on a column the frontend branches on (Bot vs User icon,
`apps/web/components/qa-panel.tsx:946-950`). `runner` carries the same fact with
zero blast radius.

**Why case counts are denormalized but `evidence_count` is not:** case counts are
written once at ingest and never mutated. Evidence is mutated by four paths
(HTTP + MCP × add/delete), so a counter would drift — that one is a `LEFT JOIN`
in the list query.

### 1b. `project_qa_test_cases` — new

```sql
CREATE TABLE IF NOT EXISTS project_qa_test_cases (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id           UUID NOT NULL REFERENCES project_qa_runs(id)  ON DELETE CASCADE,
    project_id       UUID NOT NULL REFERENCES project_graphs(id)   ON DELETE CASCADE,
    case_key         TEXT NOT NULL,
    suite            TEXT,
    name             TEXT NOT NULL,
    file             TEXT,
    status           TEXT NOT NULL CHECK (status IN ('passed','failed','skipped','error')),
    duration_ms      DOUBLE PRECISION,
    failure_message  TEXT,
    failure_detail   TEXT,
    source_sha       TEXT,
    external_ref     TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
)
```

`external_ref` holds the producing system's own per-case id —
qa-automation's `TestResult.scenarioId` for a future backfill, a CI system's case
id otherwise. One nullable column now means backfill is a plain `INSERT` rather
than a migration against a table holding millions of rows. It is deliberately
**not** folded into `case_key`: `case_key` is the stable cross-producer identity,
and a foreign id is not. No index on it yet — add a partial
`(project_id, external_ref) WHERE external_ref IS NOT NULL` when a backfill
actually lands, not before.

This pairs with the existing `project_qa_runs.external_ref` (`qa.rs:198`), which
already holds the qa-automation `TestRun` id, so the run↔run link exists and the
case↔case link becomes possible. That is the full correlation chain.

Indexes:

```sql
-- The primary index: "history of one test", which is the feature's core question.
-- This is why project_id is denormalized onto the case row: joining through
-- project_qa_runs on every history lookup would defeat the index. Safe because
-- update_run (qa.rs:515) has no project-reassignment path — that invariant needs
-- a comment there so nobody "fixes" it later.
CREATE INDEX IF NOT EXISTS idx_qa_cases_project_key_created
    ON project_qa_test_cases(project_id, case_key, created_at DESC);
-- Rendering one run's cases, failures first.
CREATE INDEX IF NOT EXISTS idx_qa_cases_run_status
    ON project_qa_test_cases(run_id, status);
-- "What is failing right now", without scanning passed rows. Partial: on a healthy
-- suite this indexes ~1% of the table.
CREATE INDEX IF NOT EXISTS idx_qa_cases_project_failed
    ON project_qa_test_cases(project_id, created_at DESC)
    WHERE status IN ('failed','error');
```

`case_key` is the stable cross-run identity and the join key for every trend
query. It is readable, not a hash: `file::suite::name`, empty segments elided,
**truncated at 480 chars with `#` + the first 8 hex of `sha256(full)` appended
when truncation occurred**, so two long names cannot silently collide into one
history. It is built by the ingester and normalized: the file
path made repo-relative (an absolute path embeds the developer's home directory
and would break correlation between machines and CI), and node's constant
`classname="test"` dropped rather than used as `suite`. Two runs of an unchanged
test on different machines must produce the same `case_key` or the history breaks.

`status` has four values, not the runs table's four: `passed|failed|skipped|error`.
`error` is distinct from `failed` because a suite that could not execute (import
error, timeout, panic in setup) is a different signal from an assertion that
evaluated false, and collapsing them hides infrastructure decay.

### 1c. `project_qa_run_metrics` — new

Load and pressure tests produce numbers, not pass/fail cases. One row per named
metric per run, rather than a JSONB blob, so a regression query is a plain
indexed comparison rather than JSON extraction.

```sql
CREATE TABLE IF NOT EXISTS project_qa_run_metrics (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id      UUID NOT NULL REFERENCES project_qa_runs(id) ON DELETE CASCADE,
    project_id  UUID NOT NULL REFERENCES project_graphs(id)  ON DELETE CASCADE,
    metric_key  TEXT NOT NULL,
    value       DOUBLE PRECISION NOT NULL,
    unit        TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (run_id, metric_key)
)
```

```sql
CREATE INDEX IF NOT EXISTS idx_qa_metrics_project_key_created
    ON project_qa_run_metrics(project_id, metric_key, created_at DESC);
```

`metric_key` is free text by design — k6, artillery and a custom harness do not
agree on names, and a CHECK constraint would reject a runner nobody has adopted
yet. The ingester normalizes the common ones (`http_req_duration_p95`,
`http_reqs_rate`, `http_req_failed_rate`, `vus_max`, `iterations`) so charts
work out of the box; anything else is stored verbatim under its own name.

`unit` (`ms`, `req/s`, `pct`, `count`) exists so the UI can format a value it has
never seen without a lookup table.

The `UNIQUE (run_id, metric_key)` is what makes ingest idempotent per metric: a
re-ingest of the same report upserts rather than duplicating.

### 1d. `project_qa_test_sources` — new

Content-addressed test source. This is the "test content/patterns" half of the
request, and the missing link between `project_qa_plans` (content) and
`project_qa_runs` (history).

```sql
CREATE TABLE IF NOT EXISTS project_qa_test_sources (
    project_id   UUID NOT NULL REFERENCES project_graphs(id) ON DELETE CASCADE,
    source_sha   TEXT NOT NULL,
    file         TEXT NOT NULL,
    language     TEXT,
    body         TEXT NOT NULL,
    byte_size    INT  NOT NULL,
    first_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, source_sha)
)
```

```sql
CREATE INDEX IF NOT EXISTS idx_qa_sources_project_file_last
    ON project_qa_test_sources(project_id, file, last_seen DESC);
```

`source_sha` is the sha256 of the **file's** bytes. `project_qa_test_cases.source_sha`
references it — deliberately **not** a declared FK: a case must still record its
result if the source upload is skipped (`--no-source`, an unreadable file, a
runner that reports no `file` attribute). A dangling `source_sha` degrades to
"content unknown for this run", which is strictly better than refusing the result.

The composite PK makes ingest naturally idempotent: N runs of an unchanged file
touch one row and only bump `last_seen`. A changed file produces a new sha, and
the two rows can be diffed against the run where results changed — which is
exactly the "when did this test change and did that explain the failure" question.

**Why file-level, not per-test-body:** per-test extraction needs a parser per
language. The server already depends on `tree-sitter` plus its `-rust`,
`-typescript`, `-javascript` and `-python` grammars for `indexer.rs`
(`apps/server/Cargo.toml:40-44`), so this is achievable later without new
dependencies — but it is a materially bigger change than hashing a file, and
file-level granularity already answers the question that motivated the request.
Explicit follow-up work, not a hidden gap.

**Relationship to `project_qa_plans`:** the two are not merged and neither
replaces the other. `project_qa_plans` holds hand-authored templates a human
edits and OpenMemory never executes. `project_qa_test_sources` holds
machine-captured snapshots of tests that actually ran. Conflating them would
break the plans table's editability guarantee.

## 2. HTTP routes and MCP tools

### 2a. New routes

Added to the existing `/projects/:id/qa/...` block in `main.rs:1756-1785`. Every
handler starts with the same `is_authenticated(&headers, &state.api_token)` guard
as the other nine — verified present on all of them today, and this must not
become the exception.

| Method + path | Purpose |
|---|---|
| `POST /projects/:id/qa/ingest` | The ingest endpoint. Accepts the normalized envelope, creates the run + cases + metrics + sources in **one transaction**, returns the run id. |
| `GET /projects/:id/qa/runs/:run_id/cases` | Per-case results for one run. Supports `?status=failed` and `?limit=`. |
| `GET /projects/:id/qa/cases/:case_key/history` | The trend query: this test's status across runs, newest first. `?limit=` (default 50). |
| `GET /projects/:id/qa/metrics?metric_key=&limit=` | Metric series for charting. |
| `GET /projects/:id/qa/sources/:source_sha` | One captured source snapshot. |

`list_project_qa_runs` is **modified**, not replaced: its query gains a
`LEFT JOIN LATERAL` supplying `evidence_count`, and it returns the new run columns.
That is the server half of the 1+N fix in §4.

### 2b. Ingest envelope

```jsonc
{
  "kind": "unit",                    // required; the runs CHECK vocabulary
  "runner": "node:test",             // free text
  "title": "web unit tests",         // required
  "started_at": "2026-09-03T07:00:00Z",
  "finished_at": "2026-09-03T07:00:04Z",
  "duration_ms": 4210,
  "commit_sha": "acb437a…",
  "branch": "main",
  "event_id": null,
  "task_id": null,
  "external_ref": null,
  "cases": [
    { "case_key": "apps/web/lib/budget-compare.test.ts::formatMoney renders whole units",
      "suite": null,
      "name": "formatMoney renders whole units",
      "file": "apps/web/lib/budget-compare.test.ts",
      "status": "passed",
      "duration_ms": 0.0127,
      "failure_message": null,
      "failure_detail": null,
      "source_sha": "9f2c…",
      "external_ref": null }
  ],
  "metrics": [
    { "metric_key": "http_req_duration_p95", "value": 412.5, "unit": "ms" }
  ],
  "sources": [
    { "source_sha": "9f2c…", "file": "apps/web/lib/budget-compare.test.ts",
      "language": "typescript", "body": "…", "byte_size": 4812 }
  ]
}
```

The run's `status` is **derived server-side**, never taken from the client:
`failed` if any case is `failed`/`error`, else `passed`. That keeps the existing
four-status vocabulary meaningful and prevents a green-washed ingest. `summary`
is left NULL, per the design decision above.

`sources` is optional and deduplicated by the server against
`project_qa_test_sources` before insert, so re-running an unchanged suite
uploads bodies once and then stops paying for them.

### 2c. New MCP tools

Two, and no more — every tool here is a permanent piece of the naming hazard
surface.

| Tool | Purpose |
|---|---|
| `qa_results_import` | Submit the envelope above. The programmatic sibling of the HTTP ingest route. |
| `qa_case_history` | Read one test's history across runs — the question agents will actually ask. |

**Naming rule:** *no new tool may reuse a noun or verb from qa-automation's
vocabulary* (`qa_list_projects`, `qa_create_project`, `qa_get_project`,
`qa_update_project`, `qa_list_test_plans`, `qa_get_test_plan`,
`qa_create_test_plan`, `qa_update_test_plan`, `qa_run_test_plan`,
`qa_get_report`). The existing collision — `qa_plan_create` (OpenMemory, stores a
template) versus `qa_create_test_plan` (executes) — happened because both sides
reached for `plan`. Applying the rule:

- **`qa_report_ingest` — rejected.** "report" collides with `qa_get_report`,
  handing an agent two same-noun tools whose data flows in opposite directions.
  That is the exact shape of the existing bug.
- **`qa_test_*` — rejected.** Collides with `qa_create_test_plan` /
  `qa_run_test_plan`.
- **`import` and `case` appear nowhere in qa-automation's vocabulary** (it says
  "scenario" and "result"), so both chosen names are unambiguous by construction.

Both new names therefore avoid the trap structurally: qa-automation has no tool containing `import` or
`history`, and neither new name contains `plan`, `run_test`, or `test_plan` — the
three stems the confusion lives in. `qa_results_import` says "results already
exist and are being filed", which is precisely the distinction the skill's table
exists to teach.

Reading per-case data for a run is deliberately **not** a new tool: it is added to
the existing `qa_run_list`/detail response, because a fourteenth QA tool costs
more in confusion than it returns in convenience.

## 3. The ingester

**Path:** `scripts/qa-ingest.mjs`. Versioned with the repo, runnable by a
developer, by Claude, and by CI — the three callers option B exists to serve.

**Parser:** `apps/web/lib/junit.ts`, colocated with a `junit.test.ts` beside it,
matching the repo's only working `lib/` test mechanism (`node --test` on
colocated `*.test.ts`). It reuses `decodeXmlEntities` (`drawio-graph.ts:33`) and
`parseAttrs` (`drawio-graph.ts:57`) rather than adding an XML dependency. Node 26
strips types natively, so the `.mjs` script imports the `.ts` parser with no
build step — verified.

It must handle both verified node-reporter quirks: `classname="test"` is a
constant and must not become `suite`, and `<testcase>` appears directly under
`<testsuites>` when no `describe` is used.

**Inputs:** `--junit <path>` (any JUnit XML), `--k6-summary <path>` (k6
`--summary-export` JSON → metrics), `--kind`, `--runner`, `--title`,
`--project-id`, `--no-source`.

**Auth:** identical precedence to every other client in the tree — the
`OPENMEMORY_API_TOKEN` env var, falling back to `~/.openmemory/api_token`. This
is the order used by `resolve_api_token()` (`main.rs:3127`), `qa_api_token()`
(`mcp_app/qa_tools.rs`), `scripts/mem`, and `~/.claude/hooks/openmemory_task_sync.py`.
No new credential, no new location.

**Project resolution:** by cwd against the registered project path, the same rule
`openmemory_session_start.py` and `openmemory_task_sync.py` already use.
`--project-id` overrides.

**Failure policy:** the ingester exits 0 on *every* internal failure — server
down, no token, no project, malformed report. It logs to stderr and gets out of
the way. Recording history must never be able to fail a developer's test run or
redden CI.

**Invocation.** Both lines replace the stage-0 scripts:

```jsonc
// apps/web/package.json
"test": "node --test --test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination=test-results.xml lib/*.test.ts",
"posttest": "node ../../scripts/qa-ingest.mjs --junit test-results.xml --kind unit --runner node:test --title 'web unit tests' || true"
```

```jsonc
// apps/server/package.json
"test": "CARGO_TARGET_DIR=target cargo test",
"posttest": "node ../../scripts/qa-ingest.mjs --junit target/nextest/ci/junit.xml --kind unit --runner cargo --title 'server unit tests' || true"
```

**`posttest` does not run when `test` fails — verified empirically**, not assumed
(a scratch package with `"test": "exit 1"` and a `posttest` echo: the echo never
fires). This is the single most important gotcha in the whole design: the naive
`posttest` wiring would record every green run and silently lose every red one —
exactly the runs the feature exists to capture. Stage 3 therefore wraps the test
command rather than relying on the lifecycle hook alone:

```jsonc
"test": "npm run test:raw; rc=$?; npm run test:ingest || true; exit $rc"
```

The wrapper preserves the real exit code (so CI and `turbo test` still fail
correctly) while guaranteeing ingestion runs on both outcomes. The `|| true` sits
on the ingest call and nowhere else: the exact inverse of the stage-0 defect this
plan removes.

Using `cargo test` (not nextest) in the `test` script keeps stage 0 dependency-free;
the nextest JUnit path is introduced in stage 3, where it is actually needed, and
guarded by a `command -v cargo-nextest` check.

## 4. Frontend

### 4a. The 1+N fix (`qa-panel.tsx:190-222`)

Today `fetchRuns` loads up to 200 runs and then issues **one detail request per
run** purely to populate an evidence count — 201 requests per panel load, repeated
on every status-filter change. The code comment justifies it as also pre-warming
the detail pane; that trade is already poor at 200 runs and becomes untenable
once ingestion writes runs continuously.

Fix, in two halves:

1. **Server:** `list_project_qa_runs` returns `evidence_count` via
   `LEFT JOIN LATERAL (SELECT count(*) …)`, plus the new run columns
   (`kind`, `runner`, the four case counts, `duration_ms`). One query, no N.
2. **Client:** delete the `Promise.all` detail loop. `evidenceByRun` is populated
   lazily on selection — the code path already exists at `qa-panel.tsx:339` and
   is currently redundant with the prefetch.

Net: 201 requests → 1, and the detail fetch moves to the moment a user actually
opens a run.

### 4b. New rendering

- **Run row** gains a `kind` badge (reusing the `statusColor`/`planKindColor`
  fallback pattern in `qa-meta.ts`, which already degrades gracefully on an
  unrecognized value — a property this feature needs, since `kind` will grow).
  Ingested runs show `142 passed · 3 failed · 16 skipped` from the denormalized
  counters, with no extra query.
- **Detail pane** gains a **Cases** tab beside the existing evidence list,
  defaulting to failures-first and collapsing passed cases behind a count. A
  161-row list rendered eagerly is noise; the three that failed are the content.
- **Case history** — clicking a case name opens its cross-run timeline from
  `GET /qa/cases/:case_key/history`. This is the view that answers "when did this
  start failing", and it is the reason `case_key` stability is a hard requirement
  rather than a nicety.
- **Metrics** render as a sparkline series per `metric_key` for `kind='load'`
  runs, using `recharts` — already a dependency (`apps/web/package.json`), so no
  new package.
- `qa-meta.ts` gains `RUN_KINDS`, `RUN_KIND_LABELS`, `RUN_KIND_COLORS` and a
  `runKindLabel`/`runKindColor` pair, following the existing
  `planKindLabel`/`planKindColor` shape exactly.

## 5. Retention

Unbounded per-case rows are the one part of this design that can degrade the
database rather than merely fill it. At ~343 cases per run and, say, 20 dev runs a
day, that is ~2.5M case rows a year per active project.

**Policy — age plus significance, never age alone:**

| Data | Kept |
|---|---|
| `project_qa_runs` | forever (small; 9 new columns on a 5-row table today) |
| `project_qa_test_cases` — failed/error | forever |
| `project_qa_test_cases` — passed/skipped | 90 days |
| `project_qa_run_metrics` | forever (tiny; a chart with a hole is useless) |
| `project_qa_test_sources` | while any live case references the sha, else 90 days |

Deleting passed cases loses "this test existed and passed on 2026-04-01" while
keeping every failure and every run-level counter — the counters are denormalized
on the run precisely so pruning cases never destroys the summary. Failures are
the scarce, expensive signal and are never pruned on a clock.

**Carve-outs — never pruned on a clock, regardless of age:**

- any run with an `event_id` (someone grouped it under a release checkpoint)
- any run with a `task_id` (it is the evidence a task was verified)
- any run with attached evidence (a human or agent curated it)
- any run with `status = 'failed'`
- every run with `kind = 'manual'` — the hand-written QA passes the tab was
  originally built for are never touched by this feature's retention at all

That list mirrors the carve-out `design_revisions.rs` already gives labelled
revisions, for the same reason: someone curated it, so a clock must not delete it.

**Mechanism:** pure functions in `qa_ingest.rs` (unit-testable with no database,
mirroring `revisions_to_prune` at `design_revisions.rs:101` and its tests at
`:287-309`), applied **inline inside the ingest transaction** — the same shape
`design_revisions::cut` uses when it prunes right after its insert (`:235-243`).
No cron, no scheduler, no new container, bounded work per ingest.
`OPENMEMORY_QA_CASE_RETENTION_DAYS` overrides the 90; `0` disables pruning
entirely, read with the same `std::env::var(...).unwrap_or_else(...)` shape as
`qa::blob_root()` (`qa.rs:44-48`).

Pruning runs **after** the ingest transaction commits, never inside it: a
retention failure must not roll back a successfully recorded run.

## 6. Test plan

Following the repo's actual conventions — `node --test` on colocated
`apps/web/lib/*.test.ts`, `#[cfg(test)]` modules for Rust unit tests, and
`apps/server/tests/*.rs` for DB-backed integration tests (which are `#[ignore]`d
and require a live database).

**Parser — `apps/web/lib/junit.test.ts`** (pure, no I/O, runs everywhere):
- node's `classname="test"` constant is dropped, not stored as `suite`
- `<testcase>` directly under `<testsuites>` (no `describe`) parses
- `<failure>` message vs body map to `failure_message` vs `failure_detail`
- `<skipped>` → `skipped`; `<error>` → `error`, distinct from `failed`
- XML entities in test names survive round-trip (node emits `&amp;quot;` — a real
  case in `budget-compare.test.ts`)
- absolute `file` paths are normalized repo-relative, so `case_key` is
  machine-independent
- malformed/truncated XML returns an error, never a partial silent success
- **a real fixture**: the actual output of `node --test --test-reporter=junit`
  on this repo, committed, so a Node upgrade that changes the format fails a test
  instead of silently breaking ingestion

**Rust unit tests — `qa_ingest.rs` `#[cfg(test)]`:**
- run status derivation: any `failed`/`error` case ⇒ run `failed`; all passed ⇒
  `passed`; empty case list ⇒ `passed` with `total_cases = 0`
- envelope validation rejects an unknown `kind` before touching the DB
- `case_key` normalization matches the parser's, exactly

**Integration — `apps/server/tests/qa_ingest_test.rs`** (`#[ignore]`, DB-backed):
- ingest creates run + cases + metrics + sources in one transaction; a bad case
  row rolls back the entire run (no orphan run)
- re-ingesting an identical report upserts sources and metrics rather than
  duplicating (`UNIQUE (run_id, metric_key)`, composite source PK)
- `prune_qa_history` deletes aged passed cases and keeps every failure
- a case with a dangling `source_sha` still stores and reads back
- existing 5 production rows still deserialize after the ALTERs — the backward
  compatibility guarantee, tested rather than asserted

**Manual verification gate:** run `pnpm test` and confirm a real run with 161
cases appears in the QA tab, then break one test deliberately and confirm the run
records `failed` with exactly that case's message. The feature is not done until
this has been seen working, not merely unit-tested.

## 7. Stages

Each stage is independently shippable and independently valuable.

### Stage 0 — make the test signal honest ✅ **SHIPPED 2026-09-03**

Nothing in this plan is worth building on top of a suite that cannot report
failure. Two script defects, and one live bug they have been hiding.

**Shipped as described below.** Three files changed: `apps/server/src/indexer.rs`
(the `GIT_ENV_LOCK` mutex), `apps/web/package.json`, `apps/server/package.json`.

Verification actually performed, not assumed:

- **10/10 full `cargo test` runs pass**, up from 1/6 before the fix
- `pnpm test` runs **343 tests** (161 web + 182 server), exit 0
- It can now *fail*: a deliberately broken web test gives exit **1**; a
  deliberately broken server test gives exit **101**. Both reverted, `git diff`
  clean afterwards.

**One deliberate divergence from the drafted fix:** the `test` script is plain
`cargo test`, **not** `cargo test -- --test-threads=1`. Pinning to one thread was
considered and rejected — it would paper over *future* env-var races instead of
surfacing them, and it makes every run slower for no benefit once the mutex makes
parallel execution correct. The 10/10 parallel verification above is the evidence
the pin is unnecessary. If a future race appears, it should fail loudly rather
than be pre-suppressed.

`no_git_history_for_non_repo_directory` (`indexer.rs:808`) was deliberately left
outside the guard: its assertion ("no commit nodes") holds whatever the env var
says, so it is genuinely immune rather than accidentally so. The `GIT_ENV_LOCK`
doc comment states the rule for anyone adding an env-sensitive test later.

1. **Fix the `indexer.rs` env-var race — this comes first.**
   `cargo test` currently fails **5 of 6 full-suite runs** (verified: exit 101,
   `--bin openmemory-mcp`, 68 passed / 1 failed).
   Root cause: `collect_git_history` (`indexer.rs:341`) reads
   `OPENMEMORY_GIT_HISTORY_COMMITS` and returns empty history when it is `0`; the
   test at `indexer.rs:835` does `std::env::set_var(…,"0")` then `remove_var` at
   `:837`. Env vars are process-global while Rust tests run as parallel threads
   in one process, so `collects_git_commit_nodes_and_modified_edges`
   (`indexer.rs:779`) reads the poisoned value, finds no commit nodes, and fails
   at `:791`. The comment at `indexer.rs:831-834` already documents the race.
   Fix: serialize the two env-sensitive tests behind a shared `static Mutex`
   (or remove the env dependency from the test by passing `max_commits` as a
   parameter — cleaner, slightly larger).
2. `apps/web/package.json`: replace `"test": "echo 'no tests yet' && exit 0"` with
   a real `node --test lib/*.test.ts`. **161 tests already pass in ~250 ms.**
3. `apps/server/package.json`: drop `|| true` from `test`. Decide separately on
   `lint`'s `|| true` (see open decisions).

Order matters: removing `|| true` before fixing the race turns a silent failure
into a permanently red build.

**Ships:** a `pnpm test` that runs 343 tests and can actually fail.

### Stage 1 — schema + read paths
`ensure_qa_tables` ALTERs and the three new tables; `list_project_qa_runs` gains
`evidence_count` and the new columns; the `qa-panel.tsx` 1+N fix. No ingestion
yet. **Ships:** the QA tab gets ~200× faster and is ready for volume.

### Stage 2 — ingest endpoint + MCP tools
`qa_ingest.rs`, `POST /qa/ingest`, the four read routes, `qa_results_import` and
`qa_case_history`. **Ships:** anything that can POST JSON can record history.

### Stage 3 — the ingester and automatic capture
`apps/web/lib/junit.ts` + tests, `scripts/qa-ingest.mjs`, the `posttest` hooks,
the nextest path. Use the exit-code-preserving
wrapper from §3, **not** a bare `posttest` — verified: `posttest` does not run
when `test` fails, so the naive wiring would lose exactly the red runs the
feature exists to capture. **Ships:** running tests records
history with nobody remembering to.

### Stage 4 — the views that pay it off
Cases tab, case-history timeline, metrics sparklines, `kind` badges, retention.
**Ships:** flake detection and regression trends.

### Stage 5 — docs
`skills/qa-run/SKILL.md` gains a fourth table row and prose stating plainly that
qa-automation runs browser and native Android **only**, and that unit, API and
load results reach the log through `qa_results_import` or automatic capture —
never through qa-automation. Same correction to the QA rows in `README.md:295-296`.
This is a correctness fix to a currently-misleading document, not an addition;
it ships with stage 2/3 rather than being deferred to the end if either slips.

## 8. Open decisions

1. ~~**Ship stage 0 now, separately?**~~ **DECIDED: yes, stage 0 only.**
2. ~~**Retention default.**~~ **DECIDED: 90 days for passed cases**; failures
   never pruned.
3. **Should CI record too, or dev only?** *Still open.* Dev-only is simpler. CI
   adds the most valuable regression history but needs a token in the CI
   environment. Revisit at stage 3.
4. ~~**`cargo nextest` as a dependency?**~~ **DECIDED: yes**, add it at stage 3,
   guarded by a `command -v cargo-nextest` check so its absence never breaks the
   build. Gets all 182 Rust tests recorded per-case.
5. **`lint`'s `|| true`** (`cargo fmt --all -- --check || true`) has the same
   dishonesty as `test`'s, but removing it may redden the build on pre-existing
   formatting drift. Recommend a separate pass: measure the drift first.

## 9. Out of scope

- **Any change to `/home/toyofumi/projects/qa-automation`.** Adding an
  artifact-listing or per-case MCP tool there would let OpenMemory pull the
  `TestResult`/`Artifact` data it already stores, and `project_qa_test_cases.external_ref`
  is here so that backfill would be a plain INSERT — but it is a different
  repository and a separate decision.
- **Per-test-body source extraction.** File-level hashing ships now;
  tree-sitter-based per-test extraction is follow-up.
- **Standing up the missing suites.** Of unit/e2e/api/pressure, only unit tests
  exist in this repo — no Playwright, no API suite, no k6. This plan builds the
  pipeline generic so those record the day they are added; writing them is
  separate work.
- **Removing `|| true` from `apps/server`'s `lint` script.** Measured
  2026-09-03: `cargo fmt --all -- --check` emits **14,075 diff lines across 877
  hunks**. That `|| true` is load-bearing — removing it reddens the build
  immediately, and fixing it properly means a tree-wide reformat commit that
  rewrites git blame across the server. It needs its own deliberate change, and
  must NOT be swept up in a pass that removes the `test` script's `|| true`.
  Called out explicitly so the two are never conflated again.
- **Coverage data.** A different shape from pass/fail and metrics; deferred.
- **Flake detection as an automated verdict.** The case-history view makes flakes
  visible to a human. Auto-classifying a test as flaky needs a policy decision
  about what threshold means flaky.
