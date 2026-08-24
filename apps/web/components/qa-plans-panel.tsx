'use client';

import { useCallback, useEffect, useState } from 'react';
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
import { Copy, Download, FileCode, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { PLAN_KINDS, planKindColor, planKindLabel } from '@/lib/qa-meta';
import { getStarterTemplate } from '@/lib/qa-plan-templates';

interface QaPlan {
  id: string;
  project_id: string;
  name: string;
  kind: 'jest' | 'playwright' | 'maestro' | 'other';
  language: 'typescript' | 'javascript' | 'yaml' | 'python' | 'other';
  description: string | null;
  body: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

const PLAN_LANGUAGES = ['typescript', 'javascript', 'yaml', 'python', 'other'] as const;

const EMPTY_FORM = { name: '', kind: 'other' as string, language: 'other' as string, description: '', body: '' };

function planFileExtension(plan: Pick<QaPlan, 'kind' | 'language'>): string {
  switch (plan.kind) {
    case 'jest':
      return plan.language === 'javascript' ? 'test.js' : 'test.ts';
    case 'playwright':
      if (plan.language === 'javascript') return 'spec.js';
      if (plan.language === 'python') return 'spec.py';
      return 'spec.ts';
    case 'maestro':
      return 'yaml';
    default:
      return 'txt';
  }
}

export function QaPlansPanel({ projectId }: { projectId: string }) {
  const [plans, setPlans] = useState<QaPlan[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [kindFilter, setKindFilter] = useState<string>('all');
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);

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
      setPlans(data.plans ?? []);
    } catch {
      toast.error('Failed to connect to server');
    } finally {
      setIsLoading(false);
    }
  }, [projectId, kindFilter]);

  useEffect(() => {
    fetchPlans();
  }, [fetchPlans]);

  const selectPlan = (plan: QaPlan | null) => {
    setSelectedPlanId(plan?.id ?? null);
    setForm(
      plan
        ? { name: plan.name, kind: plan.kind, language: plan.language, description: plan.description ?? '', body: plan.body }
        : EMPTY_FORM
    );
  };

  // Falls back to the first plan once nothing is selected or the selected one
  // disappears (e.g. deleted by another client) — mirrors qa-panel's run list.
  // Only fires on that fallback case, not on every background refetch, so an
  // in-progress edit in the detail pane survives a Refresh.
  useEffect(() => {
    if (selectedPlanId && plans.some((p) => p.id === selectedPlanId)) return;
    selectPlan(plans[0] ?? null);
  }, [plans, selectedPlanId]);

  const selectedPlan = plans.find((p) => p.id === selectedPlanId) ?? null;

  const isDirty = selectedPlan
    ? form.name !== selectedPlan.name ||
      form.kind !== selectedPlan.kind ||
      form.language !== selectedPlan.language ||
      form.description !== (selectedPlan.description ?? '') ||
      form.body !== selectedPlan.body
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
    if (!selectedPlan) return;
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

  const handleDownload = () => {
    if (!selectedPlan) return;
    const filename = `${selectedPlan.name.trim().replace(/[^a-z0-9._-]+/gi, '_') || 'plan'}.${planFileExtension(selectedPlan)}`;
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
                    <Input
                      value={form.name}
                      onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                      className="h-8 max-w-[240px] font-medium"
                      aria-label="Plan name"
                    />
                    <Select value={form.kind} onValueChange={(v) => setForm((f) => ({ ...f, kind: v }))}>
                      <SelectTrigger className="h-8 w-[130px]">
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
                    <Select value={form.language} onValueChange={(v) => setForm((f) => ({ ...f, language: v }))}>
                      <SelectTrigger className="h-8 w-[130px]">
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
                    <Button size="sm" onClick={handleSave} disabled={!isDirty || isSaving || !form.name.trim()}>
                      {isSaving ? 'Saving…' : 'Save'}
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
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>

                <div className="flex flex-1 min-h-0 flex-col gap-3 pt-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground font-normal">Description</Label>
                    <Textarea
                      value={form.description}
                      onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                      placeholder="What this plan covers"
                      rows={2}
                    />
                  </div>
                  <div className="flex min-h-0 flex-1 flex-col space-y-1.5">
                    <Label className="text-xs text-muted-foreground font-normal">Script</Label>
                    <Textarea
                      value={form.body}
                      onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
                      className="font-mono text-xs flex-1 min-h-[360px] resize-none"
                      spellCheck={false}
                    />
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}

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
    </div>
  );
}
