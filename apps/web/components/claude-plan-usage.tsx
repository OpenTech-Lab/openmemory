'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { AlertTriangle, Gauge, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

type UsageState = 'ok' | 'no_credentials' | 'token_expired' | 'upstream_error' | 'network_error';

interface UsageWindow {
  utilization: number | null;
  resets_at: string | null;
}

interface ExtraUsage {
  enabled: boolean | null;
  utilization: number | null;
  used_minor: number | null;
  limit_minor: number | null;
  currency: string | null;
  exponent: number | null;
  severity: string | null;
}

interface ClaudeUsageResponse {
  supported: boolean;
  state: UsageState;
  message: string | null;
  plan: string | null;
  rate_limit_tier: string | null;
  five_hour: UsageWindow | null;
  seven_day: UsageWindow | null;
  extra_usage: ExtraUsage | null;
  fetched_at: string;
  cached: boolean;
}

// Formats an ISO timestamp as "resets in 3h 12m" (or "resets in 12m" / "resets now").
function formatResetsIn(isoTime: string | null): string | null {
  if (!isoTime) return null;
  const target = new Date(isoTime).getTime();
  if (Number.isNaN(target)) return null;
  const diffMs = target - Date.now();
  if (diffMs <= 0) return 'resets now';
  const totalMinutes = Math.round(diffMs / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `resets in ${hours}h ${minutes}m`;
  return `resets in ${minutes}m`;
}

function formatMinorAmount(minor: number | null, exponent: number | null): string {
  if (minor === null) return '—';
  const exp = exponent ?? 2;
  const value = minor / Math.pow(10, exp);
  return value.toFixed(exp);
}

// Utilization-based color tier for the meter and credits bar: green under
// 70%, amber 70-90%, red above 90% — the same tiering the `severity` field
// on the credits response already implies for that meter.
function utilizationIndicatorClass(pct: number | null): string {
  if (pct === null) return '';
  if (pct >= 90) return '[&>[data-slot=progress-indicator]]:bg-destructive';
  if (pct >= 70) return '[&>[data-slot=progress-indicator]]:bg-amber-500';
  return '';
}

function Meter({ label, pct, resetText }: { label: string; pct: number | null; resetText: string | null }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium">{pct !== null ? `${pct.toFixed(0)}%` : '—'}</span>
      </div>
      <Progress value={pct ?? 0} className={utilizationIndicatorClass(pct)} />
      {resetText && <p className="text-xs text-muted-foreground">{resetText}</p>}
    </div>
  );
}

function CardShell({ children }: { children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Gauge className="h-4 w-4" />
          Plan &amp; Usage
        </CardTitle>
        <CardDescription>
          Account-level plan and rolling-window utilization from Anthropic, read live from this host&apos;s Claude Code credentials.
        </CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export function ClaudePlanUsage({ agentId }: { agentId: string }) {
  const [data, setData] = useState<ClaudeUsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/agents/${agentId}/claude-usage`);
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? 'Failed to load Claude plan usage');
        setData(null);
        return;
      }
      setData(body);
    } catch {
      setError('Failed to load Claude plan usage');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => { load(); }, [load]);

  // While we don't yet know whether this agent supports Claude usage (first
  // load), render nothing rather than flashing a card that then disappears
  // for non-Claude-Code agents.
  if (loading && !data && !error) {
    return null;
  }

  if (error) {
    return (
      <CardShell>
        <div className="flex items-center justify-between gap-2 text-sm text-destructive">
          <span className="flex items-center gap-1.5"><AlertTriangle className="h-4 w-4 shrink-0" />{error}</span>
          <Button variant="outline" size="sm" onClick={load}>
            <RefreshCw className="h-3.5 w-3.5 mr-1" />
            Retry
          </Button>
        </div>
      </CardShell>
    );
  }

  if (!data || !data.supported) {
    return null;
  }

  if (data.state === 'no_credentials') {
    return (
      <CardShell>
        <p className="text-sm text-muted-foreground">{data.message}</p>
      </CardShell>
    );
  }

  const planBadge = data.plan && (
    <Badge variant="secondary" className="capitalize">{data.plan}</Badge>
  );

  if (data.state === 'token_expired') {
    return (
      <CardShell>
        <div className="space-y-2">
          <div className="flex items-center gap-2">{planBadge}</div>
          <p className="text-sm text-muted-foreground">{data.message}</p>
        </div>
      </CardShell>
    );
  }

  if (data.state === 'network_error' || data.state === 'upstream_error') {
    return (
      <CardShell>
        <div className="space-y-3">
          <div className="flex items-center gap-2">{planBadge}</div>
          <div className="flex items-center justify-between gap-2 text-sm text-destructive">
            <span className="flex items-center gap-1.5"><AlertTriangle className="h-4 w-4 shrink-0" />{data.message}</span>
            <Button variant="outline" size="sm" onClick={load}>
              <RefreshCw className="h-3.5 w-3.5 mr-1" />
              Retry
            </Button>
          </div>
        </div>
      </CardShell>
    );
  }

  // state === 'ok'
  const extra = data.extra_usage;
  const creditsLine = extra
    ? `$${formatMinorAmount(extra.used_minor, extra.exponent)} of $${formatMinorAmount(extra.limit_minor, extra.exponent)}`
    : null;

  return (
    <CardShell>
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          {planBadge}
          {data.rate_limit_tier && (
            <span className="text-xs text-muted-foreground">{data.rate_limit_tier} tier</span>
          )}
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Meter
            label="5-hour window"
            pct={data.five_hour?.utilization ?? null}
            resetText={formatResetsIn(data.five_hour?.resets_at ?? null)}
          />
          <Meter
            label="7-day window"
            pct={data.seven_day?.utilization ?? null}
            resetText={formatResetsIn(data.seven_day?.resets_at ?? null)}
          />
          {extra && extra.enabled && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Extra usage credits</span>
                <span className="font-medium">{extra.utilization !== null ? `${extra.utilization.toFixed(0)}%` : '—'}</span>
              </div>
              <Progress value={extra.utilization ?? 0} className={utilizationIndicatorClass(extra.utilization)} />
              {creditsLine && <p className="text-xs text-muted-foreground">{creditsLine}</p>}
            </div>
          )}
        </div>
      </div>
    </CardShell>
  );
}
