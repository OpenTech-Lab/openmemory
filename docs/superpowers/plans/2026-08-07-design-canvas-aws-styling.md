# Design Canvas AWS Styling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add colored group/box borders and a per-edge solid/dashed line style toggle to the Designs React Flow canvas, closing the two remaining visual gaps versus the AWS-structure reference samples in `docs/refer/draw/aws_strcuture/`.

**Architecture:** Two additive, independent changes to the existing `apps/web` Designs feature: (1) a new optional `borderColor` field on group node data, validated in `lib/design-graph.ts` and rendered in `design-group-node.tsx`, with a matching `<Select>` in the canvas inspector; (2) edge selection (`onEdgeClick`) plus a new inspector "Edge" section in `design-canvas.tsx` that toggles `edge.style.strokeDasharray` and edits `edge.label`. No new dependencies, no data migration — old saved designs render unchanged since both fields are optional.

**Tech Stack:** Next.js app router, React, TypeScript, `@xyflow/react` (React Flow v12), Tailwind CSS, shadcn/ui `<Select>`/`<Input>`/`<Button>` primitives.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-07-design-canvas-aws-styling-design.md` — follow it exactly for the color palette, class names, and behavior described.
- Canvas colors are literal fixed values branched via Tailwind's `dark:` variant, never theme CSS vars (`design-node.tsx`'s existing comment explains why — CSS vars resolve against the *app* theme, not necessarily the canvas's own light/dark state).
- No new npm dependencies.
- This is a client-only React Flow component with no existing automated test suite (`design-canvas.tsx` and friends have zero test files today) — verification in this plan is manual dev-server checks, consistent with existing coverage. Do not introduce a new test framework as part of this plan.
- Follow the existing code's inline-comment style: comments explain *why*, not *what* — see any existing comment in `design-node.tsx`/`design-group-node.tsx`/`design-canvas.tsx` for the house style.

---

### Task 1: `borderColor` field — data model + validation

**Files:**
- Modify: `apps/web/lib/design-graph.ts`

**Interfaces:**
- Produces: `export const BOX_COLORS = ['none', 'slate', 'purple', 'teal', 'orange', 'green'] as const;` and `export type BoxColor = (typeof BOX_COLORS)[number];`, plus `DesignNodeData.borderColor?: BoxColor`. Task 2 and Task 3's inspector code import `BOX_COLORS`/`BoxColor` from this file, the same way `design-canvas.tsx` already imports `BORDER_STYLES`/`BorderStyle` from it today.

- [ ] **Step 1: Add the `BOX_COLORS`/`BoxColor` export**

Add directly below the existing `BORDER_STYLES`/`BorderStyle` export (currently `design-graph.ts:14-15`):

```ts
export const BOX_COLORS = ['none', 'slate', 'purple', 'teal', 'orange', 'green'] as const;
export type BoxColor = (typeof BOX_COLORS)[number];
```

- [ ] **Step 2: Add `borderColor` to `DesignNodeData`**

In the `DesignNodeData` interface (currently `design-graph.ts:17-24`), add a field right after `borderStyle`:

```ts
export interface DesignNodeData extends Record<string, unknown> {
  label: string;
  icon?: string;
  kind?: string;
  note?: string;
  /** Group-only: box border style. Ignored by 'design' (service) nodes. */
  borderStyle?: BorderStyle;
  /** Group-only: box border/label accent color. 'none' (default) keeps the neutral look. */
  borderColor?: BoxColor;
}
```

- [ ] **Step 3: Validate `borderColor` in `toDesignNode`**

In `toDesignNode` (currently `design-graph.ts:38-71`), add validation right next to the existing `borderStyle` validation (currently lines 46-48), and wire it into the returned node's `data`:

```ts
  const borderStyle = BORDER_STYLES.includes(rawData.borderStyle as BorderStyle)
    ? (rawData.borderStyle as BorderStyle)
    : undefined;
  const borderColor = BOX_COLORS.includes(rawData.borderColor as BoxColor)
    ? (rawData.borderColor as BoxColor)
    : undefined;
```

And in the returned `node.data` object (currently lines 54-60), add `borderColor,` right after `borderStyle,`.

- [ ] **Step 4: Manually verify parsing round-trips**

Run: `cd apps/web && npx tsc --noEmit`
Expected: no new type errors (this file is pure TypeScript with no test harness — the type-checker is the fastest signal that the new field is wired correctly through `DesignNodeData`, `toDesignNode`, and any place that already destructures `DesignNodeData` exhaustively).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/design-graph.ts
git commit -m "feat(design): add borderColor field to group node data"
```

---

### Task 2: Render `borderColor` in `DesignGroupNode` + inspector Select

**Files:**
- Modify: `apps/web/components/design-group-node.tsx`
- Modify: `apps/web/components/design-canvas.tsx`

**Interfaces:**
- Consumes: `BOX_COLORS`, `BoxColor` from `apps/web/lib/design-graph.ts` (Task 1).
- Produces: no new exports — this task only changes rendering and the inspector form.

- [ ] **Step 1: Add a color-class lookup in `design-group-node.tsx`**

Add near the top of the file, after the `BORDER_WIDTH` constant (currently line 13):

```ts
// AWS diagram convention: color distinguishes nesting level (VPC vs. subnet vs. outer cloud
// box), not fill — the box interior stays neutral (see the fill layer below) and only the
// border stroke + label text pick up the accent, matching how the reference AWS diagrams use
// color purely as an outline/label cue.
const BORDER_COLOR_CLASSES: Record<BoxColor, string> = {
  none: 'border-neutral-400 dark:border-neutral-600',
  slate: 'border-slate-600 dark:border-slate-400',
  purple: 'border-purple-500 dark:border-purple-400',
  teal: 'border-teal-500 dark:border-teal-400',
  orange: 'border-orange-500 dark:border-orange-400',
  green: 'border-green-600 dark:border-green-400',
};
const LABEL_COLOR_CLASSES: Record<BoxColor, string> = {
  none: 'text-neutral-700 dark:text-neutral-300',
  slate: 'text-slate-700 dark:text-slate-300',
  purple: 'text-purple-700 dark:text-purple-300',
  teal: 'text-teal-700 dark:text-teal-300',
  orange: 'text-orange-700 dark:text-orange-300',
  green: 'text-green-700 dark:text-green-300',
};
```

Add the import at the top of the file, next to the existing `awsIcon` import:

```ts
import type { BoxColor } from '@/lib/design-graph';
```

- [ ] **Step 2: Use the lookup in the component body**

In `DesignGroupNode` (currently lines 15-18), add right after `const label = data.label || 'Box';`:

```ts
  const borderColor = data.borderColor ?? 'none';
```

Replace the fill+border `<div>` (currently lines 34-39) — keep the existing selected-state override (selection still shows blue regardless of `borderColor`, matching how selection already overrides the plain neutral border today), only changing the unselected branch to use the lookup:

```tsx
      <div
        className={`pointer-events-none absolute inset-0 rounded-md bg-neutral-900/[0.02] dark:bg-white/[0.04] ${
          selected ? 'border-blue-500 dark:border-blue-400' : BORDER_COLOR_CLASSES[borderColor]
        }`}
        style={{ borderWidth: BORDER_WIDTH, borderStyle }}
      />
```

Replace the two label `text-neutral-800 dark:text-neutral-200` / `text-neutral-700 dark:text-neutral-300` classes (currently lines 48 and 56) with `LABEL_COLOR_CLASSES[borderColor]` in both branches — e.g. the icon-present branch's outer wrapper div:

```tsx
        <div className={`pointer-events-none absolute left-2 right-2 top-2 flex items-start gap-1.5 ${LABEL_COLOR_CLASSES[borderColor]}`}>
```

and the icon-absent branch's label span:

```tsx
          <span className={`break-words text-[11px] font-semibold leading-tight ${LABEL_COLOR_CLASSES[borderColor]}`}>{label}</span>
```

- [ ] **Step 3: Add "Border color" Select to the inspector**

In `design-canvas.tsx`, import `BOX_COLORS` and `BoxColor` alongside the existing `BORDER_STYLES`/`BorderStyle` import (currently line 26):

```ts
import { BORDER_STYLES, BOX_COLORS, type BorderStyle, type BoxColor, type DesignGraph, type DesignNode as DesignNodeType, type DesignNodeData } from '@/lib/design-graph';
```

Add a swatch-class lookup near the other canvas-level constants (e.g. right after `DEFAULT_NODE_HEIGHT`, currently line 80) — small solid-fill squares for the `<SelectItem>` swatches, distinct from the border-only classes in `design-group-node.tsx` since a filled swatch reads better at that size than an outline would:

```ts
const BOX_COLOR_SWATCH_CLASSES: Record<BoxColor, string> = {
  none: 'bg-neutral-400 dark:bg-neutral-600',
  slate: 'bg-slate-600 dark:bg-slate-400',
  purple: 'bg-purple-500 dark:bg-purple-400',
  teal: 'bg-teal-500 dark:bg-teal-400',
  orange: 'bg-orange-500 dark:bg-orange-400',
  green: 'bg-green-600 dark:bg-green-400',
};
```

In the group-only inspector branch (currently `design-canvas.tsx:467-495`), add a second `<Select>` right after the existing "Border style" block and before the "Icon key" block:

```tsx
                  <div className="space-y-1">
                    <Label className="text-xs">Border color</Label>
                    <Select
                      value={selectedNode.data.borderColor ?? 'none'}
                      onValueChange={(value) => patchSelected({ borderColor: value as BoxColor })}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {BOX_COLORS.map((color) => (
                          <SelectItem key={color} value={color} className="capitalize">
                            <span className="flex items-center gap-2">
                              <span className={`h-2.5 w-2.5 rounded-sm ${BOX_COLOR_SWATCH_CLASSES[color]}`} />
                              {color}
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
```

- [ ] **Step 4: Manual verification**

Run: `cd apps/web && npm run dev` (or the project's existing dev-server command if different — check `apps/web/package.json` `scripts.dev`).

In the browser: open a project's Designs tab, create a new reactflow design (or open an existing `aws` kind one), drag a Box onto the canvas, select it, change "Border color" through each of the 6 options, and confirm the border and label both recolor, in both light and dark app theme. Nest a second box inside it and give it a different color to confirm nested boxes can each carry their own color independently.

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/design-group-node.tsx apps/web/components/design-canvas.tsx
git commit -m "feat(design): render group borderColor + add inspector color picker"
```

---

### Task 3: Edge selection + inspector "Edge" section (label + dashed toggle)

**Files:**
- Modify: `apps/web/components/design-canvas.tsx`

**Interfaces:**
- Consumes: `Edge`, `MarkerType` types already imported from `@xyflow/react` (existing import at `design-canvas.tsx:8-13`); `Trash2` icon already imported from `lucide-react` (existing import at line 14).
- Produces: no new exports — internal state (`selectedEdgeId`) and a new `patchSelectedEdge` helper, both local to `DesignCanvasInner`.

- [ ] **Step 1: Add `selectedEdgeId` state**

In `DesignCanvasInner`, right after the existing `const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);` (currently `design-canvas.tsx:124`), add:

```ts
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
```

Right after `const selectedNode = nodes.find(...)` (currently line 135), add:

```ts
  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId) ?? null;
```

- [ ] **Step 2: Add `patchSelectedEdge` helper and edge removal**

Right after the existing `patchSelected` function (currently `design-canvas.tsx:160-165`), add:

```ts
  const patchSelectedEdge = (patch: Partial<Edge>) => {
    if (!selectedEdgeId) return;
    setEdges((current) => current.map((edge) =>
      edge.id === selectedEdgeId ? { ...edge, ...patch } : edge
    ));
  };

  const removeSelectedEdge = () => {
    if (!selectedEdgeId) return;
    setEdges((current) => current.filter((edge) => edge.id !== selectedEdgeId));
    setSelectedEdgeId(null);
  };
```

- [ ] **Step 3: Wire up selection handlers on `<ReactFlow>`**

In the existing `<ReactFlow>` props (currently `design-canvas.tsx:381-406`):

Replace `onNodeClick={(_, node) => setSelectedNodeId(node.id)}` with:

```tsx
          onNodeClick={(_, node) => { setSelectedNodeId(node.id); setSelectedEdgeId(null); }}
```

Add a new prop right after it:

```tsx
          onEdgeClick={(_, edge) => { setSelectedEdgeId(edge.id); setSelectedNodeId(null); }}
```

Replace `onPaneClick={() => setSelectedNodeId(null)}` with:

```tsx
          onPaneClick={() => { setSelectedNodeId(null); setSelectedEdgeId(null); }}
```

- [ ] **Step 4: Add the "Edge" inspector section**

In the right-side inspector `<aside>` (currently `design-canvas.tsx:453-520`), the ternary currently branches on `selectedNode ? (...) : (...)`. Change it to a three-way branch — node, then edge, then empty state. Replace the opening `{selectedNode ? (` through its matching `) : (` (currently lines 455 and 513) with:

```tsx
          {selectedNode ? (
            <div className="space-y-3">
              {/* ...existing node/box inspector body, unchanged... */}
            </div>
          ) : selectedEdge ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold">Edge</p>
                <Button variant="ghost" size="icon" onClick={removeSelectedEdge}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Label</Label>
                <Input
                  value={typeof selectedEdge.label === 'string' ? selectedEdge.label : ''}
                  onChange={(e) => patchSelectedEdge({ label: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Style</Label>
                <Select
                  value={selectedEdge.style?.strokeDasharray ? 'dashed' : 'solid'}
                  onValueChange={(value) => patchSelectedEdge({
                    style: {
                      ...selectedEdge.style,
                      strokeDasharray: value === 'dashed' ? '6 4' : undefined,
                    },
                  })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="solid">Solid</SelectItem>
                    <SelectItem value="dashed">Dashed</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          ) : (
```

(Leave the existing node-selected body exactly as-is — only the `{selectedNode ? (` / `) : (` wrapper lines change; everything between them stays untouched. The closing empty-state branch — the "Select a node to edit it." block — also stays untouched, just now reached only when neither a node nor an edge is selected.)

- [ ] **Step 5: Clear edge selection alongside node selection on delete**

The existing `onNodesDelete` handler (currently line 397) only clears `selectedNodeId`. Edges aren't deleted through that path (React Flow fires `onEdgesChange` with `type: 'remove'` for edge deletion via the Delete key, which already flows through `setEdges`/`onEdgesChange` and removes the edge from state — but `selectedEdgeId` would then point at a removed edge). Add an `onEdgesDelete` prop right after `onNodesDelete` (currently line 397):

```tsx
          onEdgesDelete={(deleted) => { if (deleted.some((edge) => edge.id === selectedEdgeId)) setSelectedEdgeId(null); }}
```

- [ ] **Step 6: Manual verification**

With the dev server still running: click an existing edge on the canvas (or connect two nodes to create one), confirm the inspector switches to the "Edge" section, set a label, toggle Style to "Dashed" and confirm the arrow visibly changes to a dashed stroke on the canvas, toggle back to "Solid" and confirm it reverts. Delete the edge via the trash icon and via selecting it and pressing Delete/Backspace — confirm both clear the inspector back to the empty state. Reload the design (save happens automatically via the existing `onChange` -> parent save flow; check the project's Designs panel for how saves are triggered, e.g. `apps/web/components/project-design-panel.tsx`) and confirm the dashed style and label persisted.

- [ ] **Step 7: Commit**

```bash
git add apps/web/components/design-canvas.tsx
git commit -m "feat(design): add edge selection with label + dashed style inspector"
```

---

## Self-Review Notes

- **Spec coverage:** Task 1 covers the spec's "1. Group border color" data-model paragraph; Task 2 covers its rendering + inspector Select paragraph; Task 3 covers the entire "2. Per-edge line style" section including selection, label, style toggle, and delete. The spec's "Out of scope" items (swimlanes, hex picker, per-edge color/width, bulk edit) have deliberately no corresponding task.
- **Type consistency:** `BoxColor`/`BOX_COLORS` defined once in Task 1, imported (never redefined) in Tasks 2 and 3. `borderColor` field name matches across `design-graph.ts`, `design-group-node.tsx`, and `design-canvas.tsx`. `patchSelectedEdge`/`removeSelectedEdge` names introduced in Task 3 Step 2 and used consistently in Steps 4 and the manual verification.
- **No placeholders:** every step includes literal code to write, not a description of what to write.
