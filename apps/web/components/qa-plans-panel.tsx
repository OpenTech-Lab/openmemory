'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Copy, Download, FileCode, History, Play, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { PLAN_KINDS, planKindColor, planKindLabel } from '@/lib/qa-meta';
import { getStarterTemplate } from '@/lib/qa-plan-templates';
import { planFileExtension, planSlug, runRecipeForPlan, type PlanRunRecipe } from '@/lib/qa-run-command';
import {
  formatQaPlanRevisionLabel,
  formatQaPlanVersionLabel,
  LIVE_VERSION_KEY,
  type QaPlan,
  type QaPlanRevisionDetail,
  type QaPlanRevisionSummary,
} from '@/lib/qa-plan-history';
import { QaPlanHistorySheet } from '@/components/qa-plan-history-sheet';

const PLAN_LANGUAGES = ['typescript', 'javascript', 'yaml', 'python', 'other'] as const;

const EMPTY_FORM = { name: '', kind: 'other' as string, language: 'other' as string, description: '', body: '' };

export function QaPlansPanel({
  projectId,
  focusPlanId,
  focusPlanRevisionNum,
  onCountChange,
  onOpenRun,
  onRunCreated,
}: {
  projectId: string;
  focusPlanId?: string | null;
  focusPlanRevisionNum?: number | null;
  onCountChange?: (count: number) => void;
  onOpenRun?: (runId: string) => void;
  /** Fired after a run is created, so the Runs tab count stays honest while
   *  QaPanel is unmounted. */
  onRunCreated?: () => void;
}) {
  const [plans, setPlans] = useState<QaPlan[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [kindFilter, setKindFilter] = useState<string>('all');
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const focusedPlanIdRef = useRef<string | null>(null);
  const [revisions, setRevisions] = useState<QaPlanRevisionSummary[]>([]);
  const [isLoadingRevisions, setIsLoadingRevisions] = useState(false);
  const [viewVersionKey, setViewVersionKey] = useState(LIVE_VERSION_KEY);
  const [revisionDetails, setRevisionDetails] = useState<Record<string, QaPlanRevisionDetail>>({});
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);

  // Detail pane form — seeded from the selected plan on selection, then edited
  // in place. `isDirty` compares this directly against the selected plan, so
  // a background Refresh never clobbers an in-progress edit.
  const [form, setForm] = useState(EMPTY_FORM);
  const [isSaving, setIsSaving] = useState(false);

  // New plan dialog
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [createForm, setCreateForm] = useState({ name: '', kind: 'jest' as string });
  const [isCreating, setIsCreating] = useState(false);

  // Delete confirmation
  const [deletePlan, setDeletePlan] = useState<QaPlan | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  // Run dialog — the server executes the saved plan; the copy command remains
  // available as the local fallback when a runner is unavailable there.
  const [showRunDialog, setShowRunDialog] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [runVersionKey, setRunVersionKey] = useState(LIVE_VERSION_KEY);
  const [runVersionLoading, setRunVersionLoading] = useState(false);

  // Save-as-version is deliberately separate from Save: the former names a
  // frozen snapshot, while the latter only updates the live working copy.
  const [showVersionDialog, setShowVersionDialog] = useState(false);
  const [versionLabel, setVersionLabel] = useState('');
  const [isSavingVersion, setIsSavingVersion] = useState(false);

  const fetchPlans = useCallback(async () => {
    setIsLoading(true);
    try {
      const params = new URLSearchParams();
      if (kindFilter !== 'all') params.set('kind', kindFilter);
      const res = await fetch(`/api/projects/${projectId}/qa/plans?${params}`);
      const data = await res.json();
      if (!res.ok || data.error) {
        toast.error(data.error ?? 'Failed to load QA plans');
        return;
      }
      const list: QaPlan[] = data.plans ?? [];
      setPlans(list);
      // Unfiltered loads only — see the matching note in qa-panel.tsx's fetchRuns.
      if (kindFilter === 'all') onCountChange?.(list.length);
    } catch {
      toast.error('Failed to connect to server');
    } finally {
      setIsLoading(false);
    }
  }, [projectId, kindFilter, onCountChange]);

  const fetchRevisions = useCallback(async (planId: string) => {
    setIsLoadingRevisions(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/qa/plans/${planId}/revisions`);
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error ?? 'Failed to load plan revisions');
      setRevisions(data.revisions ?? []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to load plan revisions');
      setRevisions([]);
    } finally {
      setIsLoadingRevisions(false);
    }
  }, [projectId]);

  useEffect(() => {
    fetchPlans();
  }, [fetchPlans]);

  useEffect(() => {
    if (!selectedPlanId) {
      setRevisions([]);
      setViewVersionKey(LIVE_VERSION_KEY);
      setRevisionDetails({});
      return;
    }
    void fetchRevisions(selectedPlanId);
  }, [fetchRevisions, selectedPlanId]);

  const selectPlan = useCallback((plan: QaPlan | null) => {
    setSelectedPlanId(plan?.id ?? null);
    setViewVersionKey(LIVE_VERSION_KEY);
    setRevisionDetails({});
    setRunVersionKey(LIVE_VERSION_KEY);
    setForm(
      plan
        ? { name: plan.name, kind: plan.kind, language: plan.language, description: plan.description ?? '', body: plan.body }
        : EMPTY_FORM
    );
  }, []);

  // Falls back to the first plan once nothing is selected or the selected one
  // disappears (e.g. deleted by another client) — mirrors qa-panel's run list.
  // Only fires on that fallback case, not on every background refetch, so an
  // in-progress edit in the detail pane survives a Refresh.
  useEffect(() => {
    if (!focusPlanId) focusedPlanIdRef.current = null;
    const focusedPlan = focusPlanId ? plans.find((plan) => plan.id === focusPlanId) : null;
    if (focusPlanId && focusedPlanIdRef.current !== focusPlanId) {
      if (!focusedPlan) return;
      focusedPlanIdRef.current = focusPlanId;
      selectPlan(focusedPlan);
      return;
    }
    if (selectedPlanId && plans.some((p) => p.id === selectedPlanId)) return;
    selectPlan(plans[0] ?? null);
  }, [focusPlanId, plans, selectPlan, selectedPlanId]);

  const selectedPlan = plans.find((p) => p.id === selectedPlanId) ?? null;
  const isViewingRevision = viewVersionKey !== LIVE_VERSION_KEY;

  const loadRevisionDetail = useCallback(async (planId: string, versionKey: string): Promise<QaPlanRevisionDetail> => {
    const response = await fetch(`/api/projects/${projectId}/qa/plans/${planId}/revisions/${versionKey}`);
    const data = await response.json();
    if (!response.ok || data.error) throw new Error(data.error ?? `Failed to load revision ${versionKey}`);
    const revision = data as QaPlanRevisionDetail;
    setRevisionDetails((current) => ({ ...current, [versionKey]: revision }));
    return revision;
  }, [projectId]);

  // A frozen version is a read-only view. The live key remains the only state
  // that can be edited or saved back to the parent plan row.
  useEffect(() => {
    if (!selectedPlan || viewVersionKey === LIVE_VERSION_KEY) return;
    const cached = revisionDetails[viewVersionKey];
    if (cached) {
      setForm({
        name: cached.name,
        kind: cached.kind,
        language: cached.language,
        description: cached.description ?? '',
        body: cached.body,
      });
      return;
    }
    let cancelled = false;
    void loadRevisionDetail(selectedPlan.id, viewVersionKey)
      .then((revision) => {
        if (!cancelled) {
          setForm({
            name: revision.name,
            kind: revision.kind,
            language: revision.language,
            description: revision.description ?? '',
            body: revision.body,
          });
        }
      })
      .catch((error) => {
        if (!cancelled) toast.error(error instanceof Error ? error.message : 'Failed to load plan revision');
      });
    return () => {
      cancelled = true;
    };
  }, [loadRevisionDetail, revisionDetails, selectedPlan, viewVersionKey]);

  useEffect(() => {
    if (
      focusPlanRevisionNum === null || focusPlanRevisionNum === undefined
      || focusPlanId !== selectedPlanId
      || !revisions.some((revision) => revision.revision_num === focusPlanRevisionNum)
    ) return;
    setViewVersionKey(String(focusPlanRevisionNum));
  }, [focusPlanId, focusPlanRevisionNum, revisions, selectedPlanId]);

  const isDirty = selectedPlan
    ? !isViewingRevision && (
      form.name !== selectedPlan.name ||
      form.kind !== selectedPlan.kind ||
      form.language !== selectedPlan.language ||
      form.description !== (selectedPlan.description ?? '') ||
      form.body !== selectedPlan.body
    )
    : false;

  const openCreateDialog = () => {
    setCreateForm({ name: '', kind: 'jest' });
    setShowCreateDialog(true);
  };

  const handleCreate = async () => {
    const name = createForm.name.trim();
    if (!name) {
      toast.error('Name is required');
      return;
    }
    setIsCreating(true);
    try {
      const template = getStarterTemplate(createForm.kind);
      const res = await fetch(`/api/projects/${projectId}/qa/plans`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          kind: createForm.kind,
          language: template.language,
          body: template.body,
          // A plan created through the browser was created by a human at the
          // keyboard, not an agent — record that provenance explicitly rather
          // than take the server's 'agent' default.
          created_by: 'human',
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        toast.error(data.error ?? 'Failed to create plan');
        return;
      }
      toast.success('Plan created');
      setShowCreateDialog(false);
      await fetchPlans();
      selectPlan(data);
    } catch {
      toast.error('Failed to create plan');
    } finally {
      setIsCreating(false);
    }
  };

  const handleSave = async () => {
    if (!selectedPlan || isViewingRevision) return;
    const name = form.name.trim();
    if (!name) {
      toast.error('Name is required');
      return;
    }
    setIsSaving(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/qa/plans/${selectedPlan.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          kind: form.kind,
          language: form.language,
          description: form.description.trim() || null,
          body: form.body,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        toast.error(data.error ?? 'Failed to save plan');
        return;
      }
      toast.success('Plan saved');
      await fetchPlans();
      selectPlan(data);
    } catch {
      toast.error('Failed to save plan');
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveAsVersion = async () => {
    if (!selectedPlan || isViewingRevision || isDirty) {
      toast.error('Save the live plan before creating a version');
      return;
    }
    const label = versionLabel.trim();
    if (label.length < 1 || label.length > 100) {
      toast.error('Label the version (1–100 characters)');
      return;
    }
    setIsSavingVersion(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/qa/plans/${selectedPlan.id}/revisions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, created_by: 'human' }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error ?? 'Failed to save plan version');
      toast.success(`Saved as v${data.revision_num}`);
      setVersionLabel('');
      setShowVersionDialog(false);
      await fetchRevisions(selectedPlan.id);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save plan version');
    } finally {
      setIsSavingVersion(false);
    }
  };

  const handleDelete = async () => {
    if (!deletePlan) return;
    setIsDeleting(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/qa/plans/${deletePlan.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok || data.error) {
        toast.error(data.error ?? 'Failed to delete plan');
        return;
      }
      toast.success(`"${deletePlan.name}" deleted`);
      setDeletePlan(null);
      if (selectedPlanId === deletePlan.id) selectPlan(null);
      await fetchPlans();
    } catch {
      toast.error('Failed to delete plan');
    } finally {
      setIsDeleting(false);
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(form.body);
      toast.success('Copied to clipboard');
    } catch {
      toast.error('Failed to copy');
    }
  };

  // A frozen run uses the exact revision body fetched from the detail endpoint.
  // A live run uses the saved parent plan, and is refused while the editor is
  // dirty. The separate Copy button still copies the editor's current body.
  const liveRunnablePlan = selectedPlan;
  const runPlan = runVersionKey === LIVE_VERSION_KEY
    ? liveRunnablePlan
    : revisionDetails[runVersionKey] ?? null;
  const runRecipe: PlanRunRecipe = runPlan
    ? runRecipeForPlan(runPlan)
    : {
      path: '',
      runner: 'unknown',
      ingestKind: 'unit',
      script: null,
      unsupportedReason: runVersionLoading ? 'Loading revision…' : 'Select a plan version to run.',
    };

  useEffect(() => {
    if (!showRunDialog || runVersionKey === LIVE_VERSION_KEY || !selectedPlan || revisionDetails[runVersionKey]) return;
    let cancelled = false;
    setRunVersionLoading(true);
    void loadRevisionDetail(selectedPlan.id, runVersionKey)
      .catch((error) => {
        if (!cancelled) setRunError(error instanceof Error ? error.message : 'Failed to load plan revision');
      })
      .finally(() => {
        if (!cancelled) setRunVersionLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loadRevisionDetail, revisionDetails, runVersionKey, selectedPlan, showRunDialog]);

  const handleCopyRunScript = async () => {
    if (!runRecipe.script) return;
    try {
      await navigator.clipboard.writeText(runRecipe.script);
      toast.success('Command copied — paste it at the repository root');
    } catch {
      toast.error('Failed to copy');
    }
  };

  const openRunDialog = () => {
    setRunError(null);
    setRunVersionKey(LIVE_VERSION_KEY);
    setRunVersionLoading(false);
    setShowRunDialog(true);
  };

  const handleRunNow = async () => {
    if (!selectedPlan || !runRecipe.script || isRunning || (runVersionKey === LIVE_VERSION_KEY && isDirty)) return;

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 310_000);
    setIsRunning(true);
    setRunError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/qa/plans/${selectedPlan.id}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(runVersionKey === LIVE_VERSION_KEY ? {} : { revision_num: Number(runVersionKey) }),
        signal: controller.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        setRunError(data.error ?? `Failed to run plan (${res.status})`);
        return;
      }

      const passed = Number(data.passed ?? 0);
      const failed = Number(data.failed ?? 0);
      const skipped = Number(data.skipped ?? 0);
      onRunCreated?.();
      const versionSuffix = data.plan_revision_num ? ` · v${data.plan_revision_num}` : '';
      toast.success(
        `${passed} passed · ${failed} failed · ${skipped} skipped${versionSuffix}`,
        onOpenRun && data.run_id
          ? { action: { label: 'Open run', onClick: () => onOpenRun(data.run_id) } }
          : undefined,
      );
      setShowRunDialog(false);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        setRunError('The run took too long and the request was cancelled.');
      } else {
        setRunError('Failed to connect to the server.');
      }
    } finally {
      window.clearTimeout(timeoutId);
      setIsRunning(false);
    }
  };

  const handleDownload = () => {
    if (!selectedPlan) return;
    const filename = `${planSlug(selectedPlan.name)}.${planFileExtension(selectedPlan)}`;
    const blob = new Blob([form.body], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleVersionChange = (key: string) => {
    setViewVersionKey(key);
    if (key === LIVE_VERSION_KEY && selectedPlan) {
      setForm({
        name: selectedPlan.name,
        kind: selectedPlan.kind,
        language: selectedPlan.language,
        description: selectedPlan.description ?? '',
        body: selectedPlan.body,
      });
    }
  };

  const handlePlanRestored = (restored: QaPlan) => {
    setPlans((current) => current.map((plan) => plan.id === restored.id ? restored : plan));
    selectPlan(restored);
    void fetchRevisions(restored.id);
  };

  const latestRevision = revisions[0] ?? null;
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

  return (
    <div className="flex h-full w-full min-w-0 flex-col">
      <div className="-mx-4 flex w-[calc(100%+2rem)] shrink-0 flex-wrap items-center justify-between gap-3 border-b px-4 pb-3">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">QA plans</p>
          <h2 className="text-sm font-semibold">Plans ({plans.length})</h2>
          <p className="text-xs text-muted-foreground">Editable test script templates — Jest, Playwright, Maestro.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={kindFilter} onValueChange={setKindFilter}>
            <SelectTrigger className="h-8 w-[150px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All kinds</SelectItem>
              {PLAN_KINDS.map((k) => (
                <SelectItem key={k} value={k}>
                  {planKindLabel(k)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={() => fetchPlans()} disabled={isLoading}>
            <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button size="sm" onClick={openCreateDialog}>
            <Plus className="h-4 w-4 mr-2" />
            New Plan
          </Button>
        </div>
      </div>

      {isLoading && plans.length === 0 ? (
        <div className="flex items-center justify-center h-[300px]">
          <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : plans.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <FileCode className="h-10 w-10 mx-auto mb-3 opacity-30" />
          <p className="text-sm">No test plans yet.</p>
          <p className="text-xs mt-1">Create one to give a human or agent a starting script.</p>
        </div>
      ) : (
        <div className="-mx-4 grid w-[calc(100%+2rem)] min-w-0 flex-1 grid-cols-1 gap-0 overflow-hidden lg:grid-cols-[280px_minmax(0,1fr)]">
          {/* Plan list */}
          <aside className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-y-auto border-b bg-muted/10 lg:border-b-0 lg:border-r">
            {plans.map((plan) => {
              const isSelected = plan.id === selectedPlanId;
              return (
                <button
                  key={plan.id}
                  type="button"
                  onClick={() => selectPlan(plan)}
                  className={`flex w-full flex-col items-start gap-1.5 border-b px-3 py-3 text-left transition-colors ${
                    isSelected ? 'bg-primary/5' : 'bg-background hover:bg-muted/30'
                  }`}
                >
                  <div className="flex w-full items-center gap-1.5">
                    <Badge variant="outline" className={`text-xs shrink-0 ${planKindColor(plan.kind)}`}>
                      {planKindLabel(plan.kind)}
                    </Badge>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{plan.name}</span>
                  </div>
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Badge variant="secondary" className="text-[10px]">
                      {plan.language}
                    </Badge>
                    <span>Updated {formatDistanceToNow(new Date(plan.updated_at), { addSuffix: true })}</span>
                  </div>
                </button>
              );
            })}
          </aside>

          {/* Plan detail */}
          <div className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-y-auto px-4 py-3">
            {!selectedPlan ? (
              <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
                Select a plan to edit it.
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b">
                  <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                    {latestRevision && (
                      <Badge variant="secondary" className="shrink-0 font-mono" title={formatQaPlanRevisionLabel(latestRevision)}>
                        {formatQaPlanRevisionLabel(latestRevision)}
                      </Badge>
                    )}
                    <Input
                      value={form.name}
                      onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                      className="h-8 max-w-[240px] font-medium"
                      aria-label="Plan name"
                      disabled={isViewingRevision}
                    />
                    <Select value={form.kind} onValueChange={(v) => setForm((f) => ({ ...f, kind: v }))} disabled={isViewingRevision}>
                      <SelectTrigger className="h-8 w-[130px]" aria-label="Plan kind">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {PLAN_KINDS.map((k) => (
                          <SelectItem key={k} value={k}>
                            {planKindLabel(k)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select value={form.language} onValueChange={(v) => setForm((f) => ({ ...f, language: v }))} disabled={isViewingRevision}>
                      <SelectTrigger className="h-8 w-[130px]" aria-label="Plan language">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {PLAN_LANGUAGES.map((l) => (
                          <SelectItem key={l} value={l}>
                            {l}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Select value={viewVersionKey} onValueChange={handleVersionChange} disabled={isLoadingRevisions}>
                      <SelectTrigger className="h-8 w-[160px]" aria-label="Plan version">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>{versionOptions}</SelectContent>
                    </Select>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => { setVersionLabel(''); setShowVersionDialog(true); }}
                      disabled={isViewingRevision || isDirty || isSavingVersion}
                      title={isDirty ? 'Save the live edits first' : 'Save the live plan as a labelled version'}
                    >
                      Save as version
                    </Button>
                    <Button size="sm" onClick={handleSave} disabled={!isDirty || isViewingRevision || isSaving || !form.name.trim()}>
                      {isSaving ? 'Saving…' : 'Save'}
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setIsHistoryOpen(true)}>
                      <History className="mr-2 h-4 w-4" />
                      History
                    </Button>
                    <Button variant="outline" size="sm" className="h-8" title="Run this plan" onClick={openRunDialog}>
                      <Play className="h-3.5 w-3.5 mr-1.5" />
                      Run
                    </Button>
                    <Button variant="outline" size="icon" className="h-8 w-8" title="Copy to clipboard" onClick={handleCopy}>
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="outline" size="icon" className="h-8 w-8" title="Download" onClick={handleDownload}>
                      <Download className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-8 w-8 text-destructive hover:text-destructive"
                      title="Delete"
                      onClick={() => setDeletePlan(selectedPlan)}
                      disabled={isViewingRevision}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>

                <div className="flex flex-1 min-h-0 flex-col gap-3 pt-3">
                  {isViewingRevision && (
                    <p className="rounded-md border border-dashed bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                      Viewing {formatQaPlanVersionLabel(viewVersionKey, revisions)}. Select Live (current) to edit the working copy.
                    </p>
                  )}
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground font-normal">Description</Label>
                    <Textarea
                      value={form.description}
                      onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                      placeholder="What this plan covers"
                      rows={2}
                      disabled={isViewingRevision}
                    />
                  </div>
                  <div className="flex min-h-0 flex-1 flex-col space-y-1.5">
                    <Label className="text-xs text-muted-foreground font-normal">Script</Label>
                    <Textarea
                      value={form.body}
                      onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
                      className="font-mono text-xs flex-1 min-h-[360px] resize-none"
                      spellCheck={false}
                      disabled={isViewingRevision}
                    />
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <QaPlanHistorySheet
        open={isHistoryOpen}
        onOpenChange={setIsHistoryOpen}
        projectId={projectId}
        plan={selectedPlan}
        onRestored={handlePlanRestored}
      />

      {/* Save as version dialog */}
      <Dialog open={showVersionDialog} onOpenChange={setShowVersionDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Save as version</DialogTitle>
            <DialogDescription>Give this frozen copy a label so it can be run and restored later.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5 py-2">
            <Label htmlFor="plan-version-label">Version label</Label>
            <Input
              id="plan-version-label"
              value={versionLabel}
              maxLength={100}
              placeholder="e.g. home page only"
              onChange={(event) => setVersionLabel(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && versionLabel.trim()) void handleSaveAsVersion();
              }}
            />
            <p className="text-[11px] text-muted-foreground">1–100 characters · the live plan must be saved first</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowVersionDialog(false)} disabled={isSavingVersion}>Cancel</Button>
            <Button onClick={() => void handleSaveAsVersion()} disabled={isSavingVersion || !versionLabel.trim()}>
              {isSavingVersion ? 'Saving…' : 'Save version'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* New Plan dialog */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New Test Plan</DialogTitle>
            <DialogDescription>Starts from a starter template you can edit afterward.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="plan-name">
                Name <span className="text-destructive">*</span>
              </Label>
              <Input
                id="plan-name"
                placeholder="e.g. Checkout flow smoke test"
                value={createForm.name}
                onChange={(e) => setCreateForm((f) => ({ ...f, name: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && createForm.name.trim()) handleCreate();
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Kind</Label>
              <Select value={createForm.kind} onValueChange={(v) => setCreateForm((f) => ({ ...f, kind: v }))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PLAN_KINDS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {planKindLabel(k)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreateDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={isCreating || !createForm.name.trim()}>
              {isCreating ? 'Creating…' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Plan Confirmation */}
      <AlertDialog open={!!deletePlan} onOpenChange={(open) => !open && setDeletePlan(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Test Plan</AlertDialogTitle>
            <AlertDialogDescription>
              Delete <code className="font-mono">{deletePlan?.name}</code>? This permanently removes the plan. This
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Run dialog */}
      <Dialog
        open={showRunDialog}
        onOpenChange={(open) => {
          if (!open && isRunning) return;
          setShowRunDialog(open);
          if (open) setRunError(null);
        }}
      >
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader className="min-w-0">
            <DialogTitle>Run this plan</DialogTitle>
            <DialogDescription>
              Run a frozen version or the current live plan in its project directory and record the result under QA &rsaquo; Runs.
            </DialogDescription>
            {/* Its own line with break-all: a generated filename is one long
                unbreakable token and blows out the header inline. */}
            <code className="block min-w-0 break-all font-mono text-xs text-muted-foreground">{runRecipe.path}</code>
          </DialogHeader>

          <div className="space-y-1.5">
            <Label>Version to run</Label>
            <Select value={runVersionKey} onValueChange={(key) => { setRunVersionKey(key); setRunError(null); }} disabled={isLoadingRevisions || runVersionLoading}>
              <SelectTrigger aria-label="Version to run"><SelectValue /></SelectTrigger>
              <SelectContent>{versionOptions}</SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">The run stores this version number with its result.</p>
          </div>

          {runError && (
            <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive whitespace-pre-wrap">
              {runError}
            </p>
          )}

          {runRecipe.script ? (
            <>
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <Badge variant="secondary" className="text-[10px]">{runRecipe.runner}</Badge>
                <span>recorded as a</span>
                <Badge variant="secondary" className="text-[10px]">{runRecipe.ingestKind}</Badge>
                <span>run</span>
              </div>
              {/* min-w-0 on the wrapper is what actually lets the pre scroll:
                  without it the flex item refuses to shrink below its content
                  width and the block bursts out of the dialog. */}
              <div className="min-w-0 max-w-full">
                <pre className="max-h-[45vh] w-full overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs whitespace-pre">
                  {runRecipe.script}
                </pre>
              </div>
              {runVersionKey === LIVE_VERSION_KEY && isDirty && (
                <p className="text-xs text-muted-foreground">
                  Save the edits before running; Run now uses the saved plan.
                </p>
              )}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{runRecipe.unsupportedReason}</p>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowRunDialog(false)}>
              Close
            </Button>
            <Button onClick={handleCopyRunScript} disabled={!runRecipe.script}>
              <Copy className="h-3.5 w-3.5 mr-1.5" />
              Copy command
            </Button>
            <Button onClick={handleRunNow} disabled={isRunning || runVersionLoading || !runRecipe.script || (runVersionKey === LIVE_VERSION_KEY && isDirty)}>
              {isRunning ? <RefreshCw className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Play className="h-3.5 w-3.5 mr-1.5" />}
              {isRunning ? 'Running…' : 'Run now'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
