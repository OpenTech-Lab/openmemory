'use client';

// Note: this component must be imported with next/dynamic + ssr:false

import { useEffect, useRef, useState, useCallback } from 'react';
import Graph from 'graphology';
import Sigma from 'sigma';
import { createNodeBorderProgram } from '@sigma/node-border';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import { useTheme } from 'next-themes';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  type GraphifyData,
  type GraphifyNode,
  type GraphQueryResult,
  type SelectedNodeDetail,
  FILE_TYPE_PALETTE,
  fileTypeColor,
  shouldShowCommunityView,
  buildDisplayGraph,
} from './project-graph-types';

interface Props {
  graphData: GraphifyData;
  queryResult?: GraphQueryResult | null;
  forceFullDetail?: boolean;
}

export function ProjectGraph2D({ graphData, queryResult, forceFullDetail = false }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<SelectedNodeDetail | null>(null);
  const [stats, setStats] = useState({ nodes: 0, edges: 0 });
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  const labelColor = isDark ? '#94a3b8' : '#475569';
  const borderColor = isDark ? '#ffffff' : '#000000';

  const buildGraph = useCallback(() => {
    const display = buildDisplayGraph(graphData, queryResult, forceFullDetail);
    const g = new Graph({ multi: false, type: 'undirected' });

    for (const n of display.nodes) {
      if (g.hasNode(n.id)) continue;
      g.addNode(n.id, {
        label: n.label,
        x: Math.random() * 200 - 100,
        y: Math.random() * 200 - 100,
        size: n.size,
        color: n.color,
        borderColor,
      });
    }
    for (const e of display.edges) {
      if (!g.hasNode(e.source) || !g.hasNode(e.target)) continue;
      try {
        g.addEdge(e.source, e.target, { relation: e.relation });
      } catch { /* ignore duplicate edges */ }
    }

    return { graph: g, nodeMap: display.nodeMap, edgeList: display.edges, isCommunity: display.isCommunity };
  }, [graphData, queryResult, forceFullDetail, borderColor]);

  useEffect(() => {
    const result = buildGraph();
    if (!result || !containerRef.current) return;
    const { graph, nodeMap, edgeList } = result;

    setStats({ nodes: graph.order, edges: graph.size });

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

      const NodeBorderProgram = createNodeBorderProgram({
        borders: [
          { size: { value: 0.04, mode: 'relative' }, color: { attribute: 'borderColor' } },
          { size: { fill: true }, color: { attribute: 'color' } },
        ],
      });

      // Labels only for the hovered node — with large graphs, always-on labels
      // overlap into an unreadable mess.
      let hoveredNode: string | null = null;
      renderer = new Sigma(graph, container, {
        renderEdgeLabels: false,
        allowInvalidContainer: true,
        labelColor: { color: labelColor },
        defaultEdgeType: 'arrow',
        defaultNodeType: 'border',
        nodeProgramClasses: { border: NodeBorderProgram },
        nodeReducer: (node, data) =>
          node === hoveredNode ? data : { ...data, label: null },
      });
      renderer.on('enterNode', ({ node }) => {
        hoveredNode = node;
        renderer?.refresh({ skipIndexation: true });
      });
      renderer.on('leaveNode', () => {
        hoveredNode = null;
        renderer?.refresh({ skipIndexation: true });
      });

      renderer.on('clickNode', ({ node }) => {
        const nodeData = nodeMap.get(node);
        if (!nodeData) return;

        const outgoing: SelectedNodeDetail['outgoing'] = [];
        const incoming: SelectedNodeDetail['incoming'] = [];

        for (const e of edgeList) {
          if (e.source === node) {
            const targetData = nodeMap.get(e.target);
            outgoing.push({ target: e.target, targetLabel: targetData?.label ?? e.target, relation: e.relation ?? '' });
          } else if (e.target === node) {
            const sourceData = nodeMap.get(e.source);
            incoming.push({ source: e.source, sourceLabel: sourceData?.label ?? e.source, relation: e.relation ?? '' });
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

  const isCommunityViewActive = shouldShowCommunityView(graphData, queryResult, forceFullDetail);

  return (
    <div className="relative w-full h-full">
      <div ref={containerRef} className="w-full h-full" />

      {/* Stats overlay (bottom-left) */}
      <div className="absolute bottom-4 left-4 bg-background/80 backdrop-blur rounded p-2 text-xs text-muted-foreground">
        {stats.nodes.toLocaleString()} nodes · {stats.edges.toLocaleString()} edges
        {isCommunityViewActive && <span className="ml-2">(community view)</span>}
        {queryResult && <span className="ml-2 text-primary">— query: &quot;{queryResult.query}&quot;</span>}
        {queryResult?.truncated && <span className="ml-1 text-yellow-500">(truncated)</span>}
        <span className="ml-2 opacity-60">hover for label · click for details</span>
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

      {/* Selected node detail panel — floating top-right, offset below the 2D/3D control panel */}
      {selected && (
        <div className="absolute top-14 right-3 w-72 bg-background/95 backdrop-blur border rounded-lg shadow-lg p-4 text-sm max-h-[calc(100vh-5rem)] overflow-y-auto z-10">
          <div className="flex items-center justify-between mb-2">
            <span className="font-semibold truncate">{selected.node.label ?? selected.node.id}</span>
            <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>✕</Button>
          </div>
          {selected.node.file_type && (
            <Badge variant="outline" className="mb-2 capitalize" style={{ borderColor: fileTypeColor(selected.node.file_type) }}>
              {selected.node.file_type}
            </Badge>
          )}
          {selected.node.source_file && (
            <p className="text-xs text-muted-foreground font-mono mb-3 truncate">{selected.node.source_file as string}</p>
          )}
          {selected.node.file_type === 'commit' && (
            <p className="text-xs text-muted-foreground mb-3">
              {selected.node.author as string}
              {selected.node.date ? ` · ${new Date(selected.node.date as string).toLocaleDateString()}` : ''}
            </p>
          )}

          {selected.node._members ? (
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1">
                Top members ({(selected.node._count as number) ?? 0} total)
              </p>
              <ul className="space-y-1">
                {(selected.node._members as GraphifyNode[]).map((m) => (
                  <li key={m.id} className="text-xs flex items-center gap-1.5">
                    {m.file_type && (
                      <span className="w-1.5 h-1.5 rounded-full shrink-0 inline-block" style={{ backgroundColor: fileTypeColor(m.file_type) }} />
                    )}
                    <span className="font-medium truncate">{m.label ?? m.id}</span>
                    {m.source_file && (
                      <span className="text-muted-foreground truncate font-mono text-[10px]">{m.source_file as string}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <>
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
            </>
          )}
        </div>
      )}
    </div>
  );
}
