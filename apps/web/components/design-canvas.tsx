'use client';

// Note: this component must be imported with next/dynamic + ssr:false — it renders React Flow,
// which touches `document` at import time (same constraint as mermaid-diagram.tsx).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTheme } from 'next-themes';
import {
  Background, BackgroundVariant, Controls, MarkerType, MiniMap,
  ReactFlow, ReactFlowProvider, addEdge, applyNodeChanges, useEdgesState, useNodesState,
  type Connection, type Edge, type NodeChange, type OnNodeDrag,
  type OnConnect, type ReactFlowInstance, type Viewport,
} from '@xyflow/react';
import { Boxes, Group, Image as ImageIcon, LayoutGrid, Square, Trash2, Ungroup } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DesignNode } from '@/components/design-node';
import { DesignGroupNode } from '@/components/design-group-node';
import { applyDagreLayout } from '@/lib/design-layout';
import { exportDesignToPng } from '@/lib/design-export';
import { AWS_ICON_KEYS, awsIcon } from '@/lib/aws-icons';
import { BORDER_STYLES, BOX_COLORS, type BorderStyle, type BoxColor, type DesignGraph, type DesignNode as DesignNodeType, type DesignNodeData } from '@/lib/design-graph';

const nodeTypes = { design: DesignNode, group: DesignGroupNode };

// AWS "Squid Ink" in light mode — the connector/text color in official AWS architecture diagrams.
// Dark mode uses a light slate so connectors stay legible against a dark canvas. Canvas colors are
// literal (not theme CSS vars) throughout this file — see design-node.tsx for why.
const EDGE_COLOR_LIGHT = '#232f3e';
const EDGE_COLOR_DARK = '#94a3b8';
const CANVAS_BG_LIGHT = '#ffffff';
const CANVAS_BG_DARK = '#0a0a0a';

// Everything React Flow draws is themed through its own `--xy-*` CSS variables, and those are the
// ONLY reliable lever here. Tailwind arbitrary variants cannot target these elements: `_` means
// "space" inside an arbitrary value, so `[&_.react-flow__edge-path]:…` compiles to the selector
// `.react-flow edge-path` — a descendant *element* named `edge-path`, matching nothing. An earlier
// EDGE_CLASS in this spot did exactly that and was silently dead; edges were falling through to
// library defaults the whole time. Set the variables instead of writing selectors.
//
// React Flow's LIGHT theme also leaves several colors as `inherit`, assuming the page around the
// canvas is light too — on a light canvas embedded in this app's dark chrome they'd inherit the
// app's near-white `--foreground` and vanish (the zoom controls did exactly that). Pinning every
// color explicitly for BOTH modes — rather than only patching light mode and trusting the
// library's dark defaults — keeps this canvas' palette independent of upstream default changes.
//
// `--xy-node-*` here only reaches 'group' nodes: the library styles just its own built-in node
// types plus `.react-flow__node-group`, and our other type ('design') is custom, so it renders
// unstyled. Containers are deliberately unfilled and borderless at the wrapper level — the
// reference AWS diagrams draw containers as outlines only, a translucent fill compounds with every
// nesting level (Cloud > VPC > subnet stacking to a muddy grey), and the wrapper's own border would
// double-draw beneath the colored one design-group-node.tsx paints.
const CANVAS_VARS_LIGHT = {
  '--xy-controls-button-color': '#232f3e',
  '--xy-controls-button-color-hover': '#000000',
  '--xy-edge-label-color': '#232f3e',
  '--xy-edge-label-background-color': '#ffffff',
  '--xy-edge-stroke': '#232f3e',
  '--xy-edge-stroke-width': '1.5',
  '--xy-node-color': '#232f3e',
  '--xy-node-group-background-color': 'transparent',
  '--xy-node-border': 'none',
} as React.CSSProperties;
const CANVAS_VARS_DARK = {
  '--xy-controls-button-background-color': '#18181b',
  '--xy-controls-button-background-color-hover': '#27272a',
  '--xy-controls-button-color': '#e5e5e5',
  '--xy-controls-button-color-hover': '#ffffff',
  '--xy-controls-button-border-color': '#3f3f46',
  '--xy-edge-label-color': '#94a3b8',
  '--xy-edge-label-background-color': '#171717',
  '--xy-edge-stroke': '#94a3b8',
  '--xy-edge-stroke-width': '1.5',
  '--xy-node-color': '#e5e5e5',
  '--xy-node-group-background-color': 'transparent',
  '--xy-node-border': 'none',
} as React.CSSProperties;

// Kept in sync with design-node.tsx's own width and design-layout.ts's NODE_WIDTH/HEIGHT /
// GROUP_WIDTH/HEIGHT — this is the one spot all four get created from, those are the two spots
// that need to already agree with these numbers for layout/measurement to line up.
const DEFAULT_GROUP_WIDTH = 260;
const DEFAULT_GROUP_HEIGHT = 160;
const DEFAULT_NODE_WIDTH = 96;
// Pre-measurement fallback only, and deliberately the shortest real node — labels wrap freely
// (design-node.tsx), so heights vary from ~95px at one line to ~125px at three. `groupSelection`
// prefers `measured.height` and only lands here for a node React Flow hasn't measured yet.
const DEFAULT_NODE_HEIGHT = 96;
// Small solid-fill squares for the inspector's <SelectItem> swatches — distinct from the
// border-only classes in design-group-node.tsx since a filled swatch reads better at that size
// than an outline would.
const BOX_COLOR_SWATCH_CLASSES: Record<BoxColor, string> = {
  none: 'bg-neutral-400 dark:bg-neutral-600',
  slate: 'bg-slate-600 dark:bg-slate-400',
  purple: 'bg-purple-500 dark:bg-purple-400',
  teal: 'bg-teal-500 dark:bg-teal-400',
  orange: 'bg-orange-500 dark:bg-orange-400',
  green: 'bg-green-600 dark:bg-green-400',
};
const GROUP_ICON_DATA_KEY = 'application/openmemory-design-box';
const ICON_DATA_KEY = 'application/openmemory-design-icon';

interface DesignCanvasProps {
  initialGraph: DesignGraph;
  readOnly?: boolean;
  onChange?: (graph: DesignGraph) => void;
}

function iconLabel(key: string): string {
  return key.replace(/^aws-/, '').replace(/-/g, ' ');
}

/** Absolute canvas position of `node`, resolving through its parent chain (relevant once a node
 * has `parentId` — its own `.position` is relative to that parent, not the canvas). */
function absolutePosition(node: DesignNodeType, byId: Map<string, DesignNodeType>): { x: number; y: number } {
  let x = node.position.x;
  let y = node.position.y;
  let current = node;
  while (current.parentId) {
    const parent = byId.get(current.parentId);
    if (!parent) break;
    x += parent.position.x;
    y += parent.position.y;
    current = parent;
  }
  return { x, y };
}

function DesignCanvasInner({ initialGraph, readOnly, onChange }: DesignCanvasProps) {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  const edgeColor = isDark ? EDGE_COLOR_DARK : EDGE_COLOR_LIGHT;
  const canvasBg = isDark ? CANVAS_BG_DARK : CANVAS_BG_LIGHT;
  const canvasVars = isDark ? CANVAS_VARS_DARK : CANVAS_VARS_LIGHT;
  const edgeDefaults = useMemo(() => ({
    type: 'step' as const,
    style: { stroke: edgeColor, strokeWidth: 1.5 },
    markerEnd: { type: MarkerType.ArrowClosed, color: edgeColor, width: 18, height: 18 },
  }), [edgeColor]);
  const [nodes, setNodes, onNodesChangeRaw] = useNodesState<DesignNodeType>(initialGraph.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initialGraph.edges);
  const [viewport, setViewport] = useState<Viewport | undefined>(initialGraph.viewport);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [flow, setFlow] = useState<ReactFlowInstance<DesignNodeType, Edge> | null>(null);

  // Single source of truth for reporting state upward — fires on every nodes/edges/viewport
  // change regardless of which handler caused it (drag, connect, delete, palette drop, inspector
  // edit, auto-arrange), so no call site has to remember to report.
  useEffect(() => {
    onChange?.({ nodes, edges, viewport });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, viewport]);

  const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? null;
  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId) ?? null;
  const selectedNodes = nodes.filter((node) => node.selected);

  // Deleting a group node must never leave its children with a dangling `parentId` (that crashes
  // React Flow on next render, and `parseDesignGraph`'s sanitizeNodeHierarchy would otherwise
  // have to paper over it on reload). Treat it like ungroup-then-remove: any child of a node
  // being removed is un-parented back to its absolute canvas position first.
  const onNodesChange = useCallback((changes: NodeChange<DesignNodeType>[]) => {
    const removedIds = changes.filter((change) => change.type === 'remove').map((change) => change.id);
    if (removedIds.length === 0) {
      onNodesChangeRaw(changes);
      return;
    }
    setNodes((current) => {
      const removedSet = new Set(removedIds);
      const byId = new Map(current.map((node) => [node.id, node]));
      const patched = current.map((node) => {
        if (!node.parentId || !removedSet.has(node.parentId)) return node;
        const { parentId: _parentId, extent: _extent, ...rest } = node;
        return { ...rest, position: absolutePosition(node, byId) } as DesignNodeType;
      });
      return applyNodeChanges(changes, patched);
    });
  }, [onNodesChangeRaw, setNodes]);

  const patchSelected = (patch: Partial<DesignNodeData>) => {
    if (!selectedNodeId) return;
    setNodes((current) => current.map((node) =>
      node.id === selectedNodeId ? { ...node, data: { ...node.data, ...patch } } : node
    ));
  };

  const patchSelectedEdge = (patch: Partial<Edge>) => {
    if (!selectedEdgeId) return;
    setEdges((current) => current.map((edge) =>
      edge.id === selectedEdgeId ? { ...edge, ...patch } : edge
    ));
  };

  const removeSelectedEdge = () => {
    if (!selectedEdgeId) return;
    setEdges((current) => current.filter((edge) => edge.id !== selectedEdgeId));
    setSelectedEdgeId(null);
  };

  const removeSelected = () => {
    if (!selectedNodeId) return;
    onNodesChange([{ type: 'remove', id: selectedNodeId }]);
    setEdges((current) => current.filter((edge) => edge.source !== selectedNodeId && edge.target !== selectedNodeId));
    setSelectedNodeId(null);
  };

  const addNode = useCallback((position: { x: number; y: number }, icon?: string) => {
    const node: DesignNodeType = {
      id: `node_${crypto.randomUUID()}`,
      type: 'design',
      position,
      data: { label: icon ? iconLabel(icon) : 'New node', icon },
    };
    setNodes((current) => [...current, node]);
    setSelectedNodeId(node.id);
  }, [setNodes]);

  const addGroupNode = useCallback((position: { x: number; y: number }) => {
    const node: DesignNodeType = {
      id: `node_${crypto.randomUUID()}`,
      type: 'group',
      position,
      width: DEFAULT_GROUP_WIDTH,
      height: DEFAULT_GROUP_HEIGHT,
      data: { label: 'Box', borderStyle: 'solid' },
    };
    setNodes((current) => [...current, node]);
    setSelectedNodeId(node.id);
  }, [setNodes]);

  const onConnect: OnConnect = useCallback((connection: Connection) => {
    setEdges((current) => addEdge({ ...connection, id: `edge_${connection.source}_${connection.target}_${crypto.randomUUID()}`, ...edgeDefaults }, current));
  }, [edgeDefaults, setEdges]);

  const onDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    if (!flow || readOnly) return;
    const position = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    if (event.dataTransfer.getData(GROUP_ICON_DATA_KEY)) {
      addGroupNode(position);
      return;
    }
    const iconKey = event.dataTransfer.getData(ICON_DATA_KEY);
    addNode(position, iconKey || undefined);
  }, [addGroupNode, addNode, flow, readOnly]);

  // Bounding-box-and-reparent for a multi-selection — computes a group box sized to fit the
  // selected (top-level only; already-nested nodes are skipped to avoid cross-parent moves) nodes
  // plus padding, then converts each child's position from canvas-absolute to group-relative.
  // `parentId` is set WITHOUT `extent: 'parent'` — that would hard-clamp drags to stay inside the
  // box, which would make it impossible to ever drag a node back out (checklist item 7).
  const groupSelection = useCallback(() => {
    const targets = nodes.filter((node) => node.selected && !node.parentId);
    if (targets.length < 2) return;
    const PADDING_H = 24;
    const PADDING_TOP = 40;
    const PADDING_BOTTOM = 24;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const node of targets) {
      const width = node.width ?? node.measured?.width ?? DEFAULT_NODE_WIDTH;
      const height = node.height ?? node.measured?.height ?? DEFAULT_NODE_HEIGHT;
      minX = Math.min(minX, node.position.x);
      minY = Math.min(minY, node.position.y);
      maxX = Math.max(maxX, node.position.x + width);
      maxY = Math.max(maxY, node.position.y + height);
    }
    const groupX = minX - PADDING_H;
    const groupY = minY - PADDING_TOP;
    const groupId = `node_${crypto.randomUUID()}`;
    const targetIds = new Set(targets.map((node) => node.id));
    const groupNode: DesignNodeType = {
      id: groupId,
      type: 'group',
      position: { x: groupX, y: groupY },
      width: maxX - minX + PADDING_H * 2,
      height: maxY - minY + PADDING_TOP + PADDING_BOTTOM,
      data: { label: 'Box', borderStyle: 'solid' },
    };
    setNodes((current) => {
      const rest = current.filter((node) => !targetIds.has(node.id));
      const children = current
        .filter((node) => targetIds.has(node.id))
        .map((node) => ({
          ...node,
          parentId: groupId,
          selected: false,
          position: { x: node.position.x - groupX, y: node.position.y - groupY },
        }));
      return [...rest, groupNode, ...children];
    });
    setSelectedNodeId(groupId);
  }, [nodes, setNodes]);

  // Un-parents a group's children back to their absolute canvas position, then removes the group
  // node itself. Same math as the delete-cascade in `onNodesChange`, invoked explicitly.
  const ungroupSelected = useCallback(() => {
    if (!selectedNode || selectedNode.type !== 'group') return;
    onNodesChange([{ type: 'remove', id: selectedNode.id }]);
    setSelectedNodeId(null);
  }, [onNodesChange, selectedNode]);

  // Reparents a dragged node into whichever group box it's dropped on (entering), or un-parents
  // it back to the canvas root if it no longer overlaps its current parent (exiting). Ported from
  // homelable's CanvasContainer.tsx drag-into-group pattern.
  const onNodeDragStop: OnNodeDrag<DesignNodeType> = useCallback((_event, node) => {
    if (readOnly || !flow || node.type === 'group') return;
    const overlappingGroup = flow
      .getIntersectingNodes({ id: node.id }, false)
      .find((candidate) => candidate.type === 'group');

    if (overlappingGroup && overlappingGroup.id !== node.parentId) {
      setNodes((current) => {
        const byId = new Map(current.map((n) => [n.id, n]));
        const dragged = byId.get(node.id);
        const group = byId.get(overlappingGroup.id);
        if (!dragged || !group) return current;
        const abs = absolutePosition(dragged, byId);
        const reparented: DesignNodeType = {
          ...dragged,
          parentId: group.id,
          position: { x: abs.x - group.position.x, y: abs.y - group.position.y },
        };
        const withoutDragged = current.filter((n) => n.id !== node.id);
        const groupIdx = withoutDragged.findIndex((n) => n.id === group.id);
        return [...withoutDragged.slice(0, groupIdx + 1), reparented, ...withoutDragged.slice(groupIdx + 1)];
      });
    } else if (!overlappingGroup && node.parentId) {
      setNodes((current) => {
        const byId = new Map(current.map((n) => [n.id, n]));
        const dragged = byId.get(node.id);
        if (!dragged) return current;
        const abs = absolutePosition(dragged, byId);
        const { parentId: _parentId, extent: _extent, ...rest } = dragged;
        return current.map((n) => (n.id === node.id ? ({ ...rest, position: abs } as DesignNodeType) : n));
      });
    }
  }, [flow, readOnly, setNodes]);

  const autoArrange = () => {
    setNodes((current) => applyDagreLayout(current, edges));
    window.requestAnimationFrame(() => flow?.fitView());
  };

  const exportPng = async () => {
    const viewportEl = document.querySelector<HTMLElement>('.react-flow__viewport');
    if (!viewportEl) {
      toast.error('Nothing to export');
      return;
    }
    try {
      await exportDesignToPng(viewportEl, canvasBg);
    } catch {
      toast.error('Failed to export PNG');
    }
  };

  return (
    <div
      className={`grid h-full min-h-0 grid-cols-1 overflow-hidden rounded-md ${
        readOnly ? '' : 'md:grid-cols-[200px_minmax(0,1fr)_280px]'
      }`}
    >
      {!readOnly && (
        <aside className="space-y-3 overflow-y-auto border-b bg-muted/20 p-3 md:border-b-0 md:border-r">
          <div className="flex items-center justify-between">
            <Label className="text-xs">Nodes</Label>
            <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => addNode({ x: 100, y: 100 })}>
              <Boxes className="mr-1 h-3 w-3" />
              Blank
            </Button>
          </div>
          <button
            type="button"
            draggable
            onDragStart={(event) => {
              event.dataTransfer.setData(GROUP_ICON_DATA_KEY, '1');
              event.dataTransfer.effectAllowed = 'move';
            }}
            onClick={() => addGroupNode({ x: 80, y: 80 })}
            className="flex w-full cursor-grab items-center gap-2 rounded-md border border-dashed bg-card px-2 py-2 text-xs font-medium shadow-sm transition hover:border-primary/50 active:cursor-grabbing"
          >
            <Square className="h-3.5 w-3.5" />
            Box (annotation / container)
          </button>
          <div className="grid grid-cols-3 gap-1.5">
            {AWS_ICON_KEYS.map((key) => {
              const icon = awsIcon(key);
              return (
                <button
                  key={key}
                  type="button"
                  draggable
                  title={iconLabel(key)}
                  onDragStart={(event) => {
                    event.dataTransfer.setData(ICON_DATA_KEY, key);
                    event.dataTransfer.effectAllowed = 'move';
                  }}
                  onClick={() => addNode({ x: 100, y: 100 }, key)}
                  className="flex aspect-square cursor-grab items-center justify-center rounded-md border bg-card p-1.5 shadow-sm transition hover:border-primary/50 active:cursor-grabbing"
                >
                  {icon && <svg viewBox={icon.viewBox} className="h-full w-full" dangerouslySetInnerHTML={{ __html: icon.body }} />}
                </button>
              );
            })}
          </div>
        </aside>
      )}

      <main
        className="relative h-full min-h-[400px] min-w-0 bg-white dark:bg-neutral-950"
        onDrop={onDrop}
        onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }}
      >
        <ReactFlow<DesignNodeType, Edge>
          colorMode={isDark ? 'dark' : 'light'}
          /* Styling lives entirely in `canvasVars` below — see the note there on why Tailwind
             arbitrary variants can't target React Flow's internals. */
          defaultMarkerColor={edgeColor}
          style={{ backgroundColor: canvasBg, ...canvasVars }}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onInit={setFlow}
          onMoveEnd={(_, nextViewport) => setViewport(nextViewport)}
          onNodeClick={(_, node) => { setSelectedNodeId(node.id); setSelectedEdgeId(null); }}
          onEdgeClick={(_, edge) => { setSelectedEdgeId(edge.id); setSelectedNodeId(null); }}
          onNodeDragStop={onNodeDragStop}
          onPaneClick={() => { setSelectedNodeId(null); setSelectedEdgeId(null); }}
          onNodesDelete={(deleted) => { if (deleted.some((node) => node.id === selectedNodeId)) setSelectedNodeId(null); }}
          onEdgesDelete={(deleted) => { if (deleted.some((edge) => edge.id === selectedEdgeId)) setSelectedEdgeId(null); }}
          fitView
          minZoom={0.35}
          maxZoom={1.8}
          defaultEdgeOptions={edgeDefaults}
          deleteKeyCode={['Backspace', 'Delete']}
          nodesDraggable={!readOnly}
          nodesConnectable={!readOnly}
          elementsSelectable={!readOnly}
        >
          {/* Dots are an editing aid — the read-only preview stays a clean flat surface so it reads
              (and exports) like the reference AWS diagram rather than like a canvas. */}
          <Background
            variant={readOnly ? BackgroundVariant.Lines : BackgroundVariant.Dots}
            gap={20}
            size={1}
            color={readOnly ? canvasBg : (isDark ? '#3f3f46' : '#d4d4d8')}
            bgColor={canvasBg}
          />
          {!readOnly && (
            <MiniMap
              pannable
              zoomable
              className="!border !border-neutral-200 dark:!border-neutral-700 !bg-white dark:!bg-neutral-900"
              nodeColor={isDark ? '#64748b' : '#94a3b8'}
              maskColor={isDark ? 'rgba(0,0,0,0.5)' : 'rgba(15,23,42,0.08)'}
            />
          )}
          <Controls showInteractive={false} className="!overflow-hidden !rounded-lg !border !border-neutral-200 dark:!border-neutral-700 !shadow-sm" />
        </ReactFlow>
        <div className="pointer-events-none absolute left-3 top-3 flex flex-wrap gap-2">
          {!readOnly && (
            <Button type="button" size="sm" variant="outline" className="pointer-events-auto gap-1.5 border-neutral-300 bg-white/90 text-neutral-800 backdrop-blur hover:bg-white dark:border-neutral-700 dark:bg-neutral-900/90 dark:text-neutral-100 dark:hover:bg-neutral-900" onClick={autoArrange}>
              <LayoutGrid className="h-3.5 w-3.5" />
              Auto-arrange
            </Button>
          )}
          {!readOnly && selectedNodes.length >= 2 && (
            <Button type="button" size="sm" variant="outline" className="pointer-events-auto gap-1.5 border-neutral-300 bg-white/90 text-neutral-800 backdrop-blur hover:bg-white dark:border-neutral-700 dark:bg-neutral-900/90 dark:text-neutral-100 dark:hover:bg-neutral-900" onClick={groupSelection}>
              <Group className="h-3.5 w-3.5" />
              Group selection
            </Button>
          )}
          {!readOnly && selectedNode?.type === 'group' && (
            <Button type="button" size="sm" variant="outline" className="pointer-events-auto gap-1.5 border-neutral-300 bg-white/90 text-neutral-800 backdrop-blur hover:bg-white dark:border-neutral-700 dark:bg-neutral-900/90 dark:text-neutral-100 dark:hover:bg-neutral-900" onClick={ungroupSelected}>
              <Ungroup className="h-3.5 w-3.5" />
              Ungroup
            </Button>
          )}
          <Button type="button" size="sm" variant="outline" className="pointer-events-auto gap-1.5 border-neutral-300 bg-white/90 text-neutral-800 backdrop-blur hover:bg-white dark:border-neutral-700 dark:bg-neutral-900/90 dark:text-neutral-100 dark:hover:bg-neutral-900" onClick={exportPng}>
            <ImageIcon className="h-3.5 w-3.5" />
            Export PNG
          </Button>
        </div>
      </main>

      {!readOnly && (
        <aside className="overflow-y-auto border-t bg-card p-3 md:border-l md:border-t-0">
          {selectedNode ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold">{selectedNode.type === 'group' ? 'Box' : 'Node'}</p>
                <Button variant="ghost" size="icon" onClick={removeSelected}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Label</Label>
                <Input value={selectedNode.data.label} onChange={(e) => patchSelected({ label: e.target.value })} />
              </div>
              {selectedNode.type === 'group' ? (
                <>
                  <div className="space-y-1">
                    <Label className="text-xs">Border style</Label>
                    <Select
                      value={selectedNode.data.borderStyle ?? 'solid'}
                      onValueChange={(value) => patchSelected({ borderStyle: value as BorderStyle })}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {BORDER_STYLES.map((style) => (
                          <SelectItem key={style} value={style} className="capitalize">
                            {style}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Border color</Label>
                    <Select
                      value={selectedNode.data.borderColor ?? 'none'}
                      onValueChange={(value) => patchSelected({ borderColor: value as BoxColor })}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {BOX_COLORS.map((color) => (
                          <SelectItem key={color} value={color} className="capitalize">
                            <span className="flex items-center gap-2">
                              <span className={`h-2.5 w-2.5 rounded-sm ${BOX_COLOR_SWATCH_CLASSES[color]}`} />
                              {color}
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Icon key</Label>
                    <Input
                      value={selectedNode.data.icon ?? ''}
                      onChange={(e) => patchSelected({ icon: e.target.value.trim() || undefined })}
                      placeholder="aws (blank = plain box, e.g. AWS Cloud wrapper)"
                    />
                  </div>
                </>
              ) : (
                <>
                  <div className="space-y-1">
                    <Label className="text-xs">Icon key</Label>
                    <Input
                      value={selectedNode.data.icon ?? ''}
                      onChange={(e) => patchSelected({ icon: e.target.value.trim() || undefined })}
                      placeholder="aws-lambda (blank = generic)"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Note</Label>
                    <Textarea rows={4} value={selectedNode.data.note ?? ''} onChange={(e) => patchSelected({ note: e.target.value })} />
                  </div>
                </>
              )}
            </div>
          ) : selectedEdge ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold">Edge</p>
                <Button variant="ghost" size="icon" onClick={removeSelectedEdge}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Label</Label>
                <Input
                  value={typeof selectedEdge.label === 'string' ? selectedEdge.label : ''}
                  onChange={(e) => patchSelectedEdge({ label: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Style</Label>
                <Select
                  value={selectedEdge.style?.strokeDasharray ? 'dashed' : 'solid'}
                  onValueChange={(value) => patchSelectedEdge({
                    style: {
                      ...selectedEdge.style,
                      strokeDasharray: value === 'dashed' ? '6 4' : undefined,
                    },
                  })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="solid">Solid</SelectItem>
                    <SelectItem value="dashed">Dashed</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          ) : (
            <div className="flex h-full min-h-40 flex-col items-center justify-center text-center text-muted-foreground">
              <Boxes className="mb-2 h-6 w-6 opacity-30" />
              <p className="text-xs">Select a node to edit it.</p>
            </div>
          )}
        </aside>
      )}
    </div>
  );
}

export function DesignCanvas(props: DesignCanvasProps) {
  return (
    <ReactFlowProvider>
      <DesignCanvasInner {...props} />
    </ReactFlowProvider>
  );
}
