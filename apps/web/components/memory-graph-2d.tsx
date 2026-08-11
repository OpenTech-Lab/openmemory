'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import Graph from 'graphology';
import Sigma from 'sigma';
import forceAtlas2 from 'graphology-layout-forceatlas2';
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

export function MemoryGraph2D({ memories, edges }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<SelectedNode | null>(null);
  const [stats, setStats] = useState({ nodes: 0, edges: 0 });
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  const labelColor = isDark ? '#94a3b8' : '#475569';
  const relatedColor = isDark ? '#475569' : '#cbd5e1';
  const linkedColor = '#6366f1';

  const buildGraph = useCallback(() => {
    if (memories.length === 0) return null;

    const graph = new Graph({ multi: true, type: 'undirected' });
    const memoryById = new Map<string, MemoryNode>();

    for (const m of memories) {
      memoryById.set(m.id, m);
      graph.addNode(m.id, {
        label: truncate(m.summary || '(no summary)', 40),
        x: Math.random() * 200 - 100,
        y: Math.random() * 200 - 100,
        size: 6,
        color: importanceColor(m.importance_score),
      });
    }

    for (const e of edges) {
      if (!graph.hasNode(e.from_id) || !graph.hasNode(e.to_id)) continue;
      if (graph.hasEdge(e.from_id, e.to_id)) continue;
      const isLinked = e.rel_type === 'LINKED_TO';
      graph.addEdge(e.from_id, e.to_id, {
        label: e.relationship || e.rel_type,
        color: isLinked ? linkedColor : relatedColor,
        size: isLinked ? 2.5 : 1,
      });
    }

    graph.nodes().forEach((node) => {
      const deg = graph.degree(node);
      graph.setNodeAttribute(node, 'size', 5 + Math.min(deg * 1.5, 20));
    });

    setStats({ nodes: graph.order, edges: graph.size });
    return { graph, memoryById };
  }, [memories, edges, relatedColor]);

  useEffect(() => {
    const result = buildGraph();
    if (!result || !containerRef.current) return;
    const { graph, memoryById } = result;

    let renderer: Sigma | null = null;
    let ro: ResizeObserver | null = null;
    let rafId: number;

    function initRenderer(container: HTMLDivElement) {
      if (renderer) return;
      if (graph.order > 1) {
        // ForceAtlas2 in this version runs synchronously on the main thread and
        // scales quadratically. Keep the overview responsive and avoid locking
        // the tab when a user explicitly asks to see the full graph.
        const iterations = graph.order <= 500 ? 40 : graph.order <= 1_500 ? 10 : 0;
        if (iterations > 0) {
          forceAtlas2.assign(graph, {
            iterations,
            settings: { ...forceAtlas2.inferSettings(graph), gravity: 0.5 },
          });
        }
      }

      // Labels only for the hovered/selected node — with thousands of nodes,
      // always-on labels overlap into an unreadable mess.
      let hoveredNode: string | null = null;
      renderer = new Sigma(graph, container, {
        renderEdgeLabels: false,
        allowInvalidContainer: true,
        labelColor: { color: labelColor },
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
        const memory = memoryById.get(node);
        if (!memory) return;
        setSelected({ memory, degree: graph.degree(node) });
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

  return (
    <div className="relative">
      <div
        ref={containerRef}
        className="w-full border-t"
        style={{ height: '100vh', background: 'var(--background)', transition: 'background 0.2s' }}
      />

      {memories.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground pointer-events-none">
          No memory graph data yet. Save memories with shared tags to connect them.
        </div>
      )}

      <div className="absolute bottom-3 left-3 flex flex-wrap items-center gap-3 rounded-md bg-background/80 px-3 py-1.5 text-xs text-muted-foreground backdrop-blur">
        <span>{stats.nodes} memories · {stats.edges} connections shown</span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-1 w-5 rounded" style={{ background: linkedColor }} />
          linked
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-5 rounded" style={{ background: relatedColor }} />
          related (shared tag)
        </span>
        <span className="opacity-60">click a memory for details</span>
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
