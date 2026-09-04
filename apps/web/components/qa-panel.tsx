'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent,
} from 'react';
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
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
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
import { QA_STATUSES, runKindColor, runKindLabel, statusColor, statusLabel } from '@/lib/qa-meta';
import { QaTestsPanel } from '@/components/qa-tests-panel';

interface QaRun {
  id: string;
  project_id: string;
  event_id: string | null;
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
  kind?: string;
  runner?: string | null;
  total_cases?: number;
  passed_cases?: number;
  failed_cases?: number;
  skipped_cases?: number;
  duration_ms?: number | null;
  commit_sha?: string | null;
  branch?: string | null;
  evidence_count?: number;
}

interface QaEvent {
  id: string;
  project_id: string;
  name: string;
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
const NO_EVENT_VALUE = '__none__';
const ALL_EVENTS_VALUE = '__all__';
const UNGROUPED_EVENTS_VALUE = '__ungrouped__';
const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const QA_EVENT_SIDEBAR_DEFAULT_WIDTH = 320;
const QA_EVENT_SIDEBAR_MIN_WIDTH = 240;
const QA_EVENT_SIDEBAR_MAX_WIDTH = 520;
const QA_EVENT_SIDEBAR_STORAGE_KEY = 'openmemory:qa-event-sidebar-width';

function clampQaEventSidebarWidth(width: number): number {
  return Math.round(Math.min(QA_EVENT_SIDEBAR_MAX_WIDTH, Math.max(QA_EVENT_SIDEBAR_MIN_WIDTH, width)));
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

function blobUrl(projectId: string, evidenceId: string): string {
  return `/api/projects/${projectId}/qa/evidence/${evidenceId}/blob`;
}

const EMPTY_RUN_FORM = {
  title: '',
  status: 'in_progress' as string,
  target: '',
  summary: '',
  task_id: NO_TASK_VALUE,
  event_id: NO_EVENT_VALUE,
};

export function QaPanel({
  projectId,
  onOpenPlan,
  focusRunId,
  onCountChange,
  onPlanCreated,
}: {
  projectId: string;
  onOpenPlan?: (planId: string) => void;
  focusRunId?: string | null;
  onCountChange?: (count: number) => void;
  onPlanCreated?: () => void;
}) {
  const [runs, setRuns] = useState<QaRun[]>([]);
  const [events, setEvents] = useState<QaEvent[]>([]);
  const [evidenceByRun, setEvidenceByRun] = useState<Record<string, QaEvidence[]>>({});
  const [tasks, setTasks] = useState<TaskOption[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [selectedEventId, setSelectedEventId] = useState<string>(ALL_EVENTS_VALUE);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRunIds, setSelectedRunIds] = useState<Set<string>>(new Set());
  const [bulkEventId, setBulkEventId] = useState(NO_EVENT_VALUE);
  const [isAssigningRuns, setIsAssigningRuns] = useState(false);
  const [eventSidebarWidth, setEventSidebarWidth] = useState(QA_EVENT_SIDEBAR_DEFAULT_WIDTH);
  const [isResizingEventSidebar, setIsResizingEventSidebar] = useState(false);

  // Create/edit event dialog
  const [showEventDialog, setShowEventDialog] = useState(false);
  const [editingEventId, setEditingEventId] = useState<string | null>(null);
  const [eventForm, setEventForm] = useState({ name: '' });
  const [isSavingEvent, setIsSavingEvent] = useState(false);

  // Delete event confirmation
  const [deleteEvent, setDeleteEvent] = useState<QaEvent | null>(null);

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
  const eventSidebarResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);

  // Delete evidence confirmation
  const [deleteEvidence, setDeleteEvidence] = useState<QaEvidence | null>(null);

  // Lightbox — steps through the selected run's image evidence only.
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const focusedRunIdRef = useRef<string | null>(null);

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
      // Report upward only on an unfiltered load. A filtered list is a subset, and the
      // tab badge means "how many runs exist", not "how many match the current filter".
      if (statusFilter === 'all') onCountChange?.(list.length);
    } catch {
      toast.error('Failed to connect to server');
    } finally {
      setIsLoading(false);
    }
  }, [projectId, statusFilter, onCountChange]);

  const fetchEvents = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/qa/events`);
      const data = await res.json();
      if (!res.ok || data.error) {
        toast.error(data.error ?? 'Failed to load QA events');
        return;
      }
      setEvents(data.events ?? []);
    } catch {
      toast.error('Failed to connect to server');
    }
  }, [projectId]);

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
    fetchEvents();
  }, [fetchEvents]);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);

  const eventById = useMemo(() => new Map(events.map((event) => [event.id, event])), [events]);

  const eventStats = useMemo(() => {
    const stats = new Map<string, { total: number; passed: number; failed: number; blocked: number; in_progress: number }>();
    for (const run of runs) {
      if (!run.event_id) continue;
      const current = stats.get(run.event_id) ?? { total: 0, passed: 0, failed: 0, blocked: 0, in_progress: 0 };
      current.total += 1;
      if (run.status in current) current[run.status as keyof typeof current] += 1;
      stats.set(run.event_id, current);
    }
    return stats;
  }, [runs]);

  const visibleRuns = useMemo(() => {
    if (selectedEventId === ALL_EVENTS_VALUE) return runs;
    if (selectedEventId === UNGROUPED_EVENTS_VALUE) return runs.filter((run) => !run.event_id);
    return runs.filter((run) => run.event_id === selectedEventId);
  }, [runs, selectedEventId]);

  const selectedEvent = selectedEventId !== ALL_EVENTS_VALUE && selectedEventId !== UNGROUPED_EVENTS_VALUE
    ? eventById.get(selectedEventId) ?? null
    : null;

  // Keeps a selection across refreshes and event filters; falls back to the
  // first remaining run once the selected one is gone or filtered out.
  useEffect(() => {
    if (!focusRunId) focusedRunIdRef.current = null;
    const focusedRun = focusRunId ? runs.find((run) => run.id === focusRunId) : null;
    if (focusRunId && focusedRunIdRef.current !== focusRunId) {
      if (!focusedRun) return;
      focusedRunIdRef.current = focusRunId;
      setSelectedRunId(focusRunId);
      return;
    }
    if (selectedRunId && visibleRuns.some((r) => r.id === selectedRunId)) return;
    setSelectedRunId(visibleRuns[0]?.id ?? null);
  }, [focusRunId, runs, visibleRuns, selectedRunId]);

  useEffect(() => {
    setSelectedRunIds((current) => new Set([...current].filter((id) => runs.some((run) => run.id === id))));
  }, [runs]);

  useEffect(() => {
    setBulkEventId(selectedEventId !== ALL_EVENTS_VALUE && selectedEventId !== UNGROUPED_EVENTS_VALUE
      ? selectedEventId
      : NO_EVENT_VALUE);
  }, [selectedEventId]);

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
        const evidence = data.evidence ?? [];
        setEvidenceByRun((prev) => ({ ...prev, [runId]: evidence }));
        setRuns((prev) => prev.map((r) => (
          r.id === runId
            ? { ...r, ...data.run, evidence_count: evidence.length }
            : r
        )));
      } catch {
        // Best-effort refresh; the next full fetchRuns() reconciles any drift.
      }
    },
    [projectId]
  );

  useEffect(() => {
    if (selectedRunId) refreshRunDetail(selectedRunId);
  }, [selectedRunId, refreshRunDetail]);

  const resetRunForm = () => setRunForm({ ...EMPTY_RUN_FORM });

  const openEventCreate = () => {
    setEditingEventId(null);
    setEventForm({ name: '' });
    setShowEventDialog(true);
  };

  const openEventEdit = (event: QaEvent) => {
    setEditingEventId(event.id);
    setEventForm({ name: event.name });
    setShowEventDialog(true);
  };

  const openRunCreate = () => {
    setEditingRunId(null);
    resetRunForm();
    if (selectedEventId !== ALL_EVENTS_VALUE && selectedEventId !== UNGROUPED_EVENTS_VALUE) {
      setRunForm((current) => ({ ...current, event_id: selectedEventId }));
    }
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
      event_id: run.event_id ?? NO_EVENT_VALUE,
    });
    setShowRunDialog(true);
  };

  const handleSaveEvent = async () => {
    const name = eventForm.name.trim();
    if (!name) {
      toast.error('Event name is required');
      return;
    }
    setIsSavingEvent(true);
    try {
      const res = await fetch(
        editingEventId
          ? `/api/projects/${projectId}/qa/events/${editingEventId}`
          : `/api/projects/${projectId}/qa/events`,
        {
          method: editingEventId ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        },
      );
      const data = await res.json();
      if (!res.ok || data.error) {
        toast.error(data.error ?? `Failed to ${editingEventId ? 'rename' : 'create'} event`);
        return;
      }

      let assignedCount = 0;
      let assignmentFailed = false;
      if (!editingEventId && selectedRunIds.size > 0) {
        const results = await Promise.all(
          [...selectedRunIds].map(async (runId) => {
            const assignRes = await fetch(`/api/projects/${projectId}/qa/runs/${runId}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ event_id: data.id }),
            });
            return assignRes.ok;
          }),
        );
        assignedCount = results.filter(Boolean).length;
        assignmentFailed = assignedCount !== results.length;
      }

      setShowEventDialog(false);
      setEditingEventId(null);
      setEventForm({ name: '' });
      setSelectedRunIds(new Set());
      setSelectedEventId(data.id);
      await Promise.all([fetchEvents(), fetchRuns()]);
      if (assignmentFailed) {
        toast.error(`Event saved, but only ${assignedCount} of ${selectedRunIds.size} selected runs were moved`);
      } else if (assignedCount > 0) {
        toast.success(`Event created and ${assignedCount} run${assignedCount === 1 ? '' : 's'} grouped`);
      } else {
        toast.success(editingEventId ? 'Event renamed' : 'Event created');
      }
    } catch {
      toast.error(`Failed to ${editingEventId ? 'rename' : 'create'} event`);
    } finally {
      setIsSavingEvent(false);
    }
  };

  const handleAssignSelectedRuns = async () => {
    if (selectedRunIds.size === 0) return;
    setIsAssigningRuns(true);
    const eventId = bulkEventId === NO_EVENT_VALUE ? null : bulkEventId;
    try {
      const results = await Promise.all(
        [...selectedRunIds].map(async (runId) => {
          const res = await fetch(`/api/projects/${projectId}/qa/runs/${runId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ event_id: eventId }),
          });
          return res.ok;
        }),
      );
      const updatedCount = results.filter(Boolean).length;
      if (updatedCount !== results.length) {
        toast.error(`Only ${updatedCount} of ${results.length} runs were updated`);
      } else {
        toast.success(eventId ? `${updatedCount} run${updatedCount === 1 ? '' : 's'} grouped` : `${updatedCount} runs ungrouped`);
      }
      setSelectedRunIds(new Set());
      await fetchRuns();
    } catch {
      toast.error('Failed to update selected runs');
    } finally {
      setIsAssigningRuns(false);
    }
  };

  const toggleRunSelection = (runId: string) => {
    setSelectedRunIds((current) => {
      const next = new Set(current);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  };

  const handleDeleteEvent = async () => {
    if (!deleteEvent) return;
    try {
      const res = await fetch(`/api/projects/${projectId}/qa/events/${deleteEvent.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok || data.error) {
        toast.error(data.error ?? 'Failed to delete event');
        return;
      }
      const runCount = eventStats.get(deleteEvent.id)?.total ?? 0;
      setDeleteEvent(null);
      if (selectedEventId === deleteEvent.id) setSelectedEventId(ALL_EVENTS_VALUE);
      await Promise.all([fetchEvents(), fetchRuns()]);
      toast.success(`Event deleted; ${runCount} run${runCount === 1 ? '' : 's'} left ungrouped`);
    } catch {
      toast.error('Failed to delete event');
    }
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
      const eventId = runForm.event_id === NO_EVENT_VALUE ? null : runForm.event_id;
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
            event_id: eventId,
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
            event_id: eventId ?? undefined,
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
      await fetchRuns();
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

  useEffect(() => {
    const storedWidth = window.localStorage.getItem(`${QA_EVENT_SIDEBAR_STORAGE_KEY}:${projectId}`);
    if (!storedWidth) {
      setEventSidebarWidth(QA_EVENT_SIDEBAR_DEFAULT_WIDTH);
      return;
    }
    const parsedWidth = Number(storedWidth);
    if (Number.isFinite(parsedWidth)) setEventSidebarWidth(clampQaEventSidebarWidth(parsedWidth));
  }, [projectId]);

  useEffect(() => {
    window.localStorage.setItem(`${QA_EVENT_SIDEBAR_STORAGE_KEY}:${projectId}`, String(eventSidebarWidth));
  }, [eventSidebarWidth, projectId]);

  const handleEventSidebarResizeStart = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    eventSidebarResizeRef.current = { startX: event.clientX, startWidth: eventSidebarWidth };
    setIsResizingEventSidebar(true);
  };

  const handleEventSidebarResizeMove = (event: PointerEvent<HTMLButtonElement>) => {
    const resizeStart = eventSidebarResizeRef.current;
    if (!resizeStart) return;
    setEventSidebarWidth(clampQaEventSidebarWidth(resizeStart.startWidth + event.clientX - resizeStart.startX));
  };

  const handleEventSidebarResizeEnd = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    eventSidebarResizeRef.current = null;
    setIsResizingEventSidebar(false);
  };

  const handleEventSidebarResizeKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    let nextWidth: number | null = null;
    if (event.key === 'ArrowLeft') nextWidth = eventSidebarWidth - 16;
    if (event.key === 'ArrowRight') nextWidth = eventSidebarWidth + 16;
    if (event.key === 'Home') nextWidth = QA_EVENT_SIDEBAR_MIN_WIDTH;
    if (event.key === 'End') nextWidth = QA_EVENT_SIDEBAR_MAX_WIDTH;
    if (nextWidth === null) return;
    event.preventDefault();
    setEventSidebarWidth(clampQaEventSidebarWidth(nextWidth));
  };

  return (
    <div className="flex h-full w-full min-w-0 flex-col">
      <div className="-mx-4 flex w-[calc(100%+2rem)] shrink-0 flex-wrap items-center justify-between gap-3 border-b px-4 pb-3">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">QA timeline</p>
          <h2 className="text-sm font-semibold">Events &amp; runs ({runs.length})</h2>
          <p className="text-xs text-muted-foreground">Group a deployment checkpoint, then keep each test and its evidence in order.</p>
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
          <Button variant="outline" size="sm" onClick={openEventCreate}>
            <CalendarDays className="h-4 w-4 mr-2" />
            New Event
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
      ) : runs.length === 0 && events.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <ClipboardCheck className="h-10 w-10 mx-auto mb-3 opacity-30" />
          <p className="text-sm">No QA runs recorded.</p>
          <p className="text-xs mt-1">Start one manually, or have an agent invoke the qa-run skill.</p>
        </div>
      ) : (
        <div
          className="-mx-4 grid w-[calc(100%+2rem)] min-w-0 flex-1 grid-cols-1 gap-0 overflow-hidden lg:grid-cols-[var(--qa-event-sidebar-width)_12px_minmax(0,1fr)]"
          style={{ '--qa-event-sidebar-width': `${eventSidebarWidth}px` } as CSSProperties}
        >
          {/* Event index + run list */}
          <aside className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-muted/10">
            <div className="shrink-0 border-b px-3 py-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="text-xs font-semibold">Event index</p>
                  <p className="text-[11px] text-muted-foreground">Organize runs like release checkpoints.</p>
                </div>
                <Badge variant="secondary" className="shrink-0 font-mono text-[10px]">{events.length}</Badge>
              </div>
              <div className="mt-3 space-y-0.5" role="tree" aria-label="QA events">
                <button
                  type="button"
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
                    selectedEventId === ALL_EVENTS_VALUE ? 'bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                  }`}
                  onClick={() => setSelectedEventId(ALL_EVENTS_VALUE)}
                  aria-selected={selectedEventId === ALL_EVENTS_VALUE}
                  role="treeitem"
                >
                  <ClipboardCheck className="h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">All runs</span>
                  <span className="font-mono text-[10px] text-muted-foreground/70">{runs.length}</span>
                </button>
                <button
                  type="button"
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
                    selectedEventId === UNGROUPED_EVENTS_VALUE ? 'bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                  }`}
                  onClick={() => setSelectedEventId(UNGROUPED_EVENTS_VALUE)}
                  aria-selected={selectedEventId === UNGROUPED_EVENTS_VALUE}
                  role="treeitem"
                >
                  <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">Ungrouped</span>
                  <span className="font-mono text-[10px] text-muted-foreground/70">{runs.filter((run) => !run.event_id).length}</span>
                </button>
                {events.map((event) => {
                  const stats = eventStats.get(event.id) ?? { total: 0, passed: 0, failed: 0, blocked: 0, in_progress: 0 };
                  const isEventSelected = selectedEventId === event.id;
                  return (
                    <div key={event.id} className={`group flex items-center transition-colors ${isEventSelected ? 'bg-primary/10' : 'hover:bg-muted/60'}`}>
                      <button
                        type="button"
                        className={`flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left text-xs ${isEventSelected ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                        onClick={() => setSelectedEventId(event.id)}
                        aria-selected={isEventSelected}
                        role="treeitem"
                        title={event.name}
                      >
                        {isEventSelected ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
                        <CalendarDays className={`h-3.5 w-3.5 shrink-0 ${isEventSelected ? 'text-primary' : 'text-muted-foreground/80'}`} />
                        <span className="min-w-0 flex-1 truncate">{event.name}</span>
                        <span className="font-mono text-[10px] text-muted-foreground/70">{stats.total}</span>
                      </button>
                      <div className="flex shrink-0 items-center pr-1 opacity-0 transition-opacity group-hover:opacity-100">
                        <Button type="button" variant="ghost" size="icon" className="h-6 w-6" title="Rename event" onClick={() => openEventEdit(event)}>
                          <Pencil className="h-3 w-3" />
                        </Button>
                        <Button type="button" variant="ghost" size="icon" className="h-6 w-6 text-destructive hover:text-destructive" title="Delete event" onClick={() => setDeleteEvent(event)}>
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {selectedRunIds.size > 0 && (
              <div className="shrink-0 border-b bg-background/80 p-2.5 backdrop-blur">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold">{selectedRunIds.size} selected</span>
                  <button type="button" className="text-[11px] text-muted-foreground underline-offset-2 hover:underline" onClick={() => setSelectedRunIds(new Set())}>
                    Clear
                  </button>
                </div>
                <div className="flex gap-1.5">
                  <Select value={bulkEventId} onValueChange={setBulkEventId}>
                    <SelectTrigger className="h-8 min-w-0 flex-1 text-xs">
                      <SelectValue placeholder="Move to event" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_EVENT_VALUE}>Ungrouped</SelectItem>
                      {events.map((event) => <SelectItem key={event.id} value={event.id}>{event.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Button size="sm" className="h-8" onClick={handleAssignSelectedRuns} disabled={isAssigningRuns}>
                    {isAssigningRuns ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : 'Move'}
                  </Button>
                </div>
                <p className="mt-1.5 text-[10px] leading-4 text-muted-foreground">Or use New Event to create a group and move these runs into it.</p>
              </div>
            )}

            <div className="min-h-0 flex-1 overflow-y-auto">
              {visibleRuns.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 py-12 text-center text-muted-foreground">
                  <ClipboardCheck className="h-7 w-7 opacity-30" />
                  <p className="text-xs">{runs.length === 0 ? 'No QA runs recorded.' : 'No runs in this event.'}</p>
                  {runs.length === 0 && <p className="max-w-[220px] text-[11px]">Start one manually, or have an agent invoke the qa-run skill.</p>}
                </div>
              ) : visibleRuns.map((run) => {
              const evidenceCount = run.evidence_count ?? 0;
              const totalCases = run.total_cases ?? 0;
              const task = run.task_id ? taskById.get(run.task_id) : undefined;
              const isSelected = run.id === selectedRunId;
              const isChecked = selectedRunIds.has(run.id);
              const event = run.event_id ? eventById.get(run.event_id) : undefined;
              const runKind = run.kind ?? 'manual';
              return (
                <div
                  key={run.id}
                  onClick={() => setSelectedRunId(run.id)}
                    className={`flex cursor-pointer flex-col gap-1.5 border-b px-3 py-3 transition-colors ${
                    isSelected ? 'bg-primary/5' : 'bg-background hover:bg-muted/30'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => toggleRunSelection(run.id)}
                      onClick={(e) => e.stopPropagation()}
                      aria-label={`Select ${run.title}`}
                      className="mt-1 h-3.5 w-3.5 shrink-0 accent-primary"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <Badge variant="outline" className={`text-xs shrink-0 ${statusColor(run.status)}`}>
                          {statusLabel(run.status)}
                        </Badge>
                        <Badge variant="outline" className={`text-[10px] shrink-0 ${runKindColor(runKind)}`}>
                          {runKindLabel(runKind)}
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
                    {totalCases > 0 && (
                      <span className="text-xs text-muted-foreground">
                        {run.passed_cases ?? 0} passed · {run.failed_cases ?? 0} failed · {run.skipped_cases ?? 0} skipped
                      </span>
                    )}
                    {task && (
                      <Badge variant="outline" className="text-xs gap-1 min-w-0">
                        <ListChecks className="h-3 w-3 shrink-0" />
                        <span className="truncate max-w-[160px]">{task.title}</span>
                      </Badge>
                    )}
                    {event && selectedEventId === ALL_EVENTS_VALUE && (
                      <Badge variant="secondary" className="max-w-[160px] truncate text-[10px]">{event.name}</Badge>
                    )}
                  </div>
                </div>
              );
            })}
            </div>
          </aside>

          <button
            type="button"
            role="separator"
            aria-label="Resize QA event sidebar"
            aria-orientation="vertical"
            aria-valuemin={QA_EVENT_SIDEBAR_MIN_WIDTH}
            aria-valuemax={QA_EVENT_SIDEBAR_MAX_WIDTH}
            aria-valuenow={eventSidebarWidth}
            title="Drag to resize · Use arrow keys to adjust · Double-click to reset"
            tabIndex={0}
            className={`group relative hidden h-full w-3 cursor-col-resize items-stretch justify-center bg-transparent p-0 outline-none lg:flex ${isResizingEventSidebar ? 'bg-primary/5' : ''}`}
            onPointerDown={handleEventSidebarResizeStart}
            onPointerMove={handleEventSidebarResizeMove}
            onPointerUp={handleEventSidebarResizeEnd}
            onPointerCancel={handleEventSidebarResizeEnd}
            onKeyDown={handleEventSidebarResizeKeyDown}
            onDoubleClick={() => setEventSidebarWidth(QA_EVENT_SIDEBAR_DEFAULT_WIDTH)}
          >
            <span
              aria-hidden="true"
              className={`h-full w-px transition-colors ${isResizingEventSidebar ? 'bg-primary' : 'bg-border/60 group-hover:bg-primary/60 group-focus-visible:bg-primary'}`}
            />
          </button>

          {/* Run detail */}
          <div className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-y-auto px-4 py-3">
            <div className="mb-3 shrink-0 border-b pb-3">
              <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Selected scope</p>
              <h3 className="text-sm font-semibold">
                {selectedEvent?.name ?? (selectedEventId === UNGROUPED_EVENTS_VALUE ? 'Ungrouped runs' : 'All QA runs')}
              </h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {selectedEvent ? `${eventStats.get(selectedEvent.id)?.total ?? 0} run${(eventStats.get(selectedEvent.id)?.total ?? 0) === 1 ? '' : 's'} in this event` : 'Select an event to focus the timeline.'}
              </p>
            </div>
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

                <QaTestsPanel key={projectId} projectId={projectId} run={selectedRun} onOpenPlan={onOpenPlan} onPlanCreated={onPlanCreated} />

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

      {/* Create/Edit Event Dialog */}
      <Dialog open={showEventDialog} onOpenChange={setShowEventDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editingEventId ? 'Rename QA Event' : 'New QA Event'}</DialogTitle>
            <DialogDescription>
              {selectedRunIds.size > 0 && !editingEventId
                ? `Name this group and move the ${selectedRunIds.size} selected run${selectedRunIds.size === 1 ? '' : 's'} into it.`
                : 'Create a named checkpoint for related QA runs.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5 py-2">
            <Label htmlFor="event-name">Event name <span className="text-destructive">*</span></Label>
            <Input
              id="event-name"
              placeholder="e.g. before deploy v1.0.0"
              value={eventForm.name}
              onChange={(e) => setEventForm({ name: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter' && eventForm.name.trim()) handleSaveEvent(); }}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowEventDialog(false)}>Cancel</Button>
            <Button onClick={handleSaveEvent} disabled={isSavingEvent || !eventForm.name.trim()}>
              {isSavingEvent ? 'Saving…' : editingEventId ? 'Rename' : 'Create event'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
              <Label>QA event</Label>
              <Select value={runForm.event_id} onValueChange={(v) => setRunForm((f) => ({ ...f, event_id: v }))}>
                <SelectTrigger>
                  <SelectValue placeholder="Ungrouped" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_EVENT_VALUE}>Ungrouped</SelectItem>
                  {events.map((event) => (
                    <SelectItem key={event.id} value={event.id}>
                      {event.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">Use an event for a release or deployment checkpoint shared by several runs.</p>
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

      {/* Delete Event Confirmation */}
      <AlertDialog open={!!deleteEvent} onOpenChange={(open) => !open && setDeleteEvent(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete QA Event</AlertDialogTitle>
            <AlertDialogDescription>
              Delete <code className="font-mono">{deleteEvent?.name}</code>? The runs and evidence will be kept, but
              {` ${(eventStats.get(deleteEvent?.id ?? '')?.total ?? 0)} `}run{(eventStats.get(deleteEvent?.id ?? '')?.total ?? 0) === 1 ? ' will' : 's will'} become ungrouped.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteEvent} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Delete event
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
