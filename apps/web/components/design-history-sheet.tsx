'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowRight, Camera, Columns2, History, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { DesignCompareDialog } from '@/components/design-compare-dialog';
import { diffDesignGraphs, toDiffGraph, type DiffEntry } from '@/lib/design-diff';
import type { DesignDiagramType } from '@/lib/design-graph';
import { diffHighlightMap, highlightDrawioCells } from '@/lib/design-highlight';
import {
  DIFF_KIND_STYLES,
  describeDiffEntry,
  formatRevisionLabel,
  summarizeDiff,
  type DesignRevisionSummary,
} from '@/lib/design-history';

interface DesignHistorySheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  design: { id: string; title: string; diagram_type: string; kind: string; source: string } | null;
}

// The live design is not a revision — it has no revision_num — so it needs a key of its own in the
// two pickers. Revision keys are the revision number as a string (always >= 1, so no collision,
// and never '', which Radix's Select reserves).
const LIVE_KEY = 'live';

// The resolved sources ride along with the entries so the side-by-side dialog doesn't have to
// repeat the LIVE_KEY-vs-revision lookup below and risk drifting from what was actually diffed.
type Comparison =
  | { status: 'pending' }
  | { status: 'not-diffable' }
  | { status: 'ready'; entries: DiffEntry[]; baseSource: string; headSource: string };

export function DesignHistorySheet({ open, onOpenChange, projectId, design }: DesignHistorySheetProps) {
  const [revisions, setRevisions] = useState<DesignRevisionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [baseKey, setBaseKey] = useState(LIVE_KEY);
  const [headKey, setHeadKey] = useState(LIVE_KEY);
  // Revision sources, keyed by revision number — the listing endpoint omits `source`, so each side
  // is fetched on demand and kept so flipping the pickers back doesn't refetch.
  const [sources, setSources] = useState<Record<string, string>>({});
  const [sourcesLoading, setSourcesLoading] = useState(false);
  const [snapshotLabel, setSnapshotLabel] = useState('');
  const [snapshotting, setSnapshotting] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);

  const load = useCallback(async () => {
    if (!design) return;
    setLoading(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/designs/${design.id}/revisions`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Failed to load revisions');
      const rows: DesignRevisionSummary[] = data.revisions ?? [];
      setRevisions(rows);
      // "What changed since the last save?" is the question this sheet exists to answer, and the
      // list arrives newest-first — so newest revision on the left, live on the right.
      setBaseKey(rows.length ? String(rows[0].revision_num) : LIVE_KEY);
      setHeadKey(LIVE_KEY);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to load revisions');
    } finally { setLoading(false); }
  }, [design, projectId]);

  useEffect(() => {
    // Reset on every open: the sheet is mounted once for whichever design is selected, so a stale
    // list would belong to the previously inspected one — and the live source may have moved on
    // and new revisions been cut since it was last closed.
    // The pickers reset too, and must: they hold a revision NUMBER, which means something
    // different for every design. Left alone, reopening the sheet on another design refetches the
    // previous design's r-number against the new one and 404s before `load` can correct it.
    if (open) {
      setRevisions([]); setSources({}); setSnapshotLabel('');
      setBaseKey(LIVE_KEY); setHeadKey(LIVE_KEY);
      load();
    }
  }, [open, load]);

  const selectedRevisionKeys = useMemo(
    () => [baseKey, headKey].filter((key) => key !== LIVE_KEY),
    [baseKey, headKey],
  );

  useEffect(() => {
    if (!open || !design) return;
    const missing = selectedRevisionKeys.filter((key) => !(key in sources));
    // Clear the flag here too: a run cancelled mid-flight skips its own `finally`, so if the next
    // run has nothing to fetch (both sides flipped back to already-loaded keys) nothing else would.
    if (missing.length === 0) { setSourcesLoading(false); return; }
    let cancelled = false;
    setSourcesLoading(true);
    Promise.all(missing.map(async (key) => {
      const response = await fetch(`/api/projects/${projectId}/designs/${design.id}/revisions/${key}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? `Failed to load revision ${key}`);
      return [key, data.source as string] as const;
    }))
      .then((loaded) => { if (!cancelled) setSources((prev) => ({ ...prev, ...Object.fromEntries(loaded) })); })
      .catch((error) => { if (!cancelled) toast.error(error instanceof Error ? error.message : 'Failed to load revision'); })
      .finally(() => { if (!cancelled) setSourcesLoading(false); });
    return () => { cancelled = true; };
  }, [open, design, projectId, selectedRevisionKeys, sources]);

  const comparison = useMemo<Comparison>(() => {
    if (!design) return { status: 'pending' };
    const baseSource = baseKey === LIVE_KEY ? design.source : sources[baseKey];
    const headSource = headKey === LIVE_KEY ? design.source : sources[headKey];
    if (baseSource === undefined || headSource === undefined) return { status: 'pending' };
    // `diagram_type` is an unconstrained TEXT column server-side; toDiffGraph's default branch
    // already answers null for anything it doesn't recognise, same as it does for pen and text.
    const diagramType = design.diagram_type as DesignDiagramType;
    const base = toDiffGraph(diagramType, baseSource);
    const head = toDiffGraph(diagramType, headSource);
    if (!base || !head) return { status: 'not-diffable' };
    // matchBy 'id' — never 'label' here. Both sides are revisions of ONE design, where cell ids are
    // stable across a move/rename/restyle and so are the real identity; 'label' exists for
    // comparing two DIFFERENT designs and would report this sheet's renames as a delete plus an add.
    return { status: 'ready', entries: diffDesignGraphs(base, head, { matchBy: 'id' }).entries, baseSource, headSource };
  }, [design, sources, baseKey, headKey]);

  // Outlining rewrites mxCell styles, so it only means anything for draw.io — every other diagram
  // type gets the disabled button and its tooltip instead.
  const canCompareSideBySide = design?.diagram_type === 'drawio';

  const highlighted = useMemo(() => {
    if (!canCompareSideBySide || comparison.status !== 'ready') return null;
    return {
      base: highlightDrawioCells(comparison.baseSource, diffHighlightMap(comparison.entries, 'base')),
      head: highlightDrawioCells(comparison.headSource, diffHighlightMap(comparison.entries, 'head')),
    };
  }, [canCompareSideBySide, comparison]);

  /** Picker text for one side's key, so the dialog's pane labels read exactly as the dropdowns do. */
  const versionName = (key: string) => {
    if (key === LIVE_KEY) return 'Live (current)';
    const revision = revisions.find((row) => String(row.revision_num) === key);
    return revision ? formatRevisionLabel(revision) : `r${key}`;
  };

  // The server rejects a snapshot of a pen design (400), since freeform ink has no graph to store
  // a receipt against — don't offer the control at all.
  const canSnapshot = design !== null && design.diagram_type !== 'pen';

  const snapshot = async () => {
    if (!design) return;
    const label = snapshotLabel.trim();
    if (label.length < 1 || label.length > 100) { toast.error('Label the snapshot (1–100 characters)'); return; }
    setSnapshotting(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/designs/${design.id}/revisions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Failed to snapshot design');
      toast.success(`Snapshot saved as r${data.revision_num}`);
      setSnapshotLabel('');
      await load();
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Failed to snapshot design'); }
    finally { setSnapshotting(false); }
  };

  const versionOptions = <>
    {revisions.map((revision) => <SelectItem key={revision.id} value={String(revision.revision_num)}>{formatRevisionLabel(revision)}</SelectItem>)}
    <SelectItem value={LIVE_KEY}>Live (current)</SelectItem>
  </>;

  return <Sheet open={open} onOpenChange={onOpenChange}>
    <SheetContent side="right" className="w-full overflow-hidden p-0 sm:max-w-xl">
      <SheetHeader className="border-b bg-[radial-gradient(circle_at_top_right,hsl(var(--primary)/0.12),transparent_48%)] p-5 pr-12">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-primary"><History className="h-4 w-4" /> Revision history</div>
        <SheetTitle className="text-xl">{design?.title}</SheetTitle>
        <SheetDescription>What changed between two versions of this design.</SheetDescription>
      </SheetHeader>

      <div className="flex min-h-0 flex-1 flex-col">
        {revisions.length > 0 && <div className="space-y-3 border-b px-5 py-3">
          <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
            <div className="space-y-1.5"><Label className="text-xs text-muted-foreground">Base</Label><Select value={baseKey} onValueChange={setBaseKey}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent>{versionOptions}</SelectContent></Select></div>
            <ArrowRight className="mb-2.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="space-y-1.5"><Label className="text-xs text-muted-foreground">Compare</Label><Select value={headKey} onValueChange={setHeadKey}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent>{versionOptions}</SelectContent></Select></div>
          </div>
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">{comparison.status === 'ready' ? summarizeDiff(comparison.entries) : sourcesLoading ? 'Loading revision…' : ''}</p>
            <div className="flex items-center gap-1">
              {canCompareSideBySide ? (
                <Button variant="outline" size="sm" className="h-8" disabled={highlighted === null} onClick={() => setCompareOpen(true)}>
                  <Columns2 className="mr-2 h-4 w-4" />
                  Side by side
                </Button>
              ) : (
                <Tooltip>
                  {/* A disabled button swallows pointer events, so the trigger needs its own wrapper
                      for the tooltip to fire at all. */}
                  <TooltipTrigger asChild><span tabIndex={0}><Button variant="outline" size="sm" className="h-8" disabled><Columns2 className="mr-2 h-4 w-4" />Side by side</Button></span></TooltipTrigger>
                  <TooltipContent className="max-w-xs">Side-by-side comparison is available for draw.io diagrams.</TooltipContent>
                </Tooltip>
              )}
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={load}><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /></Button>
            </div>
          </div>
        </div>}

        <div className="flex-1 overflow-y-auto">
          {!loading && revisions.length === 0 && <div className="m-5 rounded-xl border border-dashed px-5 py-12 text-center">
            <History className="mx-auto h-8 w-8 text-muted-foreground/40" />
            <p className="mt-3 font-medium">No revisions yet</p>
            <p className="mt-1 text-sm text-muted-foreground">A revision is cut automatically each time a design is saved, capturing the state before that save. This design has not been edited since it was created.</p>
          </div>}

          {revisions.length > 0 && comparison.status === 'not-diffable' && <p className="px-5 py-12 text-center text-sm text-muted-foreground">This document type has no graph to compare.</p>}
          {revisions.length > 0 && comparison.status === 'ready' && comparison.entries.length === 0 && <p className="px-5 py-12 text-center text-sm text-muted-foreground">No changes between these two versions.</p>}

          {comparison.status === 'ready' && <div className="divide-y">
            {comparison.entries.map((entry, index) => {
              const view = describeDiffEntry(entry);
              return <div key={`${entry.kind}-${entry.baseId ?? entry.headId ?? ''}-${index}`} className="flex items-start gap-3 px-5 py-3">
                <Badge variant="outline" className={`shrink-0 capitalize ${DIFF_KIND_STYLES[view.kind]}`}>{view.kind}</Badge>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{view.label}</span>
                    <span className="text-xs text-muted-foreground">{view.entity}</span>
                    {view.lowConfidence && <Tooltip>
                      <TooltipTrigger asChild><Badge variant="secondary" className="cursor-help text-[10px]">low confidence</Badge></TooltipTrigger>
                      <TooltipContent className="max-w-xs">More than one equally good candidate existed, so this pairing was resolved by document order.</TooltipContent>
                    </Tooltip>}
                  </div>
                  {(view.before || view.after) && <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 font-mono text-xs text-muted-foreground">
                    <span className="rounded bg-muted px-1.5 py-0.5">{view.before || '—'}</span>
                    <ArrowRight className="h-3 w-3 shrink-0" />
                    <span className="rounded bg-muted px-1.5 py-0.5 text-foreground">{view.after || '—'}</span>
                  </div>}
                </div>
              </div>;
            })}
          </div>}
        </div>

        {canSnapshot && <div className="border-t bg-card p-5">
          <Label className="text-xs text-muted-foreground">Snapshot the live design</Label>
          <div className="mt-1.5 flex gap-2">
            <Input value={snapshotLabel} maxLength={100} placeholder="e.g. before cache rollout" onChange={(event) => setSnapshotLabel(event.target.value)} />
            <Button onClick={snapshot} disabled={snapshotting}><Camera className="mr-2 h-4 w-4" />{snapshotting ? 'Saving…' : 'Snapshot'}</Button>
          </div>
        </div>}
      </div>
    </SheetContent>

    {highlighted && comparison.status === 'ready' && <DesignCompareDialog
      open={compareOpen}
      onOpenChange={setCompareOpen}
      title={design?.title ?? ''}
      kind={design?.kind ?? ''}
      baseName={versionName(baseKey)}
      headName={versionName(headKey)}
      baseSource={highlighted.base}
      headSource={highlighted.head}
      entries={comparison.entries}
    />}
  </Sheet>;
}
