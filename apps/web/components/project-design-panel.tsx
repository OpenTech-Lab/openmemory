'use client';

// Note: this component must be imported with next/dynamic + ssr:false — it renders
// <MermaidDiagram>, which touches `document` at import time.

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
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
import { Plus, RefreshCw, Pencil, Trash2, Palette, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { MermaidDiagram } from '@/components/mermaid-diagram';
import { DesignCanvas } from '@/components/design-canvas';
import {
  DESIGN_KINDS,
  DESIGN_KIND_GROUPS,
  designKindMeta,
  STARTER_TEMPLATES,
  type DesignKind,
} from '@/lib/design-meta';
import {
  DESIGN_DIAGRAM_TYPES,
  blankDesignGraph,
  parseAiGraph,
  parseDesignGraph,
  serializeDesignGraph,
  type DesignDiagramType,
  type DesignGraph,
} from '@/lib/design-graph';
import { applyDagreLayout } from '@/lib/design-layout';

interface Design {
  id: string;
  project_id: string;
  title: string;
  kind: string;
  diagram_type: string;
  source: string;
  notes: string | null;
  tags: string[];
  sort_order: number;
  status: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface ProjectDesignPanelProps {
  projectId: string;
  projectPath: string | null;
}

const EMPTY_EDIT_FORM = {
  title: '',
  kind: DESIGN_KINDS[0] as string,
  source: '',
  notes: '',
  diagramType: 'reactflow' as DesignDiagramType,
};

const DIAGRAM_TYPE_LABELS: Record<DesignDiagramType, string> = {
  mermaid: 'Mermaid text',
  reactflow: 'React Flow canvas',
};

// True when `graph` is still exactly the auto-generated starter for `kind` — mirrors the
// mermaid-side "sourceIsUntouched" check so switching kind on a fresh reactflow doc doesn't
// clobber a graph the user has actually started editing. Compares through serializeDesignGraph
// (ignoring viewport) rather than raw JSON.stringify — React Flow enriches each node with a
// `measured` size the moment it's first rendered, before any real user edit, so a naive
// deep-equal check never matches and the reset silently never fires.
function graphIsUntouched(graph: DesignGraph, kind: string): boolean {
  const blank = blankDesignGraph(kind);
  return serializeDesignGraph(graph.nodes, graph.edges) === serializeDesignGraph(blank.nodes, blank.edges);
}

// Short title derived from an AI generation prompt when the user hasn't typed one yet — first
// several words, capped so it doesn't run on.
function deriveTitleFromPrompt(prompt: string): string {
  const words = prompt.trim().split(/\s+/).slice(0, 8).join(' ');
  return words.length > 60 ? `${words.slice(0, 60).trim()}…` : words;
}

export function ProjectDesignPanel({ projectId, projectPath }: ProjectDesignPanelProps) {
  const [designs, setDesigns] = useState<Design[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Create/edit dialog
  const [editDesign, setEditDesign] = useState<Design | null>(null); // null while creating
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [editForm, setEditForm] = useState(EMPTY_EDIT_FORM);
  const [isSaving, setIsSaving] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');
  const [isGeneratingDiagram, setIsGeneratingDiagram] = useState(false);
  // Current reactflow graph in the edit/create dialog — tracked separately from editForm.source
  // because DesignCanvas is uncontrolled and reports state upward via onChange; only serialized
  // into editForm.source's shape (via serializeDesignGraph) at save time.
  const [graphState, setGraphState] = useState<DesignGraph>({ nodes: [], edges: [] });
  // Bumped whenever the dialog needs DesignCanvas to remount with a fresh initialGraph (new
  // design opened, different design opened, kind/format reset) — the canvas only reads its
  // initialGraph prop once, on mount.
  const [canvasKey, setCanvasKey] = useState(0);

  // Delete dialog
  const [deleteDesign, setDeleteDesign] = useState<Design | null>(null);

  const fetchDesigns = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/designs?status=active&limit=200`);
      const data = await res.json();
      if (data.error) {
        toast.error(data.error);
        return;
      }
      const list: Design[] = data.designs ?? [];
      setDesigns(list);
      setSelectedId((prev) => (prev && list.some((d) => d.id === prev) ? prev : list[0]?.id ?? null));
    } catch {
      toast.error('Failed to load designs');
    } finally {
      setIsLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    fetchDesigns();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const selectedDesign = useMemo(
    () => designs.find((d) => d.id === selectedId) ?? null,
    [designs, selectedId]
  );

  const openCreate = () => {
    setEditDesign(null);
    const kind = EMPTY_EDIT_FORM.kind;
    setEditForm({ ...EMPTY_EDIT_FORM, source: STARTER_TEMPLATES[kind as DesignKind] });
    setGraphState(blankDesignGraph(kind));
    setCanvasKey((k) => k + 1);
    setAiPrompt('');
    setIsEditOpen(true);
  };

  const openEdit = (design: Design) => {
    setEditDesign(design);
    const diagramType = (design.diagram_type === 'reactflow' ? 'reactflow' : 'mermaid') as DesignDiagramType;
    setEditForm({
      title: design.title,
      kind: design.kind,
      source: design.source,
      notes: design.notes ?? '',
      diagramType,
    });
    if (diagramType === 'reactflow') setGraphState(parseDesignGraph(design.source));
    setCanvasKey((k) => k + 1);
    setAiPrompt('');
    setIsEditOpen(true);
  };

  const handleGenerateDiagram = async () => {
    const prompt = aiPrompt.trim();
    if (!prompt) return;
    setIsGeneratingDiagram(true);
    try {
      const res = await fetch('/api/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'ai.design_diagram',
          prompt,
          kind: editForm.kind,
          ...(editForm.diagramType === 'reactflow' ? { format: 'reactflow' } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        toast.error(data.error ?? 'Failed to generate diagram');
        return;
      }
      if (editForm.diagramType === 'reactflow') {
        // The AI response is a different, position-less shape than the persisted canvas format
        // (parseAiGraph, not parseDesignGraph) — dagre lays the graph out before it reaches the
        // canvas, since the LLM never emits positions at all.
        const parsed = parseAiGraph(data.source ?? '');
        const laidOut = applyDagreLayout(parsed.nodes, parsed.edges);
        setGraphState({ nodes: laidOut, edges: parsed.edges });
        setCanvasKey((k) => k + 1);
      }
      setEditForm((f) => ({
        ...f,
        source: editForm.diagramType === 'reactflow' ? f.source : (data.source ?? f.source),
        // Only derive a title from the prompt when one hasn't already been typed — never
        // overwrite a title the user set themselves.
        title: f.title.trim() ? f.title : deriveTitleFromPrompt(prompt),
      }));
    } catch {
      toast.error('Failed to generate diagram');
    } finally {
      setIsGeneratingDiagram(false);
    }
  };

  // Auto-fill the starter template/graph when the kind changes on a NEW doc whose source is
  // still untouched (empty, or exactly a previous starter) — never clobber real edits.
  const handleKindChange = (kind: string) => {
    const isNewDoc = editDesign === null;
    setEditForm((prev) => {
      const sourceIsUntouched =
        prev.source.trim() === '' || Object.values(STARTER_TEMPLATES).includes(prev.source);
      if (isNewDoc && prev.diagramType === 'mermaid' && sourceIsUntouched) {
        return { ...prev, kind, source: STARTER_TEMPLATES[kind as DesignKind] ?? prev.source };
      }
      return { ...prev, kind };
    });
    if (isNewDoc && editForm.diagramType === 'reactflow' && graphIsUntouched(graphState, editForm.kind)) {
      setGraphState(blankDesignGraph(kind));
      setCanvasKey((k) => k + 1);
    }
  };

  // New-doc-only format toggle (Mermaid text / React Flow canvas) — a design's format is fixed
  // at creation in v1, so this only applies while editDesign is null.
  const handleFormatChange = (diagramType: DesignDiagramType) => {
    setEditForm((prev) => ({
      ...prev,
      diagramType,
      source: diagramType === 'mermaid' ? (STARTER_TEMPLATES[prev.kind as DesignKind] ?? '') : '',
    }));
    if (diagramType === 'reactflow') {
      setGraphState(blankDesignGraph(editForm.kind));
      setCanvasKey((k) => k + 1);
    }
  };

  const handleSave = async () => {
    const title = editForm.title.trim();
    if (!title) {
      toast.error('Title is required');
      return;
    }
    setIsSaving(true);
    try {
      const url = editDesign
        ? `/api/projects/${projectId}/designs/${editDesign.id}`
        : `/api/projects/${projectId}/designs`;
      const source = editForm.diagramType === 'reactflow'
        ? serializeDesignGraph(graphState.nodes, graphState.edges, graphState.viewport)
        : editForm.source;
      const res = await fetch(url, {
        method: editDesign ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          kind: editForm.kind,
          diagram_type: editForm.diagramType,
          source,
          notes: editForm.notes.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        toast.error(data.error ?? 'Failed to save design');
        return;
      }
      toast.success(editDesign ? `"${title}" updated` : `"${title}" created`);
      setIsEditOpen(false);
      setSelectedId(data.id);
      fetchDesigns();
    } catch {
      toast.error('Failed to save design');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteDesign) return;
    try {
      const res = await fetch(`/api/projects/${projectId}/designs/${deleteDesign.id}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        toast.error(data.error ?? 'Failed to delete design');
        return;
      }
      toast.success(`"${deleteDesign.title}" deleted`);
      setDeleteDesign(null);
      fetchDesigns();
    } catch {
      toast.error('Failed to delete design');
    }
  };

  return (
    <div className="flex flex-col gap-6 h-full">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-base font-semibold">Design ({designs.length})</h2>
          <p className="text-sm text-muted-foreground">
            Mermaid diagrams or interactive React Flow canvases for this project&apos;s UI, structure, workflows, or story.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={fetchDesigns} disabled={isLoading}>
            <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button size="sm" onClick={openCreate}>
            <Plus className="h-4 w-4 mr-2" />
            New Diagram
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[280px_1fr] gap-4 min-h-[400px] items-start">
        {/* Left: list */}
        <div className="border rounded-md overflow-hidden">
          {isLoading && designs.length === 0 ? (
            <div className="flex items-center justify-center h-[200px]">
              <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : designs.length === 0 ? (
            <div className="text-center py-10 px-4 text-muted-foreground">
              <Palette className="h-8 w-8 mx-auto mb-2 opacity-30" />
              <p className="text-sm">No diagrams yet.</p>
            </div>
          ) : (
            <ul className="divide-y">
              {designs.map((d) => {
                const meta = designKindMeta(d.kind);
                const Icon = meta.icon;
                return (
                  <li key={d.id}>
                    <button
                      className={`w-full text-left px-3 py-2.5 flex items-center gap-2 hover:bg-muted/50 transition-colors ${
                        selectedId === d.id ? 'bg-muted' : ''
                      }`}
                      onClick={() => setSelectedId(d.id)}
                    >
                      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="text-sm truncate flex-1">{d.title}</span>
                    </button>
                    <div className="px-3 pb-2">
                      <Badge variant="outline" className={`text-xs ${meta.color}`}>
                        {meta.label}
                      </Badge>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Right: preview */}
        {/* h-[70vh] (not max-h) is load-bearing: a flex column with only max-height caps its
            own growth but never becomes a "definite size" for CSS flex-basis resolution, so
            the flex-1/min-h-0 chain down to the scroll container below silently fails to get
            a bounded height and the diagram just overflows uncapped. An explicit height fixes
            this; selectedDesign ? '' handles the empty-state case where a fixed tall box
            would look odd with no diagram to fill it. */}
        <div className={`border rounded-md p-4 flex flex-col gap-3 overflow-hidden ${selectedDesign ? 'h-[70vh]' : 'min-h-[300px]'}`}>
          {selectedDesign ? (
            <>
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div>
                  <h3 className="text-sm font-semibold">{selectedDesign.title}</h3>
                  <Badge variant="outline" className={`text-xs mt-1 ${designKindMeta(selectedDesign.kind).color}`}>
                    {designKindMeta(selectedDesign.kind).label}
                  </Badge>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => openEdit(selectedDesign)}>
                    <Pencil className="h-4 w-4 mr-2" />
                    Edit
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setDeleteDesign(selectedDesign)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              {selectedDesign.notes && (
                <p className="text-sm text-muted-foreground whitespace-pre-wrap">{selectedDesign.notes}</p>
              )}
              <div className="border rounded-md p-3 bg-muted/20 flex-1 min-h-0 overflow-hidden">
                {selectedDesign.diagram_type === 'reactflow' ? (
                  <DesignCanvas
                    key={selectedDesign.id}
                    initialGraph={parseDesignGraph(selectedDesign.source)}
                    readOnly
                  />
                ) : (
                  <MermaidDiagram source={selectedDesign.source} />
                )}
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
              Select or create a diagram.
            </div>
          )}
        </div>
      </div>

      {/* Create/Edit dialog — the reactflow format needs far more width for the canvas than the
          mermaid textarea+preview grid ever did, so the dialog itself widens for that case. */}
      <Dialog open={isEditOpen} onOpenChange={setIsEditOpen}>
        <DialogContent
          className={
            editForm.diagramType === 'reactflow'
              ? 'flex h-[92vh] w-[96vw] max-w-[1500px] flex-col gap-0 overflow-hidden p-0 sm:max-w-[1500px]'
              : 'max-w-3xl max-h-[85vh] overflow-y-auto'
          }
        >
          {editForm.diagramType === 'reactflow' ? (
            <>
              <div className="border-b bg-card px-5 py-4">
                <DialogHeader>
                  <DialogTitle>{editDesign ? `Edit ${editDesign.title}` : 'New diagram'}</DialogTitle>
                  <DialogDescription>Drag AWS icons onto the canvas, connect handles, click a node to edit it.</DialogDescription>
                </DialogHeader>
              </div>
              <div className="grid shrink-0 grid-cols-1 gap-3 border-b bg-muted/20 p-4 md:grid-cols-[1fr_220px_1fr_1fr]">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="design-title">Title</Label>
                  <Input
                    id="design-title"
                    value={editForm.title}
                    onChange={(e) => setEditForm((f) => ({ ...f, title: e.target.value }))}
                    placeholder="e.g. Serverless API"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Kind</Label>
                  <Select value={editForm.kind} onValueChange={handleKindChange}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Software</div>
                      {DESIGN_KIND_GROUPS.software.map((k) => (
                        <SelectItem key={k} value={k}>
                          {designKindMeta(k).label}
                        </SelectItem>
                      ))}
                      <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Narrative</div>
                      {DESIGN_KIND_GROUPS.narrative.map((k) => (
                        <SelectItem key={k} value={k}>
                          {designKindMeta(k).label}
                        </SelectItem>
                      ))}
                      <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Infrastructure</div>
                      {DESIGN_KIND_GROUPS.infrastructure.map((k) => (
                        <SelectItem key={k} value={k}>
                          {designKindMeta(k).label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="design-ai-prompt">AI prompt</Label>
                  <div className="flex gap-2">
                    <Input
                      id="design-ai-prompt"
                      value={aiPrompt}
                      onChange={(e) => setAiPrompt(e.target.value)}
                      placeholder="a serverless API with S3 and RDS"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="gap-1 shrink-0"
                      onClick={handleGenerateDiagram}
                      disabled={!aiPrompt.trim() || isGeneratingDiagram}
                    >
                      <Sparkles className="h-3.5 w-3.5" />
                      {isGeneratingDiagram ? 'Generating...' : 'Generate'}
                    </Button>
                  </div>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="design-notes">Notes</Label>
                  <Input
                    id="design-notes"
                    value={editForm.notes}
                    onChange={(e) => setEditForm((f) => ({ ...f, notes: e.target.value }))}
                  />
                </div>
                {!editDesign && (
                  <div className="flex flex-col gap-1.5 md:col-span-4">
                    <Label>Format</Label>
                    <Select value={editForm.diagramType} onValueChange={(value) => handleFormatChange(value as DesignDiagramType)}>
                      <SelectTrigger className="w-56">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {DESIGN_DIAGRAM_TYPES.map((type) => (
                          <SelectItem key={type} value={type}>
                            {DIAGRAM_TYPE_LABELS[type]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>
              <div className="min-h-0 flex-1 overflow-hidden p-4">
                <DesignCanvas key={canvasKey} initialGraph={graphState} onChange={setGraphState} />
              </div>
              <DialogFooter className="border-t bg-card px-5 py-3">
                <Button variant="outline" onClick={() => setIsEditOpen(false)}>
                  Cancel
                </Button>
                <Button onClick={handleSave} disabled={isSaving}>
                  {isSaving ? 'Saving…' : editDesign ? 'Save changes' : 'Create'}
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>{editDesign ? 'Edit diagram' : 'New diagram'}</DialogTitle>
                <DialogDescription>
                  Mermaid source is rendered live below as you type.
                </DialogDescription>
              </DialogHeader>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="flex flex-col gap-3">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="design-title">Title</Label>
                    <Input
                      id="design-title"
                      value={editForm.title}
                      onChange={(e) => setEditForm((f) => ({ ...f, title: e.target.value }))}
                      placeholder="e.g. Auth flow"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>Kind</Label>
                    <Select value={editForm.kind} onValueChange={handleKindChange}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Software</div>
                        {DESIGN_KIND_GROUPS.software.map((k) => (
                          <SelectItem key={k} value={k}>
                            {designKindMeta(k).label}
                          </SelectItem>
                        ))}
                        <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Narrative</div>
                        {DESIGN_KIND_GROUPS.narrative.map((k) => (
                          <SelectItem key={k} value={k}>
                            {designKindMeta(k).label}
                          </SelectItem>
                        ))}
                        <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Infrastructure</div>
                        {DESIGN_KIND_GROUPS.infrastructure.map((k) => (
                          <SelectItem key={k} value={k}>
                            {designKindMeta(k).label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {!editDesign && (
                    <div className="flex flex-col gap-1.5">
                      <Label>Format</Label>
                      <Select value={editForm.diagramType} onValueChange={(value) => handleFormatChange(value as DesignDiagramType)}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {DESIGN_DIAGRAM_TYPES.map((type) => (
                            <SelectItem key={type} value={type}>
                              {DIAGRAM_TYPE_LABELS[type]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="design-ai-prompt">AI prompt</Label>
                    <div className="flex gap-2">
                      <Input
                        id="design-ai-prompt"
                        value={aiPrompt}
                        onChange={(e) => setAiPrompt(e.target.value)}
                        placeholder="e.g. a serverless API with S3 storage and a Postgres RDS backend"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="gap-1 shrink-0"
                        onClick={handleGenerateDiagram}
                        disabled={!aiPrompt.trim() || isGeneratingDiagram}
                      >
                        <Sparkles className="h-3.5 w-3.5" />
                        {isGeneratingDiagram ? 'Generating...' : 'Generate with AI'}
                      </Button>
                    </div>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="design-source">Mermaid source</Label>
                    <Textarea
                      id="design-source"
                      value={editForm.source}
                      onChange={(e) => setEditForm((f) => ({ ...f, source: e.target.value }))}
                      rows={12}
                      className="font-mono text-xs"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="design-notes">Notes</Label>
                    <Textarea
                      id="design-notes"
                      value={editForm.notes}
                      onChange={(e) => setEditForm((f) => ({ ...f, notes: e.target.value }))}
                      rows={3}
                    />
                  </div>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Preview</Label>
                  <div className="border rounded-md p-3 bg-muted/20 overflow-auto">
                    <MermaidDiagram source={editForm.source} />
                  </div>
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setIsEditOpen(false)}>
                  Cancel
                </Button>
                <Button onClick={handleSave} disabled={isSaving}>
                  {isSaving ? 'Saving…' : editDesign ? 'Save changes' : 'Create'}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <AlertDialog open={!!deleteDesign} onOpenChange={(open) => !open && setDeleteDesign(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete &quot;{deleteDesign?.title}&quot;?</AlertDialogTitle>
            <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
