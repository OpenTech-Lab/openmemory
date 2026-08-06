'use client';

import { useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { RefreshCw, TrendingUp } from 'lucide-react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  XAxis,
  YAxis,
} from 'recharts';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';

type Bucket = 'day' | 'week';
type Metric = 'sessions' | 'messages';

interface TimeseriesPoint {
  bucket_start: string;
  sessions: number;
  messages: number;
}

interface TimeseriesResponse {
  agent_id: string;
  agent_name: string;
  bucket: Bucket;
  periods: number;
  points: TimeseriesPoint[];
}

interface ChartPoint {
  bucket_start: string;
  sessions: number | null;
  messages: number | null;
  trend: number | null;
}

const CHART_CONFIG: ChartConfig = {
  sessions: { label: 'Sessions', color: 'var(--chart-1)' },
  messages: { label: 'Messages', color: 'var(--chart-2)' },
  trend: { label: 'Trend', color: 'var(--chart-3)' },
};

const PERIODS: Record<Bucket, number> = { day: 30, week: 12 };

// Ordinary-least-squares slope/intercept over (index, value) pairs. Returns
// null when there are fewer than two points to fit — the caller then skips
// rendering a trend line instead of crashing on a degenerate fit.
function linearRegression(values: number[]): { slope: number; intercept: number } | null {
  const n = values.length;
  if (n < 2) return null;

  const xs = values.map((_, i) => i);
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = values.reduce((a, b) => a + b, 0) / n;

  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - meanX) * (values[i] - meanY);
    den += (xs[i] - meanX) ** 2;
  }
  if (den === 0) return { slope: 0, intercept: meanY };

  const slope = num / den;
  const intercept = meanY - slope * meanX;
  return { slope, intercept };
}

export function AgentUsageTrend({ agentId }: { agentId: string }) {
  const [bucket, setBucket] = useState<Bucket>('day');
  const [metric, setMetric] = useState<Metric>('sessions');
  const [data, setData] = useState<TimeseriesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    (async () => {
      try {
        const periods = PERIODS[bucket];
        const res = await fetch(`/api/agents/${agentId}/stats/timeseries?bucket=${bucket}&periods=${periods}`);
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError(body.error ?? 'Failed to load usage trend');
          return;
        }
        setData(body);
      } catch {
        if (!cancelled) setError('Failed to load usage trend');
      }
    })();
    return () => { cancelled = true; };
  }, [agentId, bucket]);

  const { chartPoints, lastActualBucket, projectionText } = useMemo(() => {
    if (!data || data.points.length === 0) {
      return { chartPoints: [] as ChartPoint[], lastActualBucket: null as string | null, projectionText: null as string | null };
    }

    const fit = linearRegression(data.points.map(p => p[metric]));
    const lastActual = data.points[data.points.length - 1].bucket_start;

    const actualPoints: ChartPoint[] = data.points.map((p, i) => ({
      bucket_start: p.bucket_start,
      sessions: p.sessions,
      messages: p.messages,
      trend: fit ? Math.round(Math.max(0, fit.slope * i + fit.intercept)) : null,
    }));

    let futurePoints: ChartPoint[] = [];
    let text: string | null = null;

    if (fit) {
      const stepMs = data.bucket === 'week' ? 7 * 24 * 3600 * 1000 : 24 * 3600 * 1000;
      const lastDate = new Date(lastActual);
      const futureCount = Math.max(3, Math.min(5, Math.ceil(data.periods / 6)));

      futurePoints = Array.from({ length: futureCount }, (_, k) => {
        const i = data.points.length + k;
        const bucket_start = new Date(lastDate.getTime() + (k + 1) * stepMs).toISOString();
        return {
          bucket_start,
          sessions: null,
          messages: null,
          trend: Math.round(Math.max(0, fit.slope * i + fit.intercept)),
        };
      });

      const unit = data.bucket === 'week' ? 'week' : 'day';
      const lastFuture = futurePoints[futurePoints.length - 1];
      const direction = fit.slope > 0.001 ? 'Trending up' : fit.slope < -0.001 ? 'Trending down' : 'Flat trend';
      const perUnit = Math.abs(fit.slope).toFixed(1);
      const metricLabel = metric === 'sessions' ? 'sessions' : 'messages';
      const projectedDate = format(new Date(lastFuture.bucket_start), 'MMM d');
      const projectedValue = Math.round(lastFuture.trend ?? 0);
      text = `${direction} ${fit.slope >= 0 ? '+' : '-'}${perUnit} ${metricLabel}/${unit}; ~${projectedValue} ${metricLabel} projected for ${projectedDate}.`;
    }

    return { chartPoints: [...actualPoints, ...futurePoints], lastActualBucket: lastActual, projectionText: text };
  }, [data, metric]);

  const tickFormatter = (value: string) => format(new Date(value), 'MMM d');

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <ToggleGroup type="single" variant="outline" size="sm" value={bucket} onValueChange={v => v && setBucket(v as Bucket)}>
          <ToggleGroupItem value="day">Day</ToggleGroupItem>
          <ToggleGroupItem value="week">Week</ToggleGroupItem>
        </ToggleGroup>
        <ToggleGroup type="single" variant="outline" size="sm" value={metric} onValueChange={v => v && setMetric(v as Metric)}>
          <ToggleGroupItem value="sessions">Sessions</ToggleGroupItem>
          <ToggleGroupItem value="messages">Messages</ToggleGroupItem>
        </ToggleGroup>
      </div>

      {error ? (
        <p className="p-6 text-sm text-destructive">{error}</p>
      ) : !data ? (
        <div className="flex items-center justify-center h-[260px]">
          <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : chartPoints.length === 0 ? (
        <p className="p-6 text-sm text-muted-foreground">No usage data recorded yet.</p>
      ) : (
        <>
          <ChartContainer config={CHART_CONFIG} className="h-[260px] w-full">
            <ComposedChart data={chartPoints} margin={{ left: 8, right: 8, top: 8, bottom: 8 }}>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="bucket_start"
                tickFormatter={tickFormatter}
                tickLine={false}
                axisLine={false}
                minTickGap={24}
              />
              <YAxis tickLine={false} axisLine={false} width={36} allowDecimals={false} />
              <ChartTooltip
                content={<ChartTooltipContent labelFormatter={(v) => tickFormatter(String(v))} />}
              />
              {lastActualBucket && (
                <ReferenceLine x={lastActualBucket} stroke="var(--border)" strokeDasharray="3 3" />
              )}
              <Area
                dataKey={metric}
                type="monotone"
                fill={`var(--color-${metric})`}
                fillOpacity={0.2}
                stroke={`var(--color-${metric})`}
                connectNulls={false}
              />
              <Line
                dataKey="trend"
                type="monotone"
                stroke="var(--color-trend)"
                strokeDasharray="4 4"
                dot={false}
                strokeWidth={2}
              />
            </ComposedChart>
          </ChartContainer>
          {projectionText && (
            <p className="text-sm text-muted-foreground flex items-center gap-1.5">
              <TrendingUp className="h-3.5 w-3.5 shrink-0" />
              {projectionText}
            </p>
          )}
        </>
      )}
    </div>
  );
}
