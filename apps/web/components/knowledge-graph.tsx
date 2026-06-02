'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import Graph from 'graphology';
import Sigma from 'sigma';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import { useTheme } from 'next-themes';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

export interface KnowledgeEntity {
  id: string;
  name: string;
  entity_type: string;
  summary?: string | null;
  group_id: string;
  created_at: string;
}

export interface KnowledgeFact {
  fact_id: string;
  subject_name: string;
  subject_type: string;
  relationship: string;
  fact: string;
  object_name: string;
  object_type: string;
  valid_at: string;
  invalid_at?: string | null;
  is_current: boolean;
}

// Stable color per entity type (deterministic hash)
const TYPE_PALETTE: Record<string, string> = {
  Person:       '#6366f1',
  Organization: '#8b5cf6',
  Role:         '#22c55e',
  Project:      '#f97316',
  Team:         '#06b6d4',
  Location:     '#f59e0b',
  Event:        '#ec4899',
  Concept:      '#ef4444',
};

function typeColor(entityType: string): string {
  if (TYPE_PALETTE[entityType]) return TYPE_PALETTE[entityType];
  let h = 0;
  for (let i = 0; i < entityType.length; i++) h = entityType.charCodeAt(i) + ((h << 5) - h);
  const colors = Object.values(TYPE_PALETTE);
  return colors[Math.abs(h) % colors.length];
}

function fmtTs(ts: string | undefined | null): string {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return ts;
  }
}

interface SelectedNode {
  entity: KnowledgeEntity;
  outgoing: KnowledgeFact[];
  incoming: KnowledgeFact[];
}

interface Props {
  entities: KnowledgeEntity[];
  facts: KnowledgeFact[];
  showHistorical: boolean;
}

export function KnowledgeGraph({ entities, facts, showHistorical }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<SelectedNode | null>(null);
  const [stats, setStats] = useState({ nodes: 0, edges: 0, historical: 0 });
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  const bgColor        = isDark ? '#020817' : '#f8fafc';
  const labelColor     = isDark ? '#94a3b8' : '#475569';
  const currentColor   = '#22c55e';
  const historicalColor = isDark ? '#475569' : '#cbd5e1';

  const buildGraph = useCallback(() => {
    if (!containerRef.current || entities.length === 0) return null;

    const graph = new Graph({ multi: true, type: 'directed' });

    // Build entity name → entity map for fast lookup
    const entityByName = new Map<string, KnowledgeEntity>();
    for (const e of entities) {
      entityByName.set(e.name, e);
      graph.addNode(e.name, {
        label: e.name,
        x: Math.random() * 200 - 100,
        y: Math.random() * 200 - 100,
        size: 8,
        color: typeColor(e.entity_type),
        entity_type: e.entity_type,
      });
    }

    // Add any entity referenced in facts that wasn't in the entity list
    const ensureNode = (name: string, type: string) => {
      if (!graph.hasNode(name)) {
        entityByName.set(name, {
          id: name,
          name,
          entity_type: type,
          group_id: '',
          created_at: '',
        });
        graph.addNode(name, {
          label: name,
          x: Math.random() * 200 - 100,
          y: Math.random() * 200 - 100,
          size: 8,
          color: typeColor(type),
          entity_type: type,
        });
      }
    };

    let historicalCount = 0;
    for (const f of facts) {
      if (!f.is_current) {
        historicalCount++;
        if (!showHistorical) continue;
      }
      ensureNode(f.subject_name, f.subject_type);
      ensureNode(f.object_name, f.object_type);

      graph.addEdge(f.subject_name, f.object_name, {
        label: f.relationship || f.fact_id,
        color: f.is_current ? currentColor : historicalColor,
        size: f.is_current ? 2.5 : 1,
        fact: f,
      });
    }

    // Boost node size by degree (more connections = bigger)
    graph.nodes().forEach(node => {
      const deg = graph.degree(node);
      graph.setNodeAttribute(node, 'size', 6 + Math.min(deg * 1.5, 20));
    });

    setStats({ nodes: graph.order, edges: graph.size, historical: historicalCount });
    return { graph, entityByName };
  }, [entities, facts, showHistorical, currentColor, historicalColor]);

  useEffect(() => {
    const result = buildGraph();
    if (!result || !containerRef.current) return;
    const { graph, entityByName } = result;

    if (graph.order > 1) {
      forceAtlas2.assign(graph, {
        iterations: 200,
        settings: { ...forceAtlas2.inferSettings(graph), gravity: 0.5 },
      });
    }

    const renderer = new Sigma(graph, containerRef.current, {
      renderEdgeLabels: false,
      allowInvalidContainer: true,
      labelColor: { color: labelColor },
      defaultEdgeType: 'arrow',
    });

    renderer.on('clickNode', ({ node }) => {
      const entity = entityByName.get(node);
      if (!entity) return;
      const outgoing = facts.filter(f => f.subject_name === node && (showHistorical || f.is_current));
      const incoming = facts.filter(f => f.object_name === node && (showHistorical || f.is_current));
      setSelected({ entity, outgoing, incoming });
    });
    renderer.on('clickStage', () => setSelected(null));

    return () => { renderer.kill(); };
  }, [buildGraph, facts, showHistorical, labelColor]);

  const entityTypes = Array.from(new Set(entities.map(e => e.entity_type))).sort();

  return (
    <div className="flex gap-4">
      <div className="relative flex-1">
        <div
          ref={containerRef}
          className="w-full rounded-lg border"
          style={{ height: 580, background: bgColor, transition: 'background 0.2s' }}
        />

        {entities.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
            No knowledge graph data. Use <code className="mx-1 font-mono">graph.add_entity</code> and <code className="mx-1 font-mono">graph.add_fact</code> to build it.
          </div>
        )}

        {/* Stats + legend */}
        <div className="absolute bottom-3 left-3 flex flex-wrap items-center gap-3 rounded-md bg-background/80 px-3 py-1.5 text-xs text-muted-foreground backdrop-blur">
          <span>{stats.nodes} entities · {stats.edges} facts shown{stats.historical > 0 ? ` · ${stats.historical} historical` : ''}</span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-1 w-5 rounded" style={{ background: currentColor }} />
            current
          </span>
          {showHistorical && (
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-0.5 w-5 rounded" style={{ background: historicalColor }} />
              historical
            </span>
          )}
          <span className="opacity-60">click entity for details</span>
        </div>

        {/* Entity type legend */}
        {entityTypes.length > 0 && (
          <div className="absolute top-3 left-3 flex flex-wrap gap-1.5 rounded-md bg-background/80 px-3 py-1.5 backdrop-blur">
            {entityTypes.map(t => (
              <span key={t} className="flex items-center gap-1 text-xs text-muted-foreground">
                <span className="inline-block h-2 w-2 rounded-full" style={{ background: typeColor(t) }} />
                {t}
              </span>
            ))}
          </div>
        )}
      </div>

      {selected && (
        <Card className="w-80 shrink-0 self-start sticky top-4 max-h-[580px] overflow-y-auto">
          <CardHeader className="pb-2 pt-4">
            <div className="flex items-start justify-between gap-2">
              <CardTitle className="text-sm font-semibold leading-snug">{selected.entity.name}</CardTitle>
              <Badge variant="secondary" className="shrink-0 text-xs" style={{ background: typeColor(selected.entity.entity_type) + '33', color: typeColor(selected.entity.entity_type) }}>
                {selected.entity.entity_type}
              </Badge>
            </div>
            {selected.entity.summary && (
              <p className="mt-1 text-xs text-muted-foreground">{selected.entity.summary}</p>
            )}
          </CardHeader>
          <CardContent className="space-y-4 pb-4 text-xs">
            {selected.outgoing.length > 0 && (
              <div>
                <p className="mb-1.5 font-medium text-muted-foreground uppercase tracking-wide" style={{ fontSize: '10px' }}>Outgoing facts</p>
                <div className="space-y-2">
                  {selected.outgoing.map((f, i) => (
                    <FactCard key={i} fact={f} perspective="outgoing" />
                  ))}
                </div>
              </div>
            )}
            {selected.incoming.length > 0 && (
              <div>
                <p className="mb-1.5 font-medium text-muted-foreground uppercase tracking-wide" style={{ fontSize: '10px' }}>Incoming facts</p>
                <div className="space-y-2">
                  {selected.incoming.map((f, i) => (
                    <FactCard key={i} fact={f} perspective="incoming" />
                  ))}
                </div>
              </div>
            )}
            {selected.outgoing.length === 0 && selected.incoming.length === 0 && (
              <p className="text-muted-foreground">No facts recorded for this entity.</p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function FactCard({ fact, perspective }: { fact: KnowledgeFact; perspective: 'outgoing' | 'incoming' }) {
  const borderColor = fact.is_current ? '#22c55e' : '#64748b';
  return (
    <div
      className="rounded border-l-2 pl-2 py-1 space-y-0.5"
      style={{ borderColor }}
    >
      <p className="leading-snug text-foreground">{fact.fact}</p>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-muted-foreground" style={{ fontSize: '10px' }}>
        <span>{perspective === 'outgoing' ? `→ ${fact.object_name}` : `← ${fact.subject_name}`}</span>
        <span>valid {fmtTs(fact.valid_at)}</span>
        {fact.invalid_at && <span className="text-amber-500">until {fmtTs(fact.invalid_at)}</span>}
        {fact.is_current && <span className="text-green-500">current</span>}
      </div>
    </div>
  );
}
