'use client';

import { useState, useEffect, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { Button } from '@/components/ui/button';
import { RefreshCw, Boxes, LayoutGrid, GitBranch } from 'lucide-react';
import type { MemoryNode, MemoryEdge } from '@/components/memory-graph-types';

const MemoryGraph2D = dynamic(
  () => import('@/components/memory-graph-2d').then((m) => m.MemoryGraph2D),
  { ssr: false, loading: () => null }
);
const MemoryGraph3D = dynamic(
  () => import('@/components/memory-graph-3d').then((m) => m.MemoryGraph3D),
  { ssr: false, loading: () => null }
);

export default function MemoryGraphPage() {
  const [memories, setMemories] = useState<MemoryNode[]>([]);
  const [edges, setEdges] = useState<MemoryEdge[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isRebuilding, setIsRebuilding] = useState(false);
  const [rebuiltCount, setRebuiltCount] = useState<number | null>(null);
  const [view, setView] = useState<'2d' | '3d'>('2d');

  const fetchGraphData = useCallback(async () => {
    setIsLoading(true);
    try {
      const response = await fetch('/api/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'memory.graph_data' }),
      });
      const data = await response.json();
      setMemories(data.memories ?? []);
      setEdges(data.edges ?? []);
    } catch {
      setMemories([]);
      setEdges([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchGraphData();
  }, [fetchGraphData]);

  const handleRebuild = async () => {
    setIsRebuilding(true);
    setRebuiltCount(null);
    try {
      const res = await fetch('/api/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'memory.graph_rebuild' }),
      });
      const data = await res.json();
      setRebuiltCount(data.rebuilt ?? 0);
      fetchGraphData();
    } catch {
      setRebuiltCount(null);
    } finally {
      setIsRebuilding(false);
    }
  };

  return (
    <div className="relative overflow-hidden">
      {/* Floating control panel — top right overlay */}
      <div className="absolute top-3 right-3 z-20 flex items-center gap-1.5 rounded-lg border bg-background/90 backdrop-blur shadow-sm px-2 py-1.5">
        <Button
          variant={view === '2d' ? 'secondary' : 'ghost'}
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={() => setView('2d')}
        >
          <LayoutGrid className="h-3 w-3 mr-1" />
          2D
        </Button>
        <Button
          variant={view === '3d' ? 'secondary' : 'ghost'}
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={() => setView('3d')}
        >
          <Boxes className="h-3 w-3 mr-1" />
          3D
        </Button>
        <div className="w-px h-4 bg-border" />
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={handleRebuild}
          disabled={isRebuilding}
          title="Backfill RELATED_TO edges for all memories from their tags"
        >
          <GitBranch className="h-3 w-3 mr-1" />
          {isRebuilding ? 'Rebuilding…' : 'Rebuild'}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={fetchGraphData}
          disabled={isLoading}
        >
          <RefreshCw className={`h-3 w-3 ${isLoading ? 'animate-spin' : ''}`} />
        </Button>
        {rebuiltCount !== null && (
          <>
            <div className="w-px h-4 bg-border" />
            <span className="text-xs text-muted-foreground">{rebuiltCount} rebuilt</span>
          </>
        )}
      </div>

      {/* Full-screen graph */}
      {isLoading ? (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          <RefreshCw className="mr-2 h-5 w-5 animate-spin" />
          Loading graph…
        </div>
      ) : view === '2d' ? (
        <MemoryGraph2D memories={memories} edges={edges} />
      ) : (
        <MemoryGraph3D memories={memories} edges={edges} />
      )}
    </div>
  );
}
