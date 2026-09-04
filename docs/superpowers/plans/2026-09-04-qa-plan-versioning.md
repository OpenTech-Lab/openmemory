# Versioned QA plans

**Date:** 2026-09-04
**Status:** proposed — not implemented

Goal, in the user's words: *"v1 for home page only, v2 for home page + about."*
One plan that evolves, with each version keeping its own identity, and every run
knowing which version it actually executed.

## Research

### Prior art inside this repo (the strongest signal)

`project_design_revisions` (`apps/server/src/design_revisions.rs`, 350 lines) already
solves this exact problem for designs, and the QA panel should not invent a second
vocabulary for the same idea. Its shape:

```sql
CREATE TABLE IF NOT EXISTS project_design_revisions (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    design_id     UUID NOT NULL REFERENCES project_designs(id) ON DELETE CASCADE,
    revision_num  INTEGER NOT NULL,
    title         TEXT NOT NULL,
    ...            -- a full snapshot of the content, not a diff
    label         TEXT,           -- the human name: "v1 home page only"
    source_sha    TEXT NOT NULL,  -- dedupe: no revision when nothing changed
    created_by    TEXT NOT NULL DEFAULT 'user',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (design_id, revision_num)
)
```

Four properties worth copying verbatim:

1. **The parent row is the live working copy; revisions are frozen snapshots.**
   `project_designs` holds the current design, `project_design_revisions` holds history.
2. **Full snapshots, not diffs.** Reconstructing v1 must never depend on replaying a
   chain, which is what makes "show me exactly what ran" cheap and reliable.
3. **`revision_num` is a monotonic integer, unique per parent**, with an optional free-text
   `label` on top. The number is the identity; the label is for humans.
4. **Both automatic and explicit cuts.** `cut(db, design_id, Some(label))` is called from
   the explicit endpoint (`main.rs:7828`); `cut(db, design_id, None)` is called
   automatically before a destructive edit (`main.rs:7941`).

The UI half exists too — `design-history-sheet.tsx` lists revisions and compares any two,
including the special "LIVE" pseudo-key for the uncut working copy. That comment at
`design-history-sheet.tsx:34` is worth reading before designing the picker: the live
version is *not* a revision and needs its own key.

### External practice

- **TestRail** makes closed runs immutable so archived results provably were not modified,
  and offers case versioning so teams can see how a test evolved over the project's life
  ([TestRail: test case versioning](https://support.testrail.com/hc/en-us/articles/7768433966996-Test-case-versioning),
  [TestRail: when and how to version](https://www.testrail.com/blog/test-version-control/)).
- **Xray** treats test versioning as first-class, with each version independently
  executable ([Xray: Test Case Versioning](https://docs.getxray.app/display/XRAY/Test+Case+Versioning),
  [Xray: implementation tips](https://docs.getxray.app/display/XRAY/Tips+for+implementing+Test+Versioning)).

The convergent rule across both, and the one that matters most here: **a result is
meaningless without the version that produced it.** A run must pin its version, and that
pin must never be rewritten when the plan later changes.

### The gap this exposes today

`project_qa_runs` has **no link back to the plan at all**. `qa_runner.rs` sets
`external_ref: None` on every run it creates (lines 514, 556, 705). So right now, running
a plan produces a run that cannot be traced to its source, let alone its version. Adding
versioning without fixing that would be decorative.

## Design

### 1. Schema

```sql
CREATE TABLE IF NOT EXISTS project_qa_plan_revisions (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_id       UUID NOT NULL REFERENCES project_qa_plans(id) ON DELETE CASCADE,
    project_id    UUID NOT NULL REFERENCES project_graphs(id) ON DELETE CASCADE,
    revision_num  INTEGER NOT NULL,
    name          TEXT NOT NULL,
    kind          TEXT NOT NULL,
    language      TEXT NOT NULL,
    description   TEXT,
    body          TEXT NOT NULL,
    body_sha      TEXT NOT NULL,
    label         TEXT,
    created_by    TEXT NOT NULL DEFAULT 'agent' CHECK (created_by IN ('agent','human')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (plan_id, revision_num)
)
```

Deliberately **no CHECK on `kind`/`language`** here. A revision records what the plan *was*,
and if the allowed set is ever narrowed, history must stay readable rather than become
un-writable. The live `project_qa_plans` row keeps its CHECKs and remains the gate.

Two columns on `project_qa_runs`, both idempotent `ADD COLUMN IF NOT EXISTS`:

```sql
ALTER TABLE project_qa_runs ADD COLUMN IF NOT EXISTS plan_id UUID
    REFERENCES project_qa_plans(id) ON DELETE SET NULL;
ALTER TABLE project_qa_runs ADD COLUMN IF NOT EXISTS plan_revision_num INTEGER;
```

`ON DELETE SET NULL`, not CASCADE: deleting a plan must never silently delete the test
history that plan produced. `plan_revision_num` is a plain integer, not an FK, so the run
keeps a readable record of *"this was v2"* even if the revision row is later removed.

### 2. When a revision is cut

- **Explicit:** a **Save as version** action in the plan editor, taking a label. This is
  what produces "v1 home page only".
- **Automatic, before a destructive change:** cut an unlabelled revision immediately before
  saving an edit or running a plan, so the state that produced a result is always
  recoverable. Mirrors `main.rs:7941`.
- **Never on no-op:** if `body_sha` and the metadata match the latest revision, skip. Without
  this, an idle editor manufactures versions and the history becomes noise.

`revision_num` allocation must be `SELECT COALESCE(MAX(revision_num), 0) + 1 … FOR UPDATE`
inside the insert transaction. Two concurrent cuts otherwise collide on the UNIQUE
constraint — a real race once an agent and a human both touch the same plan.

### 3. Routes

| Method + path | Purpose |
|---|---|
| `GET /projects/:id/qa/plans/:plan_id/revisions` | list, newest first, without bodies |
| `GET /projects/:id/qa/plans/:plan_id/revisions/:num` | one revision, with body |
| `POST /projects/:id/qa/plans/:plan_id/revisions` | cut a revision, optional `label` |
| `POST /projects/:id/qa/plans/:plan_id/revisions/:num/restore` | copy that revision into the live plan (cutting the current state first) |

`POST …/run` gains an optional `revision_num`: absent runs the live plan, present runs that
frozen version. Either way the run records `plan_id` and `plan_revision_num`.

Restore is never destructive — it cuts the current state first, so "undo the restore" is
just another restore.

### 4. UI

- Plan detail header shows **v3** plus its label, with a picker listing every version.
- **Save as version** button beside Save, prompting for a label.
- A **History** sheet modelled on `design-history-sheet.tsx`: list, view, compare two
  versions, restore. Reuse the LIVE-key convention rather than reinventing it.
- The Run dialog shows which version will run, and lets the user pick an older one.
- A run row displays `plan · v2` and links back to that exact version.

### 5. Ingest

`IngestEnvelope` gains optional `plan_id` and `plan_revision_num`, so results arriving from
`test:record` or `qa_results_import` can pin a version too — not only runs started by the
Run button.

### 6. MCP

`qa_plan_revision_list`, `qa_plan_revision_get`, `qa_plan_revision_cut`. Agents are the
main consumer of this surface; a version an agent cannot address does not exist for it.
Follow the naming already used by `qa_plan_*`.

## What this makes possible

- Run v1 and v2 of the same plan and compare their results, because the runs are
  distinguishable.
- Answer "did this test regress, or did I change the test?" — today indistinguishable,
  since `case_key` is derived from the test name and a rewritten test looks like a new one.
- Keep `v1 home page only` runnable after v2 exists.

## Risks

| Risk | Handling |
|---|---|
| Revision spam from every keystroke | `body_sha` dedupe; auto-cut only before destructive changes |
| Concurrent cuts collide on `UNIQUE(plan_id, revision_num)` | allocate under `FOR UPDATE` in the same transaction |
| Deleting a plan orphans its history | `ON DELETE SET NULL` on the run link; revisions cascade with the plan by design |
| Bodies are large; listing gets heavy | list endpoint omits `body`, same as the design revisions list |
| Tightened CHECKs make old revisions unwritable | no CHECK on the revision table |

## Verification

- Rust tests: monotonic allocation, the no-op dedupe, concurrent-cut serialisation, and
  restore leaving the prior state recoverable.
- API tests (`tests/qa-api.api.test.ts`): cut → list → get → restore round trip; a run
  started against `revision_num` records that number.
- E2E (`e2e/qa-panel.spec.ts`): create v1, edit, save as v2, run v1 explicitly, and assert
  the run row shows `v1`.

## Open question for the reader

Whether an **agent** should be allowed to cut labelled versions, or only unlabelled
automatic ones. Labels are how a human navigates this history; an agent cutting
`v14 - updated tests` fifty times would drown it. Suggested default: agents cut unlabelled
revisions, humans label them.
