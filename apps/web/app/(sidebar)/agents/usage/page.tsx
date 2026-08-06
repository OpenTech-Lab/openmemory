'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';
import { RefreshCw, Gauge, MessageSquare, History } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ClaudePlanUsage } from '@/components/claude-plan-usage';
import { UsageSparkline } from '@/components/usage-sparkline';

interface AgentUsage {
  agent_id: string;
  agent_name: string;
  path: string;
  enabled: boolean;
  is_builtin: boolean;
  session_count: number;
  message_count: number;
  last_active_at: string | null;
  claude_usage_supported: boolean;
  sparkline: number[];
}

interface UsageSummary {
  generated_at: string;
  bucket: string;
  periods: number;
  totals: { agent_count: number; session_count: number; message_count: number };
  agents: AgentUsage[];
}

export default function AgentsUsagePage() {
  const [data, setData] = useState<UsageSummary | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/agents/usage-summary');
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      setData(body);
    } catch {
      setError('Failed to load agent usage');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const claudeUsageAgentId = data?.agents.find(a => a.claude_usage_supported)?.agent_id ?? null;

  return (
    <div className="flex-1 overflow-auto p-4">
      <div className="flex items-center gap-2 mb-2">
        <h1 className="text-lg font-semibold flex items-center gap-2">
          <Gauge className="h-5 w-5" />
          Agent Usage
        </h1>
        <div className="flex-1" />
        <Button variant="outline" size="sm" onClick={load} disabled={isLoading}>
          <RefreshCw className={`h-4 w-4 mr-1 ${isLoading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>
      <div className="h-px bg-gradient-to-r from-border via-border/40 to-transparent mb-4" />

      {!data && isLoading ? (
        <div className="flex items-center justify-center h-[300px]">
          <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : error && !data ? (
        <p className="text-sm text-destructive text-center py-8">{error}</p>
      ) : !data ? (
        <p className="text-sm text-muted-foreground text-center py-8">No usage data available.</p>
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-3 gap-4">
            <Card>
              <CardContent className="pt-6">
                <p className="text-xs text-muted-foreground">Agents recording</p>
                <p className="text-2xl font-semibold">{data.totals.agent_count}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <p className="text-xs text-muted-foreground">Total sessions</p>
                <p className="text-2xl font-semibold">{data.totals.session_count.toLocaleString()}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <p className="text-xs text-muted-foreground">Total messages</p>
                <p className="text-2xl font-semibold">{data.totals.message_count.toLocaleString()}</p>
              </CardContent>
            </Card>
          </div>

          {claudeUsageAgentId && <ClaudePlanUsage agentId={claudeUsageAgentId} />}

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {data.agents.map(agent => (
              <Card key={agent.agent_id}>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Link href={`/agents/${agent.agent_id}`} className="hover:underline">
                      {agent.agent_name}
                    </Link>
                    {agent.is_builtin && <Badge variant="secondary" className="text-xs">built-in</Badge>}
                    {!agent.enabled && <Badge variant="outline" className="text-xs">disabled</Badge>}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex items-center justify-between text-sm">
                    <span className="flex items-center gap-1.5 text-muted-foreground">
                      <History className="h-3.5 w-3.5" />
                      {agent.session_count.toLocaleString()} session{agent.session_count !== 1 ? 's' : ''}
                    </span>
                    <span className="flex items-center gap-1.5 text-muted-foreground">
                      <MessageSquare className="h-3.5 w-3.5" />
                      {agent.message_count.toLocaleString()} message{agent.message_count !== 1 ? 's' : ''}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {agent.last_active_at
                      ? `Last active ${formatDistanceToNow(new Date(agent.last_active_at), { addSuffix: true })}`
                      : 'Never active'}
                  </p>
                  <div className="h-10 flex items-center">
                    {agent.session_count === 0 ? (
                      <p className="text-sm text-muted-foreground">No sessions recorded yet.</p>
                    ) : (
                      <UsageSparkline data={agent.sparkline} />
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
