# Design canvas: colored group borders + per-edge line style

Date: 2026-08-07
Status: approved (pending spec review)

## Context

OpenMemory's "Designs" feature (`apps/web/components/design-canvas.tsx` and friends) is a
React Flow canvas purpose-built for AWS-style architecture diagrams: brand-colored service
icons (via the `logos:aws-*` iconify set), nested group/container boxes (`design-group-node.tsx`,
using React Flow `parentId` nesting), orthogonal step-routed arrows, PNG export.

Reference samples now live at `docs/refer/draw/` — 5 AWS architecture diagrams
(`aws_strcuture/sample1-5.png`) and 3 workflow/swimlane diagrams (`workflow/sample1-3.png`),
plus the original `draw.png`. Per user direction, this pass targets the AWS-structure style only
(the workflow/swimlane style — colored lane headers, decision diamonds, mixed shapes — is out of
scope for this design).

Comparing the current canvas against the AWS-structure samples, two gaps remain:

1. **Group/box borders are always a fixed neutral gray.** The samples use border color to
   distinguish nesting levels — e.g. sample3.png: black "AWS Cloud" outer box, purple "VPC" box,
   teal "Private subnet" box, orange "AWS Fargate" region. `DesignGroupNode` currently renders a
   single `border-neutral-400 dark:border-neutral-600` regardless of what the box represents.
2. **Edges have no per-edge style control and aren't even selectable.** The samples mix solid
   arrows (primary flow) with dashed arrows (feedback loops, failure paths, optional calls) — e.g.
   sample1.png's dashed loop back to `Amazon S3 video-stream-input`. Today every edge is forced
   through one global `defaultEdgeOptions` (`type: 'step'`, solid stroke); there is no
   `onEdgeClick` handler and no edge section in the inspector panel.

Everything else already matches: icon-square nodes with brand colors, multi-level nesting,
icon+label layout, minimap, PNG export. This is a small, additive change — no data model
migration, no new dependencies.

## Design

### 1. Group border color (curated palette)

Add an optional field to group node data:

```ts
// lib/design-graph.ts
export const BOX_COLORS = ['none', 'slate', 'purple', 'teal', 'orange', 'green'] as const;
export type BoxColor = (typeof BOX_COLORS)[number];

export interface DesignNodeData extends Record<string, unknown> {
  // ...existing fields...
  /** Group-only: box border/label accent color. 'none' (default) keeps today's neutral look. */
  borderColor?: BoxColor;
}
```

- `toDesignNode` in `design-graph.ts` validates `rawData.borderColor` against `BOX_COLORS`
  the same way it already validates `borderStyle`, falling back to `undefined` (→ 'none').
- `DesignGroupNode` maps `borderColor` to a Tailwind class pair (border + label text), light/dark
  variants included, following the same "fixed literal colors branched via `dark:`" convention
  already used in this file (see its own comment on why CSS vars don't work here). Five colors:
  - `slate` — border `border-slate-600 dark:border-slate-400`, label same tone (the "AWS Cloud"
    outer-box black/squid-ink look)
  - `purple` — `border-purple-500 dark:border-purple-400` (VPC convention)
  - `teal` — `border-teal-500 dark:border-teal-400` (region/subnet convention)
  - `orange` — `border-orange-500 dark:border-orange-400` (compute/ECS convention)
  - `green` — `border-green-600 dark:border-green-400` (subnet/storage convention)
  - `none` — today's `border-neutral-400 dark:border-neutral-600` (unchanged default)
- The fill tint (`bg-neutral-900/[0.02] dark:bg-white/[0.04]`) stays neutral regardless of
  `borderColor` — only the border stroke and label text pick up the color, matching how the
  samples use color purely as an outline/label accent, not a fill.
- Inspector: `design-canvas.tsx`'s group-only inspector section gains a second `<Select>` next to
  the existing "Border style" one — "Border color" — listing the 6 `BOX_COLORS` with a small
  color swatch per `<SelectItem>`. Same `patchSelected({ borderColor: value })` pattern already
  used for `borderStyle`.

### 2. Per-edge line style (solid/dashed) + edge selection

Currently no edge can be selected or individually edited. Add:

- `selectedEdgeId` state in `DesignCanvasInner`, parallel to existing `selectedNodeId`.
- `onEdgeClick={(_, edge) => { setSelectedEdgeId(edge.id); setSelectedNodeId(null); }}` on
  `<ReactFlow>`; `onNodeClick` gains the mirror `setSelectedEdgeId(null)`; `onPaneClick` clears
  both.
- Inspector panel: when `selectedEdgeId` is set (and no node is selected), render an "Edge"
  section parallel to the existing Node/Box sections:
  - **Label** — text input, patches `edge.label`.
  - **Style** — `<Select>` solid/dashed, patches `edge.style.strokeDasharray` (`undefined` for
    solid, `'6 4'` for dashed) via a `patchSelectedEdge` helper mirroring `patchSelected`.
  - Delete button (trash icon), same as the node section's, removing just that edge.
- `EDGE_CLASS`'s global dark/light stroke-color CSS still applies uniformly (color is not
  per-edge in this pass — only dash pattern is) so dashed edges keep tracking theme automatically.
- Selected edges get a visual highlight — React Flow's default `.selected` edge styling
  (slightly thicker/highlighted stroke) already covers this with no extra work, matching how
  node selection currently looks.
- No changes to `design-graph.ts`'s `toDesignEdge` — `Edge.style` and `Edge.label` already pass
  through as opaque fields (see current `...raw` spread), so `strokeDasharray` round-trips through
  save/load with zero parsing changes.

### Out of scope

- Workflow/swimlane diagram style (lanes, decision diamonds, mixed shapes) — separate future pass
  per user direction.
- Free-form hex color picker — curated palette only, to keep diagrams visually consistent with
  AWS diagram conventions rather than becoming a general-purpose drawing tool.
- Per-edge color/width customization beyond the solid/dashed toggle.
- Multi-select bulk edit for box color or edge style.

### Testing

- Manual: open an existing AWS-kind design, nest 2-3 group boxes, assign different border colors,
  verify visual distinction in both light/dark theme and in PNG export (`exportPng` rasterizes the
  live DOM, so no export-specific code path to test separately).
- Manual: create/select an edge, toggle dashed on/off, verify it persists across save/reload
  (round-trips through `serializeDesignGraph`/`parseDesignGraph` unchanged, per above).
- No existing automated test suite covers `design-canvas.tsx` (client-only React Flow component);
  this pass does not add one — consistent with the rest of this file's current test coverage.
