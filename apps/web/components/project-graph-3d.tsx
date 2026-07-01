'use client';

// Note: this component must be imported with next/dynamic + ssr:false

import { useMemo, useState } from 'react';
import { useTheme } from 'next-themes';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ForceGraph3D, type ForceGraphNode, type ForceGraphEdge } from './force-graph-3d';
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

export function ProjectGraph3D({ graphData, queryResult, forceFullDetail = false }: Props) {
  const [selected, setSelected] = useState<SelectedNodeDetail | null>(null);
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  const bgColor = isDark ? '#0a0a0a' : '#ffffff';
  const edgeColor = isDark ? '#475569' : '#cbd5e1';

  const display = useMemo(
    () => buildDisplayGraph(graphData, queryResult, forceFullDetail),
    [graphData, queryResult, forceFullDetail]
  );

  const graphNodes = useMemo<ForceGraphNode[]>(
    () => display.nodes.map((n) => ({ id: n.id, color: n.color, size: n.size })),
    [display]
  );
  const graphEdges = useMemo<ForceGraphEdge[]>(
    () => display.edges.map((e) => ({ source: e.source, target: e.target, color: edgeColor })),
    [display, edgeColor]
  );

  const handleNodeClick = (id: string) => {
    const nodeData = display.nodeMap.get(id);
    if (!nodeData) return;

    const outgoing: SelectedNodeDetail['outgoing'] = [];
    const incoming: SelectedNodeDetail['incoming'] = [];
    for (const e of display.edges) {
      if (e.source === id) {
        const targetData = display.nodeMap.get(e.target);
        outgoing.push({ target: e.target, targetLabel: targetData?.label ?? e.target, relation: e.relation ?? '' });
      } else if (e.target === id) {
        const sourceData = display.nodeMap.get(e.source);
        incoming.push({ source: e.source, sourceLabel: sourceData?.label ?? e.source, relation: e.relation ?? '' });
      }
    }
    setSelected({ node: nodeData, outgoing, incoming });
  };

  const isCommunityViewActive = shouldShowCommunityView(graphData, queryResult, forceFullDetail);

  return (
    <div className="relative w-full h-full">
      <div className="w-full h-full" style={{ background: bgColor }}>
        <ForceGraph3D
          nodes={graphNodes}
          edges={graphEdges}
          isDark={isDark}
          bgColor={bgColor}
          onNodeClick={handleNodeClick}
          onBackgroundClick={() => setSelected(null)}
        />
      </div>

      {/* Stats overlay (bottom-left) */}
      <div className="absolute bottom-4 left-4 bg-background/80 backdrop-blur rounded p-2 text-xs text-muted-foreground">
        {display.nodes.length.toLocaleString()} nodes · {display.edges.length.toLocaleString()} edges
        {isCommunityViewActive && <span className="ml-2">(community view)</span>}
        {queryResult && <span className="ml-2 text-primary">— query: &quot;{queryResult.query}&quot;</span>}
        {queryResult?.truncated && <span className="ml-1 text-yellow-500">(truncated)</span>}
        <span className="ml-2 opacity-60">drag to rotate · scroll to zoom · click for details</span>
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
            <p className="text-xs text-muted-foreground font-mono mb-3 truncate">{selected.node.source_file}</p>
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
                      <span className="text-muted-foreground truncate font-mono text-[10px]">{m.source_file}</span>
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
