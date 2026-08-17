// The React Flow diagram format contract: `source` for a design with diagram_type='reactflow'
// is React Flow's own `toObject()` shape — { nodes, edges, viewport } — serialized to JSON, with
// our own payload confined to `node.data: DesignNodeData` and `node.type` fixed to 'design'. No
// custom translation layer between what's stored and what React Flow renders.

import type { Edge, Node, Viewport } from '@xyflow/react';

export const DESIGN_DIAGRAM_TYPES = ['drawio', 'mermaid', 'reactflow', 'pen', 'text'] as const;
export type DesignDiagramType = (typeof DESIGN_DIAGRAM_TYPES)[number];

// 'junction' is the architecture-beta derived-mode dot-node (design-junction-node.tsx). Nothing
// writes it from the freeform reactflow canvas today, but toDesignNode below must still accept it
// so a future reactflow save/reload round-trip can't silently downgrade a persisted junction to a
// generic 'design' node.
export const DESIGN_NODE_TYPES = ['design', 'group', 'junction'] as const;
export type DesignNodeType = (typeof DESIGN_NODE_TYPES)[number];

export const BORDER_STYLES = ['solid', 'dashed', 'dotted'] as const;
export type BorderStyle = (typeof BORDER_STYLES)[number];

export const BOX_COLORS = ['none', 'slate', 'purple', 'teal', 'orange', 'green'] as const;
export type BoxColor = (typeof BOX_COLORS)[number];

export interface DesignNodeData extends Record<string, unknown> {
  label: string;
  icon?: string;
  kind?: string;
  note?: string;
  /** Group-only: box border style. Ignored by 'design' (service) nodes. */
  borderStyle?: BorderStyle;
  /** Group-only: box border/label accent color. 'none' (default) keeps the neutral look. */
  borderColor?: BoxColor;
  /** Derived-mode only: size comes from applyNestedLayout's recursion, not NodeResizer — the
   * group node gates its own resize handles off this flag (design-group-node.tsx). */
  derivedSize?: boolean;
}

export type DesignNode = Node<DesignNodeData, DesignNodeType>;

export interface DesignGraph {
  nodes: DesignNode[];
  edges: Edge[];
  viewport?: Viewport;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toDesignNode(raw: unknown): DesignNode | null {
  if (!isRecord(raw)) return null;
  const { id, position, data, type, parentId, extent, width, height } = raw;
  if (typeof id !== 'string' || !id) return null;
  if (!isRecord(position) || typeof position.x !== 'number' || typeof position.y !== 'number') return null;
  const rawData = isRecord(data) ? data : {};
  const label = typeof rawData.label === 'string' ? rawData.label : '';
  const nodeType: DesignNodeType = type === 'group' ? 'group' : type === 'junction' ? 'junction' : 'design';
  const borderStyle = BORDER_STYLES.includes(rawData.borderStyle as BorderStyle)
    ? (rawData.borderStyle as BorderStyle)
    : undefined;
  const borderColor = BOX_COLORS.includes(rawData.borderColor as BoxColor)
    ? (rawData.borderColor as BoxColor)
    : undefined;

  const node: DesignNode = {
    id,
    type: nodeType,
    position: { x: position.x, y: position.y },
    data: {
      label,
      icon: typeof rawData.icon === 'string' ? rawData.icon : undefined,
      kind: typeof rawData.kind === 'string' ? rawData.kind : undefined,
      note: typeof rawData.note === 'string' ? rawData.note : undefined,
      borderStyle,
      borderColor,
      derivedSize: rawData.derivedSize === true ? true : undefined,
    },
  };

  // parentId is validated for dangling references by the caller (parseDesignGraph), once the
  // full surviving node-id set is known — here we only accept the shape.
  if (typeof parentId === 'string' && parentId) node.parentId = parentId;
  if (extent === 'parent') node.extent = 'parent';
  if (typeof width === 'number' && Number.isFinite(width)) node.width = width;
  if (typeof height === 'number' && Number.isFinite(height)) node.height = height;

  return node;
}

/** Re-sorts `nodes` so every parent precedes its children (React Flow's hard requirement for
 * `parentId` nesting) and drops any `parentId` that references a node not present in the set —
 * an orphaned parentId crashes React Flow at render. Stable for already-sorted/flat input. */
function sanitizeNodeHierarchy(nodes: DesignNode[]): DesignNode[] {
  const ids = new Set(nodes.map((n) => n.id));
  const cleaned = nodes.map((n) => {
    if (n.parentId && !ids.has(n.parentId)) {
      const { parentId: _parentId, extent: _extent, ...rest } = n;
      return rest as DesignNode;
    }
    return n;
  });

  const byId = new Map(cleaned.map((n) => [n.id, n]));
  const visited = new Set<string>();
  const ordered: DesignNode[] = [];
  const visit = (node: DesignNode) => {
    if (visited.has(node.id)) return;
    visited.add(node.id);
    if (node.parentId) {
      const parent = byId.get(node.parentId);
      if (parent) visit(parent);
    }
    ordered.push(node);
  };
  for (const node of cleaned) visit(node);
  return ordered;
}

function toDesignEdge(raw: unknown): Edge | null {
  if (!isRecord(raw)) return null;
  const { id, source, target } = raw;
  if (typeof id !== 'string' || !id) return null;
  if (typeof source !== 'string' || !source) return null;
  if (typeof target !== 'string' || !target) return null;
  return {
    ...raw,
    id,
    source,
    target,
    label: typeof raw.label === 'string' ? raw.label : undefined,
  } as Edge;
}

function toViewport(raw: unknown): Viewport | undefined {
  if (!isRecord(raw)) return undefined;
  const { x, y, zoom } = raw;
  if (typeof x !== 'number' || typeof y !== 'number' || typeof zoom !== 'number') return undefined;
  return { x, y, zoom };
}

/**
 * Parses `source` for a reactflow-format design. This may be data hand-edited by a user, or
 * generated by an LLM — never throws; any malformed input falls back to an empty graph so a
 * broken save can never crash the preview or editor.
 */
export function parseDesignGraph(source: string): DesignGraph {
  const empty: DesignGraph = { nodes: [], edges: [] };
  if (!source || !source.trim()) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return empty;
  }
  if (!isRecord(parsed)) return empty;

  const nodes = Array.isArray(parsed.nodes)
    ? sanitizeNodeHierarchy(parsed.nodes.map(toDesignNode).filter((n): n is DesignNode => n !== null))
    : [];
  const edges = Array.isArray(parsed.edges)
    ? parsed.edges.map(toDesignEdge).filter((e): e is Edge => e !== null)
    : [];
  const viewport = toViewport(parsed.viewport);

  return viewport ? { nodes, edges, viewport } : { nodes, edges };
}

/**
 * Parses the raw graph JSON returned by the `ai.design_diagram` (format=reactflow) endpoint —
 * `{ nodes: [{id,label,icon?}], edges: [{source,target,label?}] }`, sanitized server-side by
 * design_ai::sanitize_graph. This is deliberately a DIFFERENT shape from parseDesignGraph's
 * persisted-source contract: the LLM never sees positions or edge ids (those are a canvas-only
 * concern), so nodes/edges lacking them are the normal case here, not something to drop. Never
 * throws, same as parseDesignGraph. All nodes land at (0,0) — the caller must run the result
 * through applyDagreLayout immediately, since there is no layout information to preserve.
 */
export function parseAiGraph(source: string): { nodes: DesignNode[]; edges: Edge[] } {
  const empty = { nodes: [] as DesignNode[], edges: [] as Edge[] };
  if (!source || !source.trim()) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return empty;
  }
  if (!isRecord(parsed)) return empty;

  const nodes: DesignNode[] = Array.isArray(parsed.nodes)
    ? parsed.nodes.flatMap((raw): DesignNode[] => {
        if (!isRecord(raw)) return [];
        const { id, label, icon } = raw;
        if (typeof id !== 'string' || !id) return [];
        return [{
          id,
          type: 'design',
          position: { x: 0, y: 0 },
          data: {
            label: typeof label === 'string' ? label : '',
            icon: typeof icon === 'string' ? icon : undefined,
          },
        }];
      })
    : [];

  const edges: Edge[] = Array.isArray(parsed.edges)
    ? parsed.edges.flatMap((raw): Edge[] => {
        if (!isRecord(raw)) return [];
        const { source: from, target: to, label } = raw;
        if (typeof from !== 'string' || !from) return [];
        if (typeof to !== 'string' || !to) return [];
        return [{
          id: `edge_${from}_${to}_${Math.random().toString(36).slice(2)}`,
          source: from,
          target: to,
          label: typeof label === 'string' ? label : undefined,
        }];
      })
    : [];

  return { nodes, edges };
}

/**
 * Serializes the canvas's current state back to `source`. Strips React Flow's transient
 * runtime-only fields (selection, drag state, measured size) so a mere click/selection in the
 * editor doesn't dirty the saved JSON on the next save.
 */
export function serializeDesignGraph(nodes: DesignNode[], edges: Edge[], viewport?: Viewport): string {
  const cleanNodes = nodes.map(({ selected: _selected, dragging: _dragging, measured: _measured, ...node }) => node);
  const cleanEdges = edges.map(({ selected: _selected, ...edge }) => edge);
  const graph: DesignGraph = viewport ? { nodes: cleanNodes, edges: cleanEdges, viewport } : { nodes: cleanNodes, edges: cleanEdges };
  return JSON.stringify(graph);
}

/** A 2-node starter graph for the New Diagram default when format=reactflow — the reactflow
 * analogue of design-meta.ts's mermaid STARTER_TEMPLATES. */
export function blankDesignGraph(kind?: string): DesignGraph {
  const isAws = kind === 'aws';
  return {
    nodes: [
      {
        id: 'node-1',
        type: 'design',
        position: { x: 0, y: 0 },
        data: { label: isAws ? 'Client' : 'Start', icon: isAws ? undefined : undefined, kind },
      },
      {
        id: 'node-2',
        type: 'design',
        position: { x: 280, y: 0 },
        data: { label: isAws ? 'API Gateway' : 'Next', icon: isAws ? 'aws-api-gateway' : undefined, kind },
      },
    ],
    edges: [
      { id: 'edge-node-1-node-2', source: 'node-1', target: 'node-2' },
    ],
  };
}
