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
import {
  Plus,
  RefreshCw,
  Pencil,
  Trash2,
  Palette,
  Sparkles,
  Expand,
  Shrink,
  WalletCards,
  Info,
  Network,
  PenTool,
  FileText,
  Folder,
  FolderOpen,
  ChevronDown,
  ChevronRight,
  ArrowUpRight,
} from 'lucide-react';
import DOMPurify from 'dompurify';
import { marked, type Tokens } from 'marked';
import { toast } from 'sonner';
import { MermaidDiagram } from '@/components/mermaid-diagram';
import { DesignCanvas } from '@/components/design-canvas';
import { DrawioDiagram, type DrawioDiagramHandle } from '@/components/drawio-diagram';
import { PencilDiagram, type PencilDiagramHandle } from '@/components/pencil-diagram';
import { blankPencilSource } from '@/lib/pencil';
import {
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
type DesignEditorMode = 'drawio' | 'pencil' | 'canvas' | 'arch' | 'mermaid' | 'text';

function computeEditorMode(diagramType: DesignDiagramType, source: string): DesignEditorMode {
  if (diagramType === 'drawio') return 'drawio';
  if (diagramType === 'pen') return 'pencil';
  if (diagramType === 'text') return 'text';
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

type DocumentCreationType = 'diagram' | 'ui' | 'text';

const EMPTY_EDIT_FORM = {
  title: '',
  kind: 'aws' as string,
  source: drawioStarterSource('aws'),
  notes: '',
  diagramType: 'drawio' as DesignDiagramType,
};

function createEditForm(type: DocumentCreationType) {
  if (type === 'ui') {
    return {
      ...EMPTY_EDIT_FORM,
      kind: 'ui',
      source: blankPencilSource(),
      diagramType: 'pen' as DesignDiagramType,
    };
  }

  if (type === 'text') {
    return {
      ...EMPTY_EDIT_FORM,
      kind: 'document',
      source: '',
      diagramType: 'text' as DesignDiagramType,
    };
  }

  return { ...EMPTY_EDIT_FORM, source: drawioStarterSource('aws') };
}

const DIAGRAM_TYPE_LABELS: Record<DesignDiagramType, string> = {
  drawio: 'Diagram studio (draw.io)',
  // Rendered by mermaid itself. AWS/architecture diagrams additionally get an "Adjust positions"
  // view in the editor, where the same text drives a draggable canvas and nudged positions persist
  // as a trailing `%%` comment — but mermaid's own rendering stays what the design actually looks like.
  mermaid: 'Mermaid text',
  reactflow: 'React Flow canvas',
  pen: 'OpenPencil',
  text: 'Text document',
};

const DOCUMENT_CREATION_OPTIONS: Array<{
  type: DocumentCreationType;
  label: string;
  detail: string;
  icon: typeof Network;
  iconClass: string;
}> = [
  {
    type: 'diagram',
    label: 'Diagram',
    detail: 'draw.io · Mermaid · canvas',
    icon: Network,
    iconClass: 'bg-sky-100 text-sky-700 dark:bg-sky-950/70 dark:text-sky-300',
  },
  {
    type: 'ui',
    label: 'UI/UX design',
    detail: 'OpenPencil · freeform canvas',
    icon: PenTool,
    iconClass: 'bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-950/70 dark:text-fuchsia-300',
  },
  {
    type: 'text',
    label: 'Text document',
    detail: 'Plain text · Markdown preview',
    icon: FileText,
    iconClass: 'bg-amber-100 text-amber-700 dark:bg-amber-950/70 dark:text-amber-300',
  },
];

const TEXT_KIND_OPTIONS = [
  { value: 'document', label: 'General document' },
  { value: 'spec', label: 'Specification' },
  { value: 'readme', label: 'README' },
  { value: 'notes', label: 'Notes' },
  { value: 'markdown', label: 'Markdown' },
] as const;

const MERMAID_SLOT_PATTERN = /<div data-openmemory-mermaid-slot="(\d+)"><\/div>/;

function textDocumentKindLabel(kind: string): string {
  return TEXT_KIND_OPTIONS.find((option) => option.value === kind)?.label ?? designKindMeta(kind).label;
}

function documentTypeLabel(diagramType: string): string {
  if (diagramType === 'pen') return 'UI/UX design';
  if (diagramType === 'text') return 'Text document';
  return 'Diagram';
}

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
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({
    diagrams: true,
    designs: true,
    notes: true,
  });

  // In-window preview expansion. This deliberately avoids the browser Fullscreen API: the
  // preview grows to the browser viewport while the browser's own chrome and monitor remain
  // untouched.
  const [isPreviewExpanded, setIsPreviewExpanded] = useState(false);

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
  // New documents can switch formats before they are saved. Keep this available in the text
  // editor too, so choosing Text document does not strand the user in that editor.
  const showFormatMenu = !editDesign;
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

  useEffect(() => {
    if (!isPreviewExpanded) return;

    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsPreviewExpanded(false);
    };

    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isPreviewExpanded]);

  const selectedDesign = useMemo(
    () => designs.find((d) => d.id === selectedId) ?? null,
    [designs, selectedId]
  );

  // Documents stay in the single designs API, but the explorer presents them as a small,
  // familiar project tree. These folders are intentionally virtual: changing a document's
  // format immediately moves it to the matching group without adding another persistence model.
  const documentFolders = useMemo(() => {
    const folders = [
      {
        key: 'diagrams',
        label: 'Diagrams',
        items: designs.filter((design) => design.diagram_type !== 'text' && design.diagram_type !== 'pen'),
      },
      {
        key: 'designs',
        label: 'UI designs',
        items: designs.filter((design) => design.diagram_type === 'pen'),
      },
      {
        key: 'notes',
        label: 'Notes & docs',
        items: designs.filter((design) => design.diagram_type === 'text'),
      },
    ];
    return folders.filter((folder) => folder.items.length > 0);
  }, [designs]);

  const openCreate = (type: DocumentCreationType = 'diagram') => {
    setEditDesign(null);
    const form = createEditForm(type);
    setEditForm(form);
    setGraphState(form.diagramType === 'reactflow' ? blankDesignGraph(form.kind) : { nodes: [], edges: [] });
    setDebouncedArchSource(form.source);
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
        : design.diagram_type === 'pen'
          ? 'pen'
          : design.diagram_type === 'reactflow'
            ? 'reactflow'
            : design.diagram_type === 'text'
              ? 'text'
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
    setGraphState(diagramType === 'reactflow' ? parseDesignGraph(design.source) : { nodes: [], edges: [] });
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
    if (editForm.diagramType === 'drawio' || editForm.diagramType === 'text') {
      toast.error(editForm.diagramType === 'text'
        ? 'AI generation is available for diagram documents.'
        : 'AI generation for Diagram studio documents is not available yet.');
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
          : diagramType === 'text'
            ? ''
            : '';
    const nextKind = diagramType === 'text'
      ? 'document'
      : diagramType === 'pen'
        ? 'ui'
        : TEXT_KIND_OPTIONS.some((option) => option.value === editForm.kind)
          ? 'aws'
          : editForm.kind;
    setEditForm((prev) => ({
      ...prev,
      diagramType,
      source: nextSource,
      kind: nextKind,
    }));
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

  const formatSelector = showFormatMenu ? (
    <div className="flex shrink-0 items-center gap-2 sm:pt-0.5">
      <Label htmlFor="design-format" className="text-xs text-muted-foreground">
        Format
      </Label>
      <Select value={editForm.diagramType} onValueChange={(value) => handleFormatChange(value as DesignDiagramType)}>
        <SelectTrigger id="design-format" className="h-9 w-full sm:w-[220px]">
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
  ) : null;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex min-h-0 flex-1 flex-col gap-3 md:grid md:grid-cols-[250px_minmax(0,1fr)]">
        <aside className="flex max-h-[300px] min-h-0 flex-col overflow-hidden rounded-lg border bg-card/30 md:h-full md:max-h-none">
          <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2.5">
            <div className="flex min-w-0 items-center gap-2">
              <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate text-sm font-medium">Documents</span>
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
                {designs.length}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={fetchDesigns}
                disabled={isLoading}
                title="Refresh documents"
                aria-label="Refresh documents"
              >
                <RefreshCw className={`size-3.5 ${isLoading ? 'animate-spin' : ''}`} />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={() => openCreate('diagram')}
                title="New document"
                aria-label="New document"
              >
                <Plus className="size-4" />
              </Button>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {isLoading && designs.length === 0 ? (
              <div className="flex items-center justify-center py-10">
                <RefreshCw className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : designs.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 px-3 py-10 text-center text-muted-foreground">
                <Palette className="size-5 opacity-50" />
                <p className="text-xs">No documents yet.</p>
                <button
                  type="button"
                  className="text-xs text-primary underline-offset-4 hover:underline"
                  onClick={() => openCreate('text')}
                >
                  Create a note
                </button>
              </div>
            ) : (
              <div className="space-y-1" role="tree" aria-label="Project documents">
                {documentFolders.map((folder) => {
                  const isExpanded = expandedFolders[folder.key] ?? true;
                  return (
                    <div key={folder.key}>
                      <button
                        type="button"
                        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                        onClick={() => setExpandedFolders((current) => ({ ...current, [folder.key]: !isExpanded }))}
                        aria-expanded={isExpanded}
                        aria-selected={false}
                        role="treeitem"
                      >
                        {isExpanded ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
                        {isExpanded ? <FolderOpen className="size-3.5 shrink-0 text-amber-500" /> : <Folder className="size-3.5 shrink-0 text-amber-500" />}
                        <span className="truncate">{folder.label}</span>
                        <span className="ml-auto tabular-nums text-[10px] text-muted-foreground/70">{folder.items.length}</span>
                      </button>
                      {isExpanded && (
                        <div className="mt-0.5 space-y-0.5 pl-4">
                          {folder.items.map((design) => {
                            const meta = designKindMeta(design.kind);
                            const Icon = design.diagram_type === 'text'
                              ? FileText
                              : design.diagram_type === 'pen'
                                ? PenTool
                                : meta.icon;
                            const typeLabel = design.diagram_type === 'text'
                              ? textDocumentKindLabel(design.kind)
                              : documentTypeLabel(design.diagram_type);
                            const isSelected = selectedId === design.id;
                            return (
                              <button
                                key={design.id}
                                type="button"
                                className={`group flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
                                  isSelected
                                    ? 'bg-primary/10 text-foreground'
                                    : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                                }`}
                                onClick={() => setSelectedId(design.id)}
                                aria-current={isSelected ? 'page' : undefined}
                                aria-selected={isSelected}
                                role="treeitem"
                                title={`${design.title} · ${typeLabel}`}
                              >
                                <Icon className={`size-3.5 shrink-0 ${isSelected ? 'text-primary' : 'text-muted-foreground/80'}`} />
                                <span className="min-w-0 flex-1 truncate">{design.title}</span>
                                <span className="max-w-16 shrink-0 truncate text-[10px] text-muted-foreground/60">{typeLabel}</span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="shrink-0 border-t p-2">
            <p className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Create</p>
            <div className="space-y-0.5">
              {DOCUMENT_CREATION_OPTIONS.map((option) => (
                <button
                  key={option.type}
                  type="button"
                  onClick={() => openCreate(option.type)}
                  className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
                  title={`${option.label} — ${option.detail}`}
                >
                  <span className={`flex size-5 shrink-0 items-center justify-center rounded ${option.iconClass}`}>
                    <option.icon className="size-3" />
                  </span>
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  <ArrowUpRight className="size-3 shrink-0 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
                </button>
              ))}
            </div>
          </div>
        </aside>

        <div className="min-w-0">
          <div className="flex flex-col gap-4 min-h-[400px]">
        {/* Preview — h-[85vh] (not max-h) is load-bearing: a flex column with
            only max-height caps its own growth but never becomes a "definite size" for CSS
            flex-basis resolution, so the flex-1/min-h-0 chain down to the scroll container below
            silently fails to get a bounded height and the diagram just overflows uncapped. An
            explicit height fixes this; selectedDesign ? '' handles the empty-state case where a
            fixed tall box would look odd with no diagram to fill it. Expanded mode is an inset
            fixed panel inside the browser viewport, rather than monitor-level fullscreen. */}
        {isPreviewExpanded && (
          <button
            type="button"
            aria-label="Close expanded preview"
            className="fixed inset-0 z-30 cursor-default bg-black/55 backdrop-blur-[2px]"
            onClick={() => setIsPreviewExpanded(false)}
          />
        )}
        <div
          className={`flex flex-col gap-3 overflow-hidden rounded-md p-4 pb-6 ${
            isPreviewExpanded
              ? 'fixed inset-3 z-40 h-auto rounded-xl border bg-background pb-4 shadow-2xl sm:inset-6'
              : selectedDesign
                ? 'h-[85vh]'
                : 'min-h-[300px]'
          }`}
        >
          {selectedDesign ? (
            <>
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold">{selectedDesign.title}</h3>
                  <Badge variant="secondary" className="text-xs">
                    {documentTypeLabel(selectedDesign.diagram_type)}
                  </Badge>
                  <Badge variant="outline" className={`text-xs ${designKindMeta(selectedDesign.kind).color}`}>
                    {selectedDesign.diagram_type === 'text'
                      ? textDocumentKindLabel(selectedDesign.kind)
                      : designKindMeta(selectedDesign.kind).label}
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
                    onClick={() => setIsPreviewExpanded((expanded) => !expanded)}
                    aria-label={isPreviewExpanded ? 'Restore preview' : 'Expand preview in window'}
                    aria-pressed={isPreviewExpanded}
                    title={isPreviewExpanded ? 'Restore preview' : 'Expand in window'}
                  >
                    {isPreviewExpanded ? <Shrink className="h-4 w-4" /> : <Expand className="h-4 w-4" />}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setDeleteDesign(selectedDesign)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <div className="rounded-md p-3 bg-muted/20 flex-1 min-h-0 overflow-hidden">
                {(() => {
                  if (selectedDesign.diagram_type === 'text') {
                    return <TextDocumentPreview source={selectedDesign.source} kind={selectedDesign.kind} />;
                  }
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
                    return (
                      <PencilDiagram
                        key={selectedDesign.id}
                        projectId={projectId}
                        designId={selectedDesign.id}
                        title={selectedDesign.title}
                        mode="viewer"
                      />
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
              Select or create a document.
            </div>
          )}
        </div>
      </div>
        </div>
      </div>

      {/* Create/Edit dialog — canvas formats need far more width than the Mermaid textarea. */}
      <Dialog open={isEditOpen} onOpenChange={setIsEditOpen}>
        <DialogContent
          className={
            editForm.diagramType === 'text'
              ? 'flex h-[86vh] w-[96vw] min-w-[80vw] max-w-[1500px] flex-col gap-0 overflow-hidden p-0 sm:max-w-[1500px]'
              : editForm.diagramType === 'drawio' || editForm.diagramType === 'pen' || editForm.diagramType === 'reactflow' || editorMode === 'arch'
                ? 'flex h-[92vh] w-[96vw] min-w-[80vw] max-w-[1500px] flex-col gap-0 overflow-hidden p-0 sm:max-w-[1500px]'
                : 'w-[96vw] min-w-[80vw] max-w-[1500px] max-h-[85vh] overflow-y-auto sm:max-w-[1500px]'
          }
        >
          {editForm.diagramType === 'text' ? (
            <>
              <div className="flex flex-col gap-4 border-b bg-card px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
                <DialogHeader className="min-w-0 flex-1">
                  <DialogTitle>{editDesign ? `Edit ${editDesign.title}` : 'New text document'}</DialogTitle>
                  <DialogDescription>
                    Keep the project&apos;s specs, notes, and content close to the visual work they explain.
                  </DialogDescription>
                </DialogHeader>
                {formatSelector}
              </div>
              <div className="grid min-h-0 flex-1 grid-cols-1 gap-5 overflow-hidden p-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)]">
                <div className="flex min-h-0 flex-col gap-4">
                  <div className="grid shrink-0 grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_190px]">
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="text-document-title">Title</Label>
                      <Input
                        id="text-document-title"
                        value={editForm.title}
                        onChange={(e) => setEditForm((f) => ({ ...f, title: e.target.value }))}
                        placeholder="e.g. Product brief"
                      />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label>Document type</Label>
                      <Select value={TEXT_KIND_OPTIONS.some((option) => option.value === editForm.kind) ? editForm.kind : 'document'} onValueChange={handleKindChange}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {TEXT_KIND_OPTIONS.map((option) => (
                            <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div className="flex min-h-0 flex-1 flex-col gap-1.5">
                    <div className="flex items-center justify-between gap-3">
                      <Label htmlFor="text-document-source">Content</Label>
                      <span className="font-mono text-[10px] text-muted-foreground">{editForm.source.length.toLocaleString()} chars</span>
                    </div>
                    <Textarea
                      id="text-document-source"
                      value={editForm.source}
                      onChange={(e) => setEditForm((f) => ({ ...f, source: e.target.value }))}
                      placeholder={editForm.kind === 'markdown' ? '# Project overview\n\nWrite with Markdown…' : 'Start writing the context your project needs…'}
                      className="min-h-0 flex-1 resize-none rounded-xl bg-muted/20 px-4 py-3 font-mono text-sm leading-6"
                      spellCheck
                    />
                  </div>
                  <div className="flex shrink-0 flex-col gap-1.5">
                    <Label htmlFor="text-document-notes">Notes <span className="font-normal text-muted-foreground">(optional)</span></Label>
                    <Input
                      id="text-document-notes"
                      value={editForm.notes}
                      onChange={(e) => setEditForm((f) => ({ ...f, notes: e.target.value }))}
                      placeholder="What should someone know before reading this?"
                    />
                  </div>
                </div>
                <div className="flex min-h-0 flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <Label>Preview</Label>
                    {editForm.kind === 'markdown' && (
                      <span className="rounded-full bg-sky-100 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-sky-700 dark:bg-sky-950/60 dark:text-sky-300">
                        Markdown rendered
                      </span>
                    )}
                  </div>
                  <div className="min-h-0 flex-1 overflow-auto rounded-xl border bg-[#fcfaf5] p-6 shadow-inner dark:bg-stone-950">
                    <TextDocumentPreview source={editForm.source} kind={editForm.kind} />
                  </div>
                </div>
              </div>
              <DialogFooter className="border-t bg-card px-5 py-3">
                <p className="mr-auto hidden text-xs text-muted-foreground sm:block">
                  {editForm.kind === 'markdown'
                    ? 'Markdown renders live in the preview.'
                    : 'Text stays in this editor until you save the document.'}
                </p>
                <Button variant="outline" onClick={() => setIsEditOpen(false)}>Cancel</Button>
                <Button onClick={handleSave} disabled={isSaving}>
                  {isSaving ? 'Saving…' : editDesign ? 'Save changes' : 'Create document'}
                </Button>
              </DialogFooter>
            </>
          ) : editForm.diagramType === 'drawio' ? (
            <>
              <div className="flex flex-col gap-4 border-b bg-card px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
                <DialogHeader className="min-w-0 flex-1">
                  <DialogTitle>{editDesign ? `Edit ${editDesign.title}` : 'New diagram'}</DialogTitle>
                  <DialogDescription>
                    Build AWS architectures, workflows, swimlanes, BPMN, and sequence diagrams with the full visual studio.
                  </DialogDescription>
                </DialogHeader>
                {formatSelector}
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
              </div>
              <div className="min-h-0 flex-1 bg-slate-100 dark:bg-slate-950">
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
              <div className="flex flex-col gap-4 border-b bg-card px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
                <DialogHeader className="min-w-0 flex-1">
                  <DialogTitle>{editDesign ? `Edit ${editDesign.title}` : 'New diagram'}</DialogTitle>
                  <DialogDescription>Drag AWS icons onto the canvas, connect handles, click a node to edit it.</DialogDescription>
                </DialogHeader>
                {formatSelector}
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
              <div className="flex flex-col gap-4 border-b bg-card px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
                <DialogHeader className="min-w-0 flex-1">
                  <DialogTitle>{editDesign ? `Edit ${editDesign.title}` : 'New diagram'}</DialogTitle>
                  <DialogDescription>
                    Free-form design surface, powered by OpenPencil.
                  </DialogDescription>
                </DialogHeader>
                {formatSelector}
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
              </div>
              <div className="min-h-0 flex-1 bg-slate-100 dark:bg-slate-950">
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
              <div className="flex flex-col gap-4 border-b bg-card px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
                <DialogHeader className="min-w-0 flex-1">
                  <DialogTitle>{editDesign ? `Edit ${editDesign.title}` : 'New diagram'}</DialogTitle>
                  <DialogDescription>
                    Drag nodes to reposition them — structure, labels and icons come from the mermaid text on the left.
                  </DialogDescription>
                </DialogHeader>
                {formatSelector}
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
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <DialogHeader className="min-w-0 flex-1">
                  <DialogTitle>{editDesign ? 'Edit diagram' : 'New diagram'}</DialogTitle>
                  <DialogDescription>
                    Mermaid source is rendered live below as you type.
                  </DialogDescription>
                </DialogHeader>
                {formatSelector}
              </div>
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

function TextDocumentPreview({ source, kind }: { source: string; kind: string }) {
  if (!source.trim()) {
    return (
      <div className="flex h-full min-h-[180px] items-center justify-center text-center text-sm text-muted-foreground">
        Your saved content will read like this.
      </div>
    );
  }

  if (kind === 'markdown') {
    return <MarkdownDocumentPreview source={source} />;
  }

  return (
    <article className="h-full overflow-y-auto mx-auto max-w-3xl whitespace-pre-wrap break-words font-serif text-[15px] leading-7 text-stone-800 dark:text-stone-200">
      {source}
    </article>
  );
}

function MarkdownDocumentPreview({ source }: { source: string }) {
  const { html, mermaidBlocks } = useMemo(() => {
    const mermaidBlocks: string[] = [];
    const defaultRenderer = new marked.Renderer();
    const renderer = new marked.Renderer();
    renderer.code = (token: Tokens.Code) => {
      const language = token.lang?.trim().toLowerCase().split(/\s+/)[0];
      if (language === 'mermaid') {
        const index = mermaidBlocks.push(token.text) - 1;
        return `<div data-openmemory-mermaid-slot="${index}"></div>`;
      }
      return defaultRenderer.code(token);
    };

    return {
      html: DOMPurify.sanitize(marked.parse(source, { async: false, breaks: true, gfm: true, renderer })),
      mermaidBlocks,
    };
  }, [source]);
  const renderedParts = html.split(MERMAID_SLOT_PATTERN);

  return (
    <article
      className="h-full overflow-y-auto mx-auto max-w-3xl break-words text-[15px] leading-7 text-stone-800 dark:text-stone-200 [&_a]:font-medium [&_a]:text-sky-700 [&_a]:underline [&_a]:underline-offset-2 dark:[&_a]:text-sky-300 [&_blockquote]:my-5 [&_blockquote]:border-l-2 [&_blockquote]:border-amber-400/70 [&_blockquote]:pl-4 [&_blockquote]:italic [&_blockquote]:text-stone-600 dark:[&_blockquote]:text-stone-300 [&_code]:rounded [&_code]:bg-stone-900/10 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.9em] [&_h1]:mb-4 [&_h1]:mt-1 [&_h1]:text-3xl [&_h1]:font-semibold [&_h1]:leading-tight [&_h2]:mb-3 [&_h2]:mt-8 [&_h2]:text-2xl [&_h2]:font-semibold [&_h2]:leading-tight [&_h3]:mb-2 [&_h3]:mt-6 [&_h3]:text-xl [&_h3]:font-semibold [&_hr]:my-7 [&_hr]:border-stone-300 dark:[&_hr]:border-stone-700 [&_li]:my-1 [&_ol]:my-4 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:my-4 [&_pre]:my-5 [&_pre]:overflow-x-auto [&_pre]:rounded-xl [&_pre]:bg-stone-900 [&_pre]:p-4 [&_pre]:text-sm [&_pre]:leading-6 [&_pre]:text-stone-100 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_table]:my-5 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-stone-300 [&_td]:p-2 dark:[&_td]:border-stone-700 [&_th]:border [&_th]:border-stone-300 [&_th]:bg-stone-900/5 [&_th]:p-2 [&_th]:text-left dark:[&_th]:border-stone-700 dark:[&_th]:bg-stone-100/5 [&_ul]:my-4 [&_ul]:list-disc [&_ul]:pl-6 [&_ul]:text-stone-800 dark:[&_ul]:text-stone-200 [&_ul]:pl-6 [&_img]:max-w-full [&_input]:mr-2"
    >
      {renderedParts.map((part, index) => {
        if (index % 2 === 0) {
          return part ? <div key={`markdown-${index}`} dangerouslySetInnerHTML={{ __html: part }} /> : null;
        }

        const mermaidSource = mermaidBlocks[Number(part)];
        if (mermaidSource === undefined) return null;

        return (
          <div
            key={`mermaid-${part}`}
            className="my-6 h-[420px] min-h-[320px] w-full overflow-hidden rounded-xl border border-stone-200 bg-white/70 p-3 shadow-sm dark:border-stone-800 dark:bg-stone-950/70"
          >
            <MermaidDiagram source={mermaidSource} />
          </div>
        );
      })}
    </article>
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
