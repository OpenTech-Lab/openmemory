'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';
import { Activity, Bot, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

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

interface SessionRow {
  id: string;
  project_name: string | null;
  git_branch: string | null;
  cwd: string | null;
  agent_name: string | null;
  started_at: string | null;
  last_event_at: string | null;
  message_count: number;
  created_at: string;
}

// Shape returned by GET /api/agents/{id}/claude-usage — see
// apps/web/app/api/agents/[id]/claude-usage/route.ts, which proxies
// apps/server's get_agent_claude_usage handler.
interface ClaudeUsage {
  supported: boolean;
  state?: 'ok' | 'no_credentials' | 'token_expired' | 'network_error' | 'upstream_error' | string;
  message?: string;
}

type AgentStatus = 'Running' | 'Waiting' | 'Error' | 'Disabled';

const RUNNING_WINDOW_MS = 15 * 60 * 1000;
const IDLE_WINDOW_MS = 24 * 60 * 60 * 1000;

function deriveStatus(agent: AgentUsage, claudeUsage: ClaudeUsage | undefined): AgentStatus {
  if (!agent.enabled) return 'Disabled';
  if (agent.claude_usage_supported && claudeUsage && claudeUsage.state !== 'ok') return 'Error';
  if (agent.last_active_at) {
    const elapsed = Date.now() - new Date(agent.last_active_at).getTime();
    if (elapsed < RUNNING_WINDOW_MS) return 'Running';
  }
  return 'Waiting';
}

// Amber vs. grey "Waiting" dot: amber within the 24h idle window, grey once
// truly dormant (or never active). Text label collapses both to "Waiting".
function waitingDotClass(agent: AgentUsage): string {
  if (!agent.last_active_at) return 'bg-muted-foreground/40';
  const elapsed = Date.now() - new Date(agent.last_active_at).getTime();
  return elapsed < IDLE_WINDOW_MS ? 'bg-amber-500' : 'bg-muted-foreground/40';
}

const STATUS_TEXT_CLASS: Record<AgentStatus, string> = {
  Running: 'text-emerald-600 dark:text-emerald-400',
  Waiting: 'text-muted-foreground',
  Error: 'text-destructive',
  Disabled: 'text-muted-foreground',
};

function StatusDot({ status, agent }: { status: AgentStatus; agent: AgentUsage }) {
  const dotClass =
    status === 'Running'
      ? 'bg-emerald-500'
      : status === 'Error'
        ? 'bg-destructive'
        : status === 'Disabled'
          ? 'bg-muted-foreground/40'
          : waitingDotClass(agent);
  return (
    <span className="relative flex h-2 w-2 shrink-0">
      {status === 'Running' && (
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-75" />
      )}
      <span className={`relative inline-flex h-2 w-2 rounded-full ${dotClass}`} />
    </span>
  );
}

export function AgentsMonitor() {
  const [data, setData] = useState<UsageSummary | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [claudeUsageByAgent, setClaudeUsageByAgent] = useState<Record<string, ClaudeUsage>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const [usageResult, sessionsResult] = await Promise.allSettled([
        fetch('/api/agents/usage-summary').then(async (res) => {
          const body = await res.json();
          if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
          return body as UsageSummary;
        }),
        fetch('/api/sessions?limit=200').then(async (res) => {
          const body = await res.json();
          if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
          return (body.sessions ?? []) as SessionRow[];
        }),
      ]);

      if (usageResult.status === 'rejected') {
        setError(usageResult.reason instanceof Error ? usageResult.reason.message : 'Failed to load agent status');
        return;
      }
      setError(null);
      const summary = usageResult.value;
      setData(summary);
      setSessions(sessionsResult.status === 'fulfilled' ? sessionsResult.value : []);

      const usageSupportedAgents = summary.agents.filter((a) => a.claude_usage_supported);
      const usageResults = await Promise.allSettled(
        usageSupportedAgents.map(async (agent) => {
          const res = await fetch(`/api/agents/${agent.agent_id}/claude-usage`);
          const body = await res.json();
          if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
          return { agentId: agent.agent_id, usage: body as ClaudeUsage };
        })
      );
      setClaudeUsageByAgent((prev) => {
        const next = { ...prev };
        for (const result of usageResults) {
          if (result.status === 'fulfilled') {
            next[result.value.agentId] = result.value.usage;
          }
          // On failure, leave the agent's prior entry (or absence) alone —
          // treated as unknown/omitted rather than blanking other agents.
        }
        return next;
      });
    } catch {
      setError('Failed to load agent status');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(() => load(), 30_000);
    return () => clearInterval(interval);
  }, [load]);

  const statusByAgentId = new Map<string, AgentStatus>();
  data?.agents.forEach((agent) => {
    statusByAgentId.set(agent.agent_id, deriveStatus(agent, claudeUsageByAgent[agent.agent_id]));
  });

  const runningCount = data?.agents.filter((agent) => statusByAgentId.get(agent.agent_id) === 'Running').length ?? 0;
  const totalCount = data?.agents.length ?? 0;

  return (
    <div className="mb-4">
      <div className="flex items-center gap-2">
        <Activity className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">Monitor</span>
        {data && (
          <span className="text-xs text-muted-foreground">
            {runningCount} running / {totalCount} agent{totalCount !== 1 ? 's' : ''}
          </span>
        )}
        <div className="flex-1" />
        <Button variant="outline" size="sm" onClick={load} disabled={isLoading}>
          <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`} />
        </Button>
      </div>
      <div className="pt-3">
        {error && (
          <p className="text-xs text-destructive mb-2">{error}</p>
        )}
        {!data && !error ? (
          <p className="text-xs text-muted-foreground">Loading agent status…</p>
        ) : data ? (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {data.agents.map((agent) => {
              const status = statusByAgentId.get(agent.agent_id) ?? 'Waiting';
              const usage = claudeUsageByAgent[agent.agent_id];
              const activeSessions =
                status === 'Running'
                  ? sessions.filter(
                      (session) =>
                        session.agent_name === agent.agent_name &&
                        session.last_event_at &&
                        Date.now() - new Date(session.last_event_at).getTime() < RUNNING_WINDOW_MS
                    )
                  : [];
              return (
                <div
                  key={agent.agent_id}
                  className="overflow-hidden rounded-md border text-sm"
                >
                  <div className="flex items-start gap-2 border-b bg-background px-2.5 py-2">
                    <StatusDot status={status} agent={agent} />
                    <Bot className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <Link
                          href={`/agents/${agent.agent_id}`}
                          className="truncate font-medium hover:underline"
                        >
                          {agent.agent_name}
                        </Link>
                        <span
                          className={`text-xs font-medium ${STATUS_TEXT_CLASS[status]}`}
                          title={status === 'Error' && usage?.state ? usage.state : undefined}
                        >
                          {status}
                        </span>
                        {agent.is_builtin && (
                          <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                            built-in
                          </Badge>
                        )}
                        {!agent.enabled && (
                          <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                            disabled
                          </Badge>
                        )}
                      </div>
                      {status === 'Error' && usage?.state && (
                        <p className="truncate text-[10px] text-destructive">{usage.state}</p>
                      )}
                      <p className="truncate text-xs text-muted-foreground">
                        Last seen{' '}
                        {agent.last_active_at
                          ? formatDistanceToNow(new Date(agent.last_active_at), { addSuffix: true })
                          : 'never'}
                        {' · '}
                        {agent.session_count.toLocaleString()} session{agent.session_count !== 1 ? 's' : ''}
                        {' · '}
                        {agent.message_count.toLocaleString()} msg{agent.message_count !== 1 ? '' : ''}
                      </p>
                    </div>
                  </div>
                  {activeSessions.length > 0 && (
                    <div className="bg-muted/30 p-1.5">
                      <div className="mb-1 flex items-center justify-between gap-2 px-0.5">
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                          Running sessions
                        </span>
                        <span className="text-[10px] tabular-nums text-muted-foreground">
                          {activeSessions.length}
                        </span>
                      </div>
                      <div className="max-h-32 space-y-1 overflow-y-auto">
                        {activeSessions.map((session) => (
                          <div
                            key={session.id}
                            className="rounded-sm border border-border/60 bg-background/70 px-1.5 py-1"
                          >
                            <p className="truncate text-[11px] font-medium text-foreground">
                              {session.project_name ?? session.cwd ?? `Session ${session.id.slice(0, 8)}`}
                            </p>
                            {(session.git_branch || session.last_event_at) && (
                              <p className="truncate text-[10px] text-muted-foreground">
                                {session.git_branch ?? 'Active'}
                                {session.last_event_at
                                  ? ` · ${formatDistanceToNow(new Date(session.last_event_at), { addSuffix: true })}`
                                  : ''}
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}
