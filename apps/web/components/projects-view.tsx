'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
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
import { DataTable } from '@/components/ui/data-table';
import { ColumnDef } from '@tanstack/react-table';
import { Plus, RefreshCw, LayoutList, Columns3, Bot, User, GripVertical, Pencil, Trash2, Repeat2, History, Sparkles, CornerDownRight } from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetFooter,
} from '@/components/ui/sheet';
import { toast } from 'sonner';
import { isNonEmptyArray } from '@/lib/autofill-merge';
import { LabelChipInput } from '@/components/label-chip-input';
import { TASK_LABEL_COLORS, CUSTOM_LABEL_COLOR } from '@/lib/task-labels';
import { TaskNotesPanel } from '@/components/task-notes-panel';

interface Project {
  id: string;
  name: string;
  path: string | null;
  description: string | null;
  node_count: number;
  edge_count: number;
  graph_hash: string | null;
  imported_at: string | null;
  created_at: string;
  updated_at: string;
  task_count?: number;
  version_status: string;
  effective_version_status: string;
}

interface Task {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  assigned_to: string | null;
  created_by: string;
  routine_id: string | null;
  created_at: string;
  updated_at: string;
  project_name?: string;
  labels: string[];
  parent_id: string | null;
  start_date: string | null;
  due_date: string | null;
  sort_order: number;
}

interface Routine {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  frequency: string;
  priority: string;
  assigned_to: string | null;
  enabled: boolean;
  last_task_date: string | null;
  created_at: string;
  updated_at: string;
  project_name?: string;
  labels: string[];
}

const STATUS_LABELS: Record<string, string> = {
  scheduled: 'Scheduled',
  todo: 'Todo',
  in_progress: 'In Progress',
  done: 'Done',
  cancelled: 'Cancelled',
};

const STATUS_COLORS: Record<string, string> = {
  scheduled: 'border-purple-400 text-purple-600 dark:text-purple-400',
  todo: 'border-border text-muted-foreground',
  in_progress: 'border-blue-400 text-blue-600 dark:text-blue-400',
  done: 'border-green-500 text-green-600 dark:text-green-400',
  cancelled: 'border-muted text-muted-foreground line-through',
};

const PRIORITY_COLORS: Record<string, string> = {
  low: 'text-muted-foreground',
  medium: 'text-yellow-600 dark:text-yellow-400',
  high: 'text-destructive',
};

const FREQ_LABELS: Record<string, string> = {
  daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', yearly: 'Yearly',
};

const VERSION_STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  maintenance: 'Maintenance',
  archived: 'Archived',
  deprecated: 'Deprecated',
};

const VERSION_STATUS_COLORS: Record<string, string> = {
  active: 'border-green-500 text-green-600 dark:text-green-400',
  maintenance: 'border-blue-400 text-blue-600 dark:text-blue-400',
  archived: 'border-border text-muted-foreground',
  deprecated: 'border-destructive text-destructive',
};

const EFFECTIVE_STATUS_EXTRA_LABELS: Record<string, string> = {
  bug_detected: 'Bug Detected',
  feature_updating: 'Feature Updating',
};

const EFFECTIVE_STATUS_EXTRA_COLORS: Record<string, string> = {
  bug_detected: 'border-red-500 text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30',
  feature_updating: 'border-blue-500 text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/30',
};

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

function matchesBoardKeyword(item: Task | Routine, query: string): boolean {
  if (!query) return true;
  return [
    item.title,
    item.description ?? '',
    item.project_name ?? '',
    ...item.labels,
    'status' in item ? STATUS_LABELS[item.status] ?? item.status : '',
    'priority' in item ? item.priority : '',
    'frequency' in item ? item.frequency : '',
  ].some((field) => field.toLowerCase().includes(query));
}

export function ProjectsView({ view }: { view: 'list' | 'board' }) {
  const router = useRouter();

  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [taskCounts, setTaskCounts] = useState<Record<string, number>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingTasks, setIsLoadingTasks] = useState(false);
  const [boardFilter, setBoardFilter] = useState<string>('all');
  const [boardSearchQuery, setBoardSearchQuery] = useState('');
  const [dragOverColumn, setDragOverColumn] = useState<string | null>(null);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [taskSheetMode, setTaskSheetMode] = useState<'view' | 'edit'>('view');
  const [confirmDeleteTaskId, setConfirmDeleteTaskId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ title: '', description: '', status: '', priority: '', assigned_to: '', labels: [] as string[] });
  const [isSavingTask, setIsSavingTask] = useState(false);

  // Routine edit sheet
  const [selectedRoutine, setSelectedRoutine] = useState<Routine | null>(null);
  const [routineSheetMode, setRoutineSheetMode] = useState<'view' | 'edit'>('view');
  const [routineEditForm, setRoutineEditForm] = useState({ title: '', description: '', frequency: '', priority: '', assigned_to: '', enabled: true, labels: [] as string[] });
  const [isSavingRoutine, setIsSavingRoutine] = useState(false);
  const [confirmDeleteRoutine, setConfirmDeleteRoutine] = useState(false);

  // Routine execution history sheet
  const [routineHistoryOpen, setRoutineHistoryOpen] = useState(false);
  const [routineHistoryRoutine, setRoutineHistoryRoutine] = useState<Routine | null>(null);
  const [routineHistoryTasks, setRoutineHistoryTasks] = useState<Task[]>([]);
  const [isLoadingRoutineHistory, setIsLoadingRoutineHistory] = useState(false);

  // Create project dialog
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [createForm, setCreateForm] = useState({ name: '', path: '', description: '', version_status: 'active' });
  const [isCreating, setIsCreating] = useState(false);
  const [rebuildingId, setRebuildingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Edit project dialog
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [projectEditForm, setProjectEditForm] = useState({ name: '', path: '', description: '', version_status: 'active' });
  const [updatingStatusId, setUpdatingStatusId] = useState<string | null>(null);
  const [isSavingProject, setIsSavingProject] = useState(false);
  const [confirmPathChange, setConfirmPathChange] = useState(false);

  // Create task dialog
  const [showTaskDialog, setShowTaskDialog] = useState(false);
  const [taskForm, setTaskForm] = useState({
    project_id: '',
    title: '',
    description: '',
    status: 'todo',
    priority: 'medium',
    assigned_to: '',
    task_type: 'regular' as 'regular' | 'scheduled',
    frequency: 'daily',
    cron_expr: '',
    labels: [] as string[],
  });
  const [isCreatingTask, setIsCreatingTask] = useState(false);
  // Every "Suggest with AI" button on the task dialogs always overwrites its
  // field(s) on click — an explicit click is unambiguous intent to
  // (re)generate, so there's no touched-flag gating here (unlike the memory
  // Add dialog, where suggestions arrive passively alongside typing).
  const [isSuggestingTask, setIsSuggestingTask] = useState(false);
  const [isSuggestingTaskTitle, setIsSuggestingTaskTitle] = useState(false);
  const [isSuggestingEditTask, setIsSuggestingEditTask] = useState(false);
  const [isSuggestingEditTaskTitle, setIsSuggestingEditTaskTitle] = useState(false);

  const fetchProjects = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/projects');
      const data = await res.json();
      setProjects(data.projects ?? []);
    } catch {
      toast.error('Failed to load projects');
    } finally {
      setIsLoading(false);
    }
  }, []);

  const fetchTasksForBoard = useCallback(async (projectList: Project[]) => {
    if (projectList.length === 0) return;
    setIsLoadingTasks(true);
    try {
      const allTasks: Task[] = [];
      const allRoutines: Routine[] = [];
      const counts: Record<string, number> = {};
      await Promise.all(
        projectList.map(async (p) => {
          const [taskRes, routineRes] = await Promise.all([
            fetch(`/api/projects/${p.id}/tasks?limit=200`),
            fetch(`/api/projects/${p.id}/routines`),
          ]);
          const taskData = await taskRes.json();
          const routineData = await routineRes.json();
          const pts: Task[] = (taskData.tasks ?? []).map((t: Task) => ({ ...t, project_name: p.name }));
          const prs: Routine[] = (routineData.routines ?? []).map((r: Routine) => ({ ...r, project_name: p.name }));
          allTasks.push(...pts);
          allRoutines.push(...prs);
          counts[p.id] = pts.length;
        })
      );
      setTasks(allTasks);
      setRoutines(allRoutines);
      setTaskCounts(counts);
    } catch {
      toast.error('Failed to load tasks');
    } finally {
      setIsLoadingTasks(false);
    }
  }, []);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  useEffect(() => {
    if (projects.length > 0) {
      fetchTasksForBoard(projects);
    }
  }, [projects, fetchTasksForBoard]);

  const handleCreate = async () => {
    if (!createForm.name.trim()) { toast.error('Name is required'); return; }
    setIsCreating(true);
    try {
      const body: Record<string, string> = { name: createForm.name, version_status: createForm.version_status };
      if (createForm.path.trim()) body.path = createForm.path.trim();
      if (createForm.description.trim()) body.description = createForm.description.trim();
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        toast.error(b.error ?? 'Failed to create project');
        return;
      }
      setShowCreateDialog(false);
      setCreateForm({ name: '', path: '', description: '', version_status: 'active' });
      fetchProjects();
      toast.success('Project created');
    } catch {
      toast.error('Failed to create project');
    } finally {
      setIsCreating(false);
    }
  };

  const handleRebuild = async (id: string) => {
    setRebuildingId(id);
    try {
      const res = await fetch(`/api/projects/${id}/rebuild`, { method: 'POST' });
      await fetchProjects();
      toast[res.ok ? 'success' : 'error'](res.ok ? 'Graph rebuilt' : 'Rebuild failed');
    } catch {
      toast.error('Rebuild failed');
    } finally {
      setRebuildingId(null);
    }
  };

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      const res = await fetch(`/api/projects/${id}`, { method: 'DELETE' });
      if (res.ok) { await fetchProjects(); toast.success('Project deleted'); }
      else toast.error('Failed to delete project');
    } catch {
      toast.error('Failed to delete project');
    } finally {
      setDeletingId(null);
      setConfirmDeleteId(null);
    }
  };

  const openProjectEdit = (project: Project) => {
    setEditingProject(project);
    setProjectEditForm({
      name: project.name,
      path: project.path ?? '',
      description: project.description ?? '',
      version_status: project.version_status ?? 'active',
    });
  };

  const handleVersionStatusChange = async (id: string, version_status: string) => {
    const previous = projects;
    setProjects(prev => prev.map(p => (p.id === id ? { ...p, version_status } : p)));
    setUpdatingStatusId(id);
    try {
      const res = await fetch(`/api/projects/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version_status }),
      });
      if (!res.ok) {
        setProjects(previous);
        toast.error('Failed to update version status');
      }
    } catch {
      setProjects(previous);
      toast.error('Failed to update version status');
    } finally {
      setUpdatingStatusId(null);
    }
  };

  const commitProjectSave = async () => {
    if (!editingProject) return;
    setIsSavingProject(true);
    try {
      const res = await fetch(`/api/projects/${editingProject.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: projectEditForm.name.trim(),
          path: projectEditForm.path.trim() || null,
          description: projectEditForm.description.trim() || null,
          version_status: projectEditForm.version_status,
        }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        toast.error(b.error ?? 'Failed to save project');
        return;
      }
      setEditingProject(null);
      setConfirmPathChange(false);
      await fetchProjects();
      toast.success('Project updated');
    } catch {
      toast.error('Failed to save project');
    } finally {
      setIsSavingProject(false);
    }
  };

  const handleSaveProject = () => {
    if (!editingProject) return;
    if (!projectEditForm.name.trim()) { toast.error('Name is required'); return; }
    const pathChanged = projectEditForm.path.trim() !== (editingProject.path ?? '');
    if (pathChanged) {
      setConfirmPathChange(true);
      return;
    }
    commitProjectSave();
  };

  const handleCreateTask = async () => {
    if (!taskForm.title.trim()) { toast.error('Title is required'); return; }
    if (!taskForm.project_id) { toast.error('Select a project'); return; }
    const isScheduled = taskForm.task_type === 'scheduled';
    const effectiveFreq = taskForm.frequency === 'custom' ? taskForm.cron_expr.trim() : taskForm.frequency;
    if (isScheduled && !effectiveFreq) { toast.error('Cron expression required'); return; }
    setIsCreatingTask(true);
    try {
      const body: Record<string, string | string[]> = {
        title: taskForm.title,
        priority: taskForm.priority,
      };
      if (taskForm.description.trim()) body.description = taskForm.description.trim();
      if (taskForm.assigned_to) body.assigned_to = taskForm.assigned_to;
      if (taskForm.labels.length) body.labels = taskForm.labels;

      let url: string;
      if (isScheduled) {
        url = `/api/projects/${taskForm.project_id}/routines`;
        body.frequency = effectiveFreq;
      } else {
        url = `/api/projects/${taskForm.project_id}/tasks`;
        body.status = taskForm.status;
      }

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        toast.error(b.error ?? `Failed to create ${isScheduled ? 'routine' : 'task'}`);
        return;
      }
      setShowTaskDialog(false);
      setTaskForm({ project_id: '', title: '', description: '', status: 'todo', priority: 'medium', assigned_to: '', task_type: 'regular', frequency: 'daily', cron_expr: '', labels: [] });
      fetchTasksForBoard(projects);
      toast.success(isScheduled ? 'Routine created' : 'Task created');
    } catch {
      toast.error('Failed to create');
    } finally {
      setIsCreatingTask(false);
    }
  };

  const handleSuggestTask = async () => {
    if (!taskForm.title.trim() && !taskForm.description.trim()) return;
    setIsSuggestingTask(true);
    try {
      const content = taskForm.description.trim()
        ? `${taskForm.title}\n\n${taskForm.description}`
        : taskForm.title;
      const res = await fetch('/api/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'ai.autofill', kind: 'task', content }),
      });
      const data = await res.json();
      if (data.error) { toast.error(data.error); return; }
      const suggestion = data.suggestion ?? {};
      setTaskForm(f => ({
        ...f,
        description: suggestion.description ?? f.description,
        priority: suggestion.priority ?? f.priority,
        labels: isNonEmptyArray(suggestion.labels) ? suggestion.labels : f.labels,
      }));
    } catch {
      toast.error('Failed to get AI suggestion');
    } finally {
      setIsSuggestingTask(false);
    }
  };

  const handleSuggestEditTask = async () => {
    if (!editForm.title.trim() && !editForm.description.trim()) return;
    setIsSuggestingEditTask(true);
    try {
      const content = editForm.description.trim()
        ? `${editForm.title}\n\n${editForm.description}`
        : editForm.title;
      const res = await fetch('/api/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'ai.autofill', kind: 'task', content }),
      });
      const data = await res.json();
      if (data.error) { toast.error(data.error); return; }
      const suggestion = data.suggestion ?? {};
      setEditForm(f => ({
        ...f,
        description: suggestion.description ?? f.description,
        priority: suggestion.priority ?? f.priority,
        labels: isNonEmptyArray(suggestion.labels) ? suggestion.labels : f.labels,
      }));
    } catch {
      toast.error('Failed to get AI suggestion');
    } finally {
      setIsSuggestingEditTask(false);
    }
  };

  const handleSuggestTaskTitle = async () => {
    if (!taskForm.title.trim() && !taskForm.description.trim()) return;
    setIsSuggestingTaskTitle(true);
    try {
      const content = taskForm.description.trim()
        ? `${taskForm.title}\n\n${taskForm.description}`
        : taskForm.title;
      const res = await fetch('/api/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'ai.autofill', kind: 'task', content }),
      });
      const data = await res.json();
      if (data.error) { toast.error(data.error); return; }
      const suggestion = data.suggestion ?? {};
      if (suggestion.title) {
        setTaskForm(f => ({ ...f, title: suggestion.title }));
      }
    } catch {
      toast.error('Failed to get AI suggestion');
    } finally {
      setIsSuggestingTaskTitle(false);
    }
  };

  const handleSuggestEditTaskTitle = async () => {
    if (!editForm.title.trim() && !editForm.description.trim()) return;
    setIsSuggestingEditTaskTitle(true);
    try {
      const content = editForm.description.trim()
        ? `${editForm.title}\n\n${editForm.description}`
        : editForm.title;
      const res = await fetch('/api/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'ai.autofill', kind: 'task', content }),
      });
      const data = await res.json();
      if (data.error) { toast.error(data.error); return; }
      const suggestion = data.suggestion ?? {};
      if (suggestion.title) {
        setEditForm(f => ({ ...f, title: suggestion.title }));
      }
    } catch {
      toast.error('Failed to get AI suggestion');
    } finally {
      setIsSuggestingEditTaskTitle(false);
    }
  };

  const handleDropToStatus = async (taskId: string, newStatus: string) => {
    const task = tasks.find(t => t.id === taskId);
    if (!task || task.status === newStatus) return;
    setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: newStatus } : t));
    try {
      const res = await fetch(`/api/projects/${task.project_id}/tasks/${taskId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!res.ok) {
        setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: task.status } : t));
        toast.error('Failed to move task');
      }
    } catch {
      setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: task.status } : t));
      toast.error('Failed to move task');
    }
  };

  const openTaskSheet = (task: Task, mode: 'view' | 'edit' = 'view') => {
    setSelectedTask(task);
    setTaskSheetMode(mode);
    setEditForm({
      title: task.title,
      description: task.description ?? '',
      status: task.status,
      priority: task.priority,
      assigned_to: task.assigned_to ?? '',
      labels: task.labels ?? [],
    });
    setIsSuggestingEditTask(false);
  };

  const handleSaveTask = async () => {
    if (!selectedTask) return;
    setIsSavingTask(true);
    try {
      const res = await fetch(`/api/projects/${selectedTask.project_id}/tasks/${selectedTask.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: editForm.title,
          description: editForm.description || null,
          status: editForm.status,
          priority: editForm.priority,
          assigned_to: editForm.assigned_to || null,
          labels: editForm.labels,
        }),
      });
      if (!res.ok) { toast.error('Failed to save task'); return; }
      const updated = await res.json();
      setTasks(prev => prev.map(t => t.id === selectedTask.id ? { ...t, ...updated, project_name: t.project_name } : t));
      setSelectedTask(prev => prev ? { ...prev, ...updated } : null);
      toast.success('Task saved');
    } catch {
      toast.error('Failed to save task');
    } finally {
      setIsSavingTask(false);
    }
  };

  const openRoutineSheet = (routine: Routine, mode: 'view' | 'edit' = 'view') => {
    setSelectedRoutine(routine);
    setRoutineSheetMode(mode);
    setRoutineEditForm({
      title: routine.title,
      description: routine.description ?? '',
      frequency: routine.frequency,
      priority: routine.priority,
      assigned_to: routine.assigned_to ?? '',
      enabled: routine.enabled,
      labels: routine.labels ?? [],
    });
  };

  const openRoutineHistory = async (routine: Routine) => {
    setRoutineHistoryRoutine(routine);
    setRoutineHistoryOpen(true);
    setIsLoadingRoutineHistory(true);
    try {
      const res = await fetch(`/api/projects/${routine.project_id}/tasks?routine_id=${routine.id}&limit=200`);
      if (!res.ok) { toast.error('Failed to load execution history'); return; }
      const data = await res.json();
      setRoutineHistoryTasks(data.tasks ?? []);
    } catch {
      toast.error('Failed to load execution history');
    } finally {
      setIsLoadingRoutineHistory(false);
    }
  };

  const handleSaveRoutine = async () => {
    if (!selectedRoutine) return;
    setIsSavingRoutine(true);
    try {
      const res = await fetch(`/api/projects/${selectedRoutine.project_id}/routines/${selectedRoutine.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: routineEditForm.title,
          description: routineEditForm.description || null,
          frequency: routineEditForm.frequency,
          priority: routineEditForm.priority,
          assigned_to: routineEditForm.assigned_to || null,
          enabled: routineEditForm.enabled,
          labels: routineEditForm.labels,
        }),
      });
      if (!res.ok) { toast.error('Failed to save routine'); return; }
      const updated = await res.json();
      setRoutines(prev => prev.map(r => r.id === selectedRoutine.id ? { ...r, ...updated, project_name: r.project_name } : r));
      setSelectedRoutine(prev => prev ? { ...prev, ...updated } : null);
      toast.success('Routine saved');
    } catch {
      toast.error('Failed to save routine');
    } finally {
      setIsSavingRoutine(false);
    }
  };

  const handleDeleteTask = async (taskId: string) => {
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;
    setTasks(prev => prev.filter(t => t.id !== taskId));
    if (selectedTask?.id === taskId) setSelectedTask(null);
    try {
      const res = await fetch(`/api/projects/${task.project_id}/tasks/${taskId}`, { method: 'DELETE' });
      if (!res.ok) {
        setTasks(prev => [...prev, task]);
        toast.error('Failed to delete task');
      } else {
        toast.success('Task deleted');
      }
    } catch {
      setTasks(prev => [...prev, task]);
      toast.error('Failed to delete task');
    } finally {
      setConfirmDeleteTaskId(null);
    }
  };

  const handleDeleteRoutine = async () => {
    if (!selectedRoutine) return;
    const routine = selectedRoutine;
    setSelectedRoutine(null);
    setRoutines(prev => prev.filter(r => r.id !== routine.id));
    try {
      const res = await fetch(`/api/projects/${routine.project_id}/routines/${routine.id}`, { method: 'DELETE' });
      if (!res.ok) {
        setRoutines(prev => [...prev, routine]);
        toast.error('Failed to delete routine');
      } else {
        toast.success('Routine deleted');
      }
    } catch {
      setRoutines(prev => [...prev, routine]);
      toast.error('Failed to delete routine');
    }
  };

  const columns: ColumnDef<Project>[] = [
    {
      accessorKey: 'name',
      header: 'Name',
      cell: ({ row }) => (
        <div className="flex items-center gap-2">
          <Link href={`/projects/${row.original.id}`} className="font-medium hover:underline">
            {row.original.name}
          </Link>
          {(taskCounts[row.original.id] ?? 0) > 0 && (
            <Badge variant="secondary" className="text-xs">
              {taskCounts[row.original.id]} task{taskCounts[row.original.id] !== 1 ? 's' : ''}
            </Badge>
          )}
        </div>
      ),
    },
    {
      accessorKey: 'path',
      header: 'Path',
      cell: ({ row }) =>
        row.original.path ? (
          <span className="text-xs text-muted-foreground font-mono truncate max-w-[200px] block">
            {row.original.path}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground italic">No path</span>
        ),
    },
    {
      accessorKey: 'version_status',
      header: 'Version Status',
      cell: ({ row }) => {
        const eff = row.original.effective_version_status ?? row.original.version_status ?? 'active';
        const isComputed = eff === 'bug_detected' || eff === 'feature_updating';
        if (isComputed) {
          return (
            <span
              className={`inline-flex items-center gap-1 h-7 px-2 rounded-md border text-xs font-medium ${EFFECTIVE_STATUS_EXTRA_COLORS[eff]}`}
              title={`Automatic — based on an open ${eff === 'bug_detected' ? "'bug'" : "'feature'"} labeled task. Manual status is still ${VERSION_STATUS_LABELS[row.original.version_status] ?? row.original.version_status}.`}
            >
              <Sparkles className="h-3 w-3" />
              {EFFECTIVE_STATUS_EXTRA_LABELS[eff]}
            </span>
          );
        }
        return (
          <Select
            value={row.original.version_status ?? 'active'}
            onValueChange={v => handleVersionStatusChange(row.original.id, v)}
            disabled={updatingStatusId === row.original.id}
          >
            <SelectTrigger className={`h-7 w-36 text-xs ${VERSION_STATUS_COLORS[row.original.version_status] ?? ''}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(VERSION_STATUS_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>{label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        );
      },
    },
    {
      accessorKey: 'node_count',
      header: 'Nodes',
      cell: ({ row }) => <Badge variant="secondary">{row.original.node_count.toLocaleString()}</Badge>,
    },
    {
      accessorKey: 'edge_count',
      header: 'Edges',
      cell: ({ row }) => <Badge variant="outline">{row.original.edge_count.toLocaleString()}</Badge>,
    },
    {
      accessorKey: 'updated_at',
      header: 'Last Updated',
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground" title={new Date(row.original.updated_at).toLocaleString()}>
          {timeAgo(row.original.updated_at)}
        </span>
      ),
    },
    {
      id: 'actions',
      header: () => <div className="text-right">Actions</div>,
      cell: ({ row }) => (
        <div className="flex items-center justify-end gap-1">
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0" title="Edit project" onClick={() => openProjectEdit(row.original)}>
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          {row.original.path && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              title="Rebuild graph"
              onClick={() => handleRebuild(row.original.id)}
              disabled={rebuildingId === row.original.id}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${rebuildingId === row.original.id ? 'animate-spin' : ''}`} />
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 text-destructive"
            title="Delete project"
            onClick={() => setConfirmDeleteId(row.original.id)}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ),
    },
  ];

  const boardQuery = boardSearchQuery.trim().toLowerCase();
  const filteredTasks = useMemo(
    () => tasks.filter((task) => (boardFilter === 'all' || task.project_id === boardFilter) && matchesBoardKeyword(task, boardQuery)),
    [tasks, boardFilter, boardQuery]
  );
  const taskTitleById = useMemo(() => new Map(tasks.map(t => [t.id, t.title])), [tasks]);
  const filteredRoutines = useMemo(
    () => routines.filter((routine) => (boardFilter === 'all' || routine.project_id === boardFilter) && matchesBoardKeyword(routine, boardQuery)),
    [routines, boardFilter, boardQuery]
  );
  const boardColumns = [
    { key: 'scheduled', label: 'Scheduled' },
    { key: 'todo', label: 'Todo' },
    { key: 'in_progress', label: 'In Progress' },
    { key: 'done', label: 'Done' },
    { key: 'cancelled', label: 'Cancelled' },
  ];

  return (
    <div className="flex flex-col h-full">
     {/* Header */}
      <div className="flex items-center justify-between p-4 border-b">
        <div>
          <h1 className="text-2xl font-semibold">Projects</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage projects, tasks, and code knowledge graphs
          </p>
        </div>
        <div className="shrink-0 flex flex-wrap items-center justify-end gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => { fetchProjects(); }}
            disabled={isLoading || isLoadingTasks}
            title="Refresh"
          >
            <RefreshCw className={`h-4 w-4 ${(isLoading || isLoadingTasks) ? 'animate-spin' : ''}`} />
          </Button>
          {/* View toggle */}
          <div className="flex items-center border rounded-md overflow-hidden">
            <Button
              variant={view === 'list' ? 'secondary' : 'ghost'}
              size="sm"
              className="rounded-none h-8 px-3"
              onClick={() => router.push('/projects')}
            >
              <LayoutList className="h-3.5 w-3.5 mr-1.5" /> List
            </Button>
            <Button
              variant={view === 'board' ? 'secondary' : 'ghost'}
              size="sm"
              className="rounded-none h-8 px-3 border-l"
              onClick={() => router.push('/projects/board')}
            >
              <Columns3 className="h-3.5 w-3.5 mr-1.5" /> Board
            </Button>
          </div>
          {/* Context-sensitive action buttons appear inline in each view */}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
        {view === 'list' ? (
          <div className="h-full overflow-auto p-6">
            {isLoading ? (
              <div className="flex items-center justify-center h-32">
                <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : projects.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-32 text-muted-foreground">
                <p>No projects yet.</p>
                <p className="text-sm mt-1">Click &quot;+ Project&quot; to create one.</p>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <div className="flex justify-start">
                  <Button size="sm" onClick={() => setShowCreateDialog(true)}>
                    <Plus className="h-4 w-4 mr-1" /> Project
                  </Button>
                </div>
                <DataTable
                  columns={columns}
                  data={projects}
                  searchKey="name"
                  searchPlaceholder="Search projects..."
                />
              </div>
            )}
          </div>
        ) : (
          /* Board view: filter row pinned, kanban scrolls x independently */
          <div className="flex flex-col h-full overflow-hidden">
            {/* Filter row — full width, never scrolls */}
            <div className="shrink-0 flex flex-wrap items-center gap-2 w-full min-w-0 px-6 py-3">
              <span className="text-sm text-muted-foreground">Project:</span>
              <Select value={boardFilter} onValueChange={setBoardFilter}>
                <SelectTrigger className="w-48 max-w-full min-w-0 h-8 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Projects</SelectItem>
                  {projects.map(p => (
                    <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                value={boardSearchQuery}
                onChange={(event) => setBoardSearchQuery(event.target.value)}
                placeholder="Search tasks and routines..."
                aria-label="Search board tasks and routines"
                className="h-8 w-[240px] max-w-full"
              />
              {isLoadingTasks && <RefreshCw className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
              <div className="ml-auto">
                <Button size="sm" onClick={() => setShowTaskDialog(true)}>
                  <Plus className="h-4 w-4 mr-1" /> Task
                </Button>
              </div>
            </div>

            {/* Kanban — takes remaining height, scrolls x only here */}
            {boardQuery && filteredTasks.length === 0 && filteredRoutines.length === 0 ? (
              <div className="flex-1 flex items-center justify-center px-6 py-4 text-sm text-muted-foreground">
                No tasks or routines match &quot;{boardSearchQuery.trim()}&quot;.
              </div>
            ) : (
            <div className="flex-1 min-h-0 min-w-0 overflow-x-auto overflow-y-auto px-6 py-4">
              {/* min-w-max forces the row to declare its real width so overflow-x-auto fires */}
              <div className="flex gap-3 min-w-max h-full">
              {boardColumns.map(col => {
                const colTasks = filteredTasks.filter(t => t.status === col.key);
                const colRoutines = col.key === 'scheduled' ? filteredRoutines : [];
                const totalCount = colTasks.length + colRoutines.length;
                const isOver = dragOverColumn === col.key;
                return (
                  <div
                    key={col.key}
                    className={`flex flex-col gap-2 rounded-lg p-3 h-full min-w-[300px] w-[300px] shrink-0 transition-colors ${col.key === 'scheduled' ? 'bg-purple-50/50 dark:bg-purple-950/20 border border-purple-200/50 dark:border-purple-800/30' : isOver ? 'bg-primary/10 ring-1 ring-primary/30' : 'bg-muted/40'}`}
                    onDragOver={e => { if (col.key !== 'scheduled') { e.preventDefault(); setDragOverColumn(col.key); } }}
                    onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOverColumn(null); }}
                    onDrop={e => {
                      e.preventDefault();
                      setDragOverColumn(null);
                      if (col.key === 'scheduled') return;
                      const taskId = e.dataTransfer.getData('taskId');
                      if (taskId) handleDropToStatus(taskId, col.key);
                    }}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm font-medium">{col.label}</span>
                      <Badge variant="secondary" className="text-xs">{totalCount}</Badge>
                    </div>
                    <div className="flex flex-col gap-2 flex-1 min-h-0 overflow-y-auto">
                      {colRoutines.map(routine => (
                        <BoardCard
                          key={routine.id}
                          item={{ kind: 'routine', data: routine }}
                          showProject={boardFilter === 'all'}
                          onOpen={() => openRoutineSheet(routine)}
                          onEdit={() => openRoutineSheet(routine, 'edit')}
                        />
                      ))}
                      {colTasks.map(task => (
                        <BoardCard
                          key={task.id}
                          item={{ kind: 'task', data: task }}
                          showProject={boardFilter === 'all'}
                          parentTitle={task.parent_id ? taskTitleById.get(task.parent_id) : undefined}
                          onOpen={() => openTaskSheet(task)}
                          onEdit={() => openTaskSheet(task, 'edit')}
                        />
                      ))}
                      {totalCount === 0 && (
                        <p className={`text-xs text-center py-4 ${isOver ? 'text-primary/60' : 'text-muted-foreground'}`}>
                          {isOver ? 'Drop here' : 'No tasks'}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
              </div>
            </div>
            )}
          </div>
        )}
      </div>

      {/* Create Project Dialog */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Project</DialogTitle>
            <DialogDescription>
              Create a project. Folder path is optional — only needed for knowledge graph features.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Name</Label>
              <Input
                value={createForm.name}
                onChange={e => setCreateForm(f => ({ ...f, name: e.target.value }))}
                placeholder="my-project"
              />
            </div>
            <div>
              <Label>Folder Path <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <Input
                value={createForm.path}
                onChange={e => setCreateForm(f => ({ ...f, path: e.target.value }))}
                placeholder="/home/user/my-project  — indexed automatically for graph features"
                className="font-mono text-sm"
              />
            </div>
            <div>
              <Label>Description <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <Textarea
                value={createForm.description}
                onChange={e => setCreateForm(f => ({ ...f, description: e.target.value }))}
                placeholder="What this project is about"
                rows={2}
              />
            </div>
            <div>
              <Label>Version Status</Label>
              <Select value={createForm.version_status} onValueChange={v => setCreateForm(f => ({ ...f, version_status: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(VERSION_STATUS_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreateDialog(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={isCreating}>
              {isCreating && <RefreshCw className="h-4 w-4 animate-spin mr-2" />}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Project Dialog */}
      <Dialog open={!!editingProject} onOpenChange={open => !open && setEditingProject(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Project</DialogTitle>
            <DialogDescription>
              Changing the path clears the indexed graph — you&apos;ll need to Rebuild afterward.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Name</Label>
              <Input
                value={projectEditForm.name}
                onChange={e => setProjectEditForm(f => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div>
              <Label>Folder Path <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <Input
                value={projectEditForm.path}
                onChange={e => setProjectEditForm(f => ({ ...f, path: e.target.value }))}
                placeholder="/home/user/my-project"
                className="font-mono text-sm"
              />
            </div>
            <div>
              <Label>Description <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <Textarea
                value={projectEditForm.description}
                onChange={e => setProjectEditForm(f => ({ ...f, description: e.target.value }))}
                placeholder="What this project is about"
                rows={2}
              />
            </div>
            <div>
              <Label>Version Status</Label>
              <Select value={projectEditForm.version_status} onValueChange={v => setProjectEditForm(f => ({ ...f, version_status: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(VERSION_STATUS_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingProject(null)}>Cancel</Button>
            <Button onClick={handleSaveProject} disabled={isSavingProject}>
              {isSavingProject && <RefreshCw className="h-4 w-4 animate-spin mr-2" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Path Change Confirm */}
      <AlertDialog open={confirmPathChange} onOpenChange={setConfirmPathChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Change project path?</AlertDialogTitle>
            <AlertDialogDescription>
              Changing the path clears the indexed knowledge graph for this project — you&apos;ll need
              to run Rebuild afterward to re-index the new location. Tasks are not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={commitProjectSave}
              disabled={isSavingProject}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Continue
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Create Task / Routine Dialog */}
      <Dialog open={showTaskDialog} onOpenChange={setShowTaskDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New Task</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {/* Type toggle */}
            <div className="flex rounded-md border overflow-hidden">
              {(['regular', 'scheduled'] as const).map(t => (
                <button
                  key={t}
                  onClick={() => setTaskForm(f => ({ ...f, task_type: t }))}
                  className={`flex-1 py-2 text-sm font-medium transition-colors ${taskForm.task_type === t ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                >
                  {t === 'regular' ? 'Regular Task' : 'Scheduled Routine'}
                </button>
              ))}
            </div>

            <div>
              <Label>Project</Label>
              <Select value={taskForm.project_id} onValueChange={v => setTaskForm(f => ({ ...f, project_id: v }))}>
                <SelectTrigger><SelectValue placeholder="Select a project" /></SelectTrigger>
                <SelectContent>
                  {projects.map(p => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <div className="flex items-center justify-between">
                <Label>Title</Label>
                {taskForm.task_type === 'regular' && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1 text-xs"
                    onClick={handleSuggestTaskTitle}
                    disabled={(!taskForm.title.trim() && !taskForm.description.trim()) || isSuggestingTaskTitle}
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    {isSuggestingTaskTitle ? 'Suggesting...' : 'Suggest with AI'}
                  </Button>
                )}
              </div>
              <Input
                value={taskForm.title}
                onChange={e => setTaskForm(f => ({ ...f, title: e.target.value }))}
                placeholder={taskForm.task_type === 'scheduled' ? 'Research top news  (date appended on run)' : 'Task title'}
              />
            </div>
            <div>
              <div className="flex items-center justify-between">
                <Label>Description <span className="text-muted-foreground font-normal">(optional)</span></Label>
                {taskForm.task_type === 'regular' && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1 text-xs"
                    onClick={handleSuggestTask}
                    disabled={(!taskForm.title.trim() && !taskForm.description.trim()) || isSuggestingTask}
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    {isSuggestingTask ? 'Suggesting...' : 'Suggest with AI'}
                  </Button>
                )}
              </div>
              <Textarea
                value={taskForm.description}
                onChange={e => setTaskForm(f => ({ ...f, description: e.target.value }))}
                placeholder={taskForm.task_type === 'scheduled' ? 'Instructions for the agent...' : ''}
                rows={2}
              />
            </div>

            {taskForm.task_type === 'scheduled' ? (
              <div className="space-y-3">
                <div>
                  <Label>Repeat</Label>
                  <Select value={taskForm.frequency} onValueChange={v => setTaskForm(f => ({ ...f, frequency: v }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="daily">Daily</SelectItem>
                      <SelectItem value="weekly">Weekly</SelectItem>
                      <SelectItem value="monthly">Monthly</SelectItem>
                      <SelectItem value="yearly">Yearly</SelectItem>
                      <SelectItem value="custom">Custom cron</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {taskForm.frequency === 'custom' && (
                  <div>
                    <Label>Cron expression <span className="text-muted-foreground font-normal">(5-field)</span></Label>
                    <Input
                      value={taskForm.cron_expr}
                      onChange={e => setTaskForm(f => ({ ...f, cron_expr: e.target.value }))}
                      placeholder="0 9 * * 1  — every Monday at 9am"
                      className="font-mono text-sm"
                    />
                    <p className="text-xs text-muted-foreground mt-1">min hour day month weekday</p>
                  </div>
                )}
              </div>
            ) : (
              <div>
                <Label>Status</Label>
                <Select value={taskForm.status} onValueChange={v => setTaskForm(f => ({ ...f, status: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="todo">Todo</SelectItem>
                    <SelectItem value="in_progress">In Progress</SelectItem>
                    <SelectItem value="done">Done</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Priority</Label>
                <Select value={taskForm.priority} onValueChange={v => setTaskForm(f => ({ ...f, priority: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Assigned to</Label>
                <Select value={taskForm.assigned_to || 'unassigned'} onValueChange={v => setTaskForm(f => ({ ...f, assigned_to: v === 'unassigned' ? '' : v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="unassigned">Unassigned</SelectItem>
                    <SelectItem value="human">Human</SelectItem>
                    <SelectItem value="agent">Agent</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div>
              <Label>Labels</Label>
              <LabelChipInput value={taskForm.labels} onChange={labels => setTaskForm(f => ({ ...f, labels }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowTaskDialog(false)}>Cancel</Button>
            <Button onClick={handleCreateTask} disabled={isCreatingTask}>
              {isCreatingTask && <RefreshCw className="h-4 w-4 animate-spin mr-2" />}
              {taskForm.task_type === 'scheduled' ? 'Create Routine' : 'Create Task'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Task Detail Sheet */}
      <Sheet open={!!selectedTask} onOpenChange={open => !open && setSelectedTask(null)}>
        <SheetContent side="right" className="w-full sm:max-w-md flex flex-col gap-0 p-0">
          <SheetHeader className="px-6 py-4 border-b">
            <div className="flex items-center gap-2">
              <SheetTitle className="text-base">Task Detail</SheetTitle>
              {taskSheetMode === 'view' && (
                <button
                  onClick={() => setTaskSheetMode('edit')}
                  className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
                  title="Edit task"
                >
                  <Pencil className="h-4 w-4" />
                </button>
              )}
              {taskSheetMode === 'edit' && (
                <button
                  type="button"
                  onClick={() => selectedTask && setConfirmDeleteTaskId(selectedTask.id)}
                  className="p-1.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                  title="Delete task"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </div>
            {selectedTask?.project_name && (
              <p className="text-xs text-muted-foreground">{selectedTask.project_name}</p>
            )}
          </SheetHeader>
          {taskSheetMode === 'view' ? (
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
              <div>
                <Label className="text-xs text-muted-foreground">Title</Label>
                <p className="text-sm font-medium mt-1">{selectedTask?.title}</p>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Description</Label>
                <p className="text-sm whitespace-pre-wrap mt-1">
                  {selectedTask?.description || <span className="text-muted-foreground">No description</span>}
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs text-muted-foreground">Status</Label>
                  <p className="mt-1">
                    <span className={`text-xs border rounded px-1.5 py-0.5 ${selectedTask ? (STATUS_COLORS[selectedTask.status] ?? '') : ''}`}>
                      {selectedTask ? (STATUS_LABELS[selectedTask.status] ?? selectedTask.status) : ''}
                    </span>
                  </p>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Priority</Label>
                  <p className={`text-sm mt-1 ${selectedTask ? (PRIORITY_COLORS[selectedTask.priority] ?? '') : ''}`}>
                    {selectedTask?.priority}
                  </p>
                </div>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Assigned to</Label>
                <p className="text-sm mt-1">
                  {selectedTask?.assigned_to === 'human' ? 'Human' : selectedTask?.assigned_to === 'agent' ? 'Agent' : 'Unassigned'}
                </p>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Labels</Label>
                <div className="flex flex-wrap gap-1.5 mt-1">
                  {selectedTask?.labels?.length ? (
                    selectedTask.labels.map(l => (
                      <span key={l} className={`text-xs px-1.5 py-0.5 rounded border ${TASK_LABEL_COLORS[l] ?? CUSTOM_LABEL_COLOR}`}>
                        {l}
                      </span>
                    ))
                  ) : (
                    <span className="text-sm text-muted-foreground">No labels</span>
                  )}
                </div>
              </div>
              {selectedTask && (
                <div className="text-xs text-muted-foreground space-y-1 pt-2 border-t">
                  <p>Created by: <span className="font-medium">{selectedTask.created_by}</span></p>
                  <p>Created: <span className="font-medium">{new Date(selectedTask.created_at).toLocaleString()}</span></p>
                  <p>Updated: <span className="font-medium">{new Date(selectedTask.updated_at).toLocaleString()}</span></p>
                </div>
              )}
              {selectedTask && (
                <TaskNotesPanel projectId={selectedTask.project_id} taskId={selectedTask.id} />
              )}
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
              <div>
                <div className="flex items-center justify-between">
                  <Label>Title</Label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1 text-xs"
                    onClick={handleSuggestEditTaskTitle}
                    disabled={(!editForm.title.trim() && !editForm.description.trim()) || isSuggestingEditTaskTitle}
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    {isSuggestingEditTaskTitle ? 'Suggesting...' : 'Suggest with AI'}
                  </Button>
                </div>
                <Input
                  value={editForm.title}
                  onChange={e => setEditForm(f => ({ ...f, title: e.target.value }))}
                />
              </div>
              <div>
                <div className="flex items-center justify-between">
                  <Label>Description</Label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1 text-xs"
                    onClick={handleSuggestEditTask}
                    disabled={(!editForm.title.trim() && !editForm.description.trim()) || isSuggestingEditTask}
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    {isSuggestingEditTask ? 'Suggesting...' : 'Suggest with AI'}
                  </Button>
                </div>
                <Textarea
                  value={editForm.description}
                  onChange={e => setEditForm(f => ({ ...f, description: e.target.value }))}
                  placeholder="Add details..."
                  rows={4}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Status</Label>
                  <Select value={editForm.status} onValueChange={v => setEditForm(f => ({ ...f, status: v }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="scheduled">Scheduled</SelectItem>
                      <SelectItem value="todo">Todo</SelectItem>
                      <SelectItem value="in_progress">In Progress</SelectItem>
                      <SelectItem value="done">Done</SelectItem>
                      <SelectItem value="cancelled">Cancelled</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Priority</Label>
                  <Select value={editForm.priority} onValueChange={v => setEditForm(f => ({ ...f, priority: v }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="low">Low</SelectItem>
                      <SelectItem value="medium">Medium</SelectItem>
                      <SelectItem value="high">High</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div>
                <Label>Assigned to</Label>
                <Select value={editForm.assigned_to || 'unassigned'} onValueChange={v => setEditForm(f => ({ ...f, assigned_to: v === 'unassigned' ? '' : v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="unassigned">Unassigned</SelectItem>
                    <SelectItem value="human">Human</SelectItem>
                    <SelectItem value="agent">Agent</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Labels</Label>
                <LabelChipInput value={editForm.labels} onChange={labels => setEditForm(f => ({ ...f, labels }))} />
              </div>
              {selectedTask && (
                <div className="text-xs text-muted-foreground space-y-1 pt-2 border-t">
                  <p>Created by: <span className="font-medium">{selectedTask.created_by}</span></p>
                  <p>Created: <span className="font-medium">{new Date(selectedTask.created_at).toLocaleString()}</span></p>
                  <p>Updated: <span className="font-medium">{new Date(selectedTask.updated_at).toLocaleString()}</span></p>
                </div>
              )}
            </div>
          )}
          <SheetFooter className="px-6 py-4 border-t">
            <Button variant="outline" onClick={() => setSelectedTask(null)}>Close</Button>
            {taskSheetMode === 'edit' && (
              <Button onClick={handleSaveTask} disabled={isSavingTask}>
                {isSavingTask && <RefreshCw className="h-4 w-4 animate-spin mr-2" />}
                Save
              </Button>
            )}
          </SheetFooter>
        </SheetContent>
      </Sheet>

      {/* Routine Edit Sheet */}
      <Sheet open={!!selectedRoutine} onOpenChange={open => !open && setSelectedRoutine(null)}>
        <SheetContent side="right" className="w-full sm:max-w-md flex flex-col gap-0 p-0">
          <SheetHeader className="px-6 py-4 border-b">
            <div className="flex items-center gap-2">
              <SheetTitle className="text-base">{routineSheetMode === 'edit' ? 'Edit Routine' : 'Routine Detail'}</SheetTitle>
              {routineSheetMode === 'view' && (
                <button
                  onClick={() => setRoutineSheetMode('edit')}
                  className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
                  title="Edit routine"
                >
                  <Pencil className="h-4 w-4" />
                </button>
              )}
              <button
                onClick={() => selectedRoutine && openRoutineHistory(selectedRoutine)}
                className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
                title="View execution history"
              >
                <History className="h-4 w-4" />
              </button>
              <button
                onClick={() => setConfirmDeleteRoutine(true)}
                className="p-1.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                title="Delete routine"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
            {selectedRoutine?.project_name && (
              <p className="text-xs text-muted-foreground">{selectedRoutine.project_name}</p>
            )}
          </SheetHeader>
          {routineSheetMode === 'view' ? (
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
              <div>
                <Label className="text-xs text-muted-foreground">Title</Label>
                <p className="text-sm font-medium mt-1">{selectedRoutine?.title}</p>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Description</Label>
                <p className="text-sm whitespace-pre-wrap mt-1">
                  {selectedRoutine?.description || <span className="text-muted-foreground">No description</span>}
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs text-muted-foreground">Repeat</Label>
                  <p className="text-sm mt-1 flex items-center gap-1">
                    <Repeat2 className="h-3 w-3 text-muted-foreground" />
                    {FREQ_LABELS[selectedRoutine?.frequency ?? ''] ?? selectedRoutine?.frequency}
                  </p>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Priority</Label>
                  <p className={`text-sm mt-1 ${selectedRoutine ? (PRIORITY_COLORS[selectedRoutine.priority] ?? '') : ''}`}>
                    {selectedRoutine?.priority}
                  </p>
                </div>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Assigned to</Label>
                <p className="text-sm mt-1">
                  {selectedRoutine?.assigned_to === 'human' ? 'Human' : selectedRoutine?.assigned_to === 'agent' ? 'Agent' : 'Unassigned'}
                </p>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Labels</Label>
                <div className="flex flex-wrap gap-1.5 mt-1">
                  {selectedRoutine?.labels?.length ? (
                    selectedRoutine.labels.map(l => (
                      <span key={l} className={`text-xs px-1.5 py-0.5 rounded border ${TASK_LABEL_COLORS[l] ?? CUSTOM_LABEL_COLOR}`}>
                        {l}
                      </span>
                    ))
                  ) : (
                    <span className="text-sm text-muted-foreground">No labels</span>
                  )}
                </div>
              </div>
              {selectedRoutine && (
                <div className="text-xs text-muted-foreground space-y-1 pt-2 border-t">
                  <p>Created: <span className="font-medium">{new Date(selectedRoutine.created_at).toLocaleString()}</span></p>
                  <p>Updated: <span className="font-medium">{new Date(selectedRoutine.updated_at).toLocaleString()}</span></p>
                </div>
              )}
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
              <div>
                <Label>Title</Label>
                <Input
                  value={routineEditForm.title}
                  onChange={e => setRoutineEditForm(f => ({ ...f, title: e.target.value }))}
                />
              </div>
              <div>
                <Label>Description</Label>
                <Textarea
                  value={routineEditForm.description}
                  onChange={e => setRoutineEditForm(f => ({ ...f, description: e.target.value }))}
                  placeholder="Instructions for the agent..."
                  rows={4}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Repeat</Label>
                  <Select value={routineEditForm.frequency} onValueChange={v => setRoutineEditForm(f => ({ ...f, frequency: v }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="daily">Daily</SelectItem>
                      <SelectItem value="weekly">Weekly</SelectItem>
                      <SelectItem value="monthly">Monthly</SelectItem>
                      <SelectItem value="yearly">Yearly</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Priority</Label>
                  <Select value={routineEditForm.priority} onValueChange={v => setRoutineEditForm(f => ({ ...f, priority: v }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="low">Low</SelectItem>
                      <SelectItem value="medium">Medium</SelectItem>
                      <SelectItem value="high">High</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div>
                <Label>Assigned to</Label>
                <Select value={routineEditForm.assigned_to || 'unassigned'} onValueChange={v => setRoutineEditForm(f => ({ ...f, assigned_to: v === 'unassigned' ? '' : v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="unassigned">Unassigned</SelectItem>
                    <SelectItem value="human">Human</SelectItem>
                    <SelectItem value="agent">Agent</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Labels</Label>
                <LabelChipInput value={routineEditForm.labels} onChange={labels => setRoutineEditForm(f => ({ ...f, labels }))} />
              </div>
              {selectedRoutine && (
                <div className="text-xs text-muted-foreground space-y-1 pt-2 border-t">
                  <p>Created: <span className="font-medium">{new Date(selectedRoutine.created_at).toLocaleString()}</span></p>
                  <p>Updated: <span className="font-medium">{new Date(selectedRoutine.updated_at).toLocaleString()}</span></p>
                </div>
              )}
            </div>
          )}
          <SheetFooter className="px-6 py-4 border-t flex gap-2">
            <Button variant="outline" className="flex-1" onClick={() => setSelectedRoutine(null)}>Close</Button>
            {routineSheetMode === 'edit' && (
              <Button className="flex-1" onClick={handleSaveRoutine} disabled={isSavingRoutine}>
                {isSavingRoutine && <RefreshCw className="h-4 w-4 animate-spin mr-2" />}
                Save
              </Button>
            )}
          </SheetFooter>
        </SheetContent>
      </Sheet>

      {/* Routine Execution History Sheet */}
      <Sheet open={routineHistoryOpen} onOpenChange={open => !open && setRoutineHistoryOpen(false)}>
        <SheetContent side="right" className="w-full sm:max-w-md flex flex-col gap-0 p-0">
          <SheetHeader className="px-6 py-4 border-b">
            <SheetTitle className="text-base">Execution History</SheetTitle>
            {routineHistoryRoutine && (
              <p className="text-xs text-muted-foreground">
                {routineHistoryRoutine.title}
                {routineHistoryRoutine.project_name ? ` · ${routineHistoryRoutine.project_name}` : ''}
              </p>
            )}
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-6 py-4">
            {isLoadingRoutineHistory ? (
              <div className="flex items-center justify-center py-12 text-muted-foreground">
                <RefreshCw className="h-4 w-4 animate-spin mr-2" />
                Loading...
              </div>
            ) : routineHistoryTasks.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-12">No tasks generated yet</p>
            ) : (
              <div className="space-y-2">
                {routineHistoryTasks.map(task => (
                  <button
                    key={task.id}
                    onClick={() => { setRoutineHistoryOpen(false); openTaskSheet(task); }}
                    className="w-full text-left rounded-md border p-3 hover:bg-accent transition-colors"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium truncate">{task.title}</span>
                      <span className={`text-xs shrink-0 border rounded px-1.5 py-0.5 ${STATUS_COLORS[task.status] ?? ''}`}>
                        {STATUS_LABELS[task.status] ?? task.status}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      {new Date(task.created_at).toLocaleString()}
                    </p>
                  </button>
                ))}
              </div>
            )}
          </div>
          <SheetFooter className="px-6 py-4 border-t">
            <Button variant="outline" className="w-full" onClick={() => setRoutineHistoryOpen(false)}>Close</Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      {/* Delete Routine Confirm */}
      <AlertDialog open={confirmDeleteRoutine} onOpenChange={setConfirmDeleteRoutine}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete routine?</AlertDialogTitle>
            <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { setConfirmDeleteRoutine(false); handleDeleteRoutine(); }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete Task Confirm */}
      <AlertDialog open={!!confirmDeleteTaskId} onOpenChange={open => !open && setConfirmDeleteTaskId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete task?</AlertDialogTitle>
            <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => confirmDeleteTaskId && handleDeleteTask(confirmDeleteTaskId)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete Project Confirm */}
      <AlertDialog open={!!confirmDeleteId} onOpenChange={open => !open && setConfirmDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete project?</AlertDialogTitle>
            <AlertDialogDescription>
              Removes the project and all its tasks from the database. Files on disk are not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => confirmDeleteId && handleDelete(confirmDeleteId)}
              disabled={!!deletingId}
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

type BoardCardItem =
  | { kind: 'task'; data: Task }
  | { kind: 'routine'; data: Routine };

/// Renders a task or a routine as a board card. The two entities are structurally
/// near-identical (title, priority, labels, assignee) — the only real differences are
/// the primary badge (task status vs. routine frequency) and the drag handle (tasks only).
function BoardCard({ item, showProject, parentTitle, onOpen, onEdit }: {
  item: BoardCardItem;
  showProject: boolean;
  parentTitle?: string;
  onOpen: () => void;
  onEdit: () => void;
}) {
  const isTask = item.kind === 'task';
  const task = item.kind === 'task' ? item.data : null;
  const routine = item.kind === 'routine' ? item.data : null;
  const isCancelled = task?.status === 'cancelled';
  const showDragHandle = !!task && !isCancelled && task.status !== 'scheduled';
  const title = isTask ? task!.title : routine!.title;
  const priority = isTask ? task!.priority : routine!.priority;
  const labels = isTask ? task!.labels : routine!.labels;
  const assignedTo = isTask ? task!.assigned_to : routine!.assigned_to;
  const projectName = isTask ? task!.project_name : routine!.project_name;

  return (
    <div
      className={`group flex items-start gap-1.5 bg-background border rounded-md shadow-sm transition-colors ${
        isTask ? 'hover:border-primary/30' : 'border-purple-200/60 dark:border-purple-800/40 hover:border-purple-400/60 dark:hover:border-purple-600/60'
      } ${isCancelled ? 'opacity-50' : ''}`}
    >
      {showDragHandle ? (
        <div
          draggable
          onDragStart={e => {
            e.dataTransfer.setData('taskId', task!.id);
            e.dataTransfer.effectAllowed = 'move';
          }}
          className="shrink-0 flex items-center px-1 py-2.5 cursor-grab active:cursor-grabbing text-muted-foreground/30 hover:text-muted-foreground transition-colors rounded-l-md"
          title="Drag to move"
          onClick={e => e.stopPropagation()}
        >
          <GripVertical className="h-3.5 w-3.5" />
        </div>
      ) : (
        <div className="w-5 shrink-0" />
      )}

      {/* Card body — click to open sheet */}
      <div className="flex-1 min-w-0 py-2.5 pr-1 cursor-pointer" onClick={onOpen}>
        {isTask && parentTitle && (
          <p className="text-[11px] text-muted-foreground truncate mb-0.5 flex items-center gap-1">
            <CornerDownRight className="h-2.5 w-2.5 shrink-0" />{parentTitle}
          </p>
        )}
        <p className={`text-sm font-medium leading-snug mb-1.5 ${isCancelled ? 'line-through text-muted-foreground' : ''}`}>
          {title}
        </p>
        <div className="flex items-center gap-1.5 flex-wrap">
          {task ? (
            <span className={`text-xs px-1.5 py-0.5 rounded border ${STATUS_COLORS[task.status] ?? 'border-border text-muted-foreground'}`}>
              {STATUS_LABELS[task.status] ?? task.status}
            </span>
          ) : (
            <span className="text-xs px-1.5 py-0.5 rounded border border-purple-400 text-purple-600 dark:text-purple-400 flex items-center gap-1">
              <Repeat2 className="h-2.5 w-2.5" />{FREQ_LABELS[routine!.frequency] ?? routine!.frequency}
            </span>
          )}
          <span className={`text-xs ${PRIORITY_COLORS[priority] ?? 'text-muted-foreground'}`}>
            {priority}
          </span>
          {labels?.map(l => (
            <span key={l} className={`text-xs px-1.5 py-0.5 rounded border ${TASK_LABEL_COLORS[l] ?? CUSTOM_LABEL_COLOR}`}>
              {l}
            </span>
          ))}
          {assignedTo === 'human' && <User className="h-3 w-3 text-muted-foreground" />}
          {assignedTo === 'agent' && <Bot className="h-3 w-3 text-muted-foreground" />}
          {showProject && projectName && (
            <span className="text-xs text-muted-foreground truncate max-w-[80px]">{projectName}</span>
          )}
        </div>
      </div>

      {/* Action buttons — shown on hover */}
      <div className="shrink-0 mt-1.5 mr-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={e => { e.stopPropagation(); onEdit(); }}
          className="p-1.5 rounded hover:bg-muted text-muted-foreground"
          title={isTask ? 'Edit task' : 'Edit routine'}
        >
          <Pencil className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}
