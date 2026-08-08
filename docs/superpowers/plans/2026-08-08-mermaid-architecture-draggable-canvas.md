# Draggable canvas for mermaid `architecture-beta` designs

Status: approved, ready to execute.

## Goal

Make `diagram_type='mermaid'` designs whose source is `architecture-beta` render and drag on the
React Flow canvas, while the **mermaid text stays the source of truth**:

```
source: mermaid text ──parse──▶ {nodes, edges}
                                      │
                            recursive dagre layout
                                      │
      position overrides {id:{x,y}} ──merge──▶ React Flow canvas
                      ▲                              │
                      └────────── drag saves ────────┘

Editing the text later → re-parse + re-layout, overrides reapplied by node id
(dropped when the node no longer exists or its parent changed).
```

We never drag mermaid's own SVG output: its arrows are baked paths and its syntax has no position
concept. Mermaid is the authoring format, React Flow is the renderer and editor.

## Why: the acceptance criterion

This feature exists because layout is broken today. The 8 reactflow samples carry hand/LLM-authored
coordinates with no layout engine, so nodes straddle container borders — measured AWS 1 = 3,
AWS 2 = 5, AWS 3 = 6 nodes, plus 2 node-on-node label collisions in AWS 3. User's words: "line and
node did not show well in react flow".

**Acceptance criterion: a node can never straddle its group's border, by construction, not by
tuning.** Asserted in unit tests (task 3) and in the browser (task 7). If the mermaid path
reproduces those collisions, the feature has failed at its purpose.

## Verified facts (do not re-derive; correct the plan if you find otherwise)

- All 12 designs in the DB: 9 `reactflow`, 3 `mermaid`. **All 8 designs in the test project
  `1d0c3c65-cf7b-4cf3-85dd-fbe35f5df961` are reactflow**, Workflow 1/2/3 included.
- The 3 `mermaid` designs all begin with `architecture-beta` and live in two other projects. They
  are the primary test corpus:

  | project | title | shape |
  |---|---|---|
  | `af9ffd44-19d7-4a0b-ad44-1bbca6542bca` | "a serverless API with S3 storage and a…" | 5 nodes, 1 group, 3 edges |
  | `af9ffd44-19d7-4a0b-ad44-1bbca6542bca` | "Wide microservices platform" | 16 nodes, 2 groups, 22 edges |
  | `c1471c75-c8da-4b5f-91af-40a80ca8727e` | "AWS Architecture (AgentCore + Amplify)" | 12 nodes, 2 groups, 10 edges |

  Fetch sources with:
  `docker exec openmemory-postgres-1 psql -U openmemory -d openmemory -t -A -c "select source from project_designs where diagram_type='mermaid';"`

- `lib/design-meta.ts` `STARTER_TEMPLATES`: 11 of 12 kinds emit `flowchart`/`erDiagram`/
  `sequenceDiagram`/`timeline`/`graph`; only `aws` emits `architecture-beta`. **Those 11 must keep
  rendering through `MermaidDiagram`.**
- Server hard-whitelists `diagram_type` to `mermaid | reactflow` (`apps/server/src/main.rs:6001-6008`,
  `:6049-6051`); `source` is free-form TEXT (`:1855`). **No server change in this plan.**
- `mermaid@^11.16.1`. `components/mermaid-diagram.tsx` already calls
  `mermaid.registerIconPacks([{ name: 'logos', icons: awsIconPack }])`, so `logos:aws-lambda`
  resolves against the same pack `lib/aws-icons.ts` uses. `awsIcon()` wants the key with **no**
  `logos:` prefix.
- Test precedent exists: `lib/autofill-merge.test.ts` runs via `node --test lib/autofill-merge.test.ts`
  using `node:test` + native TS type-stripping (verified 7/7 pass). `node --test` can import
  `lib/design-layout.ts` unmodified because its only runtime import is `@dagrejs/dagre` and its
  `@/`-aliased imports are `import type` (erased). **Keep new lib files' `@/` imports type-only.**
- Do NOT use mermaid's internal parser/AST — not a stable public API. Hand-written parser only.

## Existing patterns that must be respected

- Canvas colors are literal values branched via Tailwind's `dark:` variant, **never** theme CSS vars
  (see comment block, `design-node.tsx:15-19`).
- Anything relying on React Flow's `--xy-*` CSS custom properties **breaks PNG export** —
  html-to-image clones a subtree detached from the ancestor declaring them (commit `6bbf06e` fixed
  this for edge labels). New styling must use inline styles or Tailwind literals.
- `design-canvas.tsx` must be imported via `next/dynamic` with `ssr:false`.
- Node width 96px is load-bearing and kept in sync across `DEFAULT_NODE_WIDTH` (design-canvas.tsx),
  `NODE_WIDTH` (design-layout.ts) and `w-[96px]` (design-node.tsx). Label text overflows that box
  symmetrically via `w-[144px] -mx-6`, so the **effective label footprint is 144px**.
- Node labels honor authored `\n` via `whitespace-pre-line`. Map architecture-beta labels onto the
  two-line "service name / resource name" convention where possible.
- `parseDesignGraph` never throws and falls back to an empty graph (`design-graph.ts:133-137`).
  Match that resilience, and additionally *report* parse errors, since this text is hand-written.

## Decision 1 — Layout: recursive per-level dagre (not dagre-compound, not elkjs)

Lay out each group's children in that group's own coordinate space, bottom-up, then **derive** the
group's `width`/`height` from its children's bounding box plus padding. React Flow child positions
are already parent-relative, so if the parent's size is computed *from* the children's extent, a
child outside the parent box is arithmetically impossible. Only a **flat** dagre run is ever needed
at each level, so the existing `@dagrejs/dagre` is sufficient.

Cross-boundary edges are handled by projection: for the run at container `C`, map each edge's
endpoints to their ancestors that are direct children of `C`, dedupe, drop self-pairs. So
`a (in g1) → b (in g2)` becomes `g1 → g2` at root level and orders the boxes sensibly, while
contributing nothing inside `g1`'s own run where it can't be satisfied.

Rejected: **elkjs** — technically stronger, but buys nothing the recursion doesn't guarantee, costs
~1.4MB of GWT-compiled JS, and makes layout `async`, which propagates into the canvas mount path and
the editor's debounced re-layout. **dagre-compound (`setParent`)** — cluster size becomes an engine
output you must trust rather than an invariant, and cross-cluster edges are its documented weakness.

Prototype measured on all 3 real designs + a synthetic covering every grammar production:
**0 straddles, 0 label collisions, 0 parse errors.**

New constants in `design-layout.ts`: `NODESEP = 56` (was 40 — 48px of label overhang from
`(144-96)/2 × 2` plus 8px gap; this is the AWS-3 collision class), `RANKSEP = 80`, `rankdir: 'LR'`,
`GROUP_PAD_H = 24`, `GROUP_PAD_TOP = 40`, `GROUP_PAD_BOTTOM = 24`. The padding values deliberately
match `groupSelection`'s existing `PADDING_H`/`PADDING_TOP`/`PADDING_BOTTOM`
(`design-canvas.tsx:267-269`) so hand-grouped and derived boxes look identical.

`estimateNodeHeight(label)` = `40` (icon) `+ 4` (gap) `+ 8` (padding) `+ 14 × lineCount`, counting
lines across authored `\n` at ~22 chars per 144px line. Do **not** use the flat `NODE_HEIGHT = 96` —
it's documented as the *shortest* real node, and understating height is what lets vertically stacked
nodes touch.

Second containment guarantee, at drag time: derived-mode children get `extent: 'parent'`.
`design-canvas.tsx:262-264` deliberately omits this for the freeform canvas ("would hard-clamp
drags… impossible to ever drag a node back out"), but in derived mode group membership comes from
`in <group>` in the text and cannot be changed by dragging, so clamping is correct. Corollary:
`onNodeDragStop`'s reparent-on-overlap logic (`design-canvas.tsx:318-350`) must be disabled in
derived mode.

## Decision 2 — Override storage: a `%%` comment

Keep `diagram_type = 'mermaid'`. Zero Rust changes, zero rebuild, source stays valid portable
mermaid. One line, appended last:

```
%% openmemory:layout:v1 {"pos":{"api":{"x":120,"y":40,"p":"cloud"},"cloud":{"x":0,"y":0}}}
```

Three load-bearing details:

- **The space after `%%` is mandatory.** Mermaid's lexer has two competing terminals:
  `SINGLE_LINE_COMMENT: /[\t ]*%%[^\n\r]*/` (discarded harmlessly) and
  `DIRECTIVE: /[\t ]*%%\{[\S\s]*?\}%%…/`. A payload written `%%{…}` tokenizes as a **directive** and
  mermaid tries to interpret the JSON as config. `%% {` cannot match `DIRECTIVE`.
- Coordinates are **parent-relative** — same space as `node.position` — so the merge is
  `position = override[id] ?? laidOut[id]` with no coordinate math.
- `p` records the **parent id at drag time** (absent = top level). This makes reconciliation correct
  rather than approximate.

Reconcile rules on text edit (pure, tested):
1. Drop overrides whose id no longer exists.
2. Drop overrides whose recorded `p` ≠ the node's current parent (a relative coordinate against a
   different parent is meaningless, not merely stale).
3. Clamp survivors into the freshly derived parent box (removing siblings shrinks the box).
4. Emit only ids that differ from the computed layout, so an untouched diagram never grows a comment.

Corruption / hand-deletion: take the **last** matching line; `JSON.parse` failure, non-object
payload, or unknown `v` → `{}` overrides, i.e. pure computed layout. Never throws. In the editor
surface it as a dismissible **warning** ("saved node positions couldn't be read and were reset"), not
an error. Deleting the line by hand is a supported reset.

Editor round-trip: on open, `stripLayoutComment(source)` feeds the textarea and
`parseLayoutComment(source)` seeds React state, so **the textarea never shows the comment** — a drag
can't rewrite text under the user's caret and there's no edit-conflict to resolve. On save,
`source = withLayoutComment(textareaValue, overrides)`. Idempotent.

Backward compatibility: an existing mermaid design has no comment → `{}` → pure computed layout.
No migration, no write on read.

## Decision 3 — Routing: detect by content, not a new column

Introduce `type DesignEditorMode = 'canvas' | 'arch' | 'mermaid'`:

```
diagram_type === 'reactflow'  → 'canvas'   (unchanged)
isArchitectureSource(source)  → 'arch'     (new)
otherwise                     → 'mermaid'  (unchanged)
```

`isArchitectureSource` = first non-blank, non-comment, non-directive, non-frontmatter line is exactly
`architecture-beta`. In the **preview** path, additionally fall back to `MermaidDiagram` when the
parse yields zero nodes — mermaid's own error UI (`mermaid-diagram.tsx:181-189`) beats an empty
canvas. In the **editor**, show our own line-numbered parse errors instead.

`DESIGN_DIAGRAM_TYPES` and the server contract stay at two values. No new column or flag.

## Decision 4 — Dragging lives in the Edit dialog (confirmed by the user)

The preview stays **read-only**, matching reactflow (`project-design-panel.tsx:457`). Dragging
happens in the Edit dialog, which already has a Save button and save path. No autosave-on-drag, no
new API behavior, undo = don't save.

## Accepted grammar

Transcribed from the compiled Langium grammar in
`node_modules/@mermaid-js/parser/dist/chunks/mermaid-parser.core/chunk-KEIR6QF5.mjs` (verified: the
Arrow rule's literals in order are `--` or `-` … `-`). Statements are line-oriented; `%%` comments,
`%%{…}%%` directives, `---` YAML frontmatter and blank lines are skipped.

```
header    ::= 'architecture-beta'                      (required, first non-skip line)
group     ::= 'group'    ID ARCH_ICON? ARCH_TITLE? ('in' ID)?
service   ::= 'service'  ID (STRING | ARCH_ICON)? ARCH_TITLE? ('in' ID)?
junction  ::= 'junction' ID ('in' ID)?
edge      ::= ID '{group}'? ':' DIR ('<'|'>')?  ('--' | '-' ARCH_TITLE '-')  ('<'|'>')? DIR ':' ID '{group}'?
align     ::= 'align' ('row'|'column') ID ID+          (accepted, ignored in v1)
meta      ::= 'title' … | 'accTitle' ':' … | 'accDescr' …   (accepted, ignored)

ID         = /\w(?:[-\w]*\w)?/
DIR        = /L|R|T|B/
ARCH_ICON  = /\([\w\-:]+\)/
ARCH_TITLE = /\[(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[\w ]+)\]/
```

**The edge label sits between the dashes**: `api:R -[invoke]-> L:fn`, never
`api:R --> L:fn[invoke]`. `align`, `service x "DB"["label"]` (text-glyph icon), `title`/`accTitle:`/
`accDescr`, and the `{group}` endpoint suffix must all be accepted or valid diagrams report false
errors.

Mapping to `DesignNode`/`Edge`:

- `service` → `type: 'design'`; `data.icon` = icon with `logos:` stripped (`logos:aws-lambda` →
  `aws-lambda`); `data.label` = title with `\n` escapes unescaped to real newlines, falling back to
  the id.
- `group` → `type: 'group'`, `derivedSize: true`, `width`/`height` from the recursion.
- `junction` → `type: 'junction'`, 12×12.
- `in X` → `parentId: X` + `extent: 'parent'`; run the result through the existing
  `sanitizeNodeHierarchy` ordering discipline (`design-graph.ts:85-109`) — React Flow hard-requires
  parents to precede children.
- Edge sides → handle ids `` `${Position[dir]}-source` `` / `` `-target` ``. `Position.Left === 'left'`,
  and the handle ids in `design-node.tsx:32-33` / `design-group-node.tsx:68-69` are exactly
  `${position}-target` / `${position}-source`. So `api:R --> L:fn` → `sourceHandle: 'right-source'`,
  `targetHandle: 'left-target'`.
- Arrow markers: `lhsInto` only → swap endpoints (so only `markerEnd` is ever needed); both → set
  `markerStart` and `markerEnd`; neither → no marker. **Verify at implementation time** that a
  per-edge `markerEnd: undefined` actually beats `defaultEdgeOptions` (`design-canvas.tsx:450`) — if
  React Flow's merge keeps the default, omit the key rather than setting `undefined`.
- `{group}` suffix → remap that endpoint to its `in` parent (no-op if already a group); drop the edge
  if this makes source === target.
- Edge label → `label` + `labelBgStyle`/`labelStyle` from `edgeDefaults` (the inline-style form
  commit `6bbf06e` established for PNG-export survival).

Errors: `ParseIssue { line: number; text: string; message: string }[]`. Never throws. If the header
is missing, return immediately with a **single** issue ("not an architecture-beta diagram") rather
than one per line — the prototype emitted 4 confusing errors for `flowchart TD\n A --> B`. Dangling
`in <group>` → drop the parent, one issue. Edge referencing an unknown id → drop the edge, one issue.
Unrecognized line → one issue, keep going.

## Editor UX

The `'arch'` dialog reuses the wide `DialogContent` variant (`project-design-panel.tsx:477-478`,
`w-[96vw] max-w-[1500px]`) with a two-column body:

- **Left:** Title / Kind / AI prompt / Mermaid source textarea / Notes, plus a parse-issue list below
  the textarea (`line N: message`, destructive-toned, empty when clean).
- **Right:** `<DesignCanvas mode="derived" …>`.

Re-parse invalidation: `DesignCanvas` reads `initialGraph` only on mount
(`design-canvas.tsx:152-154`), so remount it via `canvasKey`. Key it on a hash of **structure +
labels + icons — everything except positions** — computed from the debounced (~300ms) textarea value.
So editing a label remounts (cheap at ≤50 nodes), while dragging changes only override state and does
**not** remount. No feedback loop.

Two deliberately separate affordances for stale-nudge accumulation:

- **"Reset positions"** on the canvas toolbar (replacing "Auto-arrange" in derived mode): clears all
  overrides and bumps `canvasKey` explicitly (the hash won't change, since positions aren't in it).
  Enabled only when overrides is non-empty, and shows a count (`Reset positions (3)`) so accumulated
  nudges are visible rather than silent.
- **Automatic pruning** on every re-parse via `reconcileOverrides`, so renaming a node never forces a
  manual reset.

Save: `diagram_type` stays `'mermaid'`; `source = withLayoutComment(textarea, overrides)`.

`handleFormatChange` (line 277) is new-doc-only and stays a two-value toggle; picking "Mermaid text"
with kind `aws` now yields a *draggable* starter, since `STARTER_TEMPLATES.aws` is already
`architecture-beta`. Update `DIAGRAM_TYPE_LABELS` (line 88) to say so.

## Preview and PNG export

The preview path **does** change: architecture-beta mermaid designs render `<DesignCanvas readOnly>`
instead of `<MermaidDiagram>`. Other mermaid sources are unaffected.

PNG export works unchanged — same React Flow DOM, and `exportDesignToPng` (`design-export.ts:37`)
drives off `getNodesBounds(nodes)` rather than the visible pane. The new junction component must
follow the same rules: literal colors, no `--xy-*`.

**Fix in task 5:** `exportPng` (`design-canvas.tsx:358`) does a global
`document.querySelector('.react-flow__viewport')`. That's a latent bug today and a live one in
`'arch'` mode, where the preview canvas stays mounted behind the dialog portal — exporting from the
dialog would capture the wrong viewport. Scope it to a ref.

## Files

**New**

| Path | Contents |
|---|---|
| `apps/web/lib/mermaid-architecture.ts` | `parseArchitectureDiagram(source): ArchitectureParse` (never throws) + `architectureToDesignGraph(parse)`. `@/` imports must be `import type` only. |
| `apps/web/lib/mermaid-layout-overrides.ts` | `parseLayoutComment`, `stripLayoutComment`, `withLayoutComment`, `reconcileOverrides`, `applyOverrides`. Pure. |
| `apps/web/components/design-junction-node.tsx` | 12px dot, 4 dual-purpose handles, ~25 lines. |
| `apps/web/lib/mermaid-architecture.test.ts` | `node --test` |
| `apps/web/lib/design-layout.test.ts` | `node --test` |
| `apps/web/lib/mermaid-layout-overrides.test.ts` | `node --test` |

**Modified**

| Path | Change |
|---|---|
| `apps/web/lib/design-layout.ts` | Add `applyNestedLayout(nodes, edges)` + `estimateNodeHeight(label)` + `NODESEP`/`GROUP_PAD_*`. **Leave `applyDagreLayout` exactly as is** — top-level-only is correct for the freeform canvas, where group sizes are user-owned via `NodeResizer`. |
| `apps/web/lib/design-graph.ts` | Add `'junction'` to `DESIGN_NODE_TYPES` (line 11); add `DesignNodeData.derivedSize?: boolean` with a comment ("sized from children, resize suppressed"); accept both in `toDesignNode` (lines 50-56). |
| `apps/web/components/design-group-node.tsx` | Gate `<NodeResizer>` (line 53) on `!data.derivedSize`. |
| `apps/web/components/design-canvas.tsx` | `mode?: 'freeform' \| 'derived'`; register `junction` in `nodeTypes` (line 28); `onPositionsChange` callback; derived mode → hide palette (376-420) and inspector (502-626), hide Group/Ungroup (483-494), skip reparenting in `onNodeDragStop` (318-350), swap "Auto-arrange" for "Reset positions"; ref-scope the export element (358). |
| `apps/web/components/project-design-panel.tsx` | 3-way `editorMode`; `'arch'` wide dialog with textarea + parse-error list left, derived canvas right; preview routing (453-461); strip/attach layout comment on open/save. |

**Not modified:** `apps/server/src/**`, `apps/web/lib/design-export.ts`, `apps/web/lib/aws-icons.ts`,
`apps/web/components/mermaid-diagram.tsx`, `apps/web/package.json`.

`project-design-panel.tsx` branches on `diagram_type` at these verified lines — enumerate them when
introducing `editorMode`: 85, 88-91, 200, 208, 226, 234-242, 245, 264, 269-272, 277-287, 300-302,
453-461, 476-481, 482-710.

## Tasks, in dependency order

**1. Override codec + reconcile — `lib/mermaid-layout-overrides.ts`**
Pure, no runtime imports. *Verify:* `cd apps/web && node --test lib/mermaid-layout-overrides.test.ts`
— round-trip (strip→attach→parse is identity); corrupt JSON → `{}`; missing comment → `{}`; two
comments → last wins; emitted line starts `%% ` with a space (assert it cannot match `/^[\t ]*%%\{/`);
reconcile drops vanished ids, drops parent-changed ids, keeps unchanged ids.

**2. Parser — `lib/mermaid-architecture.ts`**
Grammar above. *Verify:* `node --test lib/mermaid-architecture.test.ts` with all three real sources
inlined as fixtures (pull via the `psql` command above) → 0 issues and node/group/edge counts of
5/1/3, 16/2/22, 12/2/10. Plus: `-[label]-` extracted; `-->` vs `<--` vs `<-->` marker/direction;
`{group}` remap; `align` and `title` accepted silently; `service x "DB"` accepted; 3-level nesting;
`flowchart TD` → exactly one issue; `''` → one issue, no throw; garbage → no throw.

**3. Nested layout — `lib/design-layout.ts`**
Add `applyNestedLayout` + `estimateNodeHeight`; leave `applyDagreLayout` untouched. *Verify:*
`node --test lib/design-layout.test.ts` — for each of the three real designs and a 3-level synthetic,
assert **`straddle === 0`** (every child's position/size fully inside its parent's derived size) and
**`labelCollisions === 0`** (no two service nodes' 144px label boxes intersect in absolute
coordinates). These two assertions *are* the acceptance criterion. Also assert `applyDagreLayout`'s
existing behavior is unchanged (2-node LR case).

**4. `junction` node type — `lib/design-graph.ts` + `components/design-junction-node.tsx`**
*Verify:* `npx tsc --noEmit` clean; a junction diagram renders a dot, not a 40px grey fallback tile.
**This is the one task acceptable to cut** — mapping junctions to a label-less `design` node ships
sooner but looks broken.

**5. `DesignCanvas` derived mode — `design-canvas.tsx` + `design-group-node.tsx`**
*Verify:* `npx tsc --noEmit`; then **regression gate** — existing reactflow designs behave
identically (drag, group, ungroup, resize, auto-arrange, export) at
`http://localhost:3010/projects/1d0c3c65-cf7b-4cf3-85dd-fbe35f5df961`.

**6. Panel wiring — `project-design-panel.tsx`**
*Verify:* `npx tsc --noEmit`; then browser (task 7).

**7. Browser verification**

```bash
cd /home/toyofumi/projects/openmemory/apps/web && PORT=3010 npm run dev
B=$HOME/.claude/skills/gstack/browse/dist/browse
# The 3 real mermaid designs are in TWO OTHER projects, not the 8-sample project:
$B goto http://localhost:3010/projects/af9ffd44-19d7-4a0b-ad44-1bbca6542bca   # 2 of them
$B goto http://localhost:3010/projects/c1471c75-c8da-4b5f-91af-40a80ca8727e   # the 3rd
```

For each of the three: Design tab → pick from the dropdown → `screenshot` → expect a React Flow
canvas, **not** mermaid SVG. `console --errors` must be empty.

Then the containment check in the browser, not only in unit tests:

```bash
$B js "(()=>{const q=s=>[...document.querySelectorAll(s)];const r=e=>e.getBoundingClientRect();
  return q('.react-flow__node-design,.react-flow__node-junction').filter(n=>{
    const p=n.closest('.react-flow__node-group'); if(!p) return false;
    const a=r(n),b=r(p); return a.left<b.left||a.top<b.top||a.right>b.right||a.bottom>b.bottom;
  }).map(n=>n.dataset.id);})()" --out /tmp/straddle.json
```

Must be `[]` for all three — the same measurement that gave 3/5/6 on the reactflow samples.

Then in the Edit dialog for **"Wide microservices platform"** (the 16-node/2-group/22-edge fixture —
a screenshot of the 5-node one proves nothing): drag a node → Save → reopen → node is where it was
left; the saved `source` ends with one `%% openmemory:layout:v1 …` line and still renders in mermaid
Live Editor. Rename that node's title in the textarea → its override is dropped, others hold. Move it
out of its group in the text → override dropped. Hand-corrupt the comment via `psql` → still renders,
warning shown. "Reset positions" → snaps back. Export PNG from both the preview and the dialog →
correct canvas each time, no black label boxes. Repeat one pass in dark mode.

## Risks and fallout

- No server change, no container rebuild, no schema change, no new dependency, no version bump.
- **Behavior change:** the 3 existing mermaid architecture-beta designs stop rendering as mermaid SVG
  and start rendering as a React Flow canvas. They lose `MermaidDiagram`'s zoom/fit/fullscreen
  buttons and gain React Flow's `Controls` plus PNG export. Their `source` isn't rewritten until
  someone edits and saves.
- `DESIGN_NODE_TYPES` gains a third value, so a persisted reactflow source could in principle contain
  `type: 'junction'`. Nothing writes that today; `toDesignNode` must accept it so a future round-trip
  doesn't silently downgrade it to `'design'`.
- No existing tests break. `npm test` still echoes `no tests yet`. **Do not** wire the new
  `node --test` files into `npm test` — that changes CI behavior and is the user's call. Commit the
  test files and note their invocation in each file's header comment, matching
  `autofill-merge.test.ts:2`.
- 300ms debounce means the canvas lags typing slightly. Intended.
- `GROUP_PAD_TOP = 40` vs a long group title wrapping to 3+ lines could touch the first child row.
  Not reproducible in any of the 3 real designs. If it appears, derive `GROUP_PAD_TOP` from the
  title's estimated line count instead of a constant.

## Out of scope

- `flowchart` / `subgraph` support. Structure the parser so a second front-end can feed the same
  graph/layout/override pipeline.
- `align row|column` — parsed and ignored. dagre has no same-rank API.
- Making the preview draggable / autosave-on-drag (Decision 4 settled this).
- Switching the freeform canvas's "Auto-arrange" to `applyNestedLayout`. **Flag this loudly on
  completion:** once task 3 lands, one Auto-arrange click on AWS 1/2/3 is very likely the fix for the
  3/5/6 straddling nodes and the 2 AWS-3 label collisions. Out of scope only because it would
  overwrite user-authored group sizes (`NodeResizer`-owned), which needs its own opt-in/undo decision.
- Bidirectional sync (canvas structural edits writing mermaid text back). Text is authoritative; the
  canvas owns positions only.
- elkjs, web workers, any new npm dependency.
- Editing labels/icons from the derived canvas inspector — those come from the text.
