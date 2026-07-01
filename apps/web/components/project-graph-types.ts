// Shared, render-agnostic types and graph-building logic for the project (NetworkX/graphify)
// graph — consumed by both project-graph-2d.tsx (Sigma) and project-graph-3d.tsx (react-three-fiber).

export interface GraphifyNode {
  id: string;
  label?: string;
  file_type?: string;
  community?: number;
  source_file?: string;
  source_location?: string;
  [key: string]: unknown;
}

export interface GraphifyEdge {
  source: string;
  target: string;
  relation?: string;
  weight?: number;
  [key: string]: unknown;
}

export interface GraphifyData {
  nodes: GraphifyNode[];
  links?: GraphifyEdge[];
  edges?: GraphifyEdge[];
  [key: string]: unknown;
}

export interface GraphQueryResult {
  query: string;
  seed_nodes: string[];
  nodes: Array<{ id: string; label: string; file_type?: string; community?: number; source_file?: string }>;
  edges: Array<{ source: string; target: string; relation: string }>;
  truncated: boolean;
}

export interface SelectedNodeDetail {
  node: GraphifyNode;
  outgoing: Array<{ target: string; targetLabel: string; relation: string }>;
  incoming: Array<{ source: string; sourceLabel: string; relation: string }>;
}

export interface DisplayNode {
  id: string;
  label: string;
  color: string;
  size: number;
  isSeed: boolean;
  data: GraphifyNode;
}

export interface DisplayEdge {
  source: string;
  target: string;
  relation: string;
}

export interface DisplayGraph {
  nodes: DisplayNode[];
  edges: DisplayEdge[];
  nodeMap: Map<string, GraphifyNode>;
  isCommunity: boolean;
}

export const MAX_NODES_FULL = 2000;

export const FILE_TYPE_PALETTE: Record<string, string> = {
  code:      '#6366f1',
  document:  '#22c55e',
  paper:     '#f97316',
  image:     '#ec4899',
  rationale: '#8b5cf6',
  concept:   '#06b6d4',
};

export function fileTypeColor(fileType: string | undefined): string {
  if (fileType && FILE_TYPE_PALETTE[fileType]) return FILE_TYPE_PALETTE[fileType];
  if (!fileType) return '#94a3b8';
  let h = 0;
  for (let i = 0; i < fileType.length; i++) h = fileType.charCodeAt(i) + ((h << 5) - h);
  const colors = Object.values(FILE_TYPE_PALETTE);
  return colors[Math.abs(h) % colors.length];
}

export function shouldShowCommunityView(
  data: GraphifyData,
  queryResult: GraphQueryResult | null | undefined,
  forceFullDetail = false,
): boolean {
  return (data.nodes?.length ?? 0) > MAX_NODES_FULL && !queryResult && !forceFullDetail;
}

// ─── Community aggregation ────────────────────────────────────────────────────
// Collapses each community into one super-node so graphs over MAX_NODES_FULL stay
// readable. Returns plain nodes/edges (no graphology dependency) so both the 2D
// and 3D renderers can consume the same aggregation without duplicating it.
function buildCommunityDisplayGraph(data: GraphifyData): { nodes: DisplayNode[]; edges: DisplayEdge[]; nodeMap: Map<string, GraphifyNode> } {
  const edgeList = data.links ?? data.edges ?? [];

  const degree = new Map<string, number>();
  for (const e of edgeList) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }

  const communityGroups = new Map<number, GraphifyNode[]>();
  for (const n of data.nodes ?? []) {
    const cid = n.community ?? 0;
    if (!communityGroups.has(cid)) communityGroups.set(cid, []);
    communityGroups.get(cid)!.push(n);
  }

  const nodeMap = new Map<string, GraphifyNode>();
  const nodeToComm = new Map<string, number>();
  for (const n of data.nodes ?? []) nodeToComm.set(n.id, n.community ?? 0);

  const nodes: DisplayNode[] = [];
  for (const [cid, members] of communityGroups) {
    const count = members.length;
    const superNodeId = `community_${cid}`;

    const sorted = [...members].sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0));
    const topLabel = sorted[0]?.label ?? `Community ${cid}`;
    const subtitle = sorted.slice(0, 3).map(n => n.label ?? n.id).join(', ');
    const size = 4 + Math.min(count * 0.25, 14);

    const ftCounts: Record<string, number> = {};
    for (const n of members) ftCounts[n.file_type ?? 'unknown'] = (ftCounts[n.file_type ?? 'unknown'] ?? 0) + 1;
    const dominantFt = Object.entries(ftCounts).sort((a, b) => b[1] - a[1])[0]?.[0];
    const color = fileTypeColor(dominantFt);
    const topMembers = sorted.slice(0, 20);

    const syntheticNode: GraphifyNode = {
      id: superNodeId,
      label: topLabel,
      file_type: dominantFt,
      community: cid,
      _count: count,
      _subtitle: subtitle,
      _members: topMembers,
    };

    nodeMap.set(superNodeId, syntheticNode);
    nodes.push({ id: superNodeId, label: topLabel, color, size, isSeed: false, data: syntheticNode });
  }

  const edges: DisplayEdge[] = [];
  const seenPairs = new Set<string>();
  for (const e of edgeList) {
    const srcComm = nodeToComm.get(e.source);
    const tgtComm = nodeToComm.get(e.target);
    if (srcComm === undefined || tgtComm === undefined || srcComm === tgtComm) continue;
    const srcId = `community_${srcComm}`;
    const tgtId = `community_${tgtComm}`;
    const pairKey = srcId < tgtId ? `${srcId}|${tgtId}` : `${tgtId}|${srcId}`;
    if (seenPairs.has(pairKey)) continue;
    seenPairs.add(pairKey);
    edges.push({ source: srcId, target: tgtId, relation: 'inter-community' });
  }

  return { nodes, edges, nodeMap };
}

// ─── Entry point ──────────────────────────────────────────────────────────────
export function buildDisplayGraph(
  data: GraphifyData,
  queryResult: GraphQueryResult | null | undefined,
  forceFullDetail = false,
): DisplayGraph {
  // Query mode: build from query nodes/edges only, seed nodes highlighted.
  if (queryResult) {
    const nodeMap = new Map<string, GraphifyNode>();
    const seedSet = new Set(queryResult.seed_nodes);
    const nodes: DisplayNode[] = [];
    const seen = new Set<string>();

    for (const n of queryResult.nodes ?? []) {
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      const isSeed = seedSet.has(n.id);
      const nodeData: GraphifyNode = {
        id: n.id, label: n.label, file_type: n.file_type, community: n.community, source_file: n.source_file,
      };
      nodeMap.set(n.id, nodeData);
      nodes.push({
        id: n.id,
        label: n.label ?? n.id,
        color: isSeed ? '#facc15' : fileTypeColor(n.file_type),
        size: isSeed ? 6 : 3,
        isSeed,
        data: nodeData,
      });
    }

    const edges: DisplayEdge[] = (queryResult.edges ?? [])
      .filter(e => seen.has(e.source) && seen.has(e.target))
      .map(e => ({ source: e.source, target: e.target, relation: e.relation ?? '' }));

    return { nodes, edges, nodeMap, isCommunity: false };
  }

  // Community view: full graph exceeds the readable cap.
  if (shouldShowCommunityView(data, queryResult, forceFullDetail)) {
    const { nodes, edges, nodeMap } = buildCommunityDisplayGraph(data);
    return { nodes, edges, nodeMap, isCommunity: true };
  }

  // Full graph mode.
  const nodeMap = new Map<string, GraphifyNode>();
  const nodes: DisplayNode[] = [];
  const seen = new Set<string>();
  for (const n of data.nodes ?? []) {
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    nodeMap.set(n.id, n);
    nodes.push({ id: n.id, label: n.label ?? n.id, color: fileTypeColor(n.file_type), size: 3, isSeed: false, data: n });
  }

  const edges: DisplayEdge[] = (data.links ?? data.edges ?? [])
    .filter(e => seen.has(e.source) && seen.has(e.target))
    .map(e => ({ source: e.source, target: e.target, relation: e.relation ?? '' }));

  return { nodes, edges, nodeMap, isCommunity: false };
}
