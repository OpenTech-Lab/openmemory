'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import {
  Bot,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  FileText,
  ListChecks,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  UploadCloud,
  User,
} from 'lucide-react';
import { toast } from 'sonner';
import { QA_STATUSES, statusColor, statusLabel } from '@/lib/qa-meta';

interface QaRun {
  id: string;
  project_id: string;
  task_id: string | null;
  title: string;
  status: string;
  summary: string | null;
  target: string | null;
  external_ref: string | null;
  created_by: string;
  started_at: string;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

interface QaEvidence {
  id: string;
  run_id: string;
  kind: 'image' | 'text';
  caption: string | null;
  body: string | null;
  mime_type: string | null;
  byte_size: number | null;
  sort_order: number;
  captured_at: string;
  created_at: string;
}

interface TaskOption {
  id: string;
  title: string;
}

const NO_TASK_VALUE = '__none__';
const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function blobUrl(projectId: string, evidenceId: string): string {
  return `/api/projects/${projectId}/qa/evidence/${evidenceId}/blob`;
}

const EMPTY_RUN_FORM = {
  title: '',
  status: 'in_progress' as string,
  target: '',
  summary: '',
  task_id: NO_TASK_VALUE,
};

export function QaPanel({ projectId }: { projectId: string }) {
  const [runs, setRuns] = useState<QaRun[]>([]);
  const [evidenceByRun, setEvidenceByRun] = useState<Record<string, QaEvidence[]>>({});
  const [tasks, setTasks] = useState<TaskOption[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  // Create/edit run dialog
  const [showRunDialog, setShowRunDialog] = useState(false);
  const [editingRunId, setEditingRunId] = useState<string | null>(null);
  const [runForm, setRunForm] = useState(EMPTY_RUN_FORM);
  const [isSavingRun, setIsSavingRun] = useState(false);

  // Delete run confirmation
  const [deleteRun, setDeleteRun] = useState<QaRun | null>(null);

  // Add evidence
  const [noteCaption, setNoteCaption] = useState('');
  const [noteBody, setNoteBody] = useState('');
  const [isAddingNote, setIsAddingNote] = useState(false);
  const [imageCaption, setImageCaption] = useState('');
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Delete evidence confirmation
  const [deleteEvidence, setDeleteEvidence] = useState<QaEvidence | null>(null);

  // Lightbox — steps through the selected run's image evidence only.
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const fetchRuns = useCallback(async () => {
    setIsLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter !== 'all') params.set('status', statusFilter);
      const res = await fetch(`/api/projects/${projectId}/qa/runs?${params}`);
      const data = await res.json();
      if (!res.ok || data.error) {
        toast.error(data.error ?? 'Failed to load QA runs');
        return;
      }
      const list: QaRun[] = data.runs ?? [];
      setRuns(list);
      // The list endpoint carries neither an evidence count nor the evidence
      // itself, so fetch each run's detail in parallel — this both drives the
      // per-row evidence count and means selecting a run never needs a second
      // fetch before its detail pane can render.
      const details = await Promise.all(
        list.map(async (run) => {
          try {
            const detailRes = await fetch(`/api/projects/${projectId}/qa/runs/${run.id}`);
            const detailData = await detailRes.json();
            return [run.id, detailRes.ok ? (detailData.evidence ?? []) : []] as const;
          } catch {
            return [run.id, []] as const;
          }
        })
      );
      setEvidenceByRun(Object.fromEntries(details));
    } catch {
      toast.error('Failed to connect to server');
    } finally {
      setIsLoading(false);
    }
  }, [projectId, statusFilter]);

  const fetchTasks = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/tasks?limit=200`);
      const data = await res.json();
      setTasks(data.tasks ?? []);
    } catch {
      // Chip-only fetch — a failure here shouldn't surface a toast on top of the panel's own.
    }
  }, [projectId]);

  useEffect(() => {
    fetchRuns();
  }, [fetchRuns]);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);

  // Keeps a selection across refreshes; falls back to the first remaining run
  // once the selected one is gone (deleted, or filtered out) and to nothing
  // once the list is empty.
  useEffect(() => {
    if (selectedRunId && runs.some((r) => r.id === selectedRunId)) return;
    setSelectedRunId(runs[0]?.id ?? null);
  }, [runs, selectedRunId]);

  const selectedRun = runs.find((r) => r.id === selectedRunId) ?? null;
  // Memoised so it is referentially stable across renders — `imageEvidence` below
  // depends on it, and a fresh [] every render would defeat that memo entirely.
  const selectedEvidence = useMemo(
    () => (selectedRunId ? evidenceByRun[selectedRunId] ?? [] : []),
    [selectedRunId, evidenceByRun],
  );
  // Server already applies `ORDER BY sort_order, captured_at, created_at` — no
  // client-side re-sorting needed.
  const imageEvidence = useMemo(() => selectedEvidence.filter((e) => e.kind === 'image'), [selectedEvidence]);

  // Clamp the lightbox if the image it was showing just got deleted out from under it.
  useEffect(() => {
    if (lightboxIndex !== null && lightboxIndex >= imageEvidence.length) {
      setLightboxIndex(imageEvidence.length > 0 ? imageEvidence.length - 1 : null);
    }
  }, [imageEvidence.length, lightboxIndex]);

  useEffect(() => {
    if (lightboxIndex === null) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') setLightboxIndex((i) => (i === null ? null : Math.max(0, i - 1)));
      else if (e.key === 'ArrowRight') {
        setLightboxIndex((i) => (i === null ? null : Math.min(imageEvidence.length - 1, i + 1)));
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [lightboxIndex, imageEvidence.length]);

  const refreshRunDetail = useCallback(
    async (runId: string) => {
      try {
        const res = await fetch(`/api/projects/${projectId}/qa/runs/${runId}`);
        const data = await res.json();
        if (!res.ok) return;
        setEvidenceByRun((prev) => ({ ...prev, [runId]: data.evidence ?? [] }));
        setRuns((prev) => prev.map((r) => (r.id === runId ? data.run : r)));
      } catch {
        // Best-effort refresh; the next full fetchRuns() reconciles any drift.
      }
    },
    [projectId]
  );

  const resetRunForm = () => setRunForm(EMPTY_RUN_FORM);

  const openRunCreate = () => {
    setEditingRunId(null);
    resetRunForm();
    setShowRunDialog(true);
  };

  const openRunEdit = (run: QaRun) => {
    setEditingRunId(run.id);
    setRunForm({
      title: run.title,
      status: run.status,
      target: run.target ?? '',
      summary: run.summary ?? '',
      task_id: run.task_id ?? NO_TASK_VALUE,
    });
    setShowRunDialog(true);
  };

  const handleSaveRun = async () => {
    const title = runForm.title.trim();
    if (!title) {
      toast.error('Title is required');
      return;
    }
    setIsSavingRun(true);
    try {
      const taskId = runForm.task_id === NO_TASK_VALUE ? null : runForm.task_id;
      let res: Response;
      if (editingRunId) {
        // Always send target/summary/task_id explicitly (string or null) —
        // omitting the key leaves the existing value untouched server-side,
        // so this is the only way the field can be cleared from the form.
        res = await fetch(`/api/projects/${projectId}/qa/runs/${editingRunId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title,
            status: runForm.status,
            target: runForm.target.trim() || null,
            summary: runForm.summary.trim() || null,
            task_id: taskId,
          }),
        });
      } else {
        res = await fetch(`/api/projects/${projectId}/qa/runs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title,
            status: runForm.status,
            target: runForm.target.trim() || undefined,
            summary: runForm.summary.trim() || undefined,
            task_id: taskId ?? undefined,
            // A run created through the browser was created by a human at the
            // keyboard, not an agent — record that provenance explicitly
            // rather than take the server's 'agent' default.
            created_by: 'human',
          }),
        });
      }
      const data = await res.json();
      if (!res.ok || data.error) {
        toast.error(data.error ?? `Failed to ${editingRunId ? 'save' : 'create'} run`);
        return;
      }
      toast.success(editingRunId ? 'Run updated' : 'Run created');
      setShowRunDialog(false);
      setEditingRunId(null);
      resetRunForm();
      if (!editingRunId) setSelectedRunId(data.id);
      fetchRuns();
    } catch {
      toast.error(`Failed to ${editingRunId ? 'save' : 'create'} run`);
    } finally {
      setIsSavingRun(false);
    }
  };

  const handleDeleteRun = async () => {
    if (!deleteRun) return;
    try {
      const res = await fetch(`/api/projects/${projectId}/qa/runs/${deleteRun.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok || data.error) {
        toast.error(data.error ?? 'Failed to delete run');
        return;
      }
      toast.success(`"${deleteRun.title}" deleted`);
      setDeleteRun(null);
      fetchRuns();
    } catch {
      toast.error('Failed to delete run');
    }
  };

  const handleAddNote = async () => {
    if (!selectedRunId) return;
    const body = noteBody.trim();
    if (!body) {
      toast.error('Note text is required');
      return;
    }
    setIsAddingNote(true);
    try {
      const currentEvidence = evidenceByRun[selectedRunId] ?? [];
      const sortOrder = currentEvidence.length === 0 ? 0 : Math.max(...currentEvidence.map((e) => e.sort_order)) + 1;
      const res = await fetch(`/api/projects/${projectId}/qa/runs/${selectedRunId}/evidence`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'text',
          body,
          caption: noteCaption.trim() || undefined,
          sort_order: sortOrder,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        toast.error(data.error ?? 'Failed to add note');
        return;
      }
      setNoteCaption('');
      setNoteBody('');
      await refreshRunDetail(selectedRunId);
      toast.success('Note added');
    } catch {
      toast.error('Failed to add note');
    } finally {
      setIsAddingNote(false);
    }
  };

  const uploadImage = useCallback(
    async (file: File) => {
      if (!selectedRunId || isUploading) return;
      if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
        toast.error('Only PNG, JPEG, or WebP images are accepted');
        return;
      }
      setIsUploading(true);
      let evidenceId: string | null = null;
      try {
        const currentEvidence = evidenceByRun[selectedRunId] ?? [];
        const sortOrder = currentEvidence.length === 0 ? 0 : Math.max(...currentEvidence.map((e) => e.sort_order)) + 1;
        const createRes = await fetch(`/api/projects/${projectId}/qa/runs/${selectedRunId}/evidence`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            kind: 'image',
            caption: imageCaption.trim() || undefined,
            sort_order: sortOrder,
          }),
        });
        const createData = await createRes.json();
        if (!createRes.ok || createData.error) {
          toast.error(createData.error ?? 'Failed to create evidence row');
          return;
        }
        evidenceId = createData.id;

        const bytes = await file.arrayBuffer();
        const putRes = await fetch(`/api/projects/${projectId}/qa/evidence/${evidenceId}/blob`, {
          method: 'PUT',
          headers: { 'Content-Type': file.type },
          body: bytes,
        });
        const putData = await putRes.json();
        if (!putRes.ok || putData.error) {
          toast.error(putData.error ?? 'Failed to upload image');
          // Don't leave an image row permanently without a blob — the same
          // rollback the qa_evidence_add MCP tool performs on a failed upload.
          await fetch(`/api/projects/${projectId}/qa/evidence/${evidenceId}`, { method: 'DELETE' });
          return;
        }
        setImageCaption('');
        await refreshRunDetail(selectedRunId);
        toast.success('Image added');
      } catch {
        toast.error('Failed to upload image');
        if (evidenceId) {
          await fetch(`/api/projects/${projectId}/qa/evidence/${evidenceId}`, { method: 'DELETE' }).catch(() => {});
        }
      } finally {
        setIsUploading(false);
      }
    },
    [projectId, selectedRunId, isUploading, imageCaption, evidenceByRun, refreshRunDetail]
  );

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) uploadImage(file);
    e.target.value = '';
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDraggingOver(true);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDraggingOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) uploadImage(file);
  };

  const handleDeleteEvidence = async () => {
    if (!deleteEvidence || !selectedRunId) return;
    try {
      const res = await fetch(`/api/projects/${projectId}/qa/evidence/${deleteEvidence.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok || data.error) {
        toast.error(data.error ?? 'Failed to delete evidence');
        return;
      }
      toast.success('Evidence deleted');
      setDeleteEvidence(null);
      await refreshRunDetail(selectedRunId);
    } catch {
      toast.error('Failed to delete evidence');
    }
  };

  const currentLightboxImage = lightboxIndex !== null ? imageEvidence[lightboxIndex] : null;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between pb-3 gap-3 flex-wrap shrink-0">
        <div>
          <h2 className="text-base font-semibold">QA Runs ({runs.length})</h2>
          <p className="text-sm text-muted-foreground">What was tested, the verdict, and the evidence behind it.</p>
        </div>
        <div className="flex gap-2 flex-wrap items-center">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="h-8 w-[150px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {QA_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {statusLabel(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={() => fetchRuns()} disabled={isLoading}>
            <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button size="sm" onClick={openRunCreate}>
            <Plus className="h-4 w-4 mr-2" />
            New Run
          </Button>
        </div>
      </div>

      {isLoading && runs.length === 0 ? (
        <div className="flex items-center justify-center h-[300px]">
          <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : runs.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <ClipboardCheck className="h-10 w-10 mx-auto mb-3 opacity-30" />
          <p className="text-sm">No QA runs recorded.</p>
          <p className="text-xs mt-1">Start one manually, or have an agent invoke the qa-run skill.</p>
        </div>
      ) : (
        <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-4 overflow-hidden">
          {/* Run list */}
          <div className="flex flex-col gap-2 overflow-y-auto pr-1 min-h-0">
            {runs.map((run) => {
              const evidenceCount = (evidenceByRun[run.id] ?? []).length;
              const task = run.task_id ? taskById.get(run.task_id) : undefined;
              const isSelected = run.id === selectedRunId;
              return (
                <div
                  key={run.id}
                  onClick={() => setSelectedRunId(run.id)}
                  className={`flex flex-col gap-1.5 rounded-lg border p-3 cursor-pointer transition-colors ${
                    isSelected ? 'border-primary bg-primary/5' : 'bg-background hover:bg-muted/30'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <Badge variant="outline" className={`text-xs shrink-0 ${statusColor(run.status)}`}>
                          {statusLabel(run.status)}
                        </Badge>
                        {run.created_by === 'agent' ? (
                          <Bot className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        ) : (
                          <User className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        )}
                      </div>
                      <p className="text-sm font-medium truncate mt-1">{run.title}</p>
                      {run.target && <p className="text-xs text-muted-foreground truncate">{run.target}</p>}
                    </div>
                    <div className="flex items-center gap-0.5 shrink-0">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        title="Edit"
                        onClick={(e) => {
                          e.stopPropagation();
                          openRunEdit(run);
                        }}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-destructive hover:text-destructive"
                        title="Delete"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteRun(run);
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-xs text-muted-foreground">{formatDateTime(run.started_at)}</span>
                    <Badge variant="secondary" className="text-[10px]">
                      {evidenceCount} item{evidenceCount !== 1 ? 's' : ''}
                    </Badge>
                    {task && (
                      <Badge variant="outline" className="text-xs gap-1 min-w-0">
                        <ListChecks className="h-3 w-3 shrink-0" />
                        <span className="truncate max-w-[160px]">{task.title}</span>
                      </Badge>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Run detail */}
          <div className="flex flex-col min-h-0 overflow-y-auto rounded-lg border p-4">
            {!selectedRun ? (
              <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
                Select a run to see its evidence.
              </div>
            ) : (
              <>
                <div className="flex items-start justify-between gap-2 pb-3 border-b">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant="outline" className={`text-xs ${statusColor(selectedRun.status)}`}>
                        {statusLabel(selectedRun.status)}
                      </Badge>
                      <h3 className="text-sm font-semibold truncate">{selectedRun.title}</h3>
                    </div>
                    <div className="flex items-center gap-2 flex-wrap mt-1 text-xs text-muted-foreground">
                      <span>Started {formatDateTime(selectedRun.started_at)}</span>
                      {selectedRun.finished_at && <span>· Finished {formatDateTime(selectedRun.finished_at)}</span>}
                      {selectedRun.target && <span className="truncate">· {selectedRun.target}</span>}
                    </div>
                    {selectedRun.summary && <p className="text-sm mt-2 whitespace-pre-wrap">{selectedRun.summary}</p>}
                    {selectedRun.external_ref && (
                      <p className="text-xs text-muted-foreground mt-2">
                        qa-automation run: <code className="font-mono">{selectedRun.external_ref}</code>
                      </p>
                    )}
                  </div>
                </div>

                {/* Evidence timeline */}
                <div className="flex flex-col gap-2 py-3">
                  {selectedEvidence.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-4 text-center">No evidence yet.</p>
                  ) : (
                    selectedEvidence.map((evidence) => (
                      <div key={evidence.id} className="flex items-start gap-3 p-2 rounded-md hover:bg-muted/30">
                        {evidence.kind === 'image' ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={blobUrl(projectId, evidence.id)}
                            alt={evidence.caption ?? 'QA evidence screenshot'}
                            className="h-20 w-20 shrink-0 rounded border object-cover cursor-pointer"
                            onClick={() => {
                              const idx = imageEvidence.findIndex((e) => e.id === evidence.id);
                              if (idx >= 0) setLightboxIndex(idx);
                            }}
                          />
                        ) : (
                          <div className="h-20 w-20 shrink-0 rounded border bg-muted flex items-center justify-center">
                            <FileText className="h-6 w-6 text-muted-foreground" />
                          </div>
                        )}
                        <div className="flex-1 min-w-0">
                          {evidence.caption && <p className="text-sm font-medium break-words">{evidence.caption}</p>}
                          {evidence.kind === 'text' && evidence.body && (
                            <p className="text-sm text-muted-foreground whitespace-pre-wrap break-words">{evidence.body}</p>
                          )}
                          <p className="text-xs text-muted-foreground mt-1">{formatDateTime(evidence.captured_at)}</p>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                          title="Delete evidence"
                          onClick={() => setDeleteEvidence(evidence)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))
                  )}
                </div>

                {/* Add evidence */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-3 border-t">
                  <div className="flex flex-col gap-1.5 min-w-0">
                    <Label className="text-xs text-muted-foreground font-normal">
                      Caption <span className="opacity-70">(optional, applies to the next image)</span>
                    </Label>
                    <Input
                      value={imageCaption}
                      onChange={(e) => setImageCaption(e.target.value)}
                      placeholder="What this screenshot shows"
                      disabled={isUploading}
                    />
                    <div
                      onDragOver={handleDragOver}
                      onDragLeave={() => setIsDraggingOver(false)}
                      onDrop={handleDrop}
                      onClick={() => fileInputRef.current?.click()}
                      className={`flex flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed p-4 text-center text-sm cursor-pointer transition-colors ${
                        isDraggingOver ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/40'
                      } ${isUploading ? 'opacity-60 pointer-events-none' : ''}`}
                    >
                      <UploadCloud className="h-5 w-5 text-muted-foreground" />
                      <span className="text-muted-foreground">
                        {isUploading ? 'Uploading…' : 'Drag & drop a screenshot, or click to browse'}
                      </span>
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        className="hidden"
                        onChange={handleFileInputChange}
                      />
                    </div>
                  </div>
                  <div className="flex flex-col gap-1.5 min-w-0">
                    <Label className="text-xs text-muted-foreground font-normal">Text note</Label>
                    <Input
                      value={noteCaption}
                      onChange={(e) => setNoteCaption(e.target.value)}
                      placeholder="Caption (optional)"
                      disabled={isAddingNote}
                    />
                    <Textarea
                      value={noteBody}
                      onChange={(e) => setNoteBody(e.target.value)}
                      placeholder="Dated note about what was observed"
                      rows={2}
                      disabled={isAddingNote}
                    />
                    <Button size="sm" onClick={handleAddNote} disabled={isAddingNote || !noteBody.trim()}>
                      {isAddingNote ? 'Adding…' : 'Add note'}
                    </Button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Create/Edit Run Dialog */}
      <Dialog open={showRunDialog} onOpenChange={setShowRunDialog}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingRunId ? 'Edit QA Run' : 'New QA Run'}</DialogTitle>
            <DialogDescription>Record what was tested and the verdict.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5 min-w-0">
              <Label htmlFor="run-title">
                Title <span className="text-destructive">*</span>
              </Label>
              <Input
                id="run-title"
                placeholder="e.g. Checkout flow smoke test"
                value={runForm.title}
                onChange={(e) => setRunForm((f) => ({ ...f, title: e.target.value }))}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5 min-w-0">
                <Label>Status</Label>
                <Select value={runForm.status} onValueChange={(v) => setRunForm((f) => ({ ...f, status: v }))}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {QA_STATUSES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {statusLabel(s)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5 min-w-0">
                <Label>Linked task</Label>
                <Select value={runForm.task_id} onValueChange={(v) => setRunForm((f) => ({ ...f, task_id: v }))}>
                  <SelectTrigger>
                    <SelectValue placeholder="None" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_TASK_VALUE}>None</SelectItem>
                    {tasks.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5 min-w-0">
              <Label htmlFor="run-target">Target</Label>
              <Input
                id="run-target"
                placeholder="URL, build id, or device"
                value={runForm.target}
                onChange={(e) => setRunForm((f) => ({ ...f, target: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5 min-w-0">
              <Label htmlFor="run-summary">Summary</Label>
              <Textarea
                id="run-summary"
                placeholder="Verdict notes — what passed, what didn't"
                value={runForm.summary}
                onChange={(e) => setRunForm((f) => ({ ...f, summary: e.target.value }))}
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowRunDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleSaveRun} disabled={isSavingRun || !runForm.title.trim()}>
              {isSavingRun ? 'Saving…' : editingRunId ? 'Save' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Run Confirmation */}
      <AlertDialog open={!!deleteRun} onOpenChange={(open) => !open && setDeleteRun(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete QA Run</AlertDialogTitle>
            <AlertDialogDescription>
              Delete <code className="font-mono">{deleteRun?.title}</code>? This permanently removes the run and all
              of its evidence. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteRun} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete Evidence Confirmation */}
      <AlertDialog open={!!deleteEvidence} onOpenChange={(open) => !open && setDeleteEvidence(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Evidence</AlertDialogTitle>
            <AlertDialogDescription>
              Delete this {deleteEvidence?.kind === 'image' ? 'image' : 'note'}
              {deleteEvidence?.caption ? <> (&ldquo;{deleteEvidence.caption}&rdquo;)</> : null}? This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteEvidence}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Lightbox */}
      <Dialog open={currentLightboxImage !== null} onOpenChange={(open) => !open && setLightboxIndex(null)}>
        <DialogContent className="sm:max-w-3xl">
          {currentLightboxImage && (
            <>
              <DialogHeader>
                <DialogTitle className="truncate">{currentLightboxImage.caption || 'Screenshot'}</DialogTitle>
                <DialogDescription>
                  {formatDateTime(currentLightboxImage.captured_at)} · Image {(lightboxIndex ?? 0) + 1} of{' '}
                  {imageEvidence.length}
                </DialogDescription>
              </DialogHeader>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="icon"
                  className="shrink-0"
                  disabled={(lightboxIndex ?? 0) <= 0}
                  onClick={() => setLightboxIndex((i) => (i === null ? null : Math.max(0, i - 1)))}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={blobUrl(projectId, currentLightboxImage.id)}
                  alt={currentLightboxImage.caption ?? 'QA evidence screenshot'}
                  className="max-h-[65vh] w-full flex-1 rounded object-contain"
                />
                <Button
                  variant="outline"
                  size="icon"
                  className="shrink-0"
                  disabled={(lightboxIndex ?? 0) >= imageEvidence.length - 1}
                  onClick={() => setLightboxIndex((i) => (i === null ? null : Math.min(imageEvidence.length - 1, i + 1)))}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
