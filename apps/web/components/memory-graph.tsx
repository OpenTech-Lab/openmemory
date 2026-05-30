'use client';

import { useEffect, useRef, useState } from 'react';
import Graph from 'graphology';
import Sigma from 'sigma';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { type Memory } from '@/components/memory-columns';

export interface GraphEdge {
  from_id: string;
  to_id: string;
  rel_type: string;
  relationship?: string;
}

const PALETTE = [
  '#6366f1', '#8b5cf6', '#ec4899', '#f97316',
  '#22c55e', '#06b6d4', '#f59e0b', '#ef4444',
];

function tagColor(tag: string): string {
  let h = 0;
  for (let i = 0; i < tag.length; i++) h = tag.charCodeAt(i) + ((h << 5) - h);
  return PALETTE[Math.abs(h) % PALETTE.length];
}

interface Props {
  memories: Memory[];
  edges: GraphEdge[];
}

export function MemoryGraph({ memories, edges }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<Memory | null>(null);
  const [stats, setStats] = useState({ nodes: 0, edges: 0 });

  useEffect(() => {
    if (!containerRef.current || memories.length === 0) return;
    const container = containerRef.current;

    const graph = new Graph({ multi: false, type: 'directed' });

    for (const m of memories) {
      const color = m.tags.length > 0 ? tagColor(m.tags[0]) : '#64748b';
      const label =
        m.summary?.slice(0, 32) ??
        (m.content ? m.content.slice(0, 32) : m.id.slice(0, 8));
      graph.addNode(m.id, {
        label,
        x: Math.random() * 200 - 100,
        y: Math.random() * 200 - 100,
        size: 4 + m.importance_score * 14,
        color,
      });
    }

    // Deduplicate RELATED_TO bidirectional pairs; keep all LINKED_TO
    const seen = new Set<string>();
    for (const e of edges) {
      if (!graph.hasNode(e.from_id) || !graph.hasNode(e.to_id)) continue;
      const key =
        e.rel_type === 'RELATED_TO'
          ? [e.from_id, e.to_id].sort().join('|')
          : `${e.from_id}|${e.to_id}|${e.rel_type}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        graph.addEdge(e.from_id, e.to_id, {
          color: e.rel_type === 'LINKED_TO' ? '#6366f1' : '#334155',
          size: e.rel_type === 'LINKED_TO' ? 2.5 : 1,
        });
      } catch (_) {
        // parallel edge — skip
      }
    }

    setStats({ nodes: graph.order, edges: graph.size });

    if (graph.order > 1) {
      forceAtlas2.assign(graph, { iterations: 150, settings: forceAtlas2.inferSettings(graph) });
    }

    const renderer = new Sigma(graph, container, {
      renderEdgeLabels: false,
      allowInvalidContainer: true,
    });

    renderer.on('enterNode', ({ node }) => {
      graph.setNodeAttribute(node, 'highlighted', true);
      renderer.refresh();
    });
    renderer.on('leaveNode', ({ node }) => {
      graph.setNodeAttribute(node, 'highlighted', false);
      renderer.refresh();
    });
    renderer.on('clickNode', ({ node }) => {
      setSelected(memories.find((m) => m.id === node) ?? null);
    });
    renderer.on('clickStage', () => setSelected(null));

    return () => {
      renderer.kill();
    };
  }, [memories, edges]);

  return (
    <div className="flex gap-4">
      <div className="relative flex-1">
        <div
          ref={containerRef}
          className="w-full rounded-lg border bg-slate-950"
          style={{ height: 580 }}
        />

        {memories.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
            No memories to display. Add some memories first.
          </div>
        )}

        {/* legend + stats */}
        <div className="absolute bottom-3 left-3 flex items-center gap-4 rounded-md bg-slate-900/80 px-3 py-1.5 text-xs text-slate-400 backdrop-blur">
          <span>{stats.nodes} nodes · {stats.edges} edges</span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-5 rounded" style={{ background: '#334155' }} />
            shared tag
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-1 w-5 rounded" style={{ background: '#6366f1' }} />
            explicit link
          </span>
          <span className="text-slate-500">click node for details</span>
        </div>
      </div>

      {selected && (
        <Card className="w-72 shrink-0 self-start sticky top-4">
          <CardHeader className="pb-2 pt-4">
            <CardTitle className="line-clamp-2 text-sm font-semibold leading-snug">
              {selected.summary ?? selected.id.slice(0, 16) + '…'}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 pb-4 text-sm">
            {selected.content && (
              <p className="line-clamp-5 text-muted-foreground">{selected.content}</p>
            )}

            <div className="flex flex-wrap gap-1">
              {selected.tags.length > 0 ? (
                selected.tags.map((t) => (
                  <Badge key={t} variant="secondary" className="text-xs">
                    {t}
                  </Badge>
                ))
              ) : (
                <span className="text-muted-foreground">No tags</span>
              )}
            </div>

            <div className="flex items-center gap-2">
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${selected.importance_score * 100}%` }}
                />
              </div>
              <span className="shrink-0 text-xs text-muted-foreground">
                {selected.importance_score.toFixed(2)}
              </span>
            </div>

            <p className="truncate font-mono text-xs text-muted-foreground/60">
              {selected.id}
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
