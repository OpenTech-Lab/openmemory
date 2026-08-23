'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ArrowLeft, RefreshCw, Bot, Sparkles, BookOpen, TrendingUp } from 'lucide-react';
import { toast } from 'sonner';
import { SUBAGENT_REFERENCE } from '@/lib/subagent-reference';
import { AgentUsageTrend } from '@/components/agent-usage-trend';
import { ClaudePlanUsage } from '@/components/claude-plan-usage';

interface WatcherAgent {
  id: string;
  name: string;
  path: string;
  enabled: boolean;
  is_builtin: boolean;
  description: string | null;
  created_at: string;
  updated_at: string;
}

interface UsageEntry {
  name: string;
  uses: number;
}

interface AgentStats {
  agent_id: string;
  agent_name: string;
  session_count: number;
  message_count: number;
  subagent_usage: UsageEntry[];
  skill_usage: UsageEntry[];
}

export default function AgentDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;

  const [agent, setAgent] = useState<WatcherAgent | null>(null);
  const [stats, setStats] = useState<AgentStats | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const [agentRes, statsRes] = await Promise.all([
        fetch(`/api/agents/${id}`),
        fetch(`/api/agents/${id}/stats`),
      ]);
      if (!agentRes.ok) throw new Error(`HTTP ${agentRes.status}`);
      setAgent(await agentRes.json());
      if (statsRes.ok) {
        setStats(await statsRes.json());
      } else {
        setStats(null);
      }
    } catch (err) {
      toast.error('Failed to load agent');
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="flex-1 overflow-auto p-4">
      <div className="flex items-center gap-2 mb-2">
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => router.push('/agents')}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="text-lg font-semibold flex items-center gap-2">
          <Bot className="h-5 w-5" />
          {agent?.name ?? 'Agent'}
        </h1>
        {agent?.is_builtin && <Badge variant="secondary" className="text-xs">built-in</Badge>}
        <div className="flex-1" />
        <Button variant="outline" size="sm" onClick={load} disabled={isLoading}>
          <RefreshCw className={`h-4 w-4 mr-1 ${isLoading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>
      <div className="h-px bg-gradient-to-r from-border via-border/40 to-transparent mb-4" />

      {!agent && isLoading ? (
        <div className="flex items-center justify-center h-[300px]">
          <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : !agent ? (
        <p className="text-sm text-muted-foreground text-center py-8">Agent not found.</p>
      ) : (
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Overview</CardTitle>
              <CardDescription>{agent.description ?? 'No description'}</CardDescription>
            </CardHeader>
            <CardContent className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
              <div>
                <p className="text-muted-foreground text-xs">Root path</p>
                <code className="text-xs bg-muted px-1.5 py-0.5 rounded">{agent.path}</code>
              </div>
              <div>
                <p className="text-muted-foreground text-xs">Recording</p>
                <p>{agent.enabled ? 'Enabled' : 'Disabled'}</p>
              </div>
              <div>
                <p className="text-muted-foreground text-xs">Sessions recorded</p>
                <p>{stats?.session_count ?? '—'}</p>
              </div>
              <div>
                <p className="text-muted-foreground text-xs">Messages recorded</p>
                <p>{stats?.message_count ?? '—'}</p>
              </div>
            </CardContent>
          </Card>

          <ClaudePlanUsage agentId={id} />

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <TrendingUp className="h-4 w-4" />
                Usage Trend
              </CardTitle>
              <CardDescription>
                Sessions and messages bucketed over time, with a linear projection of the next few buckets.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <AgentUsageTrend agentId={id} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Sparkles className="h-4 w-4" />
                Subagent &amp; Skill Usage
              </CardTitle>
              <CardDescription>
                Parsed from this agent&apos;s recorded sessions — Task and Skill tool invocations found in transcripts.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-6 sm:grid-cols-2">
              <div>
                <h3 className="text-sm font-medium mb-2">Subagents invoked</h3>
                {stats && stats.subagent_usage.length > 0 ? (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Subagent</TableHead>
                        <TableHead className="text-right">Uses</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {stats.subagent_usage.map(u => (
                        <TableRow key={u.name}>
                          <TableCell>{u.name}</TableCell>
                          <TableCell className="text-right">{u.uses}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ) : (
                  <p className="text-sm text-muted-foreground">No subagent (Task) invocations recorded yet.</p>
                )}
              </div>
              <div>
                <h3 className="text-sm font-medium mb-2">Skills invoked</h3>
                {stats && stats.skill_usage.length > 0 ? (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Skill</TableHead>
                        <TableHead className="text-right">Uses</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {stats.skill_usage.map(u => (
                        <TableRow key={u.name}>
                          <TableCell>{u.name}</TableCell>
                          <TableCell className="text-right">{u.uses}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ) : (
                  <p className="text-sm text-muted-foreground">No skill invocations recorded yet.</p>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <BookOpen className="h-4 w-4" />
                Subagent Reference
              </CardTitle>
              <CardDescription>
                Claude Code&apos;s built-in subagent modes, for reference — which one to reach for depends on how much
                judgment a step needs and how expensive being wrong would be.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-32">Name</TableHead>
                    <TableHead className="w-64">Permission mode</TableHead>
                    <TableHead>Use for</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {SUBAGENT_REFERENCE.map(s => (
                    <TableRow key={s.name}>
                      <TableCell className="font-medium">{s.name}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{s.mode}</TableCell>
                      <TableCell className="text-sm">{s.purpose}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
