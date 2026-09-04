'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { History, RefreshCw, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import {
  diffQaPlanBodies,
  formatQaPlanRevisionLabel,
  formatQaPlanVersionLabel,
  LIVE_VERSION_KEY,
  summarizeQaPlanDiff,
  type QaPlan,
  type QaPlanDiffLine,
  type QaPlanRevisionDetail,
  type QaPlanRevisionSummary,
} from '@/lib/qa-plan-history';

interface QaPlanHistorySheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  plan: QaPlan | null;
  onRestored?: (plan: QaPlan) => void;
}

type VersionData = Pick<QaPlanRevisionDetail, 'name' | 'kind' | 'language' | 'description' | 'body'>;
type PlanContent = Pick<QaPlan, 'name' | 'kind' | 'language' | 'description' | 'body'>;

function dataForPlan(plan: PlanContent): VersionData {
  return {
    name: plan.name,
    kind: plan.kind,
    language: plan.language,
    description: plan.description,
    body: plan.body,
  };
}

function formatCreatedAt(value: string): string {
  return new Date(value).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function lineClass(kind: QaPlanDiffLine['kind']): string {
  if (kind === 'added') return 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
  if (kind === 'removed') return 'bg-red-500/10 text-red-700 dark:text-red-300';
  return 'text-muted-foreground';
}

export function QaPlanHistorySheet({ open, onOpenChange, projectId, plan, onRestored }: QaPlanHistorySheetProps) {
  const [revisions, setRevisions] = useState<QaPlanRevisionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [baseKey, setBaseKey] = useState(LIVE_VERSION_KEY);
  const [headKey, setHeadKey] = useState(LIVE_VERSION_KEY);
  const [versions, setVersions] = useState<Record<string, VersionData>>({});
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState<number | null>(null);
  const [restoring, setRestoring] = useState(false);

  const load = useCallback(async () => {
    if (!plan) return;
    setLoading(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/qa/plans/${plan.id}/revisions`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Failed to load plan revisions');
      const rows: QaPlanRevisionSummary[] = data.revisions ?? [];
      setRevisions(rows);
      setBaseKey(rows.length ? String(rows[0].revision_num) : LIVE_VERSION_KEY);
      setHeadKey(LIVE_VERSION_KEY);
      setVersions({});
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to load plan revisions');
    } finally {
      setLoading(false);
    }
  }, [plan, projectId]);

  useEffect(() => {
    if (!open) return;
    setRevisions([]);
    setVersions({});
    setBaseKey(LIVE_VERSION_KEY);
    setHeadKey(LIVE_VERSION_KEY);
    void load();
  }, [load, open]);

  const selectedKeys = useMemo(() => Array.from(new Set([baseKey, headKey])), [baseKey, headKey]);

  useEffect(() => {
    if (!open || !plan) return;
    const missing = selectedKeys.filter((key) => key !== LIVE_VERSION_KEY && !(key in versions));
    if (missing.length === 0) {
      setVersionsLoading(false);
      return;
    }

    let cancelled = false;
    setVersionsLoading(true);
    Promise.all(missing.map(async (key) => {
      const response = await fetch(`/api/projects/${projectId}/qa/plans/${plan.id}/revisions/${key}`);
      const data: unknown = await response.json();
      if (!response.ok) {
        const message = typeof data === 'object' && data !== null && 'error' in data
          ? String(data.error)
          : `Failed to load revision ${key}`;
        throw new Error(message);
      }
      return [key, dataForPlan(data as QaPlanRevisionDetail)] as const;
    }))
      .then((loaded) => {
        if (!cancelled) setVersions((current) => ({ ...current, ...Object.fromEntries(loaded) }));
      })
      .catch((error) => {
        if (!cancelled) toast.error(error instanceof Error ? error.message : 'Failed to load plan revision');
      })
      .finally(() => {
        if (!cancelled) setVersionsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, plan, projectId, selectedKeys, versions]);

  const comparison = useMemo(() => {
    if (!plan) return null;
    const base = baseKey === LIVE_VERSION_KEY ? dataForPlan(plan) : versions[baseKey];
    const head = headKey === LIVE_VERSION_KEY ? dataForPlan(plan) : versions[headKey];
    if (!base || !head) return null;
    return { base, head, lines: diffQaPlanBodies(base.body, head.body) };
  }, [baseKey, headKey, plan, versions]);

  const restoreTarget = baseKey === LIVE_VERSION_KEY ? null : revisions.find((revision) => String(revision.revision_num) === baseKey) ?? null;
  const versionOptions = (
    <>
      {revisions.map((revision) => (
        <SelectItem key={revision.id} value={String(revision.revision_num)}>
          {formatQaPlanRevisionLabel(revision)}
        </SelectItem>
      ))}
      <SelectItem value={LIVE_VERSION_KEY}>Live (current)</SelectItem>
    </>
  );

  const handleRestore = async () => {
    if (!plan || confirmRestore === null || restoring) return;
    setRestoring(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/qa/plans/${plan.id}/revisions/${confirmRestore}/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ created_by: 'human' }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Failed to restore plan revision');
      toast.success(`Restored ${formatQaPlanVersionLabel(String(confirmRestore), revisions)}`);
      setConfirmRestore(null);
      onRestored?.(data as QaPlan);
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to restore plan revision');
    } finally {
      setRestoring(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-hidden p-0 sm:max-w-2xl">
        <SheetHeader className="border-b bg-[radial-gradient(circle_at_top_right,hsl(var(--primary)/0.12),transparent_48%)] p-5 pr-12">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-primary">
            <History className="h-4 w-4" /> Plan history
          </div>
          <SheetTitle className="text-xl">{plan?.name}</SheetTitle>
          <SheetDescription>Compare frozen versions, inspect their source, or restore one into the live plan.</SheetDescription>
        </SheetHeader>

        <div className="flex min-h-0 flex-1 flex-col">
          {revisions.length > 0 && (
            <div className="space-y-3 border-b px-5 py-3">
              <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Base</Label>
                  <Select value={baseKey} onValueChange={setBaseKey}>
                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>{versionOptions}</SelectContent>
                  </Select>
                </div>
                <span className="mb-2.5 text-xs font-mono text-muted-foreground">vs</span>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Compare</Label>
                  <Select value={headKey} onValueChange={setHeadKey}>
                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>{versionOptions}</SelectContent>
                  </Select>
                </div>
              </div>
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm text-muted-foreground">
                  {comparison ? summarizeQaPlanDiff(comparison.lines) : versionsLoading ? 'Loading revision…' : ''}
                </p>
                <div className="flex items-center gap-1.5">
                  {restoreTarget && (
                    <Button variant="outline" size="sm" className="h-8" onClick={() => setConfirmRestore(restoreTarget.revision_num)}>
                      <RotateCcw className="mr-2 h-4 w-4" /> Restore {`v${restoreTarget.revision_num}`}
                    </Button>
                  )}
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => void load()} disabled={loading} title="Refresh history">
                    <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                  </Button>
                </div>
              </div>
            </div>
          )}

          <div className="flex-1 overflow-y-auto">
            {!loading && revisions.length === 0 && (
              <div className="m-5 rounded-xl border border-dashed px-5 py-12 text-center">
                <History className="mx-auto h-8 w-8 text-muted-foreground/40" />
                <p className="mt-3 font-medium">No revisions yet</p>
                <p className="mt-1 text-sm text-muted-foreground">Save as version to create the first frozen copy of this plan.</p>
              </div>
            )}

            {revisions.length > 0 && (
              <div className="divide-y border-b">
                {revisions.map((revision) => (
                  <button
                    key={revision.id}
                    type="button"
                    className={`flex w-full items-center gap-3 px-5 py-3 text-left transition-colors ${String(revision.revision_num) === baseKey ? 'bg-primary/5' : 'hover:bg-muted/30'}`}
                    onClick={() => setBaseKey(String(revision.revision_num))}
                  >
                    <Badge variant="outline" className="shrink-0 font-mono">v{revision.revision_num}</Badge>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{revision.label?.trim() || 'Automatic snapshot'}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{formatCreatedAt(revision.created_at)}</span>
                  </button>
                ))}
              </div>
            )}

            {comparison && (
              <div className="p-5">
                <div className="mb-3 grid gap-2 sm:grid-cols-2">
                  {([
                    ['Base', baseKey, comparison.base],
                    ['Compare', headKey, comparison.head],
                  ] as const).map(([side, key, value]) => (
                    <div key={String(side)} className="rounded-lg border bg-muted/20 p-3">
                      <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">{side}</p>
                      <p className="mt-1 truncate text-sm font-medium">{formatQaPlanVersionLabel(String(key), revisions)}</p>
                      <p className="mt-1 text-xs text-muted-foreground">{String(value.kind)} · {String(value.language)}</p>
                    </div>
                  ))}
                </div>

                {comparison.lines.length === 0 ? (
                  <p className="py-10 text-center text-sm text-muted-foreground">No changes between these two versions.</p>
                ) : (
                  <div className="overflow-hidden rounded-lg border bg-muted/10 font-mono text-xs">
                    {comparison.lines.map((line, index) => (
                      <div key={`${line.kind}-${line.lineNumber ?? 'removed'}-${index}`} className={`flex gap-3 px-3 py-1 ${lineClass(line.kind)}`}>
                        <span className="w-8 shrink-0 select-none text-right text-muted-foreground/60">{line.lineNumber ?? '—'}</span>
                        <span className="w-3 shrink-0 select-none">{line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}</span>
                        <span className="min-w-0 whitespace-pre-wrap break-words">{line.text || ' '}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </SheetContent>

      <AlertDialog open={confirmRestore !== null} onOpenChange={(open) => !open && setConfirmRestore(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restore {confirmRestore === null ? '' : formatQaPlanVersionLabel(String(confirmRestore), revisions)}?</AlertDialogTitle>
            <AlertDialogDescription>The current live plan will be preserved as an automatic revision first, so this restore can be undone from history.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={restoring}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={(event) => { event.preventDefault(); void handleRestore(); }} disabled={restoring}>
              {restoring ? 'Restoring…' : 'Restore version'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Sheet>
  );
}
