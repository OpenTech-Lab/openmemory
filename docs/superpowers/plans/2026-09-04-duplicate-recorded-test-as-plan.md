# Duplicate a recorded test into a reusable QA plan

**Date:** 2026-09-04
**Status:** proposed
**Depends on:** the test-history ingestion feature (stages 0–5, shipped 2026-09-04),
specifically `project_qa_test_sources` and `GET /projects/:id/qa/test-sources/:sha`.

## Problem

Test *content* is now recorded — every ingested case carries a `source_sha` pointing at
a content-addressed snapshot of the file that ran. Today that snapshot is read-only: the
Tests panel can show it behind **View source**, and nothing else.

Meanwhile `project_qa_plans` already exists to hold reusable test-script templates, and
the qa-run skill tells agents to check `qa_plan_list` before writing a new test from
scratch. But every plan in there has to be typed by hand. The two halves never meet: the
repo records real tests that really ran, and separately stores hand-written templates,
with no path from the first to the second.

Writing the next similar test should start from one that already works.

## Approach

Add a **Duplicate** action on a recorded case. It reads that case's captured source and
creates a QA plan pre-filled with it, carrying provenance in the description, then offers
to open it under QA › Plans where it is editable like any other plan.

Nothing new is stored: this composes two existing tables through one new client-side flow.
No schema change, no new table, no new column.

### Why a plan and not a new test file

The plan store is the right destination precisely because **nothing executes it**
(`skills/qa-run/SKILL.md` is emphatic about this). Duplicating a recorded test into a
plan produces a starting point a human or agent edits into a real test — it does not
silently add a test file to the repo, and it cannot accidentally be "run". Writing to
disk would be the wrong default for a one-click action.

## What exists already

| Piece | Location | State |
|---|---|---|
| `project_qa_plans` table | `apps/server/src/qa.rs:471` | unchanged |
| `POST /projects/:id/qa/plans` | `apps/server/src/main.rs:1812` | unchanged |
| `CreateQaPlanPayload` | `apps/server/src/main.rs:557` | unchanged |
| Next proxy for plans | `apps/web/app/api/projects/[id]/qa/plans/route.ts` | unchanged |
| `GET /qa/test-sources/:sha` | `apps/server/src/main.rs:1796` | unchanged |
| Plans UI | `apps/web/components/qa-plans-panel.tsx` (504 lines) | one prop added |
| Tests panel | `apps/web/components/qa-tests-panel.tsx` | the new action lives here |
| Sub-tab switch | `apps/web/components/qa-section.tsx` (24 lines) | lifts one callback |

## The hard constraint: two CHECK sets

`project_qa_plans` constrains both columns, and a value outside either set is a **400**,
not a silent default:

```sql
kind     TEXT NOT NULL DEFAULT 'jest'
             CHECK (kind IN ('jest','playwright','maestro','other'))
language TEXT NOT NULL DEFAULT 'typescript'
             CHECK (language IN ('typescript','javascript','yaml','python','other'))
name     TEXT NOT NULL CHECK (length(btrim(name)) > 0)
```

Recorded runs carry `runner` values these sets know nothing about (`node:test`,
`cargo nextest`), and `project_qa_test_sources.language` is unconstrained free text. So
every duplicate must pass through a total mapping that **defaults to `'other'`** rather
than passing a recorded value straight through. This is the single most likely way for
this feature to break, and it is why the mapping functions are pure and tested.

### 1. `apps/web/lib/qa-duplicate.ts` (new)

Four pure functions, no React, no fetch:

```ts
planKindForSource(runner: string | null, file: string | null): PlanKind
```
- `playwright` in runner or file → `'playwright'`
- `maestro` in runner or file, or the file ends `.yaml`/`.yml` → `'maestro'`
- `jest` or `vitest` in runner or file → `'jest'`
- everything else, `node:test` and `cargo nextest` included → `'other'`

`node:test` maps to `'other'`, not `'jest'`. It is jest-*like*, but labelling a
node:test file as a jest template would mislead whoever picks the template up later.

```ts
planLanguageForSource(language: string | null): PlanLanguage
```
Passes through only the four allowed values (case-insensitively, trimmed); everything
else, including `null`, becomes `'other'`.

```ts
duplicatePlanName(caseName: string, suite: string | null): string
```
`"<suite> › <name> (copy)"`, or just `"<name> (copy)"` with no suite. Falls back to
`"Duplicated test (copy)"` when the name is blank or whitespace — the `length(btrim(name)) > 0`
CHECK would otherwise reject it. Truncated to 200 chars on a grapheme-safe boundary.

```ts
duplicateDescription(input: DuplicateProvenance): string
```
The provenance block, which is the actual value of duplicating from a *recorded* test
rather than copy-pasting a file:

```
Duplicated from a recorded test run.

case_key:   apps/web/lib/qa-cases.test.ts::formatCaseDuration formats null, …
file:       apps/web/lib/qa-cases.test.ts
status:     failed
run:        b9f683bc-98eb-42c6-90a7-552066e9854f (Sep 4, 2026, 9:57 AM)
commit:     5dbb345 on main
source_sha: c26b08603257f5ce…
```

Whoever opens this template later can see exactly which run it came from and go read
that run's history.

### 2. `apps/web/components/qa-tests-panel.tsx`

- A **Duplicate** button on each case row, beside the existing **View source**.
  Rendered **only when `source_sha` is present** — a case with no captured snapshot has
  nothing to duplicate, and a button that always 400s is worse than no button.
- On click: reuse the **existing cached** test-source fetch (`sourceByShaRef` / whatever
  the current cache is named) rather than adding a second network path to the same data.
  If the source is not cached yet, fetch it, then continue.
- `POST /api/projects/{projectId}/qa/plans` with
  `{ name, kind, language, description, body: source.body, created_by: 'agent' }`.
- Per-case in-flight guard so a double click cannot create two plans.
- On success: `toast.success` with an action that jumps to Plans with the new plan
  selected. On failure: the same inline error treatment the panel already uses for
  cases/history/metrics — never a silent no-op.

### 3. `apps/web/components/qa-section.tsx`

Lift one callback so the Duplicate action can navigate:

```tsx
const [subTab, setSubTab] = useState<'runs' | 'plans'>('runs');
const [focusPlanId, setFocusPlanId] = useState<string | null>(null);

const openPlan = useCallback((planId: string) => {
  setFocusPlanId(planId);
  setSubTab('plans');
}, []);
```

`QaPanel` takes `onOpenPlan?: (planId: string) => void` and forwards it to
`QaTestsPanel`. `QaPlansPanel` takes `focusPlanId?: string | null` and, when it changes
to a non-null value, selects that plan after its list loads (it already owns
`selectedPlanId` at `qa-plans-panel.tsx:76`). All three props are optional, so nothing
else that renders these components has to change.

### 4. `apps/web/lib/qa-cases.test.ts` → new `apps/web/lib/qa-duplicate.test.ts`

`node:test` + `node:assert/strict`, matching the existing idiom. Cases that matter:

- every `PLAN_KINDS` value is reachable from some realistic runner/file pair
- `node:test` and `cargo nextest` both land on `'other'` (the CHECK-safety property)
- an unknown language and `null` both land on `'other'`
- a blank / whitespace-only case name still yields a non-empty name
- a name longer than 200 chars is truncated and stays non-empty
- the description contains the case_key, run id and source_sha verbatim

## Stage 2 (separable) — MCP parity

`qa_case_duplicate_to_plan { project_id, case_key, source_sha?, name?, kind? }` in
`catalog.rs` + `dispatch.rs` + `qa_tools.rs`, following `qa_case_history`'s shape exactly.
Agents are the primary consumer of this QA surface — the whole ingestion feature exists
for them — so an agent that spots a useful recorded test should be able to template it
without going through the browser.

Defaults to the case's newest recorded `source_sha` when none is given. Same pure mapping
rules, reimplemented server-side in Rust (the constraint lives in the database, so both
callers must respect it independently).

This stage is separable: stage 1 ships a complete, usable feature without it.

## Risks

| Risk | Handling |
|---|---|
| CHECK violation → 400 | total mapping functions defaulting to `'other'`, with tests asserting exactly that |
| Blank case name → CHECK violation | explicit fallback name, tested |
| Very large test file → very large plan body | `project_qa_test_sources.body` has **no size cap** today (unlike `failure_detail`, capped at 8 KB in `qa_ingest.rs:30`). A 5000-line test file becomes a 5000-line plan. Acceptable for now — `body` is TEXT and the plans editor already handles long bodies — but worth a cap if it bites. |
| Double click → two plans | per-case in-flight guard |
| Duplicate plan names | no uniqueness constraint on `name`; collisions are allowed and harmless |

## Out of scope

- Writing a test file to disk
- Executing anything (`qa_plan_*` never executes — see `skills/qa-run/SKILL.md`)
- Diffing a plan against the current file on disk
- Any schema change

## Verification

```
cd apps/web
node --test lib/*.test.ts          # must exceed 177, exit 0
npx tsc --noEmit -p tsconfig.json  # exit 0
npx eslint components/qa-tests-panel.tsx components/qa-section.tsx \
          components/qa-plans-panel.tsx components/qa-panel.tsx \
          lib/qa-duplicate.ts lib/qa-duplicate.test.ts
```

Then end-to-end against the live stack (server and web were rebuilt and restarted
2026-09-04): open QA › Runs, select the failed run, Duplicate the failed case, confirm a
plan appears under QA › Plans with the captured body and the provenance description, and
confirm `POST /qa/plans` returned 201 rather than 400.
