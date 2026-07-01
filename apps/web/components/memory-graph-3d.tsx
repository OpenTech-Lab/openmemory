'use client';

import { useEffect, useRef, useState } from 'react';
import ForceGraph3D, { ForceGraph3DInstance } from '3d-force-graph';
import { Vector2 } from 'three';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { useTheme } from 'next-themes';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { MemoryNode, MemoryEdge } from './memory-graph-types';
import { importanceColor, fmtTs, truncate } from './memory-graph-types';

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
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ForceGraph3DInstance | null>(null);
  const [selected, setSelected] = useState<SelectedNode | null>(null);
  const [linkCount, setLinkCount] = useState(0);
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  const relatedColor = isDark ? '#475569' : '#cbd5e1';

  useEffect(() => {
    if (!containerRef.current) return;

    const memoryById = new Map(memories.map((m) => [m.id, m]));
    const degree = new Map<string, number>();
    const links = edges
      .filter((e) => memoryById.has(e.from_id) && memoryById.has(e.to_id))
      .map((e) => {
        degree.set(e.from_id, (degree.get(e.from_id) || 0) + 1);
        degree.set(e.to_id, (degree.get(e.to_id) || 0) + 1);
        return {
          source: e.from_id,
          target: e.to_id,
          isLinked: e.rel_type === 'LINKED_TO',
        };
      });

    const nodes = memories.map((m) => ({
      id: m.id,
      label: truncate(m.summary || '(no summary)', 40),
      val: 3 + Math.min((degree.get(m.id) || 0) * 1.2, 15),
      color: importanceColor(m.importance_score),
    }));

    setLinkCount(links.length);

    const graph = new ForceGraph3D(containerRef.current)
      .backgroundColor(isDark ? '#0a0a0a' : '#ffffff')
      .nodeLabel('label')
      .nodeColor('color')
      .nodeVal('val')
      .linkColor((l: any) => (l.isLinked ? LINKED_COLOR : relatedColor))
      .linkWidth((l: any) => (l.isLinked ? 2 : 0.5))
      .linkOpacity(0.6)
      .graphData({ nodes, links })
      .onNodeClick((node: any) => {
        const memory = memoryById.get(node.id);
        if (!memory) return;
        setSelected({ memory, degree: degree.get(node.id) || 0 });
      })
      .onBackgroundClick(() => setSelected(null));

    graphRef.current = graph;

    // Bloom only makes sense against the dark background — the light theme's
    // near-white background already sits above any sane luminance threshold,
    // so adding the pass there blooms the whole frame to solid white.
    let bloomPass: UnrealBloomPass | null = null;
    if (isDark) {
      bloomPass = new UnrealBloomPass(
        new Vector2(containerRef.current.clientWidth, containerRef.current.clientHeight),
        1.1,
        0.5,
        0.15
      );
      graph.postProcessingComposer().addPass(bloomPass);
    }

    const resize = () => {
      if (!containerRef.current) return;
      graph.width(containerRef.current.clientWidth);
      graph.height(containerRef.current.clientHeight);
      bloomPass?.resolution.set(containerRef.current.clientWidth, containerRef.current.clientHeight);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      graph._destructor?.();
      graphRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memories, edges, isDark, relatedColor]);

  return (
    <div className="relative">
      <div
        ref={containerRef}
        className="w-full border-t"
        style={{ height: '100vh' }}
      />

      {memories.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground pointer-events-none">
          No memory graph data yet. Save memories with shared tags to connect them.
        </div>
      )}

      <div className="absolute bottom-3 left-3 flex flex-wrap items-center gap-3 rounded-md bg-background/80 px-3 py-1.5 text-xs text-muted-foreground backdrop-blur">
        <span>{memories.length} memories · {linkCount} connections shown</span>
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
                  <span key={t} className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">{t}</span>
                ))}
              </div>
              <p className="text-muted-foreground">Importance: {selected.memory.importance_score.toFixed(1)}</p>
              <p className="text-muted-foreground">Created: {fmtTs(selected.memory.created_at)}</p>
              <p className="text-muted-foreground">{selected.degree} connection{selected.degree === 1 ? '' : 's'}</p>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
