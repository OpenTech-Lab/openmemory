// Dagre auto-layout for the design canvas. Ported from homelable's frontend/src/utils/layout.ts
// (~89-123) — only the core rank/position loop; the Proxmox/multi-port-switch peer-grouping and
// child-reordering logic there (buildPeerGroups, reorderChildrenByPort, handlePortIndex, parent/
// child containers) is specific to network topology diagrams and doesn't apply here.

import dagre from '@dagrejs/dagre';
import type { Edge } from '@xyflow/react';
import type { DesignNode } from '@/lib/design-graph';

const NODE_WIDTH = 200;
const NODE_HEIGHT = 64;

/**
 * Lays out `nodes` left-to-right (architecture diagrams read left-to-right, unlike homelable's
 * top-to-bottom network topology) using dagre, returning new nodes with updated `position`.
 */
export function applyDagreLayout(nodes: DesignNode[], edges: Edge[]): DesignNode[] {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'LR', nodesep: 60, ranksep: 100 });

  for (const node of nodes) {
    g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  return nodes.map((node) => {
    const pos = g.node(node.id);
    if (!pos) return node;
    // dagre returns CENTER coordinates; React Flow positions nodes by TOP-LEFT — convert or
    // every node silently ends up offset by half its own width/height.
    return { ...node, position: { x: pos.x - NODE_WIDTH / 2, y: pos.y - NODE_HEIGHT / 2 } };
  });
}
