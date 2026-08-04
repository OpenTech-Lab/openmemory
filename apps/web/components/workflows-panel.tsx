'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Background, BackgroundVariant, Controls, Handle, MarkerType, MiniMap, Position,
  ReactFlow, ReactFlowProvider, addEdge, useEdgesState, useNodesState,
  type Connection, type Edge, type Node, type NodeProps, type ReactFlowInstance,
} from '@xyflow/react';
import {
  Braces, Check, CirclePlay, Code2, GitBranch, GripVertical, ImageIcon, KeyRound,
  Pencil, Play, Plus, Save, Sparkles, Trash2, Workflow as WorkflowIcon, Zap,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';

type JsonObject = Record<string, unknown>;
type Point = { x: number; y: number };
type InputKind = 'text' | 'json' | 'image' | 'pdf' | 'file' | 'any';

interface InputFieldDraft {
  key: string;
  type: InputKind;
  required: boolean;
  description: string;
}

interface WorkflowStep {
  id: string;
  name?: string;
  kind?: 'http' | 'agent';
  method: string;
  url: string;
  auth_key?: string;
  secret_target?: 'header' | 'url';
  auth_header?: string;
  auth_prefix?: string;
  headers?: Record<string, string>;
  body?: unknown;
  capability?: 'image_generation' | 'skill' | 'command';
  instruction?: string;
  skill?: string;
  command?: string;
  working_directory?: string;
  required_inputs?: string[];
  required_files?: string[];
  expected_output?: string;
  position?: Point;
  next_step_id?: string;
}

interface Workflow {
  id: string;
  name: string;
  description: string | null;
  input_schema: JsonObject;
  steps: WorkflowStep[];
  enabled: boolean;
  updated_at: string;
}

interface StepDraft extends Omit<WorkflowStep, 'headers' | 'body' | 'position' | 'next_step_id'> {
  headersText: string;
  bodyText: string;
}

type StepNodeData = { step: StepDraft; order: number };
type StepNode = Node<StepNodeData, 'httpStep'>;

const METHOD_TONES: Record<string, string> = {
  GET: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  POST: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  PUT: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  PATCH: 'bg-orange-500/15 text-orange-700 dark:text-orange-300',
  DELETE: 'bg-rose-500/15 text-rose-700 dark:text-rose-300',
};

const blankStep = (index = 0): StepDraft => ({
  id: `step_${index + 1}`, name: '', kind: 'http', method: 'GET', url: '', auth_key: '',
  secret_target: 'header', auth_header: 'Authorization', auth_prefix: 'Bearer ',
  headersText: '{}', bodyText: '',
});

const blankAgentStep = (index: number, capability: 'image_generation' | 'skill' | 'command'): StepDraft => ({
  ...blankStep(index), kind: 'agent', capability,
  id: `${capability}_${index + 1}`, name: capability === 'image_generation' ? 'Generate image' : capability === 'skill' ? 'Run skill' : 'Run script',
  instruction: '', skill: capability === 'skill' ? 'img2threejs' : '', command: '',
  working_directory: '', required_inputs: [], required_files: [], expected_output: '',
});

function toDraft(step: WorkflowStep): StepDraft {
  return {
    id: step.id, name: step.name ?? '', kind: step.kind ?? 'http', method: step.method ?? 'GET', url: step.url ?? '',
    auth_key: step.auth_key ?? '', secret_target: step.secret_target ?? 'header',
    auth_header: step.auth_header ?? 'Authorization', auth_prefix: step.auth_prefix ?? 'Bearer ',
    headersText: JSON.stringify(step.headers ?? {}, null, 2),
    bodyText: step.body === undefined || step.body === null ? '' : JSON.stringify(step.body, null, 2),
    capability: step.capability, instruction: step.instruction ?? '', skill: step.skill ?? '',
    command: step.command ?? '', working_directory: step.working_directory ?? '',
    required_inputs: step.required_inputs ?? [], required_files: step.required_files ?? [], expected_output: step.expected_output ?? '',
  };
}

function parseObject(text: string, label: string): JsonObject {
  const value = JSON.parse(text || '{}');
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(`${label} must be a JSON object.`);
  return value;
}

function schemaToFields(schema: JsonObject): InputFieldDraft[] {
  return Object.entries(schema).map(([key, raw]) => {
    const definition = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as JsonObject : {};
    const rawType = typeof definition.type === 'string' ? definition.type : 'any';
    const type: InputKind = rawType === 'string' ? 'text' : ['text', 'json', 'image', 'pdf', 'file', 'any'].includes(rawType) ? rawType as InputKind : 'any';
    return { key, type, required: definition.required === true, description: typeof definition.description === 'string' ? definition.description : '' };
  });
}

function fieldsToSchema(fields: InputFieldDraft[]): JsonObject {
  const schema: JsonObject = {};
  for (const field of fields) {
    const key = field.key.trim();
    if (!key) throw new Error('Every input needs a key.');
    if (schema[key]) throw new Error(`Duplicate input key: ${key}`);
    if (!/^[A-Za-z0-9_-]+$/.test(key)) throw new Error(`Input key '${key}' may contain only letters, numbers, '-' and '_'.`);
    schema[key] = { type: field.type, required: field.required, description: field.description.trim() };
  }
  return schema;
}

function HttpStepNode({ data, selected }: NodeProps<StepNode>) {
  const { step, order } = data;
  const isAgent = step.kind === 'agent';
  const endpoint = isAgent ? step.capability?.replace('_', ' ') : step.secret_target === 'url' ? 'URL stored in Environment' : step.url || 'Add request URL';
  const AgentIcon = step.capability === 'image_generation' ? ImageIcon : step.capability === 'command' ? Code2 : Sparkles;
  return (
    <div className={`group w-[250px] overflow-hidden rounded-xl border bg-card text-card-foreground shadow-[0_12px_35px_-18px_rgba(0,0,0,.7)] transition-all ${selected ? 'border-primary ring-2 ring-primary/20' : 'border-border hover:border-foreground/25'}`}>
      <Handle type="target" position={Position.Left} className="!h-3 !w-3 !border-2 !border-background !bg-foreground" />
      <div className="flex items-center gap-2 border-b bg-muted/45 px-3 py-2">
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-foreground text-[10px] font-semibold text-background">{order}</span>
        <GripVertical className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold">{step.name || step.id}</span>
        {isAgent ? <AgentIcon className="h-3.5 w-3.5 text-violet-500" /> : step.auth_key && <KeyRound className="h-3.5 w-3.5 text-amber-500" />}
      </div>
      <div className="space-y-2 px-3 py-3">
        <div className="flex items-center gap-2">
          <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-bold ${isAgent ? 'bg-violet-500/15 text-violet-700 dark:text-violet-300' : METHOD_TONES[step.method]}`}>{isAgent ? 'AGENT' : step.method}</span>
          <span className="truncate font-mono text-[10px] text-muted-foreground">{endpoint}</span>
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          {isAgent ? <Sparkles className="h-3 w-3" /> : <Braces className="h-3 w-3" />}
          {isAgent ? (step.skill || step.command || 'Configure action') : step.bodyText ? 'JSON body configured' : 'No request body'}
        </div>
      </div>
      <Handle type="source" position={Position.Right} className="!h-3 !w-3 !border-2 !border-background !bg-primary" />
    </div>
  );
}

const nodeTypes = { httpStep: HttpStepNode };
const edgeDefaults = { type: 'smoothstep', animated: true, markerEnd: { type: MarkerType.ArrowClosed } };

function graphOrder(nodes: StepNode[], edges: Edge[]): StepNode[] {
  if (nodes.length === 0) throw new Error('Add at least one HTTP step.');
  if (nodes.length === 1) return nodes;
  if (edges.length !== nodes.length - 1) throw new Error('Connect every step into one execution chain before saving.');
  const incoming = new Map(nodes.map((node) => [node.id, 0]));
  const outgoing = new Map<string, string>();
  for (const edge of edges) {
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
    if (outgoing.has(edge.source)) throw new Error('A step can only connect to one next step.');
    outgoing.set(edge.source, edge.target);
  }
  const roots = nodes.filter((node) => incoming.get(node.id) === 0);
  if (roots.length !== 1) throw new Error('The workflow must have exactly one starting step.');
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const ordered: StepNode[] = [];
  const visited = new Set<string>();
  let current: StepNode | undefined = roots[0];
  while (current && !visited.has(current.id)) {
    ordered.push(current); visited.add(current.id);
    current = outgoing.get(current.id) ? byId.get(outgoing.get(current.id)!) : undefined;
  }
  if (ordered.length !== nodes.length) throw new Error('Connections contain a cycle or disconnected steps.');
  return ordered;
}

function wouldCreateCycle(edges: Edge[], source: string, target: string): boolean {
  const nextByNode = new Map(edges.map((edge) => [edge.source, edge.target]));
  let current: string | undefined = target;
  const visited = new Set<string>();
  while (current && !visited.has(current)) {
    if (current === source) return true;
    visited.add(current);
    current = nextByNode.get(current);
  }
  return false;
}

function WorkflowPanelInner() {
  const [items, setItems] = useState<Workflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<Workflow | null | undefined>(undefined);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [inputFields, setInputFields] = useState<InputFieldDraft[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [nodes, setNodes, onNodesChange] = useNodesState<StepNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [flow, setFlow] = useState<ReactFlowInstance<StepNode, Edge> | null>(null);
  const [running, setRunning] = useState<Workflow | null>(null);
  const [runInput, setRunInput] = useState('{}');
  const [runResult, setRunResult] = useState<unknown>(null);
  const [deleting, setDeleting] = useState<Workflow | null>(null);

  const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? null;
  const orderedIds = useMemo(() => {
    try { return graphOrder(nodes, edges).map((node) => node.id); } catch { return nodes.map((node) => node.id); }
  }, [nodes, edges]);

  useEffect(() => {
    setNodes((current) => current.map((node) => ({ ...node, data: { ...node.data, order: orderedIds.indexOf(node.id) + 1 } })));
  }, [orderedIds.join('|'), setNodes]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/workflows');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to load workflows');
      setItems(data.workflows ?? []);
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Failed to load workflows'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const makeNode = useCallback((step: StepDraft, position: Point): StepNode => ({
    id: `node_${crypto.randomUUID()}`, type: 'httpStep', position, data: { step, order: nodes.length + 1 },
  }), [nodes.length]);

  const openCreate = () => {
    const first = makeNode(blankStep(), { x: 100, y: 120 });
    setEditing(null); setName(''); setDescription(''); setInputFields([]); setEnabled(true);
    setNodes([first]); setEdges([]); setSelectedNodeId(first.id);
  };

  const openEdit = (workflow: Workflow) => {
    const loadedNodes: StepNode[] = workflow.steps.map((step, index) => ({
      id: `node_${crypto.randomUUID()}`, type: 'httpStep',
      position: step.position ?? { x: 80 + index * 290, y: 120 },
      data: { step: toDraft(step), order: index + 1 },
    }));
    const nodeByStepId = new Map(workflow.steps.map((step, index) => [step.id, loadedNodes[index].id]));
    const loadedEdges: Edge[] = workflow.steps.flatMap((step, index) => {
      const targetStepId = step.next_step_id ?? workflow.steps[index + 1]?.id;
      const target = targetStepId ? nodeByStepId.get(targetStepId) : undefined;
      return target ? [{ id: `edge_${loadedNodes[index].id}_${target}`, source: loadedNodes[index].id, target, ...edgeDefaults }] : [];
    });
    setEditing(workflow); setName(workflow.name); setDescription(workflow.description ?? '');
    setInputFields(schemaToFields(workflow.input_schema)); setEnabled(workflow.enabled);
    setNodes(loadedNodes); setEdges(loadedEdges); setSelectedNodeId(loadedNodes[0]?.id ?? null);
  };

  const addNode = useCallback((position?: Point, capability?: 'image_generation' | 'skill' | 'command') => {
    const draft = capability ? blankAgentStep(nodes.length, capability) : blankStep(nodes.length);
    const node = makeNode(draft, position ?? { x: 100 + nodes.length * 40, y: 100 + nodes.length * 40 });
    setNodes((current) => [...current, node]); setSelectedNodeId(node.id);
  }, [makeNode, nodes.length, setNodes]);

  const patchSelected = (patch: Partial<StepDraft>) => {
    if (!selectedNodeId) return;
    setNodes((current) => current.map((node) => node.id === selectedNodeId
      ? { ...node, data: { ...node.data, step: { ...node.data.step, ...patch } } } : node));
  };

  const patchInput = (index: number, patch: Partial<InputFieldDraft>) => {
    setInputFields((current) => current.map((field, fieldIndex) => fieldIndex === index ? { ...field, ...patch } : field));
  };

  const removeSelected = () => {
    if (!selectedNodeId || nodes.length === 1) return;
    setNodes((current) => current.filter((node) => node.id !== selectedNodeId));
    setEdges((current) => current.filter((edge) => edge.source !== selectedNodeId && edge.target !== selectedNodeId));
    setSelectedNodeId(null);
  };

  const onConnect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target || connection.source === connection.target) return;
    if (edges.some((edge) => edge.source === connection.source)) { toast.error('This step already has a next step.'); return; }
    if (edges.some((edge) => edge.target === connection.target)) { toast.error('This step already has a previous step.'); return; }
    if (wouldCreateCycle(edges, connection.source, connection.target)) { toast.error('That connection would create a cycle.'); return; }
    setEdges(addEdge({ ...connection, id: `edge_${connection.source}_${connection.target}`, ...edgeDefaults }, edges));
  }, [edges, setEdges]);

  const onDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    if (!flow) return;
    const nodeKind = event.dataTransfer.getData('application/openmemory-step');
    if (!['http', 'image_generation', 'skill', 'command'].includes(nodeKind)) return;
    addNode(flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }), nodeKind === 'http' ? undefined : nodeKind as 'image_generation' | 'skill' | 'command');
  }, [addNode, flow]);

  const save = async () => {
    setSaving(true);
    try {
      const ordered = graphOrder(nodes, edges);
      const stepIds = new Set<string>();
      const payloadSteps = ordered.map((node, index) => {
        const step = node.data.step;
        if (!step.id.trim()) throw new Error(`Step ${index + 1} needs an ID.`);
        if (stepIds.has(step.id.trim())) throw new Error(`Duplicate step ID: ${step.id.trim()}`);
        stepIds.add(step.id.trim());
        const common = {
          id: step.id.trim(), name: step.name?.trim() || undefined, method: step.method,
          kind: step.kind ?? 'http', url: step.url.trim(), position: node.position,
          next_step_id: ordered[index + 1]?.data.step.id.trim(),
        };
        if (step.kind === 'agent') return {
          ...common, capability: step.capability, instruction: step.instruction?.trim(),
          skill: step.skill?.trim() || undefined, command: step.command?.trim() || undefined,
          working_directory: step.working_directory?.trim() || undefined,
          required_inputs: step.required_inputs ?? [], required_files: step.required_files ?? [],
          expected_output: step.expected_output?.trim() || undefined,
        };
        const headers = parseObject(step.headersText, `Step ${step.id} headers`) as Record<string, string>;
        const body = step.bodyText.trim() ? JSON.parse(step.bodyText) : undefined;
        return {
          ...common, auth_key: step.auth_key?.trim() || undefined,
          secret_target: step.secret_target, auth_header: step.auth_header?.trim() || undefined,
          auth_prefix: step.auth_prefix ?? undefined, headers, body,
        };
      });
      const payload = { name, description: description || null, input_schema: fieldsToSchema(inputFields), steps: payloadSteps, enabled };
      const response = await fetch(editing ? `/api/workflows/${editing.id}` : '/api/workflows', {
        method: editing ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to save workflow');
      toast.success(editing ? 'Workflow updated' : 'Workflow created'); setEditing(undefined); await load();
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Invalid workflow'); }
    finally { setSaving(false); }
  };

  const run = async () => {
    if (!running) return;
    setSaving(true); setRunResult(null);
    try {
      const response = await fetch(`/api/workflows/${running.id}/run`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: parseObject(runInput, 'Run input') }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Workflow failed');
      setRunResult(data);
      if (data.status === 'action_required') toast.info('Workflow paused for an agent action');
      else if (data.success) toast.success('Workflow completed');
      else toast.error('Workflow stopped on a failed step');
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Workflow failed'); }
    finally { setSaving(false); }
  };

  const remove = async () => {
    if (!deleting) return;
    try {
      const response = await fetch(`/api/workflows/${deleting.id}`, { method: 'DELETE' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to delete workflow');
      toast.success('Workflow deleted'); setDeleting(null); await load();
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Failed to delete workflow'); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div><p className="max-w-2xl text-sm text-muted-foreground">Build repeatable processes from HTTP calls and Codex-hosted agent actions. Runs pause safely while the agent generates media, invokes a skill, or executes an inspected command.</p><p className="mt-1 text-xs text-muted-foreground">Templates: <code>{'{{input.issue_id}}'}</code> or <code>{'{{steps.lookup.body.id}}'}</code>.</p></div>
        <Button size="sm" onClick={openCreate}><Plus className="mr-1.5 h-4 w-4" />New workflow</Button>
      </div>

      <div className="rounded-md border"><Table><TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Steps</TableHead><TableHead>Status</TableHead><TableHead>Updated</TableHead><TableHead className="text-right">Actions</TableHead></TableRow></TableHeader><TableBody>
        {loading ? <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground">Loading…</TableCell></TableRow> : items.length === 0 ? <TableRow><TableCell colSpan={5} className="h-28 text-center text-muted-foreground"><WorkflowIcon className="mx-auto mb-2 h-5 w-5" />No workflows configured.</TableCell></TableRow> : items.map((workflow) => <TableRow key={workflow.id}>
          <TableCell><div className="font-mono font-medium">{workflow.name}</div><div className="max-w-md truncate text-xs text-muted-foreground">{workflow.description}</div></TableCell><TableCell>{workflow.steps.length}</TableCell><TableCell><Badge variant={workflow.enabled ? 'default' : 'secondary'}>{workflow.enabled ? 'Enabled' : 'Disabled'}</Badge></TableCell><TableCell className="text-xs text-muted-foreground">{new Date(workflow.updated_at).toLocaleString()}</TableCell>
          <TableCell><div className="flex justify-end gap-1"><Button variant="ghost" size="icon" disabled={!workflow.enabled} onClick={() => { setRunning(workflow); setRunInput('{}'); setRunResult(null); }}><Play className="h-4 w-4" /></Button><Button variant="ghost" size="icon" onClick={() => openEdit(workflow)}><Pencil className="h-4 w-4" /></Button><Button variant="ghost" size="icon" onClick={() => setDeleting(workflow)}><Trash2 className="h-4 w-4" /></Button></div></TableCell>
        </TableRow>)}</TableBody></Table></div>

      <Dialog open={editing !== undefined} onOpenChange={(open) => { if (!open) setEditing(undefined); }}>
        <DialogContent className="flex h-[92vh] w-[96vw] max-w-[1500px] flex-col gap-0 overflow-hidden p-0 sm:max-w-[1500px]">
          <div className="border-b bg-card px-5 py-4"><DialogHeader><div className="flex items-center gap-3"><div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground"><Zap className="h-4 w-4" /></div><div><DialogTitle>{editing ? `Edit ${editing.name}` : 'Build a workflow'}</DialogTitle><DialogDescription>Connect nodes from left to right to define execution order.</DialogDescription></div></div></DialogHeader></div>
          <div className="grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)_360px] overflow-hidden">
            <aside className="space-y-5 overflow-y-auto border-r bg-muted/20 p-4">
              <div className="space-y-3"><div className="flex items-center justify-between"><Label>Workflow</Label><div className="flex items-center gap-2"><Checkbox id="workflow-enabled" checked={enabled} onCheckedChange={(value) => setEnabled(value === true)} /><Label htmlFor="workflow-enabled" className="text-xs">Enabled</Label></div></div><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="publish_release" /><Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="When agents should use this" /></div>
              <div className="space-y-2"><div className="flex items-center justify-between"><Label>Workflow inputs</Label><Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setInputFields((current) => [...current, { key: '', type: 'text', required: false, description: '' }])}><Plus className="mr-1 h-3 w-3" />Input</Button></div>
                {inputFields.length === 0 ? <div className="rounded-lg border border-dashed p-3 text-[11px] text-muted-foreground">No inputs. Add text, JSON, image, PDF, generic file, or unrestricted data.</div> : inputFields.map((field, index) => <div key={index} className="space-y-2 rounded-lg border bg-card p-2.5 shadow-sm">
                  <div className="flex gap-1.5"><Input className="h-8 font-mono text-xs" value={field.key} onChange={(event) => patchInput(index, { key: event.target.value })} placeholder="input_name" /><Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => setInputFields((current) => current.filter((_, fieldIndex) => fieldIndex !== index))}><Trash2 className="h-3.5 w-3.5" /></Button></div>
                  <Select value={field.type} onValueChange={(type: InputKind) => patchInput(index, { type })}><SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="text">Text</SelectItem><SelectItem value="json">JSON</SelectItem><SelectItem value="image">Image file</SelectItem><SelectItem value="pdf">PDF file</SelectItem><SelectItem value="file">Any file</SelectItem><SelectItem value="any">Any value</SelectItem></SelectContent></Select>
                  <Input className="h-8 text-xs" value={field.description} onChange={(event) => patchInput(index, { description: event.target.value })} placeholder="What should the agent provide?" />
                  <label className="flex items-center gap-2 text-[11px] text-muted-foreground"><Checkbox checked={field.required} onCheckedChange={(value) => patchInput(index, { required: value === true })} />Required</label>
                </div>)}
              </div>
              <div className="space-y-2"><Label>Node library</Label>{[
                ['http', 'HTTP request', 'Server-side API call', CirclePlay, 'bg-sky-500/15 text-sky-600'],
                ['image_generation', 'Generate image', 'Codex image tool', ImageIcon, 'bg-fuchsia-500/15 text-fuchsia-600'],
                ['skill', 'Run skill', 'Codex skill action', Sparkles, 'bg-violet-500/15 text-violet-600'],
                ['command', 'Run script', 'Agent-inspected command', Code2, 'bg-amber-500/15 text-amber-600'],
              ].map(([kind, label, hint, Icon, tone]) => <button key={kind as string} draggable onDragStart={(event) => { event.dataTransfer.setData('application/openmemory-step', kind as string); event.dataTransfer.effectAllowed = 'move'; }} onClick={() => addNode(undefined, kind === 'http' ? undefined : kind as 'image_generation' | 'skill' | 'command')} className="flex w-full cursor-grab items-center gap-3 rounded-lg border bg-card p-3 text-left shadow-sm transition hover:border-primary/50 hover:shadow-md active:cursor-grabbing"><span className={`flex h-9 w-9 items-center justify-center rounded-md ${tone}`}><Icon className="h-4 w-4" /></span><span><span className="block text-sm font-medium">{label as string}</span><span className="text-[11px] text-muted-foreground">{hint as string}</span></span></button>)}</div>
              <div className="rounded-lg border border-dashed p-3 text-[11px] leading-relaxed text-muted-foreground"><GitBranch className="mb-2 h-4 w-4" />The runtime currently supports a single chain. Each node can have one previous and one next connection.</div>
            </aside>

            <main className="relative h-full min-h-0 min-w-0 bg-[radial-gradient(circle_at_center,var(--color-muted)_1px,transparent_1px)] bg-[size:20px_20px]" onDrop={onDrop} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }}>
              <ReactFlow<StepNode, Edge> nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} onInit={setFlow} onNodeClick={(_, node) => setSelectedNodeId(node.id)} onPaneClick={() => setSelectedNodeId(null)} onNodesDelete={(deleted) => { if (deleted.some((node) => node.id === selectedNodeId)) setSelectedNodeId(null); }} fitView minZoom={0.35} maxZoom={1.8} defaultEdgeOptions={edgeDefaults} deleteKeyCode={nodes.length > 1 ? ['Backspace', 'Delete'] : null}>
                <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--border)" /><MiniMap pannable zoomable className="!border !bg-card" nodeColor="var(--foreground)" maskColor="color-mix(in oklab, var(--background) 72%, transparent)" /><Controls showInteractive={false} className="!overflow-hidden !rounded-lg !border !shadow-sm" />
              </ReactFlow>
              <div className="pointer-events-none absolute left-4 top-4 rounded-full border bg-background/85 px-3 py-1.5 text-[11px] text-muted-foreground shadow-sm backdrop-blur"><Check className="mr-1 inline h-3 w-3" />Drag nodes · connect handles · click to edit</div>
            </main>

            <aside className="overflow-y-auto border-l bg-card p-4">
              {selectedNode ? <div className="space-y-4"><div className="flex items-center justify-between"><div><p className="text-sm font-semibold">{selectedNode.data.step.kind === 'agent' ? 'Agent action' : 'HTTP step'}</p><p className="text-[11px] text-muted-foreground">Execution #{selectedNode.data.order}</p></div><Button variant="ghost" size="icon" disabled={nodes.length === 1} onClick={removeSelected}><Trash2 className="h-4 w-4" /></Button></div>
                <div className="grid grid-cols-2 gap-2"><div className="space-y-1"><Label htmlFor="workflow-step-id" className="text-xs">Step ID</Label><Input id="workflow-step-id" value={selectedNode.data.step.id} onChange={(e) => patchSelected({ id: e.target.value })} /></div><div className="space-y-1"><Label htmlFor="workflow-step-label" className="text-xs">Label</Label><Input id="workflow-step-label" value={selectedNode.data.step.name ?? ''} onChange={(e) => patchSelected({ name: e.target.value })} placeholder="Optional" /></div></div>
                {selectedNode.data.step.kind === 'agent' ? <>
                  <div className="space-y-1"><Label className="text-xs">Capability</Label><Select value={selectedNode.data.step.capability ?? 'skill'} onValueChange={(capability: 'image_generation' | 'skill' | 'command') => patchSelected({ capability })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="image_generation">Image generation</SelectItem><SelectItem value="skill">Codex skill</SelectItem><SelectItem value="command">Script / command</SelectItem></SelectContent></Select></div>
                  {selectedNode.data.step.capability === 'skill' && <div className="space-y-1"><Label className="text-xs">Skill name</Label><Input value={selectedNode.data.step.skill ?? ''} onChange={(e) => patchSelected({ skill: e.target.value })} placeholder="img2threejs" /></div>}
                  {selectedNode.data.step.capability === 'command' && <><div className="space-y-1"><Label className="text-xs">Working directory</Label><Input value={selectedNode.data.step.working_directory ?? ''} onChange={(e) => patchSelected({ working_directory: e.target.value })} placeholder="/absolute/project/path" /></div><div className="space-y-1"><Label className="text-xs">Command</Label><Textarea className="font-mono text-[11px]" rows={4} value={selectedNode.data.step.command ?? ''} onChange={(e) => patchSelected({ command: e.target.value })} placeholder="node export-glb.mjs" /></div></>}
                  <div className="space-y-1"><Label className="text-xs">Instruction</Label><Textarea rows={9} value={selectedNode.data.step.instruction ?? ''} onChange={(e) => patchSelected({ instruction: e.target.value })} placeholder="Tell the agent exactly what to do…" /></div>
                  <div className="space-y-1"><Label className="text-xs">Required workflow inputs</Label><Input value={(selectedNode.data.step.required_inputs ?? []).join(', ')} onChange={(e) => patchSelected({ required_inputs: e.target.value.split(',').map((item) => item.trim()).filter(Boolean) })} placeholder="user_image_path" /></div>
                  <div className="space-y-1"><Label className="text-xs">Required files</Label><Input value={(selectedNode.data.step.required_files ?? []).join(', ')} onChange={(e) => patchSelected({ required_files: e.target.value.split(',').map((item) => item.trim()).filter(Boolean) })} placeholder={'{{input.user_image_path}}'} /></div>
                  <div className="space-y-1"><Label className="text-xs">Expected result</Label><Textarea rows={3} value={selectedNode.data.step.expected_output ?? ''} onChange={(e) => patchSelected({ expected_output: e.target.value })} placeholder={'Return {"image_path":"/absolute/path"}'} /></div>
                </> : <>
                <div className="space-y-1"><Label className="text-xs">Request</Label><div className="flex gap-2"><Select value={selectedNode.data.step.method} onValueChange={(method) => patchSelected({ method })}><SelectTrigger className="w-28"><SelectValue /></SelectTrigger><SelectContent>{['GET','POST','PUT','PATCH','DELETE'].map((method) => <SelectItem key={method} value={method}>{method}</SelectItem>)}</SelectContent></Select><Input value={selectedNode.data.step.url} disabled={selectedNode.data.step.secret_target === 'url'} onChange={(e) => patchSelected({ url: e.target.value })} placeholder="https://api.example.com" /></div></div>
                <div className="space-y-1"><Label className="text-xs">Environment credential</Label><Input value={selectedNode.data.step.auth_key ?? ''} onChange={(e) => patchSelected({ auth_key: e.target.value })} placeholder="SERVICE_API_TOKEN" /></div>
                <div className="space-y-1"><Label className="text-xs">Credential target</Label><Select value={selectedNode.data.step.secret_target ?? 'header'} onValueChange={(value: 'header' | 'url') => patchSelected({ secret_target: value })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="header">Request header</SelectItem><SelectItem value="url">Secret is full URL</SelectItem></SelectContent></Select></div>
                {selectedNode.data.step.secret_target !== 'url' && <div className="grid grid-cols-2 gap-2"><div className="space-y-1"><Label className="text-xs">Auth header</Label><Input value={selectedNode.data.step.auth_header ?? ''} onChange={(e) => patchSelected({ auth_header: e.target.value })} /></div><div className="space-y-1"><Label className="text-xs">Prefix</Label><Input value={selectedNode.data.step.auth_prefix ?? ''} onChange={(e) => patchSelected({ auth_prefix: e.target.value })} /></div></div>}
                <div className="space-y-1"><Label className="text-xs">Headers JSON</Label><Textarea className="font-mono text-[11px]" rows={5} value={selectedNode.data.step.headersText} onChange={(e) => patchSelected({ headersText: e.target.value })} /></div>
                <div className="space-y-1"><Label className="text-xs">Body JSON</Label><Textarea className="font-mono text-[11px]" rows={7} value={selectedNode.data.step.bodyText} onChange={(e) => patchSelected({ bodyText: e.target.value })} placeholder={'{"id":"{{input.id}}"}'} /></div>
                </>}
              </div> : <div className="flex h-full min-h-80 flex-col items-center justify-center text-center text-muted-foreground"><WorkflowIcon className="mb-3 h-8 w-8 opacity-30" /><p className="text-sm font-medium text-foreground">Select a node</p><p className="mt-1 max-w-48 text-xs">Click any step on the canvas to edit its request.</p></div>}
            </aside>
          </div>
          <DialogFooter className="border-t bg-card px-5 py-3"><div className="mr-auto text-xs text-muted-foreground">{nodes.length} node{nodes.length === 1 ? '' : 's'} · {edges.length} connection{edges.length === 1 ? '' : 's'}</div><Button variant="outline" onClick={() => setEditing(undefined)}>Cancel</Button><Button disabled={saving} onClick={save}><Save className="mr-1.5 h-4 w-4" />{saving ? 'Saving…' : 'Save workflow'}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={running !== null} onOpenChange={(open) => { if (!open) setRunning(null); }}><DialogContent className="sm:max-w-2xl"><DialogHeader><DialogTitle>Run {running?.name}</DialogTitle><DialogDescription>HTTP nodes execute here. Agent nodes return the next action for an MCP-connected Codex host.</DialogDescription></DialogHeader><div className="grid gap-2"><Label>Input JSON</Label><Textarea className="font-mono text-xs" rows={5} value={runInput} onChange={(e) => setRunInput(e.target.value)} />{runResult !== null && <pre className="max-h-72 overflow-auto rounded-md bg-muted p-3 text-xs">{JSON.stringify(runResult, null, 2)}</pre>}</div><DialogFooter><Button variant="outline" onClick={() => setRunning(null)}>Close</Button><Button disabled={saving} onClick={run}><Play className="mr-1.5 h-4 w-4" />{saving ? 'Running…' : 'Run'}</Button></DialogFooter></DialogContent></Dialog>
      <Dialog open={deleting !== null} onOpenChange={(open) => { if (!open) setDeleting(null); }}><DialogContent><DialogHeader><DialogTitle>Delete workflow?</DialogTitle><DialogDescription>Agents will no longer be able to run <span className="font-mono">{deleting?.name}</span>.</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setDeleting(null)}>Cancel</Button><Button variant="destructive" onClick={remove}>Delete</Button></DialogFooter></DialogContent></Dialog>
    </div>
  );
}

export function WorkflowsPanel() {
  return <ReactFlowProvider><WorkflowPanelInner /></ReactFlowProvider>;
}
