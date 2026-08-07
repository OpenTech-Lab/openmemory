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
