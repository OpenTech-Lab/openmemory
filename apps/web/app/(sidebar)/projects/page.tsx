'use client';

import { Suspense, useState, useEffect, useCallback } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
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
import { Plus, RefreshCw, LayoutList, Columns3, Bot, User } from 'lucide-react';
import { toast } from 'sonner';

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
  created_at: string;
  updated_at: string;
  project_name?: string;
}

const STATUS_LABELS: Record<string, string> = {
  todo: 'Todo',
  in_progress: 'In Progress',
  done: 'Done',
};

const PRIORITY_COLORS: Record<string, string> = {
  low: 'text-muted-foreground',
  medium: 'text-yellow-600 dark:text-yellow-400',
  high: 'text-destructive',
};

export default function ProjectsPageWrapper() {
  return <Suspense><ProjectsPage /></Suspense>;
}

function ProjectsPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const view = (searchParams.get('view') as 'list' | 'board') ?? 'list';

  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [taskCounts, setTaskCounts] = useState<Record<string, number>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingTasks, setIsLoadingTasks] = useState(false);
  const [boardFilter, setBoardFilter] = useState<string>('all');

  // Create project dialog
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [createForm, setCreateForm] = useState({ name: '', path: '', description: '' });
  const [isCreating, setIsCreating] = useState(false);
  const [rebuildingId, setRebuildingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Create task dialog
  const [showTaskDialog, setShowTaskDialog] = useState(false);
  const [taskForm, setTaskForm] = useState({
    project_id: '',
    title: '',
    description: '',
    status: 'todo',
    priority: 'medium',
    assigned_to: '',
  });
  const [isCreatingTask, setIsCreatingTask] = useState(false);

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
      const counts: Record<string, number> = {};
      await Promise.all(
        projectList.map(async (p) => {
          const res = await fetch(`/api/projects/${p.id}/tasks?limit=200`);
          const data = await res.json();
          const pts: Task[] = (data.tasks ?? []).map((t: Task) => ({ ...t, project_name: p.name }));
          allTasks.push(...pts);
          counts[p.id] = pts.length;
        })
      );
      setTasks(allTasks);
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
      const body: Record<string, string> = { name: createForm.name };
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
      setCreateForm({ name: '', path: '', description: '' });
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

  const handleCreateTask = async () => {
    if (!taskForm.title.trim()) { toast.error('Title is required'); return; }
    if (!taskForm.project_id) { toast.error('Select a project'); return; }
    setIsCreatingTask(true);
    try {
      const body: Record<string, string> = {
        title: taskForm.title,
        status: taskForm.status,
        priority: taskForm.priority,
      };
      if (taskForm.description.trim()) body.description = taskForm.description.trim();
      if (taskForm.assigned_to) body.assigned_to = taskForm.assigned_to;
      const res = await fetch(`/api/projects/${taskForm.project_id}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        toast.error(b.error ?? 'Failed to create task');
        return;
      }
      setShowTaskDialog(false);
      setTaskForm({ project_id: '', title: '', description: '', status: 'todo', priority: 'medium', assigned_to: '' });
      fetchTasksForBoard(projects);
      toast.success('Task created');
    } catch {
      toast.error('Failed to create task');
    } finally {
      setIsCreatingTask(false);
    }
  };

  const handleStatusCycle = async (task: Task) => {
    const next = task.status === 'todo' ? 'in_progress' : task.status === 'in_progress' ? 'done' : 'todo';
    // Optimistic update
    setTasks(prev => prev.map(t => t.id === task.id ? { ...t, status: next } : t));
    try {
      const res = await fetch(`/api/projects/${task.project_id}/tasks/${task.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next }),
      });
      if (!res.ok) {
        setTasks(prev => prev.map(t => t.id === task.id ? { ...t, status: task.status } : t));
        toast.error('Failed to update task');
      }
    } catch {
      setTasks(prev => prev.map(t => t.id === task.id ? { ...t, status: task.status } : t));
      toast.error('Failed to update task');
    }
  };

  const columns: ColumnDef<Project>[] = [
    {
      accessorKey: 'name',
      header: 'Name',
      cell: ({ row }) => (
        <div className="flex items-center gap-2">
          <Link href={`/projects/${row.original.id}`} className="text-primary hover:underline font-medium">
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
      id: 'actions',
      header: () => <div className="text-right">Actions</div>,
      cell: ({ row }) => (
        <div className="flex items-center justify-end gap-2">
          {row.original.path && (
            <Button variant="ghost" size="sm" onClick={() => handleRebuild(row.original.id)} disabled={rebuildingId === row.original.id}>
              {rebuildingId === row.original.id ? <RefreshCw className="h-3 w-3 animate-spin" /> : 'Rebuild'}
            </Button>
          )}
          <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setConfirmDeleteId(row.original.id)}>
            Delete
          </Button>
        </div>
      ),
    },
  ];

  const filteredTasks = boardFilter === 'all' ? tasks : tasks.filter(t => t.project_id === boardFilter);
  const boardColumns = [
    { key: 'todo', label: 'Todo' },
    { key: 'in_progress', label: 'In Progress' },
    { key: 'done', label: 'Done' },
  ];

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between p-6 border-b">
        <div>
          <h1 className="text-2xl font-semibold">Projects</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage projects, tasks, and code knowledge graphs
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* View toggle */}
          <div className="flex items-center border rounded-md overflow-hidden">
            <Button
              variant={view === 'list' ? 'secondary' : 'ghost'}
              size="sm"
              className="rounded-none h-8 px-3"
              onClick={() => router.push('/projects?view=list')}
            >
              <LayoutList className="h-3.5 w-3.5 mr-1.5" /> List
            </Button>
            <Button
              variant={view === 'board' ? 'secondary' : 'ghost'}
              size="sm"
              className="rounded-none h-8 px-3 border-l"
              onClick={() => router.push('/projects?view=board')}
            >
              <Columns3 className="h-3.5 w-3.5 mr-1.5" /> Board
            </Button>
          </div>
          <Button size="sm" variant="outline" onClick={() => setShowTaskDialog(true)}>
            <Plus className="h-4 w-4 mr-1" /> Task
          </Button>
          <Button size="sm" onClick={() => setShowCreateDialog(true)}>
            <Plus className="h-4 w-4 mr-1" /> Project
          </Button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-6">
        {view === 'list' ? (
          isLoading ? (
            <div className="flex items-center justify-center h-32">
              <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : projects.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-32 text-muted-foreground">
              <p>No projects yet.</p>
              <p className="text-sm mt-1">Click &quot;+ Project&quot; to create one.</p>
            </div>
          ) : (
            <DataTable columns={columns} data={projects} />
          )
        ) : (
          /* Board view */
          <div className="flex flex-col gap-4 h-full">
            {/* Board filter */}
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Project:</span>
              <Select value={boardFilter} onValueChange={setBoardFilter}>
                <SelectTrigger className="w-48 h-8 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Projects</SelectItem>
                  {projects.map(p => (
                    <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {isLoadingTasks && <RefreshCw className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
            </div>

            {/* Kanban columns */}
            <div className="grid grid-cols-3 gap-4 flex-1 min-h-0">
              {boardColumns.map(col => {
                const colTasks = filteredTasks.filter(t => t.status === col.key);
                return (
                  <div key={col.key} className="flex flex-col gap-2 bg-muted/40 rounded-lg p-3 min-h-[200px]">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm font-medium">{col.label}</span>
                      <Badge variant="secondary" className="text-xs">{colTasks.length}</Badge>
                    </div>
                    <div className="flex flex-col gap-2 overflow-y-auto">
                      {colTasks.map(task => (
                        <TaskCard key={task.id} task={task} showProject={boardFilter === 'all'} onStatusCycle={handleStatusCycle} />
                      ))}
                      {colTasks.length === 0 && (
                        <p className="text-xs text-muted-foreground text-center py-4">No tasks</p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
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
                placeholder="/home/user/my-project  — for graph features, run /graphify first"
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

      {/* Create Task Dialog */}
      <Dialog open={showTaskDialog} onOpenChange={setShowTaskDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Task</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
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
              <Label>Title</Label>
              <Input
                value={taskForm.title}
                onChange={e => setTaskForm(f => ({ ...f, title: e.target.value }))}
                placeholder="Task title"
              />
            </div>
            <div>
              <Label>Description <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <Textarea
                value={taskForm.description}
                onChange={e => setTaskForm(f => ({ ...f, description: e.target.value }))}
                rows={2}
              />
            </div>
            <div className="grid grid-cols-3 gap-3">
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
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowTaskDialog(false)}>Cancel</Button>
            <Button onClick={handleCreateTask} disabled={isCreatingTask}>
              {isCreatingTask && <RefreshCw className="h-4 w-4 animate-spin mr-2" />}
              Create Task
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirm */}
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

function TaskCard({ task, showProject, onStatusCycle }: {
  task: Task;
  showProject: boolean;
  onStatusCycle: (task: Task) => void;
}) {
  return (
    <div className="bg-background border rounded-md p-2.5 shadow-sm cursor-default">
      <p className="text-sm font-medium leading-snug mb-1.5">{task.title}</p>
      <div className="flex items-center gap-1.5 flex-wrap">
        <button
          onClick={() => onStatusCycle(task)}
          className={`text-xs px-1.5 py-0.5 rounded border transition-colors hover:bg-muted ${PRIORITY_COLORS[task.priority] ?? ''}`}
          title="Click to advance status"
        >
          {STATUS_LABELS[task.status] ?? task.status}
        </button>
        <span className={`text-xs ${PRIORITY_COLORS[task.priority] ?? 'text-muted-foreground'}`}>
          {task.priority}
        </span>
        {task.assigned_to === 'human' && <User className="h-3 w-3 text-muted-foreground" />}
        {task.assigned_to === 'agent' && <Bot className="h-3 w-3 text-muted-foreground" />}
        {showProject && task.project_name && (
          <span className="text-xs text-muted-foreground truncate max-w-[80px]">{task.project_name}</span>
        )}
      </div>
    </div>
  );
}
