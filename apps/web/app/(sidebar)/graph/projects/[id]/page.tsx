'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { RefreshCw, ArrowLeft, Search } from 'lucide-react';
import { toast } from 'sonner';

const ProjectKnowledgeGraph = dynamic(
  () => import('@/components/project-knowledge-graph').then(m => m.ProjectKnowledgeGraph),
  {
    ssr: false,
    loading: () => (
      <div className="w-full h-full flex items-center justify-center">
        <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    ),
  }
);

interface ProjectGraph {
  id: string;
  name: string;
  path: string;
  description: string | null;
  node_count: number;
  edge_count: number;
  graph_hash: string | null;
  imported_at: string | null;
  created_at: string;
  updated_at: string;
  graph_data?: { nodes?: unknown[] } | null; // present from GET /api/project-graphs/:id
}

interface GraphQueryResult {
  query: string;
  seed_nodes: string[];
  nodes: Array<{ id: string; label: string; file_type?: string; community?: number; source_file?: string }>;
  edges: Array<{ source: string; target: string; relation: string }>;
  truncated: boolean;
}

export default function ProjectDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const router = useRouter();

  const [project, setProject] = useState<ProjectGraph | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isRebuilding, setIsRebuilding] = useState(false);

  // Query panel
  const [queryInput, setQueryInput] = useState('');
  const [queryResult, setQueryResult] = useState<GraphQueryResult | null>(null);
  const [isQuerying, setIsQuerying] = useState(false);
  const queriedQueryRef = useRef<string>('');

  const fetchProject = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/project-graphs/${id}`);
      if (res.status === 404) {
        router.push('/graph/projects');
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setProject(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load project');
    } finally {
      setIsLoading(false);
    }
  }, [id, router]);

  const handleRebuild = async () => {
    setIsRebuilding(true);
    try {
      const res = await fetch(`/api/project-graphs/${id}/rebuild`, { method: 'POST' });
      const data = await res.json();
      if (data.status === 'unchanged') {
        toast.info('Graph is up to date — no changes detected');
      } else {
        toast.success('Graph rebuilt successfully');
        await fetchProject();
      }
    } catch {
      toast.error('Rebuild failed');
    } finally {
      setIsRebuilding(false);
    }
  };

  const handleQuery = async () => {
    const q = queryInput.trim();
    if (!q) return;
    setIsQuerying(true);
    queriedQueryRef.current = q;
    try {
      const res = await fetch(`/api/project-graphs/${id}/query?q=${encodeURIComponent(q)}&hops=2`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: GraphQueryResult = await res.json();
      if (queriedQueryRef.current === q) {
        setQueryResult(data);
      }
    } catch {
      toast.error('Query failed');
    } finally {
      setIsQuerying(false);
    }
  };

  useEffect(() => {
    fetchProject();
  }, [fetchProject]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4">
        <p className="text-destructive">{error}</p>
        <Button variant="outline" onClick={() => router.push('/graph/projects')}>
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Projects
        </Button>
      </div>
    );
  }

  if (!project) return null;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-4 px-6 py-3 border-b shrink-0">
        <Button variant="ghost" size="sm" onClick={() => router.push('/graph/projects')}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="font-semibold truncate">{project.name}</h1>
            <Badge variant="secondary">{project.node_count.toLocaleString()} nodes</Badge>
            <Badge variant="outline">{project.edge_count.toLocaleString()} edges</Badge>
          </div>
          <p className="text-xs text-muted-foreground font-mono truncate">{project.path}</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleRebuild}
          disabled={isRebuilding}
        >
          {isRebuilding ? (
            <RefreshCw className="h-4 w-4 animate-spin" />
          ) : (
            <>
              <RefreshCw className="h-4 w-4 mr-1" />
              Rebuild
            </>
          )}
        </Button>
      </div>

      {/* Graph + Query Panel */}
      <div className="flex-1 relative overflow-hidden">
        {/* Full-screen graph or empty state */}
        {!project.graph_data ||
         (project.graph_data as { nodes?: unknown }).nodes === undefined ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-3">
            <p>No graph data available.</p>
            <p className="text-sm">
              Run <code className="bg-muted px-1 rounded">/graphify {project.path}</code> then click Rebuild.
            </p>
            <Button variant="outline" size="sm" onClick={handleRebuild} disabled={isRebuilding}>
              {isRebuilding ? <RefreshCw className="h-4 w-4 animate-spin mr-2" /> : null}
              Rebuild
            </Button>
          </div>
        ) : (
          <>
            <ProjectKnowledgeGraph
              graphData={project.graph_data as import('@/components/project-knowledge-graph').GraphifyData}
              queryResult={queryResult}
            />

            {/* Floating query panel at bottom */}
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 w-full max-w-lg px-4">
              <div className="bg-background/95 backdrop-blur border rounded-lg shadow-lg p-3">
                <div className="flex gap-2">
                  <Input
                    value={queryInput}
                    onChange={e => setQueryInput(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleQuery()}
                    placeholder="Search the graph... (e.g. auth, database, handler)"
                    className="flex-1 text-sm"
                    disabled={isQuerying}
                  />
                  <Button
                    onClick={handleQuery}
                    disabled={isQuerying || !queryInput.trim()}
                    size="sm"
                  >
                    {isQuerying ? (
                      <RefreshCw className="h-4 w-4 animate-spin" />
                    ) : (
                      <Search className="h-4 w-4" />
                    )}
                  </Button>
                  {queryResult && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setQueryResult(null);
                        setQueryInput('');
                      }}
                    >
                      Clear
                    </Button>
                  )}
                </div>
                {queryResult && (
                  <p className="text-xs text-muted-foreground mt-2">
                    Found {queryResult.nodes.length} nodes from {queryResult.seed_nodes.length} seed(s)
                    {queryResult.truncated && ' (truncated)'}
                  </p>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
