'use client';

import { useState, useEffect, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { Button } from '@/components/ui/button';
import { RefreshCw, GitBranch } from 'lucide-react';
import { type KnowledgeEntity, type KnowledgeFact } from '@/components/knowledge-graph';

const KnowledgeGraph = dynamic(
  () => import('@/components/knowledge-graph').then((m) => m.KnowledgeGraph),
  { ssr: false, loading: () => null }
);

export default function GraphPage() {
  const [graphEntities, setGraphEntities] = useState<KnowledgeEntity[]>([]);
  const [graphFacts, setGraphFacts] = useState<KnowledgeFact[]>([]);
  const [showHistorical, setShowHistorical] = useState(true);
  const [isGraphLoading, setIsGraphLoading] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analyzeResult, setAnalyzeResult] = useState<{ processed: number; entities: number; facts: number; errors: number } | null>(null);
  const [llmConfigured, setLlmConfigured] = useState(false);

  const fetchGraphData = useCallback(async () => {
    setIsGraphLoading(true);
    try {
      const response = await fetch('/api/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'graph.get_graph', limit: 500 }),
      });
      const data = await response.json();
      setGraphEntities(data.entities ?? []);
      setGraphFacts(data.facts ?? []);
    } catch {
      setGraphEntities([]);
      setGraphFacts([]);
    } finally {
      setIsGraphLoading(false);
    }
  }, []);

  const checkLlmConfig = useCallback(async () => {
    try {
      const res = await fetch('/api/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'graph.get_llm_config' }),
      });
      const data = await res.json();
      setLlmConfigured(data.configured === true);
    } catch {
      setLlmConfigured(false);
    }
  }, []);

  useEffect(() => {
    fetchGraphData();
    checkLlmConfig();
  }, [fetchGraphData, checkLlmConfig]);

  const handleAnalyzeAll = async () => {
    setIsAnalyzing(true);
    setAnalyzeResult(null);
    try {
      const res = await fetch('/api/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'graph.analyze_all', limit: 50 }),
      });
      const data = await res.json();
      setAnalyzeResult({
        processed: data.processed ?? 0,
        entities: data.entities_created ?? 0,
        facts: data.facts_created ?? 0,
        errors: data.errors ?? 0,
      });
      fetchGraphData();
    } catch {
      setAnalyzeResult(null);
    } finally {
      setIsAnalyzing(false);
    }
  };

  return (
    <div className="relative overflow-hidden">
      {/* Floating control panel — top right overlay */}
      <div className="absolute top-3 right-3 z-20 flex items-center gap-1.5 rounded-lg border bg-background/90 backdrop-blur shadow-sm px-2 py-1.5">
        <Button
          variant={showHistorical ? 'secondary' : 'ghost'}
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={() => setShowHistorical((v) => !v)}
        >
          {showHistorical ? 'Hide historical' : 'Show historical'}
        </Button>
        <div className="w-px h-4 bg-border" />
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={handleAnalyzeAll}
          disabled={isAnalyzing || !llmConfigured}
          title={!llmConfigured ? 'Configure LLM in Settings first' : 'Extract entities from memories'}
        >
          <GitBranch className="h-3 w-3 mr-1" />
          {isAnalyzing ? 'Analyzing…' : 'Build'}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={fetchGraphData}
          disabled={isGraphLoading}
        >
          <RefreshCw className={`h-3 w-3 ${isGraphLoading ? 'animate-spin' : ''}`} />
        </Button>
        {analyzeResult && (
          <>
            <div className="w-px h-4 bg-border" />
            <span className="text-xs text-muted-foreground">
              {analyzeResult.entities}+{analyzeResult.facts} added
            </span>
          </>
        )}
      </div>

      {/* Full-screen graph */}
      {isGraphLoading ? (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          <RefreshCw className="mr-2 h-5 w-5 animate-spin" />
          Loading graph…
        </div>
      ) : (
        <KnowledgeGraph
          entities={graphEntities}
          facts={graphFacts}
          showHistorical={showHistorical}
        />
      )}
    </div>
  );
}
