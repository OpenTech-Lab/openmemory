'use client';

// Note: this component must be imported with next/dynamic + ssr:false — it renders
// <MermaidDiagram>, which touches `document` at import time.

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
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
import { Plus, RefreshCw, Pencil, Trash2, Palette, Sparkles, Expand, Shrink, WalletCards, Info } from 'lucide-react';
import { toast } from 'sonner';
import { MermaidDiagram } from '@/components/mermaid-diagram';
import { DesignCanvas } from '@/components/design-canvas';
import { DrawioDiagram, type DrawioDiagramHandle } from '@/components/drawio-diagram';
import { PencilDiagram, type PencilDiagramHandle } from '@/components/pencil-diagram';
import { blankPencilSource } from '@/lib/pencil';
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
import { applyDagreLayout, applyNestedLayout } from '@/lib/design-layout';
import { architectureToDesignGraph, isArchitectureSource, parseArchitectureDiagram } from '@/lib/mermaid-architecture';
import {
  applyOverrides,
  diffOverrides,
  hasCorruptLayoutComment,
  parseLayoutComment,
  reconcileOverrides,
  stripLayoutComment,
  withLayoutComment,
  type LayoutOverrides,
} from '@/lib/mermaid-layout-overrides';
import { drawioStarterSource, isDrawioStarterSource } from '@/lib/drawio';
import type { ForecastProfile } from '@/lib/forecast-types';
import { DesignBudgetSheet } from '@/components/design-budget-sheet';

// The editor/preview routing decision (Decision 3): draw.io uses the same mxGraph document in its
// editor and viewer, React Flow designs are always 'canvas';
// mermaid designs split further by content, since architecture-beta is the one starter kind whose
// text can drive the same draggable canvas the reactflow format uses. Detected from content, not
// a stored flag.
type DesignEditorMode = 'drawio' | 'pencil' | 'canvas' | 'arch' | 'mermaid';

function computeEditorMode(diagramType: DesignDiagramType, source: string): DesignEditorMode {
  if (diagramType === 'drawio') return 'drawio';
  if (diagramType === 'pen') return 'pencil';
  if (diagramType === 'reactflow') return 'canvas';
  return isArchitectureSource(source) ? 'arch' : 'mermaid';
}

/** Remount key for the derived-mode canvas: a hash of structure/labels/icons — everything except
 * positions — so editing a label remounts the canvas (cheap at this scale) while dragging (which
 * only changes override state, never this hash) does not. */
function archStructureHash(graph: DesignGraph): string {
  const nodesPart = graph.nodes
    .map((n) => `${n.id}:${n.type}:${n.parentId ?? ''}:${n.data.label}:${n.data.icon ?? ''}`)
    .join('|');
  const edgesPart = graph.edges
    .map((e) => `${e.source}>${e.target}:${typeof e.label === 'string' ? e.label : ''}`)
    .join('|');
  return `${nodesPart}##${edgesPart}`;
}

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
  kind: 'aws' as string,
  source: drawioStarterSource('aws'),
  notes: '',
  diagramType: 'drawio' as DesignDiagramType,
};

const DIAGRAM_TYPE_LABELS: Record<DesignDiagramType, string> = {
  drawio: 'Diagram studio (draw.io)',
  // Rendered by mermaid itself. AWS/architecture diagrams additionally get an "Adjust positions"
  // view in the editor, where the same text drives a draggable canvas and nudged positions persist
  // as a trailing `%%` comment — but mermaid's own rendering stays what the design actually looks like.
  mermaid: 'Mermaid text',
  reactflow: 'React Flow canvas',
  pen: 'OpenPencil',
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
  const [isBudgetOpen, setIsBudgetOpen] = useState(false);

  // Preview fullscreen — same Fullscreen API pattern as mermaid-diagram.tsx's own toggle,
  // applied here to the whole preview block (title/badge/Edit/Delete row + canvas) rather than
  // just the canvas, so those controls stay reachable while fullscreen.
  const [isPreviewFullscreen, setIsPreviewFullscreen] = useState(false);
  const previewRef = useRef<HTMLDivElement>(null);

  // Create/edit dialog
  const [editDesign, setEditDesign] = useState<Design | null>(null); // null while creating
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [editForm, setEditForm] = useState(EMPTY_EDIT_FORM);
  const [isSaving, setIsSaving] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');
  const [forecastProfiles, setForecastProfiles] = useState<ForecastProfile[]>([]);
  const [forecastProfileId, setForecastProfileId] = useState('none');
  const [isGeneratingDiagram, setIsGeneratingDiagram] = useState(false);
  // Current reactflow graph in the edit/create dialog — tracked separately from editForm.source
  // because DesignCanvas is uncontrolled and reports state upward via onChange; only serialized
  // into editForm.source's shape (via serializeDesignGraph) at save time.
  const [graphState, setGraphState] = useState<DesignGraph>({ nodes: [], edges: [] });
  // Bumped whenever the dialog needs DesignCanvas to remount with a fresh initialGraph (new
  // design opened, different design opened, kind/format reset) — the canvas only reads its
  // initialGraph prop once, on mount.
  const [canvasKey, setCanvasKey] = useState(0);
  const drawioEditorRef = useRef<DrawioDiagramHandle>(null);
  const pencilEditorRef = useRef<PencilDiagramHandle>(null);

  // --- 'arch' (architecture-beta derived-mode) editor state ---------------------------------
  // Saved position overrides, seeded from the opened design's `%%` comment and reconciled on
  // every re-parse (ids that vanished or changed parent are dropped — see reconcileOverrides).
  const [archOverrides, setArchOverrides] = useState<LayoutOverrides>({});
  // The derived canvas's live nodes/edges, reported via its own onChange — separate from
  // `graphState` (reactflow-only) since the two formats' save paths are unrelated.
  const [archGraphState, setArchGraphState] = useState<DesignGraph | null>(null);
  // Bumped by "Reset positions" to force a canvas remount even though the structural hash (which
  // drives `archCanvasKey` below) doesn't change when only positions are cleared.
  const [archResetNonce, setArchResetNonce] = useState(0);
  const [archCorruptWarning, setArchCorruptWarning] = useState(false);
  // Which surface the edit dialog's right pane shows. 'mermaid' is the default because mermaid's
  // own rendering is the real output; 'canvas' is the opt-in position-editing detour. Staying on
  // 'mermaid' leaves `archGraphState` null, so the save path diffs baseline against itself and a
  // source that had no `%%` layout comment never grows one.
  const [archView, setArchView] = useState<'mermaid' | 'canvas'>('mermaid');
  // ~300ms debounced mirror of editForm.source that the parser/layout/canvas-remount pipeline
  // reads, so the canvas doesn't re-lay-out (and lag typing) on every keystroke.
  const [debouncedArchSource, setDebouncedArchSource] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedArchSource(editForm.source), 300);
    return () => clearTimeout(timer);
  }, [editForm.source]);

  const editorMode = computeEditorMode(editForm.diagramType, editForm.source);
  const archParse = useMemo(() => parseArchitectureDiagram(debouncedArchSource), [debouncedArchSource]);
  const archGraph = useMemo(() => architectureToDesignGraph(archParse), [archParse]);
  const archLaidOut = useMemo(() => applyNestedLayout(archGraph.nodes, archGraph.edges), [archGraph]);
  const archCanvasKey = `${archStructureHash(archGraph)}::${archResetNonce}`;
  // Reconciled INLINE (same render as archLaidOut, not via a setState+effect round-trip) — a
  // remount can happen in the very same render that archLaidOut changes (archCanvasKey is a plain
  // derived value, not state), so reconciling a render late would let a stale, since-invalidated
  // override get baked into the canvas's initial mount with no second remount to correct it
  // (DesignCanvas only reads `initialGraph` once, on mount).
  const reconciledArchOverrides = useMemo(() => reconcileOverrides(archOverrides, archLaidOut), [archOverrides, archLaidOut]);
  const archInitialGraph = useMemo(
    () => ({ nodes: applyOverrides(archLaidOut, reconciledArchOverrides), edges: archGraph.edges }),
    [archLaidOut, reconciledArchOverrides, archGraph.edges]
  );
  const archLiveNodes = archGraphState?.nodes ?? archInitialGraph.nodes;
  const archOverrideCount = Object.keys(diffOverrides(archLiveNodes, archLaidOut)).length;
  // Nothing downstream reads the raw `archOverrides` state directly except through
  // `reconciledArchOverrides` above (recomputed fresh every render) and handleSave (which
  // re-derives its own overrides from editForm.source + archGraphState, not from this state) — so
  // there's no need to also write the pruned value back into state; doing so via a naive
  // `useEffect` is an infinite loop besides, since `reconcileOverrides` always returns a new
  // object reference even when its content is unchanged.

  const handleResetArchPositions = useCallback(() => {
    setArchOverrides({});
    setArchGraphState(null);
    setArchResetNonce((n) => n + 1);
  }, []);

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

  useEffect(() => {
    fetch('/api/forecast-profiles')
      .then((res) => res.json())
      .then((data) => setForecastProfiles(data.profiles ?? []))
      .catch(() => setForecastProfiles([]));
  }, []);

  // Keep isPreviewFullscreen in sync with the browser's actual fullscreen state — the user can
  // exit via Esc or the browser's own UI, not just our button.
  useEffect(() => {
    const handleChange = () => setIsPreviewFullscreen(document.fullscreenElement === previewRef.current);
    document.addEventListener('fullscreenchange', handleChange);
    return () => document.removeEventListener('fullscreenchange', handleChange);
  }, []);

  const togglePreviewFullscreen = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      // Can reject (e.g. Permissions-Policy denies "fullscreen" in an embedded/iframed context)
      // — swallow rather than throw, same as mermaid-diagram.tsx's toggle.
      previewRef.current?.requestFullscreen().catch(() => {});
    }
  };

  const selectedDesign = useMemo(
    () => designs.find((d) => d.id === selectedId) ?? null,
    [designs, selectedId]
  );

  const openCreate = () => {
    setEditDesign(null);
    const kind = EMPTY_EDIT_FORM.kind;
    const source = drawioStarterSource(kind);
    setEditForm({ ...EMPTY_EDIT_FORM, source });
    setGraphState(blankDesignGraph(kind));
    setDebouncedArchSource(source);
    setArchOverrides({});
    setArchGraphState(null);
    setArchResetNonce(0);
    setArchCorruptWarning(false);
    setArchView('mermaid');
    setCanvasKey((k) => k + 1);
    setAiPrompt('');
    setIsEditOpen(true);
  };

  const openEdit = (design: Design) => {
    setEditDesign(design);
    const diagramType = (
      design.diagram_type === 'drawio'
        ? 'drawio'
        : design.diagram_type === 'reactflow'
          ? 'reactflow'
          : 'mermaid'
    ) as DesignDiagramType;
    // The textarea never shows the layout comment — a drag can't rewrite text under the user's
    // caret, and there's no edit-conflict to resolve on save (Decision 2's editor round-trip).
    const source = diagramType === 'mermaid' ? stripLayoutComment(design.source) : design.source;
    setEditForm({
      title: design.title,
      kind: design.kind,
      source,
      notes: design.notes ?? '',
      diagramType,
    });
    if (diagramType === 'reactflow') setGraphState(parseDesignGraph(design.source));
    setDebouncedArchSource(source);
    setArchOverrides(diagramType === 'mermaid' ? parseLayoutComment(design.source) : {});
    setArchGraphState(null);
    setArchResetNonce(0);
    setArchCorruptWarning(diagramType === 'mermaid' && hasCorruptLayoutComment(design.source));
    setCanvasKey((k) => k + 1);
    setAiPrompt('');
    setIsEditOpen(true);
  };

  const handleGenerateDiagram = async () => {
    if (editForm.diagramType === 'drawio') {
      toast.error('AI generation for Diagram studio documents is not available yet.');
      return;
    }
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
          ...(forecastProfileId !== 'none' ? { forecast_profile_id: forecastProfileId } : {}),
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
      if (editForm.diagramType === 'mermaid' && data.source) {
        // A freshly-generated diagram's node ids won't match any prior design's, so stale
        // overrides would be dropped by reconciliation anyway — clearing them (and syncing the
        // debounced mirror immediately) just avoids a stale "Reset positions" flash before that
        // reconcile effect catches up.
        setDebouncedArchSource(data.source);
        setArchOverrides({});
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
  // still untouched (empty, or exactly a previous starter) — never clobber real edits. Picking
  // 'aws' here now yields a *draggable* starter, since STARTER_TEMPLATES.aws is already
  // architecture-beta — editorMode picks that up automatically from the new source text.
  const handleKindChange = (kind: string) => {
    const isNewDoc = editDesign === null;
    const sourceIsUntouched = editForm.diagramType === 'drawio'
      ? isDrawioStarterSource(editForm.source)
      : editForm.source.trim() === '' || Object.values(STARTER_TEMPLATES).includes(editForm.source);
    const nextSource =
      isNewDoc && sourceIsUntouched
        ? editForm.diagramType === 'drawio'
          ? drawioStarterSource(kind)
          : editForm.diagramType === 'mermaid'
            ? (STARTER_TEMPLATES[kind as DesignKind] ?? editForm.source)
            : editForm.source
        : editForm.source;
    setEditForm((prev) => ({ ...prev, kind, source: nextSource }));
    if (nextSource !== editForm.source) {
      setDebouncedArchSource(nextSource);
      setArchOverrides({});
      setArchResetNonce(0);
    }
    if (isNewDoc && editForm.diagramType === 'reactflow' && graphIsUntouched(graphState, editForm.kind)) {
      setGraphState(blankDesignGraph(kind));
      setCanvasKey((k) => k + 1);
    }
    if (isNewDoc && editForm.diagramType === 'drawio' && sourceIsUntouched) {
      setCanvasKey((k) => k + 1);
    }
  };

  // New-doc-only format toggle (Mermaid text / React Flow canvas) — a design's format is fixed
  // at creation in v1, so this only applies while editDesign is null.
  const handleFormatChange = (diagramType: DesignDiagramType) => {
    const nextSource = diagramType === 'drawio'
      ? drawioStarterSource(editForm.kind)
      : diagramType === 'mermaid'
        ? (STARTER_TEMPLATES[editForm.kind as DesignKind] ?? '')
        : diagramType === 'pen'
          ? blankPencilSource()
          : '';
    setEditForm((prev) => ({ ...prev, diagramType, source: nextSource }));
    setDebouncedArchSource(nextSource);
    setArchOverrides({});
    setArchGraphState(null);
    setArchResetNonce(0);
    setArchCorruptWarning(false);
    setArchView('mermaid');
    if (diagramType === 'reactflow') {
      setGraphState(blankDesignGraph(editForm.kind));
    }
    setCanvasKey((k) => k + 1);
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
      let source: string;
      if (editForm.diagramType === 'drawio') {
        source = await drawioEditorRef.current?.flushSource() ?? editForm.source;
      } else if (editForm.diagramType === 'pen') {
        // On create there is no embed mounted yet, so just store the marker; the user
        // reopens the design to draw. On update, pull from the embed: flushSource()
        // uploads the .fig bytes and resolves only once the blob is safely written, so a
        // failed upload rejects here and abandons the record save rather than leaving the
        // row pointing at a blob that was never written.
        source = editDesign
          ? await pencilEditorRef.current!.flushSource()
          : blankPencilSource();
      } else if (editForm.diagramType === 'reactflow') {
        source = serializeDesignGraph(graphState.nodes, graphState.edges, graphState.viewport);
      } else if (editorMode === 'arch') {
        // Recomputed fresh from the CURRENT (undebounced) textarea value rather than reused from
        // render state, so a save immediately after typing can't miss the last edit; reconciled
        // once more defensively in case the debounced pipeline hasn't caught up yet either.
        const parse = parseArchitectureDiagram(editForm.source);
        const graph = architectureToDesignGraph(parse);
        const baseline = applyNestedLayout(graph.nodes, graph.edges);
        const current = archGraphState?.nodes ?? baseline;
        const overrides = reconcileOverrides(diffOverrides(current, baseline), baseline);
        source = withLayoutComment(editForm.source, overrides);
      } else {
        source = editForm.source;
      }
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
            WYSIWYG diagram studio, Mermaid text, or React Flow canvases for architectures and workflows.
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

      <div className="flex flex-col gap-4 min-h-[400px]">
        {/* Diagram switcher — a dropdown rather than the old fixed-width sidebar list, so the
            structure/canvas block below gets the full panel width instead of losing 280px to a
            list that only ever shows one thing at a time anyway. */}
        {isLoading && designs.length === 0 ? (
          <div className="flex items-center justify-center h-[80px] border rounded-md">
            <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : designs.length === 0 ? (
          <div className="text-center py-10 px-4 border rounded-md text-muted-foreground">
            <Palette className="h-8 w-8 mx-auto mb-2 opacity-30" />
            <p className="text-sm">No diagrams yet.</p>
          </div>
        ) : (
          <Select value={selectedId ?? undefined} onValueChange={setSelectedId}>
            <SelectTrigger className="w-full sm:w-[420px]">
              <SelectValue placeholder="Select a diagram" />
            </SelectTrigger>
            <SelectContent>
              {designs.map((d) => {
                const meta = designKindMeta(d.kind);
                const Icon = meta.icon;
                return (
                  <SelectItem key={d.id} value={d.id}>
                    <span className="flex items-center gap-2">
                      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                      {/* Full titles here too (see design-node.tsx / this file's earlier fix for
                          the same ellipsis problem) — `break-words` since the dropdown list has
                          room to wrap, unlike the closed trigger's single-line `SelectValue`. */}
                      <span className="break-words">{d.title}</span>
                    </span>
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        )}

        {/* Preview — now full width. h-[70vh] (not max-h) is load-bearing: a flex column with
            only max-height caps its own growth but never becomes a "definite size" for CSS
            flex-basis resolution, so the flex-1/min-h-0 chain down to the scroll container below
            silently fails to get a bounded height and the diagram just overflows uncapped. An
            explicit height fixes this; selectedDesign ? '' handles the empty-state case where a
            fixed tall box would look odd with no diagram to fill it.
            In fullscreen, the browser's UA stylesheet forces this element to fill the viewport
            regardless of the h-[70vh]/min-h classes below (same as mermaid-diagram.tsx's own
            fullscreen root), so no separate fullscreen-specific sizing class is needed here —
            only a background, since fullscreen otherwise renders on a transparent/black canvas. */}
        <div
          ref={previewRef}
          className={`rounded-md p-4 pb-6 flex flex-col gap-3 overflow-hidden ${selectedDesign ? 'h-[85vh]' : 'min-h-[300px]'} ${isPreviewFullscreen ? 'bg-background' : ''}`}
        >
          {selectedDesign ? (
            <>
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold">{selectedDesign.title}</h3>
                  <Badge variant="outline" className={`text-xs ${designKindMeta(selectedDesign.kind).color}`}>
                    {designKindMeta(selectedDesign.kind).label}
                  </Badge>
                  {selectedDesign.notes && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
                      </TooltipTrigger>
                      <TooltipContent className="max-w-sm whitespace-pre-wrap text-left">
                        {selectedDesign.notes}
                      </TooltipContent>
                    </Tooltip>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => setIsBudgetOpen(true)}>
                    <WalletCards className="h-4 w-4 mr-2" />
                    Budget
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => openEdit(selectedDesign)}>
                    <Pencil className="h-4 w-4 mr-2" />
                    Edit
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={togglePreviewFullscreen}
                    title={isPreviewFullscreen ? 'Exit full screen' : 'Full screen'}
                  >
                    {isPreviewFullscreen ? <Shrink className="h-4 w-4" /> : <Expand className="h-4 w-4" />}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setDeleteDesign(selectedDesign)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <div className="rounded-md p-3 bg-muted/20 flex-1 min-h-0 overflow-hidden">
                {(() => {
                  if (selectedDesign.diagram_type === 'drawio') {
                    return (
                      <DrawioDiagram
                        key={selectedDesign.id}
                        source={selectedDesign.source}
                        mode="viewer"
                        title={selectedDesign.title}
                        kind={selectedDesign.kind}
                      />
                    );
                  }
                  if (selectedDesign.diagram_type === 'pen') {
                    // PencilDiagram has no viewer-only mode (unlike DrawioDiagram's mode="viewer"),
                    // and building one is explicitly out of scope for this pass. Rather than feed
                    // the pen design's small JSON marker into MermaidDiagram — which would render
                    // it as an "invalid diagram" error — show a static placeholder that sends the
                    // user straight to the real editor.
                    return (
                      <div className="h-full flex flex-col items-center justify-center gap-3 text-muted-foreground text-sm">
                        <Pencil className="h-8 w-8" />
                        <p>Open in Edit to view this OpenPencil design.</p>
                        <Button variant="outline" size="sm" onClick={() => openEdit(selectedDesign)}>
                          <Pencil className="h-4 w-4 mr-2" />
                          Edit
                        </Button>
                      </div>
                    );
                  }
                  const previewMode = computeEditorMode(
                    selectedDesign.diagram_type === 'reactflow' ? 'reactflow' : 'mermaid',
                    selectedDesign.source
                  );
                  if (previewMode === 'canvas') {
                    return (
                      <DesignCanvas
                        key={selectedDesign.id}
                        initialGraph={parseDesignGraph(selectedDesign.source)}
                        readOnly
                      />
                    );
                  }
                  // Every mermaid design — architecture-beta included — previews through mermaid's
                  // own renderer. The React Flow canvas is a position-editing surface, not a
                  // display surface: reproducing architecture-beta on it was a worse likeness of
                  // the diagram than mermaid drawing it itself. Dragging still lives in the edit
                  // dialog's "Adjust positions" view.
                  return <MermaidDiagram source={selectedDesign.source} />;
                })()}
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
              Select or create a diagram.
            </div>
          )}
        </div>
      </div>

      {/* Create/Edit dialog — canvas formats need far more width than the Mermaid textarea. */}
      <Dialog open={isEditOpen} onOpenChange={setIsEditOpen}>
        <DialogContent
          className={
            editForm.diagramType === 'drawio' || editForm.diagramType === 'pen' || editForm.diagramType === 'reactflow' || editorMode === 'arch'
              ? 'flex h-[92vh] w-[96vw] min-w-[80vw] max-w-[1500px] flex-col gap-0 overflow-hidden p-0 sm:max-w-[1500px]'
              : 'max-w-3xl max-h-[85vh] overflow-y-auto'
          }
        >
          {editForm.diagramType === 'drawio' ? (
            <>
              <div className="border-b bg-card px-5 py-4">
                <DialogHeader>
                  <DialogTitle>{editDesign ? `Edit ${editDesign.title}` : 'New diagram'}</DialogTitle>
                  <DialogDescription>
                    Build AWS architectures, workflows, swimlanes, BPMN, and sequence diagrams with the full visual studio.
                  </DialogDescription>
                </DialogHeader>
              </div>
              <div className="grid shrink-0 grid-cols-1 gap-3 border-b bg-muted/20 p-4 md:grid-cols-[1fr_220px_1fr]">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="design-title">Title</Label>
                  <Input
                    id="design-title"
                    value={editForm.title}
                    onChange={(e) => setEditForm((f) => ({ ...f, title: e.target.value }))}
                    placeholder="e.g. Multi-region service architecture"
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
                        <SelectItem key={k} value={k}>{designKindMeta(k).label}</SelectItem>
                      ))}
                      <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Narrative</div>
                      {DESIGN_KIND_GROUPS.narrative.map((k) => (
                        <SelectItem key={k} value={k}>{designKindMeta(k).label}</SelectItem>
                      ))}
                      <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Infrastructure</div>
                      {DESIGN_KIND_GROUPS.infrastructure.map((k) => (
                        <SelectItem key={k} value={k}>{designKindMeta(k).label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="design-notes">Notes</Label>
                  <Input
                    id="design-notes"
                    value={editForm.notes}
                    onChange={(e) => setEditForm((f) => ({ ...f, notes: e.target.value }))}
                    placeholder="Context, decisions, or implementation notes"
                  />
                </div>
                {!editDesign && (
                  <div className="flex flex-col gap-1.5 md:col-span-3">
                    <Label>Format</Label>
                    <Select value={editForm.diagramType} onValueChange={(value) => handleFormatChange(value as DesignDiagramType)}>
                      <SelectTrigger className="w-64">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {DESIGN_DIAGRAM_TYPES.map((type) => (
                          <SelectItem key={type} value={type}>{DIAGRAM_TYPE_LABELS[type]}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>
              <div className="min-h-0 flex-1 bg-slate-100 p-3 dark:bg-slate-950">
                <DrawioDiagram
                  ref={drawioEditorRef}
                  key={editDesign?.id ?? `new-${canvasKey}`}
                  source={editForm.source}
                  mode="editor"
                  title={editForm.title || 'Untitled diagram'}
                  kind={editForm.kind}
                  onChange={(source) => setEditForm((form) => ({ ...form, source }))}
                />
              </div>
              <DialogFooter className="border-t bg-card px-5 py-3">
                <p className="mr-auto text-xs text-muted-foreground">
                  Changes stay in this dialog until you save the OpenMemory design.
                </p>
                <Button variant="outline" onClick={() => setIsEditOpen(false)}>Cancel</Button>
                <Button onClick={handleSave} disabled={isSaving}>
                  {isSaving ? 'Saving…' : editDesign ? 'Save changes' : 'Create'}
                </Button>
              </DialogFooter>
            </>
          ) : editForm.diagramType === 'reactflow' ? (
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
                  <ForecastProfileSelect profiles={forecastProfiles} value={forecastProfileId} onChange={setForecastProfileId} />
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
          ) : editForm.diagramType === 'pen' ? (
            <>
              <div className="border-b bg-card px-5 py-4">
                <DialogHeader>
                  <DialogTitle>{editDesign ? `Edit ${editDesign.title}` : 'New diagram'}</DialogTitle>
                  <DialogDescription>
                    Free-form design surface, powered by OpenPencil.
                  </DialogDescription>
                </DialogHeader>
              </div>
              <div className="grid shrink-0 grid-cols-1 gap-3 border-b bg-muted/20 p-4 md:grid-cols-[1fr_220px_1fr]">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="design-title">Title</Label>
                  <Input
                    id="design-title"
                    value={editForm.title}
                    onChange={(e) => setEditForm((f) => ({ ...f, title: e.target.value }))}
                    placeholder="e.g. Onboarding flow sketch"
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
                        <SelectItem key={k} value={k}>{designKindMeta(k).label}</SelectItem>
                      ))}
                      <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Narrative</div>
                      {DESIGN_KIND_GROUPS.narrative.map((k) => (
                        <SelectItem key={k} value={k}>{designKindMeta(k).label}</SelectItem>
                      ))}
                      <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Infrastructure</div>
                      {DESIGN_KIND_GROUPS.infrastructure.map((k) => (
                        <SelectItem key={k} value={k}>{designKindMeta(k).label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="design-notes">Notes</Label>
                  <Input
                    id="design-notes"
                    value={editForm.notes}
                    onChange={(e) => setEditForm((f) => ({ ...f, notes: e.target.value }))}
                    placeholder="Context, decisions, or implementation notes"
                  />
                </div>
                {!editDesign && (
                  <div className="flex flex-col gap-1.5 md:col-span-3">
                    <Label>Format</Label>
                    <Select value={editForm.diagramType} onValueChange={(value) => handleFormatChange(value as DesignDiagramType)}>
                      <SelectTrigger className="w-64">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {DESIGN_DIAGRAM_TYPES.map((type) => (
                          <SelectItem key={type} value={type}>{DIAGRAM_TYPE_LABELS[type]}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>
              <div className="min-h-0 flex-1 bg-slate-100 p-3 dark:bg-slate-950">
                {editDesign ? (
                  <PencilDiagram
                    key={editDesign.id}
                    ref={pencilEditorRef}
                    projectId={projectId}
                    designId={editDesign.id}
                    title={editForm.title}
                  />
                ) : (
                  <div className="flex h-full min-h-[360px] items-center justify-center rounded-lg border border-border/80 bg-muted/30 p-6 text-center text-sm text-muted-foreground">
                    Save this design first — the editor opens once the design has an ID.
                  </div>
                )}
              </div>
              <DialogFooter className="border-t bg-card px-5 py-3">
                <p className="mr-auto text-xs text-muted-foreground">
                  Changes stay in this dialog until you save the OpenMemory design.
                </p>
                <Button variant="outline" onClick={() => setIsEditOpen(false)}>Cancel</Button>
                <Button onClick={handleSave} disabled={isSaving}>
                  {isSaving ? 'Saving…' : editDesign ? 'Save changes' : 'Create'}
                </Button>
              </DialogFooter>
            </>
          ) : editorMode === 'arch' ? (
            <>
              <div className="border-b bg-card px-5 py-4">
                <DialogHeader>
                  <DialogTitle>{editDesign ? `Edit ${editDesign.title}` : 'New diagram'}</DialogTitle>
                  <DialogDescription>
                    Drag nodes to reposition them — structure, labels and icons come from the mermaid text on the left.
                  </DialogDescription>
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
                  <ForecastProfileSelect profiles={forecastProfiles} value={forecastProfileId} onChange={setForecastProfileId} />
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
              {archCorruptWarning && (
                <div className="flex items-center justify-between gap-3 border-b bg-amber-50 px-5 py-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                  <span>Saved node positions couldn&apos;t be read and were reset.</span>
                  <button type="button" className="underline underline-offset-2" onClick={() => setArchCorruptWarning(false)}>
                    Dismiss
                  </button>
                </div>
              )}
              <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-hidden p-4 md:grid-cols-2">
                <div className="flex min-h-0 flex-col gap-2">
                  <Label htmlFor="design-source">Mermaid source</Label>
                  <Textarea
                    id="design-source"
                    value={editForm.source}
                    onChange={(e) => setEditForm((f) => ({ ...f, source: e.target.value }))}
                    className="min-h-0 flex-1 resize-none font-mono text-xs"
                  />
                  {archParse.issues.length > 0 && (
                    <ul className="max-h-28 shrink-0 space-y-0.5 overflow-y-auto rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
                      {archParse.issues.map((issue, index) => (
                        <li key={index}>
                          line {issue.line}: {issue.message}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="flex min-h-0 flex-col gap-2">
                  {/* Mermaid draws the diagram; the canvas only exists to nudge positions. Default
                      to mermaid so what you edit is what you'll see in the preview and anywhere
                      else the source is rendered — the canvas is an explicit detour, and it's
                      disabled when the source doesn't parse (nothing to drag). */}
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      type="button"
                      size="sm"
                      variant={archView === 'mermaid' ? 'default' : 'outline'}
                      onClick={() => setArchView('mermaid')}
                    >
                      Mermaid
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant={archView === 'canvas' ? 'default' : 'outline'}
                      disabled={archGraph.nodes.length === 0}
                      onClick={() => setArchView('canvas')}
                    >
                      Adjust positions
                    </Button>
                  </div>
                  <div className="min-h-0 flex-1">
                    {archView === 'canvas' ? (
                      <DesignCanvas
                        key={archCanvasKey}
                        initialGraph={archInitialGraph}
                        mode="derived"
                        onChange={setArchGraphState}
                        resetPositionsCount={archOverrideCount}
                        onResetPositions={handleResetArchPositions}
                      />
                    ) : (
                      <MermaidDiagram source={stripLayoutComment(editForm.source)} />
                    )}
                  </div>
                </div>
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
                    <ForecastProfileSelect profiles={forecastProfiles} value={forecastProfileId} onChange={setForecastProfileId} />
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

      <DesignBudgetSheet
        open={isBudgetOpen}
        onOpenChange={setIsBudgetOpen}
        projectId={projectId}
        design={selectedDesign}
      />
    </div>
  );
}

function ForecastProfileSelect({ profiles, value, onChange }: {
  profiles: ForecastProfile[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-8 text-xs">
        <SelectValue placeholder="No usage forecast" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="none">No usage forecast</SelectItem>
        {profiles.map((profile) => (
          <SelectItem key={profile.id} value={profile.id}>
            {profile.name} · {profile.user_count.toLocaleString()} MAU · ${profile.monthly_budget_usd.toLocaleString()}/mo
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
