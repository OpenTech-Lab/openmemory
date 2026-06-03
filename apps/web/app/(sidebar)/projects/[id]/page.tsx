'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { RefreshCw, ArrowLeft, Search, Plus, Bot, User, Repeat2 } from 'lucide-react';
import { toast } from 'sonner';

const ProjectKnowledgeGraph = dynamic(
  () => import('@/components/project-knowledge-graph').then(m => m.ProjectKnowledgeGraph),
  {
    ssr: false,
    loading: () => (
      <div className="w-full h-full flex items-center justify-center">
        <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    ),
  }
);

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
  graph_data?: { nodes?: unknown[] } | null;
}

interface Routine {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  frequency: string;
  priority: string;
  assigned_to: string | null;
  last_task_date: string | null;
  enabled: boolean;
  created_at: string;
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
}

interface GraphQueryResult {
  query: string;
  seed_nodes: string[];
  nodes: Array<{ id: string; label: string; file_type?: string; community?: number; source_file?: string }>;
  edges: Array<{ source: string; target: string; relation: string }>;
  truncated: boolean;
}

const STATUS_LABELS: Record<string, string> = { scheduled: 'Scheduled', todo: 'Todo', in_progress: 'In Progress', done: 'Done', cancelled: 'Cancelled' };
const PRIORITY_COLORS: Record<string, string> = {
  low: 'text-muted-foreground',
  medium: 'text-yellow-600 dark:text-yellow-400',
  high: 'text-destructive',
};

export default function ProjectDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const router = useRouter();

  const [project, setProject] = useState<Project | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isRebuilding, setIsRebuilding] = useState(false);
  const [activeTab, setActiveTab] = useState<'graph' | 'tasks' | 'routines'>('graph');

  // Graph query
  const [queryInput, setQueryInput] = useState('');
  const [queryResult, setQueryResult] = useState<GraphQueryResult | null>(null);
  const [isQuerying, setIsQuerying] = useState(false);
  const queriedQueryRef = useRef<string>('');

  // Tasks
  const [tasks, setTasks] = useState<Task[]>([]);
  const [isLoadingTasks, setIsLoadingTasks] = useState(false);
  const [showTaskDialog, setShowTaskDialog] = useState(false);
  const [taskForm, setTaskForm] = useState({ title: '', description: '', status: 'todo', priority: 'medium', assigned_to: '' });
  const [isCreatingTask, setIsCreatingTask] = useState(false);

  // Routines
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [isLoadingRoutines, setIsLoadingRoutines] = useState(false);
  const [showRoutineDialog, setShowRoutineDialog] = useState(false);
  const [routineForm, setRoutineForm] = useState({ title: '', description: '', frequency: 'daily', priority: 'medium', assigned_to: '' });
  const [isCreatingRoutine, setIsCreatingRoutine] = useState(false);
  const [isCheckingRoutines, setIsCheckingRoutines] = useState(false);

  const fetchProject = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${id}`);
      if (res.status === 404) { router.push('/projects'); return; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setProject(data);
      // Default to tasks tab for path-less projects
      if (!data.path) setActiveTab('tasks');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load project');
    } finally {
      setIsLoading(false);
    }
  }, [id, router]);

  const fetchTasks = useCallback(async () => {
    setIsLoadingTasks(true);
    try {
      const res = await fetch(`/api/projects/${id}/tasks?limit=200`);
      const data = await res.json();
      setTasks(data.tasks ?? []);
    } catch {
      toast.error('Failed to load tasks');
    } finally {
      setIsLoadingTasks(false);
    }
  }, [id]);

  const fetchRoutines = useCallback(async () => {
    setIsLoadingRoutines(true);
    try {
      const res = await fetch(`/api/projects/${id}/routines`);
      const data = await res.json();
      setRoutines(data.routines ?? []);
    } catch {
      toast.error('Failed to load routines');
    } finally {
      setIsLoadingRoutines(false);
    }
  }, [id]);

  useEffect(() => { fetchProject(); }, [fetchProject]);
  useEffect(() => { fetchTasks(); }, [fetchTasks]);
  useEffect(() => { fetchRoutines(); }, [fetchRoutines]);

  const handleRebuild = async () => {
    setIsRebuilding(true);
    try {
      const res = await fetch(`/api/projects/${id}/rebuild`, { method: 'POST' });
      const data = await res.json();
      if (data.status === 'unchanged') toast.info('Graph is up to date');
      else { toast.success('Graph rebuilt'); await fetchProject(); }
    } catch {
      toast.error('Rebuild failed');
    } finally {
      setIsRebuilding(false);
    }
  };

  const handleQuery = async () => {
    const q = queryInput.trim();
    if (!q) return;
    setIsQuerying(true);
    queriedQueryRef.current = q;
    try {
      const res = await fetch(`/api/projects/${id}/query?q=${encodeURIComponent(q)}&hops=2`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: GraphQueryResult = await res.json();
      if (queriedQueryRef.current === q) setQueryResult(data);
    } catch {
      toast.error('Query failed');
    } finally {
      setIsQuerying(false);
    }
  };

  const handleStatusCycle = async (task: Task) => {
    const next = task.status === 'todo' ? 'in_progress' : task.status === 'in_progress' ? 'done' : 'todo';
    setTasks(prev => prev.map(t => t.id === task.id ? { ...t, status: next } : t));
    try {
      const res = await fetch(`/api/projects/${id}/tasks/${task.id}`, {
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

  const handleDeleteTask = async (taskId: string) => {
    try {
      await fetch(`/api/projects/${id}/tasks/${taskId}`, { method: 'DELETE' });
      setTasks(prev => prev.filter(t => t.id !== taskId));
      toast.success('Task deleted');
    } catch {
      toast.error('Failed to delete task');
    }
  };

  const handleCheckRoutines = async () => {
    setIsCheckingRoutines(true);
    try {
      const res = await fetch(`/api/projects/${id}/routines/check`, { method: 'POST' });
      const data = await res.json();
      const count = data.created?.length ?? 0;
      if (count > 0) {
        toast.success(`Created ${count} task${count !== 1 ? 's' : ''} from routines`);
        fetchTasks();
        fetchRoutines();
      } else {
        toast.info('No routines are due right now');
      }
    } catch {
      toast.error('Failed to check routines');
    } finally {
      setIsCheckingRoutines(false);
    }
  };

  const handleCreateRoutine = async () => {
    if (!routineForm.title.trim()) { toast.error('Title is required'); return; }
    setIsCreatingRoutine(true);
    try {
      const body: Record<string, string> = {
        title: routineForm.title,
        frequency: routineForm.frequency,
        priority: routineForm.priority,
      };
      if (routineForm.description.trim()) body.description = routineForm.description.trim();
      if (routineForm.assigned_to) body.assigned_to = routineForm.assigned_to;
      const res = await fetch(`/api/projects/${id}/routines`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) { toast.error('Failed to create routine'); return; }
      setShowRoutineDialog(false);
      setRoutineForm({ title: '', description: '', frequency: 'daily', priority: 'medium', assigned_to: '' });
      fetchRoutines();
      toast.success('Routine created');
    } catch {
      toast.error('Failed to create routine');
    } finally {
      setIsCreatingRoutine(false);
    }
  };

  const handleToggleRoutine = async (routine: Routine) => {
    try {
      await fetch(`/api/projects/${id}/routines/${routine.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !routine.enabled }),
      });
      fetchRoutines();
    } catch {
      toast.error('Failed to update routine');
    }
  };

  const handleDeleteRoutine = async (routineId: string) => {
    try {
      await fetch(`/api/projects/${id}/routines/${routineId}`, { method: 'DELETE' });
      setRoutines(prev => prev.filter(r => r.id !== routineId));
      toast.success('Routine deleted');
    } catch {
      toast.error('Failed to delete routine');
    }
  };

  const handleCreateTask = async () => {
    if (!taskForm.title.trim()) { toast.error('Title is required'); return; }
    setIsCreatingTask(true);
    try {
      const body: Record<string, string> = {
        title: taskForm.title,
        status: taskForm.status,
        priority: taskForm.priority,
      };
      if (taskForm.description.trim()) body.description = taskForm.description.trim();
      if (taskForm.assigned_to) body.assigned_to = taskForm.assigned_to;
      const res = await fetch(`/api/projects/${id}/tasks`, {
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
      setTaskForm({ title: '', description: '', status: 'todo', priority: 'medium', assigned_to: '' });
      fetchTasks();
      toast.success('Task created');
    } catch {
      toast.error('Failed to create task');
    } finally {
      setIsCreatingTask(false);
    }
  };

  if (isLoading) {
    return <div className="flex items-center justify-center h-full"><RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" /></div>;
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4">
        <p className="text-destructive">{error}</p>
        <Button variant="outline" onClick={() => router.push('/projects')}><ArrowLeft className="h-4 w-4 mr-2" />Back to Projects</Button>
      </div>
    );
  }

  if (!project) return null;

  const hasGraph = !!project.path;
  const taskCount = tasks.length;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-4 px-6 py-3 border-b shrink-0">
        <Button variant="ghost" size="sm" onClick={() => router.push('/projects')}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="font-semibold truncate">{project.name}</h1>
            {hasGraph && (
              <>
                <Badge variant="secondary">{project.node_count.toLocaleString()} nodes</Badge>
                <Badge variant="outline">{project.edge_count.toLocaleString()} edges</Badge>
              </>
            )}
          </div>
          {project.path && (
            <p className="text-xs text-muted-foreground font-mono truncate">{project.path}</p>
          )}
        </div>
        {hasGraph && (
          <Button variant="outline" size="sm" onClick={handleRebuild} disabled={isRebuilding}>
            {isRebuilding ? <RefreshCw className="h-4 w-4 animate-spin" /> : <><RefreshCw className="h-4 w-4 mr-1" />Rebuild</>}
          </Button>
        )}
      </div>

      {/* Tabs — always visible; Graph tab only for projects with a path */}
      <div className="flex border-b shrink-0 px-6">
        {hasGraph && (
          <button
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${activeTab === 'graph' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
            onClick={() => setActiveTab('graph')}
          >
            Graph
          </button>
        )}
        <button
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${activeTab === 'tasks' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
          onClick={() => setActiveTab('tasks')}
        >
          Tasks {taskCount > 0 && <span className="ml-1 text-xs bg-muted rounded-full px-1.5 py-0.5">{taskCount}</span>}
        </button>
        <button
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${activeTab === 'routines' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
          onClick={() => setActiveTab('routines')}
        >
          Routines {routines.length > 0 && <span className="ml-1 text-xs bg-muted rounded-full px-1.5 py-0.5">{routines.length}</span>}
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 relative overflow-hidden">
        {/* Graph tab */}
        {activeTab === 'graph' && hasGraph && (
          <>
            {!project.graph_data || (project.graph_data as { nodes?: unknown }).nodes === undefined ? (
              <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-3">
                <p>No graph data yet.</p>
                <p className="text-sm">Run <code className="bg-muted px-1 rounded">/graphify {project.path}</code> then click Rebuild.</p>
                <Button variant="outline" size="sm" onClick={handleRebuild} disabled={isRebuilding}>
                  {isRebuilding && <RefreshCw className="h-4 w-4 animate-spin mr-2" />}
                  Rebuild
                </Button>
              </div>
            ) : (
              <>
                <ProjectKnowledgeGraph
                  graphData={project.graph_data as import('@/components/project-knowledge-graph').GraphifyData}
                  queryResult={queryResult}
                />
                <div className="absolute bottom-4 left-1/2 -translate-x-1/2 w-full max-w-lg px-4">
                  <div className="bg-background/95 backdrop-blur border rounded-lg shadow-lg p-3">
                    <div className="flex gap-2">
                      <Input
                        value={queryInput}
                        onChange={e => setQueryInput(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && handleQuery()}
                        placeholder="Search the graph..."
                        className="flex-1 text-sm"
                        disabled={isQuerying}
                      />
                      <Button onClick={handleQuery} disabled={isQuerying || !queryInput.trim()} size="sm">
                        {isQuerying ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                      </Button>
                      {queryResult && (
                        <Button variant="ghost" size="sm" onClick={() => { setQueryResult(null); setQueryInput(''); }}>Clear</Button>
                      )}
                    </div>
                    {queryResult && (
                      <p className="text-xs text-muted-foreground mt-2">
                        Found {queryResult.nodes.length} nodes from {queryResult.seed_nodes.length} seed(s)
                        {queryResult.truncated && ' (truncated)'}
                      </p>
                    )}
                  </div>
                </div>
              </>
            )}
          </>
        )}

        {/* Tasks tab */}
        {activeTab === 'tasks' && (
          <div className="flex flex-col h-full p-6 gap-4 overflow-auto">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium text-muted-foreground">
                {taskCount} task{taskCount !== 1 ? 's' : ''}
              </h2>
              <Button size="sm" onClick={() => setShowTaskDialog(true)}>
                <Plus className="h-4 w-4 mr-1" /> Add Task
              </Button>
            </div>
            {isLoadingTasks ? (
              <div className="flex items-center justify-center py-8">
                <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : tasks.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-2">
                <p>No tasks yet.</p>
                <Button variant="outline" size="sm" onClick={() => setShowTaskDialog(true)}>
                  <Plus className="h-4 w-4 mr-1" /> Add first task
                </Button>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {tasks.map(task => (
                  <div key={task.id} className="flex items-start gap-3 p-3 border rounded-lg bg-background hover:bg-muted/30 transition-colors">
                    <button
                      onClick={() => handleStatusCycle(task)}
                      className="mt-0.5 shrink-0 text-xs border rounded px-1.5 py-0.5 hover:bg-muted transition-colors"
                      title="Click to advance status"
                    >
                      {STATUS_LABELS[task.status] ?? task.status}
                    </button>
                    <div className="flex-1 min-w-0">
                      <p className={`text-sm font-medium ${task.status === 'done' ? 'line-through text-muted-foreground' : ''}`}>
                        {task.title}
                      </p>
                      {task.description && (
                        <p className="text-xs text-muted-foreground mt-0.5 truncate">{task.description}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <span className={`text-xs ${PRIORITY_COLORS[task.priority] ?? ''}`}>{task.priority}</span>
                      {task.assigned_to === 'human' && <User className="h-3.5 w-3.5 text-muted-foreground" />}
                      {task.assigned_to === 'agent' && <Bot className="h-3.5 w-3.5 text-muted-foreground" />}
                      <button
                        onClick={() => handleDeleteTask(task.id)}
                        className="text-xs text-muted-foreground hover:text-destructive transition-colors ml-1"
                      >
                        ×
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Routines tab */}
        {activeTab === 'routines' && (
          <div className="flex flex-col h-full p-6 gap-4 overflow-auto">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-medium">Recurring Tasks</h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Templates that generate a dated task each time they&apos;re checked
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleCheckRoutines}
                  disabled={isCheckingRoutines}
                  title="Create tasks for any due routines"
                >
                  {isCheckingRoutines
                    ? <RefreshCw className="h-4 w-4 animate-spin mr-1" />
                    : <Repeat2 className="h-4 w-4 mr-1" />}
                  Check due
                </Button>
                <Button size="sm" onClick={() => setShowRoutineDialog(true)}>
                  <Plus className="h-4 w-4 mr-1" /> Add Routine
                </Button>
              </div>
            </div>

            {isLoadingRoutines ? (
              <div className="flex items-center justify-center py-8">
                <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : routines.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-2">
                <Repeat2 className="h-8 w-8 opacity-30" />
                <p>No routines yet.</p>
                <p className="text-xs text-center max-w-xs">
                  Add a routine like &quot;Research top news&quot; (daily) — when an AI agent calls
                  <code className="bg-muted px-1 rounded mx-1">routine_check</code>
                  it creates a dated task automatically.
                </p>
                <Button variant="outline" size="sm" onClick={() => setShowRoutineDialog(true)}>
                  <Plus className="h-4 w-4 mr-1" /> Add first routine
                </Button>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {routines.map(routine => (
                  <div key={routine.id} className={`flex items-start gap-3 p-3 border rounded-lg transition-colors ${routine.enabled ? 'bg-background' : 'bg-muted/30 opacity-60'}`}>
                    <Repeat2 className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">{routine.title}</p>
                      {routine.description && (
                        <p className="text-xs text-muted-foreground mt-0.5 truncate">{routine.description}</p>
                      )}
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-xs border rounded px-1.5 py-0.5 capitalize">{routine.frequency}</span>
                        <span className={`text-xs ${PRIORITY_COLORS[routine.priority] ?? ''}`}>{routine.priority}</span>
                        {routine.assigned_to === 'human' && <User className="h-3 w-3 text-muted-foreground" />}
                        {routine.assigned_to === 'agent' && <Bot className="h-3 w-3 text-muted-foreground" />}
                        <span className="text-xs text-muted-foreground">
                          last: {routine.last_task_date ?? 'never'}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        onClick={() => handleToggleRoutine(routine)}
                        className="text-xs text-muted-foreground hover:text-foreground transition-colors border rounded px-1.5 py-0.5"
                        title={routine.enabled ? 'Disable' : 'Enable'}
                      >
                        {routine.enabled ? 'on' : 'off'}
                      </button>
                      <button
                        onClick={() => handleDeleteRoutine(routine.id)}
                        className="text-xs text-muted-foreground hover:text-destructive transition-colors ml-1"
                      >
                        ×
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Add Routine Dialog */}
      <Dialog open={showRoutineDialog} onOpenChange={setShowRoutineDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Routine</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Title</Label>
              <Input
                value={routineForm.title}
                onChange={e => setRoutineForm(f => ({ ...f, title: e.target.value }))}
                placeholder="Research top news"
              />
              <p className="text-xs text-muted-foreground mt-1">Today&apos;s date is appended when a task is created, e.g. &quot;Research top news — 2026-06-03&quot;</p>
            </div>
            <div>
              <Label>Instructions <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <Textarea
                value={routineForm.description}
                onChange={e => setRoutineForm(f => ({ ...f, description: e.target.value }))}
                placeholder="Steps or context for the AI agent handling this task"
                rows={2}
              />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label>Frequency</Label>
                <Select value={routineForm.frequency} onValueChange={v => setRoutineForm(f => ({ ...f, frequency: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="daily">Daily</SelectItem>
                    <SelectItem value="weekly">Weekly</SelectItem>
                    <SelectItem value="monthly">Monthly</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Priority</Label>
                <Select value={routineForm.priority} onValueChange={v => setRoutineForm(f => ({ ...f, priority: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Assign to</Label>
                <Select value={routineForm.assigned_to || 'unassigned'} onValueChange={v => setRoutineForm(f => ({ ...f, assigned_to: v === 'unassigned' ? '' : v }))}>
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
            <Button variant="outline" onClick={() => setShowRoutineDialog(false)}>Cancel</Button>
            <Button onClick={handleCreateRoutine} disabled={isCreatingRoutine}>
              {isCreatingRoutine && <RefreshCw className="h-4 w-4 animate-spin mr-2" />}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Task Dialog */}
      <Dialog open={showTaskDialog} onOpenChange={setShowTaskDialog}>
        <DialogContent>
          <DialogHeader><DialogTitle>New Task</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Title</Label>
              <Input
                value={taskForm.title}
                onChange={e => setTaskForm(f => ({ ...f, title: e.target.value }))}
                placeholder="Task title"
                onKeyDown={e => e.key === 'Enter' && handleCreateTask()}
              />
            </div>
            <div>
              <Label>Description <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <Textarea value={taskForm.description} onChange={e => setTaskForm(f => ({ ...f, description: e.target.value }))} rows={2} />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label>Status</Label>
                <Select value={taskForm.status} onValueChange={v => setTaskForm(f => ({ ...f, status: v }))}>
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
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
