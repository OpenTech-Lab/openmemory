'use client';

import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from 'react';
import {
  format,
  startOfDay,
  addDays,
  differenceInCalendarDays,
  eachMonthOfInterval,
  startOfMonth,
  endOfMonth,
  isBefore,
  isWeekend,
} from 'date-fns';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  ChevronRight,
  ChevronLeft,
  ChevronDown,
  Plus,
  RefreshCw,
  Pencil,
  Trash2,
  CalendarIcon,
  GanttChartSquare,
  ChevronsDownUp,
  ChevronsUpDown,
  Eye,
  EyeOff,
} from 'lucide-react';
import { toast } from 'sonner';
import { I18nText } from '@/lib/i18n';

interface Project {
  id: string;
  name: string;
}

interface Task {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  assigned_to: string | null;
  parent_id: string | null;
  start_date: string | null;
  due_date: string | null;
  sort_order: number;
  created_at: string;
}

interface TaskNode extends Task {
  depth: number;
  children: TaskNode[];
}

/** A task's own dates, or — when it has none — the span rolled up from its descendants. */
interface Span {
  from: Date;
  to: Date;
  rollup: boolean;
}

const ROW_H = 34;
const DONE_STATUSES = new Set(['done', 'cancelled']);

const ZOOMS = {
  day: { dayWidth: 32, label: 'Day' },
  week: { dayWidth: 11, label: 'Week' },
  month: { dayWidth: 3.6, label: 'Month' },
} as const;
type ZoomKey = keyof typeof ZOOMS;

/** [days before earliest, days after latest] of blank canvas per zoom, so you can plan ahead. */
const PADS: Record<ZoomKey, [number, number]> = {
  day: [21, 90],
  week: [45, 210],
  month: [120, 420],
};

/** How many extra days to bolt onto whichever edge you scroll into, per zoom. */
const EXTEND_STEPS: Record<ZoomKey, number> = {
  day: 30,
  week: 90,
  month: 180,
};

type DragMode = 'move' | 'start' | 'end';

/** Preview/commit a bar drag: move shifts both ends, start/end resize one edge. */
function applyDrag(from: Date, to: Date, mode: DragMode, delta: number): { from: Date; to: Date } {
  if (delta === 0) return { from, to };
  if (mode === 'move') return { from: addDays(from, delta), to: addDays(to, delta) };
  if (mode === 'start') {
    const next = addDays(from, delta);
    return { from: next > to ? to : next, to };
  }
  const next = addDays(to, delta);
  return { from, to: next < from ? from : next };
}

const STATUS_LABELS: Record<string, string> = {
  todo: 'Todo',
  in_progress: 'In Progress',
  done: 'Done',
  cancelled: 'Cancelled',
  scheduled: 'Scheduled',
};

const STATUS_DOT: Record<string, string> = {
  todo: 'bg-muted-foreground/40',
  in_progress: 'bg-blue-500',
  done: 'bg-emerald-500',
  cancelled: 'bg-muted-foreground/25',
  scheduled: 'bg-violet-500',
};

const BAR_FILL: Record<string, string> = {
  todo: 'bg-foreground/35',
  in_progress: 'bg-blue-500',
  done: 'bg-emerald-500/70',
  cancelled: 'bg-muted-foreground/25',
  scheduled: 'bg-violet-500',
};

const PRIORITY_TEXT: Record<string, string> = {
  low: 'text-muted-foreground/70',
  medium: 'text-amber-600 dark:text-amber-400',
  high: 'text-destructive',
};

const EMPTY_FORM = {
  id: null as string | null,
  project_id: null as string | null,
  title: '',
  description: '',
  status: 'todo',
  priority: 'medium',
  parent_id: null as string | null,
  start_date: null as string | null,
  due_date: null as string | null,
};

function toDate(s: string): Date {
  // Dates come back as YYYY-MM-DD; parse as local midnight, not UTC.
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function buildTree(tasks: Task[]): TaskNode[] {
  const byParent = new Map<string | null, Task[]>();
  const ids = new Set(tasks.map((t) => t.id));
  for (const t of tasks) {
    // Orphans (parent filtered out by paging) surface at root rather than vanishing.
    const key = t.parent_id && ids.has(t.parent_id) ? t.parent_id : null;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(t);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at));
  }
  const attach = (parentId: string | null, depth: number): TaskNode[] =>
    (byParent.get(parentId) ?? []).map((t) => ({ ...t, depth, children: attach(t.id, depth + 1) }));
  return attach(null, 0);
}

/** Keep a node when it matches, or when any descendant does, so parents never hide open children. */
function pruneTree(nodes: TaskNode[], keep: (t: TaskNode) => boolean): TaskNode[] {
  const out: TaskNode[] = [];
  for (const n of nodes) {
    const children = pruneTree(n.children, keep);
    if (keep(n) || children.length > 0) out.push({ ...n, children });
  }
  return out;
}

function flatten(nodes: TaskNode[]): TaskNode[] {
  const out: TaskNode[] = [];
  const visit = (n: TaskNode) => {
    out.push(n);
    n.children.forEach(visit);
  };
  nodes.forEach(visit);
  return out;
}

function descendantIds(node: TaskNode | undefined): Set<string> {
  const out = new Set<string>();
  if (!node) return out;
  const visit = (n: TaskNode) => {
    out.add(n.id);
    n.children.forEach(visit);
  };
  node.children.forEach(visit);
  return out;
}

/** Own dates win; otherwise span the descendants that do have dates. */
function computeSpan(node: TaskNode): Span | null {
  if (node.start_date || node.due_date) {
    const from = toDate(node.start_date ?? node.due_date!);
    const to = toDate(node.due_date ?? node.start_date!);
    return { from: from <= to ? from : to, to: to >= from ? to : from, rollup: false };
  }
  const childSpans = node.children.map(computeSpan).filter((s): s is Span => s !== null);
  if (childSpans.length === 0) return null;
  return {
    from: new Date(Math.min(...childSpans.map((s) => s.from.getTime()))),
    to: new Date(Math.max(...childSpans.map((s) => s.to.getTime()))),
    rollup: true,
  };
}

function isOverdue(node: TaskNode, span: Span | null): boolean {
  if (!span || span.rollup || DONE_STATUSES.has(node.status)) return false;
  return isBefore(span.to, startOfDay(new Date()));
}

export function ProjectRoadmapView() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectIds, setSelectedProjectIds] = useState<Set<string>>(new Set());
  const [tasks, setTasks] = useState<Task[]>([]);
  const [isLoadingProjects, setIsLoadingProjects] = useState(false);
  const [isLoadingTasks, setIsLoadingTasks] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [zoom, setZoom] = useState<ZoomKey>('day');
  const [hideDone, setHideDone] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [leftWidth, setLeftWidth] = useState(380);
  const [showDialog, setShowDialog] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [isSaving, setIsSaving] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [schedulingId, setSchedulingId] = useState<string | null>(null);

  const [drag, setDrag] = useState<{ id: string; mode: DragMode; delta: number } | null>(null);
  // Extra days bolted onto the data-driven range when you scroll/pan into an edge —
  // this is what makes the timeline feel infinite instead of hard-stopping.
  const [extraDays, setExtraDays] = useState({ before: 0, after: 0 });

  const scrollRef = useRef<HTMLDivElement>(null);
  const didCenterToday = useRef(false);
  // Prepending days shifts every existing x-position right; this holds how many pixels
  // of scrollLeft to add back once the DOM reflects the new range, so extending backward
  // never causes a visible jump.
  const pendingScrollAdjust = useRef(0);
  // Debounces edge-triggered extension so one continuous scroll/drag near an edge
  // doesn't fire dozens of "add 30 more days" calls.
  const extendCooldown = useRef(false);
  const dragRef = useRef<{ id: string; mode: DragMode; originX: number; from: Date; to: Date; delta: number; moved: boolean } | null>(null);
  // Holds the id of a bar that was just dragged, so its trailing click doesn't open the
  // picker. Scoped per-task and self-clearing — a global flag leaks onto the next click
  // when a drag ends without emitting one.
  const suppressClick = useRef<string | null>(null);

  const fetchProjects = useCallback(async () => {
    setIsLoadingProjects(true);
    try {
      const res = await fetch('/api/projects');
      const data = await res.json();
      const list: Project[] = data.projects ?? data ?? [];
      setProjects(list);
      setSelectedProjectIds((cur) => (cur.size > 0 ? cur : list[0] ? new Set([list[0].id]) : cur));
    } catch {
      toast.error('Failed to load projects');
    } finally {
      setIsLoadingProjects(false);
    }
  }, []);

  const fetchTasks = useCallback(async (projectIds: string[]) => {
    if (projectIds.length === 0) { setTasks([]); return; }
    setIsLoadingTasks(true);
    try {
      const results = await Promise.all(
        projectIds.map((id) => fetch(`/api/projects/${id}/tasks?limit=200`).then((r) => r.json()))
      );
      setTasks(results.flatMap((data) => data.tasks ?? []));
    } catch {
      toast.error('Failed to load tasks');
    } finally {
      setIsLoadingTasks(false);
    }
  }, []);

  const selectedIdsKey = [...selectedProjectIds].sort().join(',');
  useEffect(() => { fetchProjects(); }, [fetchProjects]);
  useEffect(() => { fetchTasks([...selectedProjectIds]); }, [selectedIdsKey, fetchTasks]); // eslint-disable-line react-hooks/exhaustive-deps

  const projectNameById = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects]);

  // Built per-project (in a stable order) rather than as one merged tree, so tasks from
  // different projects group cleanly instead of interleaving by sort_order/created_at.
  const fullTree = useMemo(() => {
    const byProject = new Map<string, Task[]>();
    for (const t of tasks) {
      if (!byProject.has(t.project_id)) byProject.set(t.project_id, []);
      byProject.get(t.project_id)!.push(t);
    }
    return projects
      .filter((p) => byProject.has(p.id))
      .flatMap((p) => buildTree(byProject.get(p.id)!));
  }, [tasks, projects]);
  const searchTree = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return fullTree;
    return pruneTree(fullTree, (task) => [
      task.title,
      task.description ?? '',
      projectNameById.get(task.project_id) ?? '',
      STATUS_LABELS[task.status] ?? task.status,
      task.priority,
    ].some((field) => field.toLowerCase().includes(query)));
  }, [fullTree, projectNameById, searchQuery]);
  const tree = useMemo(
    () => (hideDone ? pruneTree(searchTree, (t) => !DONE_STATUSES.has(t.status)) : searchTree),
    [searchTree, hideDone]
  );
  const flat = useMemo(() => flatten(tree), [tree]);
  const nodeById = useMemo(() => new Map(flatten(fullTree).map((n) => [n.id, n])), [fullTree]);
  const spanById = useMemo(() => new Map(flat.map((n) => [n.id, computeSpan(n)])), [flat]);

  const rows = useMemo(() => {
    const isVisible = (node: TaskNode): boolean => {
      if (searchQuery.trim()) return true;
      let p = node.parent_id;
      while (p) {
        if (collapsed.has(p)) return false;
        p = nodeById.get(p)?.parent_id ?? null;
      }
      return true;
    };
    return flat.filter(isVisible);
  }, [flat, collapsed, nodeById, searchQuery]);

  // Base range: covers every dated task and today, padded generously so there is always
  // empty canvas to scroll into. `extraDays` then bolts more on whichever edge you hit,
  // so the timeline never hard-stops.
  const { rangeStart, totalDays } = useMemo(() => {
    const today = startOfDay(new Date());
    const stamps: number[] = [today.getTime()];
    for (const s of spanById.values()) {
      if (s) { stamps.push(s.from.getTime(), s.to.getTime()); }
    }
    const [padBefore, padAfter] = PADS[zoom];
    const start = addDays(startOfDay(new Date(Math.min(...stamps))), -padBefore - extraDays.before);
    const end = addDays(startOfDay(new Date(Math.max(...stamps))), padAfter + extraDays.after);
    return { rangeStart: start, totalDays: Math.max(differenceInCalendarDays(end, start) + 1, 60) };
  }, [spanById, zoom, extraDays]);

  // A zoom change or a different set of projects redefines the base range from scratch —
  // drop any manual extension so it doesn't stack on top of a now-irrelevant window.
  useEffect(() => { setExtraDays({ before: 0, after: 0 }); }, [zoom, selectedIdsKey]);

  const dayWidth = ZOOMS[zoom].dayWidth;
  const chartWidth = totalDays * dayWidth;
  const todayX = differenceInCalendarDays(startOfDay(new Date()), rangeStart) * dayWidth;

  const months = useMemo(() => {
    const end = addDays(rangeStart, totalDays - 1);
    return eachMonthOfInterval({ start: rangeStart, end }).map((m) => {
      const from = startOfMonth(m) < rangeStart ? rangeStart : startOfMonth(m);
      const to = endOfMonth(m) > end ? end : endOfMonth(m);
      return {
        key: format(m, 'yyyy-MM'),
        label: format(m, dayWidth < 6 ? 'MMM' : 'MMMM yyyy'),
        x: differenceInCalendarDays(from, rangeStart) * dayWidth,
        w: (differenceInCalendarDays(to, from) + 1) * dayWidth,
      };
    });
  }, [rangeStart, totalDays, dayWidth]);

  const ticks = useMemo(() => {
    if (zoom === 'month') return [];
    const step = zoom === 'day' ? 1 : 7;
    const out: { key: string; x: number; label: string; weekend: boolean }[] = [];
    for (let i = 0; i < totalDays; i += step) {
      const d = addDays(rangeStart, i);
      out.push({
        key: d.toISOString(),
        x: i * dayWidth,
        label: zoom === 'day' ? format(d, 'd') : format(d, 'd MMM'),
        weekend: zoom === 'day' && isWeekend(d),
      });
    }
    return out;
  }, [rangeStart, totalDays, dayWidth, zoom]);

  const stats = useMemo(() => {
    let overdue = 0, soon = 0, unscheduled = 0;
    const in7 = addDays(startOfDay(new Date()), 7);
    for (const n of flat) {
      if (DONE_STATUSES.has(n.status)) continue;
      const s = spanById.get(n.id) ?? null;
      if (!s || s.rollup) { unscheduled++; continue; }
      if (isOverdue(n, s)) overdue++;
      else if (s.to <= in7) soon++;
    }
    return { overdue, soon, unscheduled };
  }, [flat, spanById]);

  // Bring today into view once the timeline first has width.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || didCenterToday.current || rows.length === 0) return;
    el.scrollLeft = Math.max(todayX - el.clientWidth / 3, 0);
    didCenterToday.current = true;
  }, [rows.length, todayX]);

  // Compensate scrollLeft after the range grows backward, so the view doesn't jump.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && pendingScrollAdjust.current !== 0) {
      el.scrollLeft += pendingScrollAdjust.current;
      pendingScrollAdjust.current = 0;
    }
  }, [rangeStart]);

  function toggleCollapse(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  /** Bolts more days onto whichever edge is reached — this is what makes the timeline feel infinite. */
  function extendRange(direction: 'before' | 'after') {
    const step = EXTEND_STEPS[zoom];
    if (direction === 'before') pendingScrollAdjust.current += step * dayWidth;
    setExtraDays((prev) =>
      direction === 'before' ? { ...prev, before: prev.before + step } : { ...prev, after: prev.after + step }
    );
  }

  /** True once scrollLeft has nowhere further to go on that side (accounts for sub-pixel rounding). */
  function isAtEdge(el: HTMLDivElement, side: 'start' | 'end'): boolean {
    return side === 'start' ? el.scrollLeft <= 2 : el.scrollLeft >= el.scrollWidth - el.clientWidth - 2;
  }

  function maybeExtendAtEdge(el: HTMLDivElement) {
    if (extendCooldown.current) return;
    if (isAtEdge(el, 'start')) {
      extendCooldown.current = true;
      extendRange('before');
      setTimeout(() => { extendCooldown.current = false; }, 120);
    } else if (isAtEdge(el, 'end')) {
      extendCooldown.current = true;
      extendRange('after');
      setTimeout(() => { extendCooldown.current = false; }, 120);
    }
  }

  /** Catches trackpad/wheel/scrollbar input reaching an edge — buttons and drag-pan handle themselves. */
  const handleTimelineScroll = () => {
    const el = scrollRef.current;
    if (el) maybeExtendAtEdge(el);
  };

  const panBy = (dir: 1 | -1) => {
    const el = scrollRef.current;
    if (!el) return;
    // Already pinned to this edge: extend first so there's somewhere to scroll into,
    // rather than a dead click.
    if (dir === -1 && isAtEdge(el, 'start')) extendRange('before');
    else if (dir === 1 && isAtEdge(el, 'end')) extendRange('after');
    requestAnimationFrame(() => {
      el.scrollBy({ left: dir * el.clientWidth * 0.6, behavior: 'smooth' });
    });
  };

  const goToToday = () => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ left: Math.max(todayX - el.clientWidth / 3, 0), behavior: 'smooth' });
  };

  /** Click-drag anywhere on empty timeline to pan, like a map — extends past either edge. */
  const startPan = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (!target.closest('[data-timeline]') || target.closest('[data-bar]')) return;
    const el = scrollRef.current;
    if (!el) return;
    const originX = e.clientX;
    const originScroll = el.scrollLeft;
    const onMove = (ev: MouseEvent) => {
      el.scrollLeft = originScroll - (ev.clientX - originX);
      maybeExtendAtEdge(el);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  /** Drag a bar body to reschedule, or an edge handle to stretch one end. */
  const startBarDrag = (e: React.MouseEvent, node: TaskNode, span: Span, mode: DragMode) => {
    if (span.rollup) return; // summary bars are derived from children
    e.preventDefault();
    e.stopPropagation();
    suppressClick.current = null;
    dragRef.current = { id: node.id, mode, originX: e.clientX, from: span.from, to: span.to, delta: 0, moved: false };
    setDrag({ id: node.id, mode, delta: 0 });

    const onMove = (ev: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (Math.abs(ev.clientX - d.originX) > 3) d.moved = true;
      d.delta = Math.round((ev.clientX - d.originX) / dayWidth);
      setDrag({ id: d.id, mode: d.mode, delta: d.delta });
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      const d = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!d) return;
      if (d.moved) {
        // The browser fires click right after mouseup; drop the guard on the next tick.
        suppressClick.current = d.id;
        setTimeout(() => { if (suppressClick.current === d.id) suppressClick.current = null; }, 0);
      }
      if (d.moved && d.delta !== 0) {
        const next = applyDrag(d.from, d.to, d.mode, d.delta);
        patchTask(d.id, node.project_id, {
          start_date: format(next.from, 'yyyy-MM-dd'),
          due_date: format(next.to, 'yyyy-MM-dd'),
        });
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = leftWidth;
    const onMove = (ev: MouseEvent) =>
      setLeftWidth(Math.min(Math.max(startW + ev.clientX - startX, 220), 680));
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  function refreshSelected() {
    fetchProjects();
    fetchTasks([...selectedProjectIds]);
  }

  function toggleProject(id: string) {
    setSelectedProjectIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  /** A task's own project always wins; patch/delete/edit never need the picker's selection. */
  async function patchTask(id: string, projectId: string, patch: Record<string, unknown>) {
    const prev = tasks;
    setTasks((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } as Task : t)));
    try {
      const res = await fetch(`/api/projects/${projectId}/tasks/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Update failed');
    } catch (e) {
      setTasks(prev);
      toast.error(e instanceof Error ? e.message : 'Update failed');
    }
  }

  function openCreate(parentId: string | null, projectId?: string) {
    // Subtasks inherit their parent's project; a new root task defaults to the first
    // checked project but stays editable below when more than one is checked.
    const fallback = projectId ?? (selectedProjectIds.size === 1 ? [...selectedProjectIds][0] : null);
    setForm({ ...EMPTY_FORM, parent_id: parentId, project_id: fallback });
    setShowDialog(true);
  }

  function openEdit(task: TaskNode) {
    setForm({
      id: task.id,
      project_id: task.project_id,
      title: task.title,
      description: task.description ?? '',
      status: task.status,
      priority: task.priority,
      parent_id: task.parent_id,
      start_date: task.start_date,
      due_date: task.due_date,
    });
    setShowDialog(true);
  }

  async function handleSave() {
    if (!form.title.trim() || !form.project_id) return;
    const projectId = form.project_id;
    setIsSaving(true);
    try {
      const payload = {
        title: form.title.trim(),
        description: form.description || null,
        status: form.status,
        priority: form.priority,
        parent_id: form.parent_id,
        start_date: form.start_date,
        due_date: form.due_date,
      };
      const res = await fetch(
        form.id ? `/api/projects/${projectId}/tasks/${form.id}` : `/api/projects/${projectId}/tasks`,
        {
          method: form.id ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }
      );
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Save failed');
      toast.success(form.id ? 'Task updated' : 'Task created');
      setShowDialog(false);
      fetchTasks([...selectedProjectIds]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setIsSaving(false);
    }
  }

  async function handleDelete(id: string, projectId: string) {
    try {
      const res = await fetch(`/api/projects/${projectId}/tasks/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
      toast.success('Task deleted');
      setConfirmDeleteId(null);
      fetchTasks([...selectedProjectIds]);
    } catch {
      toast.error('Delete failed');
    }
  }

  const excluded = form.id ? descendantIds(nodeById.get(form.id)) : new Set<string>();
  if (form.id) excluded.add(form.id);
  // Parent must live in the same project — the backend rejects cross-project parents too.
  const parentOptions = flatten(fullTree).filter((t) => !excluded.has(t.id) && t.project_id === form.project_id);

  const headerH = zoom === 'month' ? 40 : 56;

  return (
    <div className="flex flex-col h-full min-w-0">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-3 p-4 border-b flex-wrap shrink-0">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <GanttChartSquare className="h-5 w-5 shrink-0" /> <I18nText id="page.roadmap" />
          </h1>
          <div className="text-sm text-muted-foreground mt-1 flex items-center gap-2 flex-wrap">
            {stats.overdue > 0 && (
              <span className="text-destructive font-medium">{stats.overdue} overdue</span>
            )}
            {stats.soon > 0 && <span>{stats.soon} due within 7 days</span>}
            {stats.unscheduled > 0 && (
              <span className="text-muted-foreground/80">{stats.unscheduled} unscheduled</span>
            )}
            {stats.overdue === 0 && stats.soon === 0 && stats.unscheduled === 0 && (
              <span>Drag bars to reschedule · drag the timeline to pan</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          <Input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search tasks..."
            aria-label="Search roadmap tasks"
            className="h-9 w-52"
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="w-52 justify-between font-normal min-w-0 h-9">
                <span className="truncate">
                  {selectedProjectIds.size === 0
                    ? 'Select projects'
                    : selectedProjectIds.size === 1
                      ? projectNameById.get([...selectedProjectIds][0]) ?? '1 project'
                      : `${selectedProjectIds.size} projects`}
                </span>
                <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64 max-h-80 overflow-y-auto">
              {projects.length === 0 ? (
                <div className="px-2 py-1.5 text-sm text-muted-foreground">No projects yet</div>
              ) : (
                projects.map((p) => (
                  <DropdownMenuCheckboxItem
                    key={p.id}
                    checked={selectedProjectIds.has(p.id)}
                    onSelect={(e) => e.preventDefault()}
                    onCheckedChange={() => toggleProject(p.id)}
                    className="truncate"
                  >
                    {p.name}
                  </DropdownMenuCheckboxItem>
                ))
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          <div className="flex items-center border rounded-md overflow-hidden h-9">
            <button
              onClick={() => panBy(-1)}
              className="h-full px-2 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
              title="Scroll back"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              onClick={goToToday}
              className="h-full px-2.5 text-xs border-x text-muted-foreground hover:bg-muted/60 hover:text-foreground"
              title="Jump to today"
            >
              Today
            </button>
            <button
              onClick={() => panBy(1)}
              className="h-full px-2 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
              title="Scroll forward"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>

          <div className="flex items-center border rounded-md overflow-hidden h-9">
            {(Object.keys(ZOOMS) as ZoomKey[]).map((z) => (
              <button
                key={z}
                onClick={() => setZoom(z)}
                className={`h-full px-2.5 text-xs transition-colors ${
                  zoom === z ? 'bg-secondary font-medium' : 'text-muted-foreground hover:bg-muted/60'
                }`}
              >
                {ZOOMS[z].label}
              </button>
            ))}
          </div>

          <Button
            size="sm"
            variant={hideDone ? 'secondary' : 'ghost'}
            onClick={() => setHideDone((v) => !v)}
            title={hideDone ? 'Showing open tasks only' : 'Showing all tasks'}
          >
            {hideDone ? <EyeOff className="h-4 w-4 mr-1.5" /> : <Eye className="h-4 w-4 mr-1.5" />}
            {hideDone ? 'Open only' : 'All'}
          </Button>

          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              setCollapsed((prev) =>
                prev.size > 0 ? new Set() : new Set(flat.filter((n) => n.children.length > 0).map((n) => n.id))
              )
            }
            title={collapsed.size > 0 ? 'Expand all' : 'Collapse all'}
          >
            {collapsed.size > 0 ? <ChevronsUpDown className="h-4 w-4" /> : <ChevronsDownUp className="h-4 w-4" />}
          </Button>

          <Button
            size="sm"
            variant="ghost"
            onClick={refreshSelected}
            disabled={isLoadingProjects || isLoadingTasks}
            title="Refresh"
          >
            <RefreshCw className={`h-4 w-4 ${isLoadingProjects || isLoadingTasks ? 'animate-spin' : ''}`} />
          </Button>

          <Button size="sm" onClick={() => openCreate(null)} disabled={selectedProjectIds.size === 0}>
            <Plus className="h-4 w-4 mr-1" /> Task
          </Button>
        </div>
      </div>

      {/* Chart */}
      <div className="flex-1 min-h-0 relative">
        {selectedProjectIds.size === 0 ? (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            Select one or more projects to see their roadmap.
          </div>
        ) : isLoadingTasks ? (
          <div className="flex items-center justify-center h-full">
            <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground text-sm gap-2">
            <p>{searchQuery.trim() ? `No tasks match "${searchQuery.trim()}".` : hideDone ? 'No open tasks — everything here is done.' : 'No tasks yet.'}</p>
            {searchQuery.trim() ? (
              <Button size="sm" variant="outline" onClick={() => setSearchQuery('')}>Clear search</Button>
            ) : hideDone ? (
              <Button size="sm" variant="outline" onClick={() => setHideDone(false)}>Show completed</Button>
            ) : (
              <Button size="sm" onClick={() => openCreate(null)}><Plus className="h-4 w-4 mr-1" /> New task</Button>
            )}
          </div>
        ) : (
          <>
            <div ref={scrollRef} onMouseDown={startPan} onScroll={handleTimelineScroll} className="absolute inset-0 overflow-auto">
              <div className="relative" style={{ width: leftWidth + chartWidth, minHeight: '100%' }}>
                {/* Calendar banding sits behind the rows */}
                <div
                  className="absolute pointer-events-none"
                  style={{ left: leftWidth, top: headerH, width: chartWidth, height: rows.length * ROW_H }}
                >
                  {ticks.filter((t) => t.weekend).map((t) => (
                    <div key={`wk-${t.key}`} className="absolute top-0 bottom-0 bg-muted/40" style={{ left: t.x, width: dayWidth }} />
                  ))}
                  {months.filter((m) => m.x > 0).map((m) => (
                    <div key={`ml-${m.key}`} className="absolute top-0 bottom-0 w-px bg-border" style={{ left: m.x }} />
                  ))}
                </div>

                {/* Header: month band + ticks */}
                <div className="sticky top-0 z-20 flex bg-background border-b" style={{ height: headerH }}>
                  <div
                    className="sticky left-0 z-30 bg-background border-r flex items-end px-3 pb-1.5 shrink-0"
                    style={{ width: leftWidth }}
                  >
                    <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
                      Task
                    </span>
                  </div>
                  <div className="relative shrink-0" style={{ width: chartWidth }}>
                    {months.map((m) => (
                      <div
                        key={m.key}
                        className="absolute top-0 h-5 flex items-center border-r border-border/60 overflow-hidden"
                        style={{ left: m.x, width: m.w }}
                      >
                        {/* Sticks beside the task column so the month stays legible while scrolling */}
                        <span
                          className="text-[11px] font-medium text-muted-foreground whitespace-nowrap w-max px-2"
                          style={{ position: 'sticky', left: leftWidth }}
                        >
                          {m.label}
                        </span>
                      </div>
                    ))}
                    {ticks.map((t) => (
                      <div
                        key={t.key}
                        className={`absolute top-5 bottom-0 flex items-end justify-center pb-1 border-r border-border/40 ${
                          t.weekend ? 'bg-muted/40' : ''
                        }`}
                        style={{ left: t.x, width: (zoom === 'day' ? 1 : 7) * dayWidth }}
                      >
                        <span className="text-[10px] tabular-nums text-muted-foreground/80">{t.label}</span>
                      </div>
                    ))}
                    {/* Lives in the header so the sticky corner cell clips it when scrolled away */}
                    {todayX >= 0 && todayX <= chartWidth && (
                      <div
                        className="absolute -translate-x-1/2 px-1 rounded bg-destructive text-[9px] font-medium text-white leading-4 pointer-events-none"
                        style={{ left: todayX, top: 22 }}
                      >
                        today
                      </div>
                    )}
                  </div>
                </div>

                {/* Rows */}
                {rows.map((node) => {
                  const rawSpan = spanById.get(node.id) ?? null;
                  const active = drag?.id === node.id ? drag : null;
                  // While dragging, preview the new position without touching server state.
                  const span = rawSpan && active
                    ? { ...rawSpan, ...applyDrag(rawSpan.from, rawSpan.to, active.mode, active.delta) }
                    : rawSpan;
                  const overdue = isOverdue(node, span);
                  const isDone = DONE_STATUSES.has(node.status);
                  const barX = span ? differenceInCalendarDays(span.from, rangeStart) * dayWidth : 0;
                  const barW = span
                    ? Math.max((differenceInCalendarDays(span.to, span.from) + 1) * dayWidth, 6)
                    : 0;

                  return (
                    <div key={node.id} className="flex group" style={{ height: ROW_H }}>
                      {/* Task cell */}
                      <div
                        className="sticky left-0 z-10 bg-background border-r border-b flex items-center gap-1 pr-1 shrink-0 group-hover:bg-muted/40"
                        style={{ width: leftWidth, paddingLeft: node.depth * 16 + 6 }}
                      >
                        {node.children.length > 0 ? (
                          <button
                            onClick={() => toggleCollapse(node.id)}
                            className="shrink-0 text-muted-foreground hover:text-foreground p-0.5 rounded"
                          >
                            {collapsed.has(node.id) ? (
                              <ChevronRight className="h-3.5 w-3.5" />
                            ) : (
                              <ChevronDown className="h-3.5 w-3.5" />
                            )}
                          </button>
                        ) : (
                          <span className="w-[18px] shrink-0" />
                        )}

                        <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${STATUS_DOT[node.status] ?? 'bg-muted'}`} />

                        <span
                          className={`text-sm truncate flex-1 min-w-0 ${isDone ? 'text-muted-foreground line-through decoration-muted-foreground/40' : ''}`}
                          title={node.title}
                        >
                          {node.title}
                        </span>

                        {/* Only root rows need the project tag — subtasks always sit under it */}
                        {node.depth === 0 && selectedProjectIds.size > 1 && (
                          <span className="text-[10px] text-muted-foreground/60 shrink-0 truncate max-w-20" title={projectNameById.get(node.project_id)}>
                            {projectNameById.get(node.project_id)}
                          </span>
                        )}

                        <span className={`text-[10px] shrink-0 ${PRIORITY_TEXT[node.priority] ?? ''}`}>
                          {node.priority === 'medium' ? '' : node.priority}
                        </span>

                        <div className="shrink-0 flex items-center opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                          <Button variant="ghost" size="icon" className="h-6 w-6" title="Add subtask" onClick={() => openCreate(node.id, node.project_id)}>
                            <Plus className="h-3 w-3" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-6 w-6" title="Edit" onClick={() => openEdit(node)}>
                            <Pencil className="h-3 w-3" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-6 w-6" title="Delete" onClick={() => setConfirmDeleteId(node.id)}>
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </div>
                      </div>

                      {/* Timeline cell */}
                      <div
                        data-timeline
                        className="relative border-b shrink-0 group-hover:bg-muted/25 cursor-grab active:cursor-grabbing"
                        style={{ width: chartWidth }}
                      >
                        {span ? (
                          <Popover
                            open={schedulingId === node.id}
                            onOpenChange={(o) => setSchedulingId(o ? node.id : null)}
                          >
                            <PopoverTrigger asChild>
                              <button
                                data-bar
                                onMouseDown={(e) => startBarDrag(e, node, span, 'move')}
                                onClickCapture={(e) => {
                                  if (suppressClick.current === node.id) {
                                    suppressClick.current = null;
                                    e.preventDefault();
                                    e.stopPropagation();
                                  }
                                }}
                                className={`absolute top-1/2 -translate-y-1/2 flex items-center transition-shadow hover:ring-2 hover:ring-ring/40 ${
                                  span.rollup
                                    ? 'h-[7px] rounded-[1px] bg-foreground/55 cursor-default'
                                    : `h-[18px] rounded-[3px] px-1.5 cursor-grab active:cursor-grabbing ${
                                        overdue ? 'bg-destructive' : BAR_FILL[node.status] ?? 'bg-foreground/35'
                                      } ${active ? 'ring-2 ring-ring shadow-lg' : ''}`
                                }`}
                                style={{ left: barX, width: barW }}
                                title={`${node.title}\n${format(span.from, 'MMM d, yyyy')} → ${format(span.to, 'MMM d, yyyy')}${span.rollup ? ' (rolled up from subtasks)' : '\nDrag to move · drag an edge to resize · click to pick dates'}`}
                              >
                                {barW > 56 && !span.rollup && (
                                  <span className="text-[10px] text-white/95 truncate whitespace-nowrap pointer-events-none">
                                    {node.title}
                                  </span>
                                )}
                              </button>
                            </PopoverTrigger>
                            <SchedulePopover
                              node={node}
                              onApply={(start, due) => {
                                setSchedulingId(null);
                                patchTask(node.id, node.project_id, { start_date: start, due_date: due });
                              }}
                            />
                          </Popover>
                        ) : (
                          <Popover
                            open={schedulingId === node.id}
                            onOpenChange={(o) => setSchedulingId(o ? node.id : null)}
                          >
                            <PopoverTrigger asChild>
                              <button
                                data-bar
                                className="absolute top-1/2 -translate-y-1/2 h-[18px] px-2 rounded-[3px] border border-dashed border-muted-foreground/40 text-[10px] text-muted-foreground opacity-0 group-hover:opacity-100 hover:border-foreground/50 hover:text-foreground flex items-center gap-1"
                                style={{ left: Math.max(todayX, 0) }}
                              >
                                <CalendarIcon className="h-2.5 w-2.5" /> Schedule
                              </button>
                            </PopoverTrigger>
                            <SchedulePopover
                              node={node}
                              onApply={(start, due) => {
                                setSchedulingId(null);
                                patchTask(node.id, node.project_id, { start_date: start, due_date: due });
                              }}
                            />
                          </Popover>
                        )}

                        {/* Edge handles: stretch one end without moving the other */}
                        {span && !span.rollup && (
                          <>
                            <div
                              data-bar
                              onMouseDown={(e) => startBarDrag(e, node, span, 'start')}
                              className="absolute top-1/2 -translate-y-1/2 h-[18px] w-1.5 cursor-ew-resize opacity-0 group-hover:opacity-100 rounded-l-[3px] bg-white/40 hover:bg-white/70"
                              style={{ left: barX }}
                              title="Drag to change the start date"
                            />
                            <div
                              data-bar
                              onMouseDown={(e) => startBarDrag(e, node, span, 'end')}
                              className="absolute top-1/2 -translate-y-1/2 h-[18px] w-1.5 cursor-ew-resize opacity-0 group-hover:opacity-100 rounded-r-[3px] bg-white/40 hover:bg-white/70"
                              style={{ left: barX + barW - 6 }}
                              title="Drag to change the due date"
                            />
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}

                {/* Today line. Kept under the sticky task column (z-10) and header (z-20)
                    so scrolling the timeline away hides it instead of painting over them. */}
                {todayX >= 0 && todayX <= chartWidth && (
                  <div
                    className="absolute top-0 w-px bg-destructive/70 pointer-events-none z-[5]"
                    style={{ left: leftWidth + todayX, height: headerH + rows.length * ROW_H }}
                  />
                )}
              </div>
            </div>

            {/* Column resize handle — sits above the sticky task column's right edge */}
            <div
              onMouseDown={startResize}
              className="absolute top-0 bottom-0 w-1.5 -ml-0.5 cursor-col-resize z-40 hover:bg-ring/40 active:bg-ring/60"
              style={{ left: leftWidth }}
            />
          </>
        )}
      </div>

      {/* Create / edit dialog */}
      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{form.id ? 'Edit task' : 'New task'}</DialogTitle>
            <DialogDescription>
              {form.parent_id && !form.id ? 'Creating a subtask.' : 'Nest tasks by choosing a parent below.'}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 min-w-0">
            {/* Only ask for a project when creating a brand-new root task with more than one
                checked — a subtask always inherits its parent's project, and a task's
                project can't be changed after creation. */}
            {!form.id && !form.parent_id && selectedProjectIds.size > 1 && (
              <div className="flex flex-col gap-1.5 min-w-0">
                <Label className="text-xs text-muted-foreground">Project</Label>
                <Select value={form.project_id ?? ''} onValueChange={(v) => setForm((f) => ({ ...f, project_id: v }))}>
                  <SelectTrigger className="w-full"><SelectValue className="truncate flex-1 min-w-0" placeholder="Choose a project" /></SelectTrigger>
                  <SelectContent className="max-w-[90vw]">
                    {[...selectedProjectIds].map((id) => (
                      <SelectItem key={id} value={id} className="truncate">{projectNameById.get(id) ?? id}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs text-muted-foreground">Title</Label>
              <Input value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} autoFocus />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs text-muted-foreground">Description</Label>
              <Textarea value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} rows={3} />
            </div>
            <div className="grid grid-cols-2 gap-3 min-w-0">
              <div className="flex flex-col gap-1.5 min-w-0">
                <Label className="text-xs text-muted-foreground">Status</Label>
                <Select value={form.status} onValueChange={(v) => setForm((f) => ({ ...f, status: v }))}>
                  <SelectTrigger className="w-full"><SelectValue className="truncate flex-1 min-w-0" /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(STATUS_LABELS).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5 min-w-0">
                <Label className="text-xs text-muted-foreground">Priority</Label>
                <Select value={form.priority} onValueChange={(v) => setForm((f) => ({ ...f, priority: v }))}>
                  <SelectTrigger className="w-full"><SelectValue className="truncate flex-1 min-w-0" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 min-w-0">
              <DateField label="Start date" value={form.start_date} onChange={(v) => setForm((f) => ({ ...f, start_date: v }))} />
              <DateField label="Due date" value={form.due_date} onChange={(v) => setForm((f) => ({ ...f, due_date: v }))} />
            </div>
            <div className="flex flex-col gap-1.5 min-w-0">
              <Label className="text-xs text-muted-foreground">Parent task</Label>
              <Select
                value={form.parent_id ?? '__none__'}
                onValueChange={(v) => setForm((f) => ({ ...f, parent_id: v === '__none__' ? null : v }))}
              >
                <SelectTrigger className="w-full"><SelectValue className="truncate flex-1 min-w-0" /></SelectTrigger>
                <SelectContent className="max-w-[90vw]">
                  <SelectItem value="__none__">No parent (top-level)</SelectItem>
                  {parentOptions.map((t) => (
                    <SelectItem key={t.id} value={t.id} className="truncate">
                      {'—'.repeat(t.depth)} {t.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDialog(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={isSaving || !form.title.trim() || !form.project_id}>
              {form.id ? 'Save' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!confirmDeleteId} onOpenChange={(open) => !open && setConfirmDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete task?</AlertDialogTitle>
            <AlertDialogDescription>
              This also deletes all of its subtasks. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const proj = confirmDeleteId ? nodeById.get(confirmDeleteId)?.project_id : undefined;
                if (confirmDeleteId && proj) handleDelete(confirmDeleteId, proj);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Range calendar so a task gets both dates in two clicks, straight from the timeline row. */
function SchedulePopover({
  node,
  onApply,
}: {
  node: TaskNode;
  onApply: (start: string | null, due: string | null) => void;
}) {
  const initial = node.start_date || node.due_date
    ? { from: toDate(node.start_date ?? node.due_date!), to: toDate(node.due_date ?? node.start_date!) }
    : undefined;
  const [range, setRange] = useState<{ from?: Date; to?: Date } | undefined>(initial);

  return (
    <PopoverContent className="w-auto p-0" align="start">
      <div className="px-3 pt-3 pb-1">
        <p className="text-xs font-medium truncate max-w-[240px]">{node.title}</p>
        <p className="text-[11px] text-muted-foreground">Click a start day, then an end day.</p>
      </div>
      <Calendar
        mode="range"
        defaultMonth={range?.from}
        selected={range as never}
        onSelect={(r: unknown) => setRange(r as { from?: Date; to?: Date } | undefined)}
        numberOfMonths={1}
      />
      <div className="flex items-center justify-between gap-2 p-2 border-t">
        <Button variant="ghost" size="sm" onClick={() => onApply(null, null)}>Clear</Button>
        <Button
          size="sm"
          disabled={!range?.from}
          onClick={() =>
            onApply(
              range?.from ? format(range.from, 'yyyy-MM-dd') : null,
              range?.to ? format(range.to, 'yyyy-MM-dd') : range?.from ? format(range.from, 'yyyy-MM-dd') : null
            )
          }
        >
          Apply
        </Button>
      </div>
    </PopoverContent>
  );
}

function DateField({
  value,
  onChange,
  label,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  label: string;
}) {
  return (
    <div className="flex flex-col gap-1.5 min-w-0">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="justify-start font-normal w-full min-w-0">
            <CalendarIcon className="h-3.5 w-3.5 mr-1.5 shrink-0" />
            <span className="truncate">{value ? format(toDate(value), 'MMM d, yyyy') : 'Set date'}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="single"
            selected={value ? toDate(value) : undefined}
            onSelect={(d) => onChange(d ? format(d, 'yyyy-MM-dd') : null)}
          />
          {value && (
            <div className="p-2 border-t">
              <Button variant="ghost" size="sm" className="w-full" onClick={() => onChange(null)}>
                Clear date
              </Button>
            </div>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}
