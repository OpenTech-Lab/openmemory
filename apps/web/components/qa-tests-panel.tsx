'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts';
import {
  Activity,
  ChevronDown,
  ChevronRight,
  Code2,
  Copy,
  GitBranch,
  GitCommitHorizontal,
  History,
  RefreshCw,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { toast } from 'sonner';
import { caseStatusColor } from '@/lib/qa-meta';
import {
  caseHistorySummary,
  formatCaseDuration,
  partitionCases,
  shortSha,
  type QaCaseHistoryEntry,
  type QaRunMetric,
  type QaTestCase,
  type QaTestSource,
} from '@/lib/qa-cases';
import {
  duplicateDescription,
  duplicatePlanName,
  planKindForSource,
  planLanguageForSource,
} from '@/lib/qa-duplicate';

interface QaTestsPanelProps {
  projectId: string;
  onOpenPlan?: (planId: string) => void;
  /** Fired after a plan is created, so an unmounted plans panel's tab count stays honest. */
  onPlanCreated?: () => void;
  run: {
    id: string;
    kind?: string;
    runner?: string | null;
    total_cases?: number;
  };
}

interface CachedCases {
  cases: QaTestCase[];
  total: number;
}

interface CasesResponse {
  cases: QaTestCase[];
  total: number;
}

interface MetricsResponse {
  metrics: QaRunMetric[];
  total: number;
}

interface MetricSeries {
  metric: QaRunMetric;
  dataKey: string;
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function caseStatusLabel(status: string): string {
  return status ? `${status.charAt(0).toUpperCase()}${status.slice(1)}` : 'Unknown';
}

function responseError(data: unknown): string | null {
  if (typeof data !== 'object' || data === null || !('error' in data)) return null;
  const error = data.error;
  return typeof error === 'string' ? error : null;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function isCasesResponse(data: unknown): data is CasesResponse {
  return typeof data === 'object'
    && data !== null
    && 'cases' in data
    && Array.isArray(data.cases)
    && 'total' in data
    && typeof data.total === 'number';
}

function isMetricsResponse(data: unknown): data is MetricsResponse {
  return typeof data === 'object'
    && data !== null
    && 'metrics' in data
    && Array.isArray(data.metrics)
    && 'total' in data
    && typeof data.total === 'number';
}

function isTestSource(data: unknown): data is QaTestSource {
  return typeof data === 'object'
    && data !== null
    && 'body' in data
    && typeof data.body === 'string'
    && 'file' in data
    && typeof data.file === 'string';
}

function isCreatedPlan(data: unknown): data is { id: string } {
  return typeof data === 'object'
    && data !== null
    && 'id' in data
    && typeof data.id === 'string';
}

function formatMetricValue(value: number): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: 3 });
}

function CaseRow({
  testCase,
  isSelected,
  onSelect,
}: {
  testCase: QaTestCase;
  isSelected: boolean;
  onSelect: (testCase: QaTestCase) => void;
}) {
  const [detailOpen, setDetailOpen] = useState(false);
  const hasFailureDetail = Boolean(testCase.failure_detail);

  return (
    <div className={`rounded-md border p-2.5 transition-colors ${isSelected ? 'border-primary/50 bg-primary/5' : 'hover:bg-muted/30'}`}>
      <div className="flex items-start gap-2">
        <Badge variant="outline" className={`mt-0.5 text-[10px] ${caseStatusColor(testCase.status)}`}>
          {caseStatusLabel(testCase.status)}
        </Badge>
        <div className="min-w-0 flex-1">
          <button
            type="button"
            className="block max-w-full text-left text-xs font-medium text-primary underline-offset-2 hover:underline"
            onClick={() => onSelect(testCase)}
            title={testCase.name}
          >
            {testCase.suite ? `${testCase.suite} → ` : ''}{testCase.name}
          </button>
          {testCase.file && <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">{testCase.file}</p>}
          {testCase.failure_message && <p className="mt-1 whitespace-pre-wrap break-words text-xs text-destructive">{testCase.failure_message}</p>}
        </div>
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground" title="This case's own duration">
          Case time {formatCaseDuration(testCase.duration_ms)}
        </span>
      </div>
      {hasFailureDetail && (
        <Collapsible open={detailOpen} onOpenChange={setDetailOpen}>
          <CollapsibleTrigger asChild>
            <button type="button" className="mt-2 flex items-center gap-1 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
              {detailOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              {detailOpen ? 'Hide failure detail' : 'Show failure detail'}
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre className="mt-2 max-h-64 overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-2 font-mono text-[11px] leading-4">{testCase.failure_detail}</pre>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}

function CaseGroup({
  label,
  cases,
  open,
  onOpenChange,
  selectedCaseKey,
  onSelect,
}: {
  label: string;
  cases: QaTestCase[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedCaseKey: string | null;
  onSelect: (testCase: QaTestCase) => void;
}) {
  if (cases.length === 0) return null;

  const unknownCount = cases.filter((testCase) => testCase.status !== 'skipped').length;
  const countLabel = label === 'skipped' && unknownCount > 0
    ? `${cases.length} skipped / other`
    : `${cases.length} ${label}`;

  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <CollapsibleTrigger asChild>
        <button type="button" className="flex w-full items-center justify-between rounded-md border px-2.5 py-2 text-left text-xs font-medium transition-colors hover:bg-muted/40">
          <span className="flex items-center gap-1.5">
            {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            {countLabel}
          </span>
          <span className="text-[10px] text-muted-foreground">{open ? 'Collapse' : 'Expand'}</span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1.5 space-y-1.5">
        {cases.map((testCase) => (
          <CaseRow
            key={testCase.id}
            testCase={testCase}
            isSelected={testCase.case_key === selectedCaseKey}
            onSelect={onSelect}
          />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

function HistoryEntry({
  entry,
  source,
  sourceOpen,
  sourceLoading,
  sourceError,
  onToggleSource,
  onDuplicate,
  isDuplicating,
  duplicateError,
}: {
  entry: QaCaseHistoryEntry;
  source?: QaTestSource;
  sourceOpen: boolean;
  sourceLoading: boolean;
  sourceError?: string;
  onToggleSource: (sha: string) => void;
  onDuplicate: () => void;
  isDuplicating: boolean;
  duplicateError?: string;
}) {
  return (
    <div className="rounded-md border p-2.5">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1.5">
        <div className="flex min-w-[132px] items-center gap-2">
          <Badge variant="outline" className={`text-[10px] ${caseStatusColor(entry.status)}`}>
            {caseStatusLabel(entry.status)}
          </Badge>
          <span className="text-xs text-muted-foreground">{formatDateTime(entry.started_at)}</span>
        </div>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          <span title="This case's own duration"><span className="font-medium text-foreground">Case time</span> {formatCaseDuration(entry.case_duration_ms)}</span>
          <span title="The whole run's wall-clock duration"><span className="font-medium text-foreground">Run total</span> {formatCaseDuration(entry.run_duration_ms)}</span>
          {entry.commit_sha && (
            <span className="inline-flex items-center gap-1" title={entry.commit_sha}>
              <GitCommitHorizontal className="h-3 w-3" />{shortSha(entry.commit_sha)}
            </span>
          )}
          {entry.branch && (
            <span className="inline-flex min-w-0 items-center gap-1">
              <GitBranch className="h-3 w-3 shrink-0" /><span className="truncate">{entry.branch}</span>
            </span>
          )}
          {entry.source_sha && (
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 text-[11px]"
                onClick={() => onToggleSource(entry.source_sha as string)}
              >
                <Code2 className="h-3 w-3" />
                {sourceLoading ? 'Loading source…' : sourceOpen ? 'Hide source' : 'View source'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 text-[11px]"
                onClick={onDuplicate}
                disabled={isDuplicating}
              >
                <Copy className="h-3 w-3" />
                {isDuplicating ? 'Duplicating…' : 'Duplicate'}
              </Button>
            </div>
          )}
        </div>
      </div>
      {sourceError && <p className="mt-2 text-xs text-destructive" role="alert">{sourceError}</p>}
      {duplicateError && <p className="mt-2 text-xs text-destructive" role="alert">{duplicateError}</p>}
      {sourceOpen && source && (
        <div className="mt-2 rounded-md border bg-muted/20 p-2">
          <div className="mb-2 flex items-center gap-2 text-[10px] text-muted-foreground">
            <span className="min-w-0 truncate font-mono">{source.file}</span>
            {source.language && <Badge variant="secondary" className="text-[10px]">{source.language}</Badge>}
          </div>
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 font-mono text-[11px] leading-4">{source.body}</pre>
        </div>
      )}
    </div>
  );
}

function MetricsChart({ metrics }: { metrics: QaRunMetric[] }) {
  const series = useMemo<MetricSeries[]>(() => {
    const uniqueMetrics = new Map<string, QaRunMetric>();
    for (const metric of metrics) {
      if (!uniqueMetrics.has(metric.metric_key)) uniqueMetrics.set(metric.metric_key, metric);
    }
    return [...uniqueMetrics.values()].map((metric, index) => ({ metric, dataKey: `metric_${index}` }));
  }, [metrics]);

  const chartConfig = useMemo<ChartConfig>(() => {
    const config: ChartConfig = {};
    series.forEach(({ metric, dataKey }, index) => {
      config[dataKey] = {
        label: metric.unit ? `${metric.metric_key} (${metric.unit})` : metric.metric_key,
        color: `var(--chart-${(index % 5) + 1})`,
      };
    });
    return config;
  }, [series]);

  const chartData = useMemo(() => {
    if (series.length === 0) return [];
    return [{
      label: 'Selected run',
      ...Object.fromEntries(series.map(({ metric, dataKey }) => [dataKey, metric.value])),
    }];
  }, [series]);

  const units = [...new Set(series.map(({ metric }) => metric.unit).filter((unit): unit is string => Boolean(unit)))];

  return (
    <div>
      <ChartContainer config={chartConfig} className="h-[240px] w-full">
        <LineChart data={chartData} margin={{ left: 8, right: 12, top: 10, bottom: 8 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="label" tickLine={false} axisLine={false} />
          <YAxis
            tickLine={false}
            axisLine={false}
            width={48}
            label={units.length === 1 ? { value: units[0], angle: -90, position: 'insideLeft' } : undefined}
          />
          <ChartTooltip
            content={(
              <ChartTooltipContent
                labelFormatter={() => 'Selected run'}
                formatter={(value, name) => (
                  <div className="flex flex-1 items-center justify-between gap-3">
                    <span className="text-muted-foreground">{chartConfig[String(name)]?.label ?? String(name)}</span>
                    <span className="font-mono font-medium tabular-nums text-foreground">{formatMetricValue(Number(value))}</span>
                  </div>
                )}
              />
            )}
          />
          <ChartLegend content={<ChartLegendContent />} />
          {series.map(({ dataKey }) => (
            <Line
              key={dataKey}
              dataKey={dataKey}
              type="monotone"
              stroke={`var(--color-${dataKey})`}
              strokeWidth={2}
              dot={{ r: 4 }}
              activeDot={{ r: 5 }}
            />
          ))}
        </LineChart>
      </ChartContainer>
      <div className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
        {series.map(({ metric }) => (
          <div key={metric.metric_key} className="flex items-center justify-between gap-3 rounded-md bg-muted/30 px-2.5 py-1.5 text-xs">
            <span className="min-w-0 truncate text-muted-foreground">{metric.metric_key}</span>
            <span className="shrink-0 font-mono font-medium tabular-nums">{formatMetricValue(metric.value)}{metric.unit ? ` ${metric.unit}` : ''}</span>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[10px] text-muted-foreground">Snapshot of the metrics recorded for this run; each line contains one sample.</p>
    </div>
  );
}

export function QaTestsPanel({ projectId, onOpenPlan, onPlanCreated, run }: QaTestsPanelProps) {
  const runId = run.id;
  const runKind = run.kind ?? 'manual';
  const totalCases = run.total_cases ?? 0;
  const [casesByRun, setCasesByRun] = useState<Record<string, CachedCases>>({});
  const [caseLoadingByRun, setCaseLoadingByRun] = useState<Record<string, boolean>>({});
  const [caseErrorByRun, setCaseErrorByRun] = useState<Record<string, string>>({});
  const caseRequestsRef = useRef(new Set<string>());
  const [expandedGroups, setExpandedGroups] = useState({ passed: false, skipped: false });

  const [selectedCase, setSelectedCase] = useState<QaTestCase | null>(null);
  const [historyByCaseKey, setHistoryByCaseKey] = useState<Record<string, QaCaseHistoryEntry[]>>({});
  const [historyLoadingByCaseKey, setHistoryLoadingByCaseKey] = useState<Record<string, boolean>>({});
  const [historyErrorByCaseKey, setHistoryErrorByCaseKey] = useState<Record<string, string>>({});
  const historyRequestsRef = useRef(new Set<string>());

  const [sourceBySha, setSourceBySha] = useState<Record<string, QaTestSource>>({});
  const [sourceLoadingBySha, setSourceLoadingBySha] = useState<Record<string, boolean>>({});
  const [sourceErrorBySha, setSourceErrorBySha] = useState<Record<string, string>>({});
  const [sourceOpenSha, setSourceOpenSha] = useState<string | null>(null);
  const sourceByShaRef = useRef<Record<string, QaTestSource>>({});
  const sourceRequestsRef = useRef(new Map<string, Promise<QaTestSource | null>>());

  const [duplicatingCaseKey, setDuplicatingCaseKey] = useState<string | null>(null);
  const [duplicateErrorByCaseKey, setDuplicateErrorByCaseKey] = useState<Record<string, string>>({});
  const duplicateRequestsRef = useRef(new Set<string>());

  const [metricsByRun, setMetricsByRun] = useState<Record<string, QaRunMetric[]>>({});
  const [metricsLoadingByRun, setMetricsLoadingByRun] = useState<Record<string, boolean>>({});
  const [metricsErrorByRun, setMetricsErrorByRun] = useState<Record<string, string>>({});
  const metricsRequestsRef = useRef(new Set<string>());

  const loadCases = useCallback(async (targetRunId: string) => {
    if (casesByRun[targetRunId] || caseRequestsRef.current.has(targetRunId)) return;
    caseRequestsRef.current.add(targetRunId);
    setCaseLoadingByRun((current) => ({ ...current, [targetRunId]: true }));
    setCaseErrorByRun((current) => {
      const next = { ...current };
      delete next[targetRunId];
      return next;
    });

    try {
      const res = await fetch(`/api/projects/${projectId}/qa/runs/${targetRunId}/cases?limit=500&offset=0`);
      const data: unknown = await res.json().catch(() => null);
      const apiError = responseError(data);
      if (!res.ok || apiError) throw new Error(apiError ?? `Failed to load test cases (${res.status})`);
      if (!isCasesResponse(data)) throw new Error('The test cases response was not in the expected format.');
      setCasesByRun((current) => ({ ...current, [targetRunId]: { cases: data.cases, total: data.total } }));
    } catch (error) {
      setCaseErrorByRun((current) => ({ ...current, [targetRunId]: errorMessage(error, 'Failed to load test cases') }));
    } finally {
      caseRequestsRef.current.delete(targetRunId);
      setCaseLoadingByRun((current) => {
        const next = { ...current };
        delete next[targetRunId];
        return next;
      });
    }
  }, [casesByRun, projectId]);

  useEffect(() => {
    if (totalCases > 0) void loadCases(runId);
  }, [loadCases, runId, totalCases]);

  useEffect(() => {
    setExpandedGroups({ passed: false, skipped: false });
    setSelectedCase(null);
    setSourceOpenSha(null);
  }, [runId]);

  const loadHistory = useCallback(async (caseKey: string) => {
    if (historyByCaseKey[caseKey] || historyRequestsRef.current.has(caseKey)) return;
    historyRequestsRef.current.add(caseKey);
    setHistoryLoadingByCaseKey((current) => ({ ...current, [caseKey]: true }));
    setHistoryErrorByCaseKey((current) => {
      const next = { ...current };
      delete next[caseKey];
      return next;
    });

    try {
      const query = new URLSearchParams({ case_key: caseKey, limit: '50' });
      const res = await fetch(`/api/projects/${projectId}/qa/cases/history?${query}`);
      const data: unknown = await res.json().catch(() => null);
      const apiError = responseError(data);
      if (!res.ok || apiError) throw new Error(apiError ?? `Failed to load case history (${res.status})`);
      if (!Array.isArray(data)) throw new Error('The case history response was not an array.');
      const history = (data as QaCaseHistoryEntry[]).slice().sort(
        (left, right) => new Date(right.started_at).getTime() - new Date(left.started_at).getTime(),
      );
      setHistoryByCaseKey((current) => ({ ...current, [caseKey]: history }));
    } catch (error) {
      setHistoryErrorByCaseKey((current) => ({ ...current, [caseKey]: errorMessage(error, 'Failed to load case history') }));
    } finally {
      historyRequestsRef.current.delete(caseKey);
      setHistoryLoadingByCaseKey((current) => {
        const next = { ...current };
        delete next[caseKey];
        return next;
      });
    }
  }, [historyByCaseKey, projectId]);

  const handleCaseSelect = useCallback((testCase: QaTestCase) => {
    setSelectedCase(testCase);
    void loadHistory(testCase.case_key);
  }, [loadHistory]);

  const loadSource = useCallback(async (sourceSha: string): Promise<QaTestSource | null> => {
    const cachedSource = sourceByShaRef.current[sourceSha];
    if (cachedSource) return cachedSource;

    const existingRequest = sourceRequestsRef.current.get(sourceSha);
    if (existingRequest) return existingRequest;

    const request = (async () => {
      setSourceLoadingBySha((current) => ({ ...current, [sourceSha]: true }));
      setSourceErrorBySha((current) => {
        const next = { ...current };
        delete next[sourceSha];
        return next;
      });

      try {
        const res = await fetch(`/api/projects/${projectId}/qa/test-sources/${encodeURIComponent(sourceSha)}`);
        const data: unknown = await res.json().catch(() => null);
        const apiError = responseError(data);
        if (!res.ok || apiError) throw new Error(apiError ?? `Failed to load test source (${res.status})`);
        if (!isTestSource(data)) throw new Error('The test source response was not in the expected format.');
        sourceByShaRef.current[sourceSha] = data;
        setSourceBySha((current) => ({ ...current, [sourceSha]: data }));
        return data;
      } catch (error) {
        setSourceErrorBySha((current) => ({ ...current, [sourceSha]: errorMessage(error, 'Failed to load test source') }));
        return null;
      } finally {
        sourceRequestsRef.current.delete(sourceSha);
        setSourceLoadingBySha((current) => {
          const next = { ...current };
          delete next[sourceSha];
          return next;
        });
      }
    })();

    sourceRequestsRef.current.set(sourceSha, request);
    return request;
  }, [projectId]);

  const toggleSource = useCallback((sourceSha: string) => {
    setSourceOpenSha((current) => (current === sourceSha ? null : sourceSha));
    void loadSource(sourceSha);
  }, [loadSource]);

  const handleDuplicate = useCallback(async (testCase: QaTestCase, entry: QaCaseHistoryEntry) => {
    const caseKey = testCase.case_key;
    const sourceSha = entry.source_sha;
    if (!sourceSha || duplicateRequestsRef.current.has(caseKey)) return;

    duplicateRequestsRef.current.add(caseKey);
    setDuplicatingCaseKey(caseKey);
    setDuplicateErrorByCaseKey((current) => {
      const next = { ...current };
      delete next[caseKey];
      return next;
    });

    try {
      const source = await loadSource(sourceSha);
      if (!source) throw new Error('Failed to load test source');

      const res = await fetch(`/api/projects/${projectId}/qa/plans`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: duplicatePlanName(testCase.name, testCase.suite),
          kind: planKindForSource(run.runner ?? null, source.file),
          language: planLanguageForSource(source.language),
          description: duplicateDescription({
            case_key: testCase.case_key,
            file: source.file,
            status: entry.status,
            run_id: entry.run_id,
            started_at: entry.started_at,
            commit_sha: entry.commit_sha,
            branch: entry.branch,
            source_sha: sourceSha,
          }),
          body: source.body,
          created_by: 'agent',
        }),
      });
      const data: unknown = await res.json().catch(() => null);
      const apiError = responseError(data);
      if (!res.ok || apiError) throw new Error(apiError ?? `Failed to duplicate test (${res.status})`);
      if (!isCreatedPlan(data)) {
        throw new Error('The created QA plan response was not in the expected format.');
      }

      onPlanCreated?.();
      toast.success('Plan created', onOpenPlan
        ? { action: { label: 'Open plan', onClick: () => onOpenPlan(data.id) } }
        : undefined);
    } catch (error) {
      setDuplicateErrorByCaseKey((current) => ({
        ...current,
        [caseKey]: errorMessage(error, 'Failed to duplicate test as a plan'),
      }));
    } finally {
      duplicateRequestsRef.current.delete(caseKey);
      setDuplicatingCaseKey((current) => (current === caseKey ? null : current));
    }
  }, [loadSource, onOpenPlan, onPlanCreated, projectId, run.runner]);

  const loadMetrics = useCallback(async (targetRunId: string) => {
    if (metricsByRun[targetRunId] !== undefined || metricsRequestsRef.current.has(targetRunId)) return;
    metricsRequestsRef.current.add(targetRunId);
    setMetricsLoadingByRun((current) => ({ ...current, [targetRunId]: true }));
    setMetricsErrorByRun((current) => {
      const next = { ...current };
      delete next[targetRunId];
      return next;
    });

    try {
      const res = await fetch(`/api/projects/${projectId}/qa/metrics?run_id=${encodeURIComponent(targetRunId)}`);
      const data: unknown = await res.json().catch(() => null);
      const apiError = responseError(data);
      if (!res.ok || apiError) throw new Error(apiError ?? `Failed to load load metrics (${res.status})`);
      if (!isMetricsResponse(data)) throw new Error('The load metrics response was not in the expected format.');
      setMetricsByRun((current) => ({ ...current, [targetRunId]: data.metrics }));
    } catch (error) {
      setMetricsErrorByRun((current) => ({ ...current, [targetRunId]: errorMessage(error, 'Failed to load load metrics') }));
    } finally {
      metricsRequestsRef.current.delete(targetRunId);
      setMetricsLoadingByRun((current) => {
        const next = { ...current };
        delete next[targetRunId];
        return next;
      });
    }
  }, [metricsByRun, projectId]);

  useEffect(() => {
    if (runKind === 'load') void loadMetrics(runId);
  }, [loadMetrics, runId, runKind]);

  const cachedCases = casesByRun[runId];
  const casePartition = useMemo(
    () => (cachedCases ? partitionCases(cachedCases.cases) : null),
    [cachedCases],
  );
  const selectedHistory = selectedCase ? historyByCaseKey[selectedCase.case_key] : undefined;
  const selectedHistoryLoading = selectedCase ? historyLoadingByCaseKey[selectedCase.case_key] : false;
  const selectedHistoryError = selectedCase ? historyErrorByCaseKey[selectedCase.case_key] : undefined;
  const historySummary = selectedHistory ? caseHistorySummary(selectedHistory) : null;
  const metrics = metricsByRun[runId];
  const metricsLoading = metricsLoadingByRun[runId] ?? false;
  const metricsError = metricsErrorByRun[runId];

  return (
    <div className="flex flex-col">
      {totalCases > 0 && (
        <section className="border-b py-3" aria-label="Test cases">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <Activity className="h-3.5 w-3.5 text-primary" />
                <p className="text-xs font-semibold">Test cases</p>
              </div>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {cachedCases ? `${cachedCases.total} recorded case${cachedCases.total === 1 ? '' : 's'}` : `${totalCases} case${totalCases === 1 ? '' : 's'} in this run`}
              </p>
            </div>
            {casePartition && <Badge variant="outline" className={`text-[10px] ${casePartition.failed.length > 0 ? 'border-red-400 text-red-600 dark:text-red-400' : 'border-green-400 text-green-600 dark:text-green-400'}`}>{casePartition.failed.length} failing</Badge>}
          </div>

          {(caseLoadingByRun[runId] || (!cachedCases && !caseErrorByRun[runId])) && (
            <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
              <RefreshCw className="h-3.5 w-3.5 animate-spin" /> Loading test cases…
            </div>
          )}
          {caseErrorByRun[runId] && (
            <div className="mt-3 flex items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/5 px-2.5 py-2 text-xs text-destructive" role="alert">
              <span>{caseErrorByRun[runId]}</span>
              <Button variant="outline" size="sm" className="h-7 shrink-0 text-[11px]" onClick={() => void loadCases(runId)}>Retry</Button>
            </div>
          )}

          {casePartition && (
            <div className="mt-3 space-y-1.5">
              {casePartition.failed.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-destructive">Failures first</p>
                  {casePartition.failed.map((testCase) => (
                    <CaseRow
                      key={testCase.id}
                      testCase={testCase}
                      isSelected={testCase.case_key === selectedCase?.case_key}
                      onSelect={handleCaseSelect}
                    />
                  ))}
                </div>
              )}
              <CaseGroup
                label="passed"
                cases={casePartition.passed}
                open={expandedGroups.passed}
                onOpenChange={(open) => setExpandedGroups((current) => ({ ...current, passed: open }))}
                selectedCaseKey={selectedCase?.case_key ?? null}
                onSelect={handleCaseSelect}
              />
              <CaseGroup
                label="skipped"
                cases={casePartition.skipped}
                open={expandedGroups.skipped}
                onOpenChange={(open) => setExpandedGroups((current) => ({ ...current, skipped: open }))}
                selectedCaseKey={selectedCase?.case_key ?? null}
                onSelect={handleCaseSelect}
              />
              {casePartition.failed.length === 0 && casePartition.passed.length === 0 && casePartition.skipped.length === 0 && (
                <p className="py-3 text-xs text-muted-foreground">The run reported cases, but none were returned.</p>
              )}
            </div>
          )}
        </section>
      )}

      {selectedCase && (
        <section className="border-b py-3" aria-label="Case history">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <History className="h-3.5 w-3.5 text-primary" />
                <p className="text-xs font-semibold">Case history</p>
              </div>
              <p className="mt-0.5 truncate text-[11px] text-muted-foreground" title={selectedCase.case_key}>{selectedCase.name}</p>
            </div>
            <Button variant="ghost" size="sm" className="h-7 shrink-0 text-[11px]" onClick={() => setSelectedCase(null)}>Close</Button>
          </div>

          {selectedHistoryLoading && (
            <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
              <RefreshCw className="h-3.5 w-3.5 animate-spin" /> Loading history…
            </div>
          )}
          {selectedHistoryError && (
            <div className="mt-3 flex items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/5 px-2.5 py-2 text-xs text-destructive" role="alert">
              <span>{selectedHistoryError}</span>
              <Button variant="outline" size="sm" className="h-7 shrink-0 text-[11px]" onClick={() => void loadHistory(selectedCase.case_key)}>Retry</Button>
            </div>
          )}

          {selectedHistory && (
            selectedHistory.length === 0 ? (
              <p className="mt-3 text-xs text-muted-foreground">No history recorded for this case yet.</p>
            ) : (
              <div className="mt-3 space-y-2">
                {historySummary?.firstFailingRunId && historySummary.firstFailingStartedAt && (
                  <div className="rounded-md border border-red-400/50 bg-red-500/5 px-2.5 py-2 text-xs text-red-700 dark:text-red-300">
                    Started failing in the run from {formatDateTime(historySummary.firstFailingStartedAt)} · run <code className="font-mono">{shortSha(historySummary.firstFailingRunId)}</code>
                  </div>
                )}
                <div className="flex items-center gap-1.5 overflow-x-auto pb-1" aria-label="Case status timeline">
                  <span className="shrink-0 text-[10px] text-muted-foreground">Newest</span>
                  {selectedHistory.map((entry, index) => (
                    <div key={`${entry.run_id}-${entry.started_at}`} className="flex shrink-0 items-center gap-1.5">
                      <Badge variant="outline" className={`text-[10px] ${caseStatusColor(entry.status)}`} title={`${entry.status} · ${formatDateTime(entry.started_at)}`}>
                        {caseStatusLabel(entry.status)}
                      </Badge>
                      {index < selectedHistory.length - 1 && <span className="text-muted-foreground/50">→</span>}
                    </div>
                  ))}
                  <span className="shrink-0 text-[10px] text-muted-foreground">Oldest</span>
                </div>
                <div className="space-y-1.5">
                  {selectedHistory.map((entry) => (
                    <HistoryEntry
                      key={`${entry.run_id}-${entry.started_at}-detail`}
                      entry={entry}
                      source={entry.source_sha ? sourceBySha[entry.source_sha] : undefined}
                      sourceOpen={entry.source_sha === sourceOpenSha}
                      sourceLoading={entry.source_sha ? sourceLoadingBySha[entry.source_sha] ?? false : false}
                      sourceError={entry.source_sha ? sourceErrorBySha[entry.source_sha] : undefined}
                      onToggleSource={toggleSource}
                      onDuplicate={() => void handleDuplicate(selectedCase, entry)}
                      isDuplicating={duplicatingCaseKey === selectedCase.case_key}
                      duplicateError={duplicateErrorByCaseKey[selectedCase.case_key]}
                    />
                  ))}
                </div>
              </div>
            )
          )}
        </section>
      )}

      {runKind === 'load' && (
        <section className="border-b py-3" aria-label="Load metrics">
          <div className="flex items-center gap-1.5">
            <Activity className="h-3.5 w-3.5 text-primary" />
            <p className="text-xs font-semibold">Load metrics</p>
          </div>
          <p className="mt-0.5 text-[11px] text-muted-foreground">Recorded measurements for this load run.</p>
          {metricsLoading && (
            <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
              <RefreshCw className="h-3.5 w-3.5 animate-spin" /> Loading load metrics…
            </div>
          )}
          {metricsError && (
            <div className="mt-3 flex items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/5 px-2.5 py-2 text-xs text-destructive" role="alert">
              <span>{metricsError}</span>
              <Button variant="outline" size="sm" className="h-7 shrink-0 text-[11px]" onClick={() => void loadMetrics(runId)}>Retry</Button>
            </div>
          )}
          {metrics && metrics.length > 0 && <div className="mt-3"><MetricsChart metrics={metrics} /></div>}
          {metrics && metrics.length === 0 && <p className="mt-3 text-xs text-muted-foreground">No load metrics recorded for this run.</p>}
        </section>
      )}
    </div>
  );
}
