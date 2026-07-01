'use client';

import { useMemo, useState } from 'react';
import { useTheme } from 'next-themes';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ForceGraph3D, type ForceGraphNode, type ForceGraphEdge } from './force-graph-3d';
import type { MemoryNode, MemoryEdge } from './memory-graph-types';
import { importanceColor, fmtTs } from './memory-graph-types';

interface SelectedNode {
  memory: MemoryNode;
  degree: number;
}

interface Props {
  memories: MemoryNode[];
  edges: MemoryEdge[];
}

const LINKED_COLOR = '#6366f1';

export function MemoryGraph3D({ memories, edges }: Props) {
  const [selected, setSelected] = useState<SelectedNode | null>(null);
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  const relatedColor = isDark ? '#475569' : '#cbd5e1';
  const bgColor = isDark ? '#0a0a0a' : '#ffffff';

  const { graphNodes, graphEdges, memoryById, degreeById } = useMemo(() => {
    const memoryById = new Map(memories.map((m) => [m.id, m]));
    const degreeById = new Map<string, number>();
    const graphEdges: ForceGraphEdge[] = [];
    for (const e of edges) {
      if (!memoryById.has(e.from_id) || !memoryById.has(e.to_id)) continue;
      degreeById.set(e.from_id, (degreeById.get(e.from_id) || 0) + 1);
      degreeById.set(e.to_id, (degreeById.get(e.to_id) || 0) + 1);
      graphEdges.push({
        source: e.from_id,
        target: e.to_id,
        color: e.rel_type === 'LINKED_TO' ? LINKED_COLOR : relatedColor,
      });
    }
    const graphNodes: ForceGraphNode[] = memories.map((m) => {
      const degree = degreeById.get(m.id) || 0;
      return { id: m.id, color: importanceColor(m.importance_score), size: 1 + Math.min(degree * 0.4, 6) };
    });
    return { graphNodes, graphEdges, memoryById, degreeById };
  }, [memories, edges, relatedColor]);

  return (
    <div className="relative">
      <div className="w-full border-t" style={{ height: '100vh', background: bgColor }}>
        <ForceGraph3D
          nodes={graphNodes}
          edges={graphEdges}
          isDark={isDark}
          bgColor={bgColor}
          onNodeClick={(id) => {
            const memory = memoryById.get(id);
            if (!memory) return;
            setSelected({ memory, degree: degreeById.get(id) || 0 });
          }}
          onBackgroundClick={() => setSelected(null)}
        />
      </div>

      {memories.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground pointer-events-none">
          No memory graph data yet. Save memories with shared tags to connect them.
        </div>
      )}

      <div className="absolute bottom-3 left-3 flex flex-wrap items-center gap-3 rounded-md bg-background/80 px-3 py-1.5 text-xs text-muted-foreground backdrop-blur">
        <span>
          {memories.length} memories · {graphEdges.length} connections shown
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-1 w-5 rounded" style={{ background: LINKED_COLOR }} />
          linked
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-5 rounded" style={{ background: relatedColor }} />
          related (shared tag)
        </span>
        <span className="opacity-60">drag to rotate · scroll to zoom · click a memory for details</span>
      </div>

      {selected && (
        <div className="absolute top-14 right-3 w-72 z-10">
          <Card className="bg-background/90 backdrop-blur border shadow-lg max-h-[calc(100vh-5rem)] overflow-y-auto scrollbar-thin">
            <CardHeader className="pb-2 pt-4">
              <CardTitle className="text-sm font-semibold leading-snug">
                {selected.memory.summary || '(no summary)'}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 pb-4 text-xs">
              <div className="flex flex-wrap gap-1">
                {selected.memory.tags.map((t) => (
                  <span key={t} className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
                    {t}
                  </span>
                ))}
              </div>
              <p className="text-muted-foreground">Importance: {selected.memory.importance_score.toFixed(1)}</p>
              <p className="text-muted-foreground">Created: {fmtTs(selected.memory.created_at)}</p>
              <p className="text-muted-foreground">
                {selected.degree} connection{selected.degree === 1 ? '' : 's'}
              </p>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
