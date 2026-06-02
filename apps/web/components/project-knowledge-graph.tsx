'use client';

// Note: this component must be imported with next/dynamic + ssr:false

import { useEffect, useRef, useState, useCallback } from 'react';
import Graph from 'graphology';
import Sigma from 'sigma';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import { useTheme } from 'next-themes';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

// ─── Types ────────────────────────────────────────────────────────────────────

interface GraphifyNode {
  id: string;
  label?: string;
  file_type?: string;
  community?: number;
  source_file?: string;
  source_location?: string;
  [key: string]: unknown;
}

interface GraphifyEdge {
  source: string;
  target: string;
  relation?: string;
  weight?: number;
  [key: string]: unknown;
}

interface GraphifyData {
  nodes: GraphifyNode[];
  links?: GraphifyEdge[];
  edges?: GraphifyEdge[];
  [key: string]: unknown;
}

interface SelectedNodeDetail {
  node: GraphifyNode;
  outgoing: Array<{ target: string; targetLabel: string; relation: string }>;
  incoming: Array<{ source: string; sourceLabel: string; relation: string }>;
}

interface GraphQueryResult {
  query: string;
  seed_nodes: string[];
  nodes: Array<{ id: string; label: string; file_type?: string; community?: number; source_file?: string }>;
  edges: Array<{ source: string; target: string; relation: string }>;
  truncated: boolean;
}

interface Props {
  graphData: GraphifyData;
  queryResult?: GraphQueryResult | null;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_NODES_FULL = 2000;

const FILE_TYPE_PALETTE: Record<string, string> = {
  code:      '#6366f1',
  document:  '#22c55e',
  paper:     '#f97316',
  image:     '#ec4899',
  rationale: '#8b5cf6',
  concept:   '#06b6d4',
};

function fileTypeColor(fileType: string | undefined): string {
  if (fileType && FILE_TYPE_PALETTE[fileType]) return FILE_TYPE_PALETTE[fileType];
  if (!fileType) return '#94a3b8';
  let h = 0;
  for (let i = 0; i < fileType.length; i++) h = fileType.charCodeAt(i) + ((h << 5) - h);
  const colors = Object.values(FILE_TYPE_PALETTE);
  return colors[Math.abs(h) % colors.length];
}

function shouldShowCommunityView(data: GraphifyData, queryResult: GraphQueryResult | null | undefined): boolean {
  return (data.nodes?.length ?? 0) > MAX_NODES_FULL && !queryResult;
}

// ─── Community aggregation ────────────────────────────────────────────────────

function buildCommunityGraph(data: GraphifyData): { graph: Graph; nodeMap: Map<string, GraphifyNode> } {
  const communityGroups = new Map<number, GraphifyNode[]>();

  for (const n of data.nodes ?? []) {
    const cid = n.community ?? 0;
    if (!communityGroups.has(cid)) communityGroups.set(cid, []);
    communityGroups.get(cid)!.push(n);
  }

  const graph = new Graph({ multi: false, type: 'undirected' });
  const nodeMap = new Map<string, GraphifyNode>();

  for (const [cid, members] of communityGroups) {
    const count = members.length;
    const superNodeId = `community_${cid}`;
    // Stable seed position based on community id
    const x = (cid * 37) % 200 - 100;
    const y = (cid * 53) % 200 - 100;
    const size = 8 + Math.min(count * 0.5, 30);

    // Hash-based color for community
    let h = cid * 2654435761;
    const colors = Object.values(FILE_TYPE_PALETTE);
    const color = colors[Math.abs(h) % colors.length];

    const syntheticNode: GraphifyNode = {
      id: superNodeId,
      label: `Community ${cid} (${count} nodes)`,
      file_type: undefined,
      community: cid,
    };

    nodeMap.set(superNodeId, syntheticNode);
    graph.addNode(superNodeId, {
      label: `Community ${cid} (${count} nodes)`,
      x,
      y,
      size,
      color,
      community: cid,
    });
  }

  // Add edges between communities based on cross-community links
  const edgeList = data.links ?? data.edges ?? [];
  // Build node → community map
  const nodeToComm = new Map<string, number>();
  for (const n of data.nodes ?? []) {
    nodeToComm.set(n.id, n.community ?? 0);
  }

  for (const e of edgeList) {
    const srcComm = nodeToComm.get(e.source);
    const tgtComm = nodeToComm.get(e.target);
    if (srcComm === undefined || tgtComm === undefined) continue;
    if (srcComm === tgtComm) continue;
    const srcId = `community_${srcComm}`;
    const tgtId = `community_${tgtComm}`;
    if (!graph.hasEdge(srcId, tgtId)) {
      try {
        graph.addEdge(srcId, tgtId, { relation: 'inter-community', weight: 1 });
      } catch { /* ignore */ }
    }
  }

  return { graph, nodeMap };
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ProjectKnowledgeGraph({ graphData, queryResult }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<SelectedNodeDetail | null>(null);
  const [stats, setStats] = useState({ nodes: 0, edges: 0 });
  const [isCommunityView, setIsCommunityView] = useState(false);
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  const labelColor = isDark ? '#94a3b8' : '#475569';

  const buildGraph = useCallback(() => {
    // Query result mode: build from query nodes/edges only
    if (queryResult) {
      const g = new Graph({ multi: false, type: 'undirected' });
      const nodeMap = new Map<string, GraphifyNode>();
      const seedSet = new Set(queryResult.seed_nodes);

      for (const n of queryResult.nodes ?? []) {
        if (g.hasNode(n.id)) continue;
        const isSeed = seedSet.has(n.id);
        const nodeData: GraphifyNode = {
          id: n.id,
          label: n.label,
          file_type: n.file_type,
          community: n.community,
          source_file: n.source_file,
        };
        nodeMap.set(n.id, nodeData);
        g.addNode(n.id, {
          label: n.label ?? n.id,
          x: Math.random() * 200 - 100,
          y: Math.random() * 200 - 100,
          size: isSeed ? 12 : 6,
          color: isSeed ? '#facc15' : fileTypeColor(n.file_type),
          file_type: n.file_type,
          community: n.community,
          source_file: n.source_file,
        });
      }

      const edgeList = queryResult.edges ?? [];
      for (const e of edgeList) {
        if (g.hasNode(e.source) && g.hasNode(e.target)) {
          try {
            g.addEdge(e.source, e.target, { relation: e.relation ?? '', weight: 1 });
          } catch { /* ignore duplicate edges */ }
        }
      }

      return { graph: g, nodeMap, edgeList: edgeList as GraphifyEdge[], isCommunity: false };
    }

    // Community view: if full graph exceeds cap
    if (shouldShowCommunityView(graphData, queryResult)) {
      const { graph: g, nodeMap } = buildCommunityGraph(graphData);
      const edgeList: GraphifyEdge[] = [];
      g.edges().forEach(edgeId => {
        const { source, target } = g.extremities(edgeId) as unknown as { source: string; target: string };
        edgeList.push({ source, target, relation: 'inter-community' });
      });
      return { graph: g, nodeMap, edgeList, isCommunity: true };
    }

    // Full graph mode
    const g = new Graph({ multi: false, type: 'undirected' });
    const nodeMap = new Map<string, GraphifyNode>();

    for (const n of graphData.nodes ?? []) {
      if (g.hasNode(n.id)) continue;
      nodeMap.set(n.id, n);
      g.addNode(n.id, {
        label: n.label ?? n.id,
        x: Math.random() * 200 - 100,
        y: Math.random() * 200 - 100,
        size: 6,
        color: fileTypeColor(n.file_type),
        file_type: n.file_type,
        community: n.community,
        source_file: n.source_file,
      });
    }

    const edgeList = graphData.links ?? graphData.edges ?? [];
    for (const e of edgeList) {
      if (g.hasNode(e.source) && g.hasNode(e.target)) {
        try {
          g.addEdge(e.source, e.target, { relation: e.relation ?? '', weight: e.weight ?? 1 });
        } catch { /* ignore duplicate edges */ }
      }
    }

    return { graph: g, nodeMap, edgeList, isCommunity: false };
  }, [graphData, queryResult]);

  useEffect(() => {
    const result = buildGraph();
    if (!result || !containerRef.current) return;
    const { graph, nodeMap, edgeList, isCommunity } = result;

    setStats({ nodes: graph.order, edges: graph.size });
    setIsCommunityView(isCommunity);

    let renderer: Sigma | null = null;
    let ro: ResizeObserver | null = null;
    let rafId: number;

    function initRenderer(container: HTMLDivElement) {
      if (renderer) return;

      if (graph.order > 1) {
        forceAtlas2.assign(graph, {
          iterations: 200,
          settings: { ...forceAtlas2.inferSettings(graph), gravity: 0.5 },
        });
      }

      renderer = new Sigma(graph, container, {
        renderEdgeLabels: false,
        allowInvalidContainer: true,
        labelColor: { color: labelColor },
        defaultEdgeType: 'arrow',
      });

      renderer.on('clickNode', ({ node }) => {
        const nodeData = nodeMap.get(node);
        if (!nodeData) return;

        const outgoing: SelectedNodeDetail['outgoing'] = [];
        const incoming: SelectedNodeDetail['incoming'] = [];

        for (const e of edgeList) {
          if (e.source === node) {
            const targetData = nodeMap.get(e.target);
            outgoing.push({
              target: e.target,
              targetLabel: targetData?.label ?? e.target,
              relation: e.relation ?? '',
            });
          } else if (e.target === node) {
            const sourceData = nodeMap.get(e.source);
            incoming.push({
              source: e.source,
              sourceLabel: sourceData?.label ?? e.source,
              relation: e.relation ?? '',
            });
          }
        }

        setSelected({ node: nodeData, outgoing, incoming });
      });

      renderer.on('clickStage', () => setSelected(null));

      ro?.disconnect();
      ro = null;
    }

    const container = containerRef.current;

    rafId = requestAnimationFrame(() => {
      if (!container) return;
      if (container.clientWidth > 0 && container.clientHeight > 0) {
        initRenderer(container);
      } else {
        ro = new ResizeObserver(() => {
          if (container.clientWidth > 0 && container.clientHeight > 0) {
            initRenderer(container);
          }
        });
        ro.observe(container);
      }
    });

    return () => {
      cancelAnimationFrame(rafId);
      ro?.disconnect();
      renderer?.kill();
    };
  }, [buildGraph, labelColor]);

  const totalNodeCount = graphData.nodes?.length ?? 0;

  return (
    <div className="relative w-full h-full">
      {/* Sigma container — full size */}
      <div ref={containerRef} className="w-full h-full" />

      {/* Community view notice */}
      {isCommunityView && (
        <div className="absolute top-14 left-1/2 -translate-x-1/2 bg-yellow-500/10 border border-yellow-500/30 rounded px-3 py-1.5 text-xs text-yellow-600 dark:text-yellow-400 text-center max-w-sm">
          Showing community view — graph has {totalNodeCount.toLocaleString()} nodes (limit {MAX_NODES_FULL.toLocaleString()}). Select a query to explore a subgraph.
        </div>
      )}

      {/* Stats overlay (bottom-left) */}
      <div className="absolute bottom-4 left-4 bg-background/80 backdrop-blur rounded p-2 text-xs text-muted-foreground">
        {stats.nodes.toLocaleString()} nodes · {stats.edges.toLocaleString()} edges
        {queryResult && (
          <span className="ml-2 text-primary">— query: "{queryResult.query}"</span>
        )}
        {queryResult?.truncated && (
          <span className="ml-1 text-yellow-500">(truncated)</span>
        )}
      </div>

      {/* File type legend (top-left) */}
      <div className="absolute top-4 left-4 bg-background/80 backdrop-blur rounded p-2 text-xs space-y-1">
        {Object.entries(FILE_TYPE_PALETTE).map(([type, color]) => (
          <div key={type} className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full inline-block" style={{ backgroundColor: color }} />
            <span className="text-muted-foreground capitalize">{type}</span>
          </div>
        ))}
        {queryResult && queryResult.seed_nodes.length > 0 && (
          <div className="flex items-center gap-1.5 border-t pt-1 mt-1">
            <span className="w-2 h-2 rounded-full inline-block" style={{ backgroundColor: '#facc15' }} />
            <span className="text-muted-foreground capitalize">seed node</span>
          </div>
        )}
      </div>

      {/* Selected node detail panel (right side) */}
      {selected && (
        <div className="absolute top-4 right-4 w-72 bg-background/95 backdrop-blur border rounded-lg p-4 text-sm max-h-[80vh] overflow-y-auto">
          <div className="flex items-center justify-between mb-2">
            <span className="font-semibold truncate">{selected.node.label ?? selected.node.id}</span>
            <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>✕</Button>
          </div>
          {selected.node.file_type && (
            <Badge variant="outline" className="mb-2 capitalize">{selected.node.file_type}</Badge>
          )}
          {selected.node.source_file && (
            <p className="text-xs text-muted-foreground font-mono mb-3 truncate">{selected.node.source_file}</p>
          )}
          {selected.outgoing.length > 0 && (
            <div className="mb-3">
              <p className="text-xs font-medium text-muted-foreground mb-1">Outgoing ({selected.outgoing.length})</p>
              <ul className="space-y-1">
                {selected.outgoing.slice(0, 10).map((e, i) => (
                  <li key={i} className="text-xs">
                    <span className="text-muted-foreground">{e.relation || '→'}</span>{' '}
                    <span className="font-medium truncate">{e.targetLabel}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {selected.incoming.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1">Incoming ({selected.incoming.length})</p>
              <ul className="space-y-1">
                {selected.incoming.slice(0, 10).map((e, i) => (
                  <li key={i} className="text-xs">
                    <span className="font-medium truncate">{e.sourceLabel}</span>{' '}
                    <span className="text-muted-foreground">{e.relation || '→'}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {selected.outgoing.length === 0 && selected.incoming.length === 0 && (
            <p className="text-xs text-muted-foreground">No connections recorded for this node.</p>
          )}
        </div>
      )}
    </div>
  );
}
