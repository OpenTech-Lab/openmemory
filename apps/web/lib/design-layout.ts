// Dagre auto-layout for the design canvas. Ported from homelable's frontend/src/utils/layout.ts
// (~89-123) — only the core rank/position loop; the Proxmox/multi-port-switch peer-grouping and
// child-reordering logic there (buildPeerGroups, reorderChildrenByPort, handlePortIndex, parent/
// child containers) is specific to network topology diagrams and doesn't apply here.

import dagre from '@dagrejs/dagre';
import type { Edge } from '@xyflow/react';
import type { DesignNode } from '@/lib/design-graph';

// Icon-above-label 'design' node footprint (see design-node.tsx: 96px wide, 40px icon + label).
// Kept in sync with design-canvas.tsx's DEFAULT_NODE_WIDTH/HEIGHT.
// HEIGHT is only a pre-measurement fallback, and is deliberately the *shortest* real node: labels
// wrap to as many lines as they need (design-node.tsx), so real heights vary — about 95px at one
// line up to ~125px at three. Callers prefer `measured.height` and reach this only before React
// Flow has measured a node.
const NODE_WIDTH = 96;
const NODE_HEIGHT = 96;
// 'group' box footprint used only as a dagre placeholder when a group node itself has no
// explicit width/height yet (freshly created boxes always do, but stay defensive). Kept in sync
// with design-canvas.tsx's DEFAULT_GROUP_WIDTH/HEIGHT.
const GROUP_WIDTH = 260;
const GROUP_HEIGHT = 160;

/**
 * Lays out `nodes` left-to-right (architecture diagrams read left-to-right, unlike homelable's
 * top-to-bottom network topology) using dagre, returning new nodes with updated `position`.
 *
 * Only TOP-LEVEL nodes (no `parentId`) are repositioned by dagre — a node with `parentId` has a
 * position relative to its parent group, which dagre has no concept of, so those pass through
 * completely untouched (mirrors homelable's utils/layout.ts top-level-only filtering).
 */
export function applyDagreLayout(nodes: DesignNode[], edges: Edge[]): DesignNode[] {
  const topLevel = nodes.filter((node) => !node.parentId);
  const topLevelIds = new Set(topLevel.map((node) => node.id));

  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 80 });

  for (const node of topLevel) {
    const isGroup = node.type === 'group';
    const width = node.width ?? node.measured?.width ?? (isGroup ? GROUP_WIDTH : NODE_WIDTH);
    const height = node.height ?? node.measured?.height ?? (isGroup ? GROUP_HEIGHT : NODE_HEIGHT);
    g.setNode(node.id, { width, height });
  }
  for (const edge of edges) {
    if (!topLevelIds.has(edge.source) || !topLevelIds.has(edge.target)) continue;
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  return nodes.map((node) => {
    if (node.parentId) return node;
    const pos = g.node(node.id);
    if (!pos) return node;
    const { width, height } = g.node(node.id);
    // dagre returns CENTER coordinates; React Flow positions nodes by TOP-LEFT — convert or
    // every node silently ends up offset by half its own width/height.
    return { ...node, position: { x: pos.x - width / 2, y: pos.y - height / 2 } };
  });
}

// --- Nested (derived-mode) layout for mermaid architecture-beta designs ---------------------
//
// Used only by the 'arch' derived-mode canvas (mermaid-architecture.ts's output) — NOT by the
// freeform reactflow canvas, where group sizes are user-owned via NodeResizer. `applyDagreLayout`
// above is untouched: top-level-only is still correct there.
//
// Each group's children are laid out in that group's OWN coordinate space, bottom-up, and the
// group's width/height are DERIVED from its children's bounding box plus padding. Because React
// Flow child positions are already parent-relative, a child outside a parent box sized from that
// same child's own extent is arithmetically impossible — containment is a construction guarantee,
// not a tuned constant. Only a flat dagre run is ever needed at each level.

// 48px of label overhang (`(144-96)/2 × 2`, see design-node.tsx) plus 8px gap — this is exactly
// the class of collision measured on the AWS-3 reactflow sample (2 node-on-node label overlaps).
const NODESEP = 56;
const RANKSEP = 80;
// Deliberately match groupSelection's existing PADDING_H/PADDING_TOP/PADDING_BOTTOM
// (design-canvas.tsx:267-269) so hand-grouped and derived boxes look identical.
const GROUP_PAD_H = 24;
const GROUP_PAD_TOP = 40;
const GROUP_PAD_BOTTOM = 24;

/**
 * Estimates a 'design' node's rendered height from its label before React Flow has measured it —
 * `NODE_HEIGHT` (96) is documented as the *shortest* real node, so using it here for multi-line
 * labels is what lets vertically stacked nodes touch. 40 (icon) + 4 (gap) + 8 (padding) +
 * 14 × lineCount, counting wrapped lines across authored `\n` breaks at ~22 chars per 144px line
 * (the label footprint — see design-node.tsx's `-mx-6 w-[144px]`).
 */
export function estimateNodeHeight(label: string): number {
  const CHARS_PER_LINE = 22;
  const LINE_HEIGHT = 14;
  const segments = (label || '').split('\n');
  let lines = 0;
  for (const segment of segments) {
    lines += Math.max(1, Math.ceil(segment.length / CHARS_PER_LINE));
  }
  if (lines === 0) lines = 1;
  return 40 + 4 + 8 + LINE_HEIGHT * lines;
}

interface LevelResult {
  /** Every node at this level and below, fully positioned. */
  positioned: DesignNode[];
  /** This level's own derived box size — meaningless at the root level (no enclosing group). */
  width: number;
  height: number;
}

/**
 * Recursively lays out `nodes` so that no child can ever straddle its group's border: each
 * group's children are dagre-laid-out in that group's own space, then the group's width/height
 * are derived from that layout's bounding box plus padding — the containment guarantee comes from
 * this recursion, not from tuning NODESEP/RANKSEP/padding.
 *
 * Cross-boundary edges are handled by projection: at the run for container `C`, each edge's
 * endpoints are mapped to their ancestor that is a direct child of `C` (dedupe, drop self-pairs),
 * so `a (in g1) → b (in g2)` becomes `g1 → g2` at root level and contributes nothing inside `g1`'s
 * own run, where it can't be satisfied anyway.
 */
export function applyNestedLayout(nodes: DesignNode[], edges: Edge[]): DesignNode[] {
  if (nodes.length === 0) return nodes;
  const byId = new Map(nodes.map((node) => [node.id, node]));

  const childrenByParent = new Map<string | undefined, DesignNode[]>();
  for (const node of nodes) {
    const key = node.parentId;
    const siblings = childrenByParent.get(key) ?? [];
    siblings.push(node);
    childrenByParent.set(key, siblings);
  }

  /** Walks `id`'s parent chain up to the node that is a direct child of `targetParentId` (the
   * edge-projection step described above). `null` if `id` isn't under that subtree at all. */
  function findAncestorAtLevel(id: string, targetParentId: string | undefined): string | null {
    let current = byId.get(id);
    let guard = 0;
    while (current && current.parentId !== targetParentId) {
      if (guard++ > nodes.length) return null; // defensive: cyclic parentId chain
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return current ? current.id : null;
  }

  function layoutLevel(parentId: string | undefined): LevelResult {
    const children = childrenByParent.get(parentId) ?? [];
    if (children.length === 0) {
      return { positioned: [], width: GROUP_WIDTH, height: GROUP_HEIGHT };
    }

    // Bottom-up: group children must already know their own derived size before this level's
    // dagre run treats them as fixed-size boxes.
    const childSizes = new Map<string, { width: number; height: number }>();
    const descendantsPositioned: DesignNode[] = [];
    for (const child of children) {
      if (child.type === 'group') {
        const sub = layoutLevel(child.id);
        childSizes.set(child.id, { width: sub.width, height: sub.height });
        descendantsPositioned.push(...sub.positioned);
      }
    }

    const g = new dagre.graphlib.Graph();
    g.setDefaultEdgeLabel(() => ({}));
    g.setGraph({ rankdir: 'LR', nodesep: NODESEP, ranksep: RANKSEP });

    for (const child of children) {
      let width: number;
      let height: number;
      if (child.type === 'group') {
        ({ width, height } = childSizes.get(child.id)!);
      } else if (child.type === 'junction') {
        width = child.width ?? 12;
        height = child.height ?? 12;
      } else {
        width = child.width ?? child.measured?.width ?? NODE_WIDTH;
        height = child.height ?? child.measured?.height ?? estimateNodeHeight(child.data.label);
      }
      g.setNode(child.id, { width, height });
    }

    const childIds = new Set(children.map((child) => child.id));
    const seenPairs = new Set<string>();
    for (const edge of edges) {
      const a = findAncestorAtLevel(edge.source, parentId);
      const b = findAncestorAtLevel(edge.target, parentId);
      if (!a || !b || a === b || !childIds.has(a) || !childIds.has(b)) continue;
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      g.setEdge(a, b);
    }

    dagre.layout(g);

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const raw = new Map<string, { x: number; y: number; width: number; height: number }>();
    for (const child of children) {
      const pos = g.node(child.id);
      const left = pos.x - pos.width / 2;
      const top = pos.y - pos.height / 2;
      raw.set(child.id, { x: left, y: top, width: pos.width, height: pos.height });
      minX = Math.min(minX, left);
      minY = Math.min(minY, top);
      maxX = Math.max(maxX, left + pos.width);
      maxY = Math.max(maxY, top + pos.height);
    }

    // Top level has no enclosing group, so no padding offset is applied — matches
    // applyDagreLayout's own untouched top-level behavior.
    const isRoot = parentId === undefined;
    const offsetX = isRoot ? 0 : GROUP_PAD_H - minX;
    const offsetY = isRoot ? 0 : GROUP_PAD_TOP - minY;

    const positioned: DesignNode[] = children.map((child) => {
      const r = raw.get(child.id)!;
      const position = { x: r.x + offsetX, y: r.y + offsetY };
      if (child.type === 'group') {
        const size = childSizes.get(child.id)!;
        return { ...child, position, width: size.width, height: size.height };
      }
      return { ...child, position };
    });

    const width = isRoot ? 0 : maxX - minX + GROUP_PAD_H * 2;
    const height = isRoot ? 0 : maxY - minY + GROUP_PAD_TOP + GROUP_PAD_BOTTOM;

    return { positioned: [...positioned, ...descendantsPositioned], width, height };
  }

  const { positioned } = layoutLevel(undefined);
  const positionedById = new Map(positioned.map((node) => [node.id, node]));
  // Preserves the caller's original ordering (parents-before-children, from
  // architectureToDesignGraph) rather than the recursion's own traversal order.
  return nodes.map((node) => positionedById.get(node.id) ?? node);
}
