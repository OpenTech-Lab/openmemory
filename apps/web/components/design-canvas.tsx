'use client';

// Note: this component must be imported with next/dynamic + ssr:false — it renders React Flow,
// which touches `document` at import time (same constraint as mermaid-diagram.tsx).

import { useCallback, useEffect, useState } from 'react';
import { useTheme } from 'next-themes';
import {
  Background, BackgroundVariant, Controls, MarkerType, MiniMap,
  ReactFlow, ReactFlowProvider, addEdge, useEdgesState, useNodesState,
  type Connection, type Edge, type OnConnect, type ReactFlowInstance, type Viewport,
} from '@xyflow/react';
import { Boxes, Image as ImageIcon, LayoutGrid, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { DesignNode } from '@/components/design-node';
import { applyDagreLayout } from '@/lib/design-layout';
import { exportDesignToPng } from '@/lib/design-export';
import { AWS_ICON_KEYS, awsIcon } from '@/lib/aws-icons';
import type { DesignGraph, DesignNode as DesignNodeType, DesignNodeData } from '@/lib/design-graph';

const nodeTypes = { design: DesignNode };
const edgeDefaults = { type: 'smoothstep', markerEnd: { type: MarkerType.ArrowClosed } };

interface DesignCanvasProps {
  initialGraph: DesignGraph;
  readOnly?: boolean;
  onChange?: (graph: DesignGraph) => void;
}

function iconLabel(key: string): string {
  return key.replace(/^aws-/, '').replace(/-/g, ' ');
}

function DesignCanvasInner({ initialGraph, readOnly, onChange }: DesignCanvasProps) {
  const { resolvedTheme } = useTheme();
  const [nodes, setNodes, onNodesChange] = useNodesState<DesignNodeType>(initialGraph.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initialGraph.edges);
  const [viewport, setViewport] = useState<Viewport | undefined>(initialGraph.viewport);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [flow, setFlow] = useState<ReactFlowInstance<DesignNodeType, Edge> | null>(null);

  // Single source of truth for reporting state upward — fires on every nodes/edges/viewport
  // change regardless of which handler caused it (drag, connect, delete, palette drop, inspector
  // edit, auto-arrange), so no call site has to remember to report.
  useEffect(() => {
    onChange?.({ nodes, edges, viewport });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, viewport]);

  const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? null;

  const patchSelected = (patch: Partial<DesignNodeData>) => {
    if (!selectedNodeId) return;
    setNodes((current) => current.map((node) =>
      node.id === selectedNodeId ? { ...node, data: { ...node.data, ...patch } } : node
    ));
  };

  const removeSelected = () => {
    if (!selectedNodeId) return;
    setNodes((current) => current.filter((node) => node.id !== selectedNodeId));
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

  const onConnect: OnConnect = useCallback((connection: Connection) => {
    setEdges((current) => addEdge({ ...connection, id: `edge_${connection.source}_${connection.target}_${crypto.randomUUID()}`, ...edgeDefaults }, current));
  }, [setEdges]);

  const onDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    if (!flow || readOnly) return;
    const iconKey = event.dataTransfer.getData('application/openmemory-design-icon');
    addNode(flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }), iconKey || undefined);
  }, [addNode, flow, readOnly]);

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
      await exportDesignToPng(viewportEl);
    } catch {
      toast.error('Failed to export PNG');
    }
  };

  return (
    <div
      className={`grid h-full min-h-0 grid-cols-1 overflow-hidden rounded-md border ${
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
                    event.dataTransfer.setData('application/openmemory-design-icon', key);
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
        className="relative h-full min-h-[400px] min-w-0 bg-[radial-gradient(circle_at_center,var(--color-muted)_1px,transparent_1px)] bg-[size:20px_20px]"
        onDrop={onDrop}
        onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }}
      >
        <ReactFlow<DesignNodeType, Edge>
          colorMode={resolvedTheme === 'dark' ? 'dark' : 'light'}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onInit={setFlow}
          onMoveEnd={(_, nextViewport) => setViewport(nextViewport)}
          onNodeClick={(_, node) => setSelectedNodeId(node.id)}
          onPaneClick={() => setSelectedNodeId(null)}
          onNodesDelete={(deleted) => { if (deleted.some((node) => node.id === selectedNodeId)) setSelectedNodeId(null); }}
          fitView
          minZoom={0.35}
          maxZoom={1.8}
          defaultEdgeOptions={edgeDefaults}
          deleteKeyCode={['Backspace', 'Delete']}
          nodesDraggable={!readOnly}
          nodesConnectable={!readOnly}
          elementsSelectable={!readOnly}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--border)" />
          <MiniMap pannable zoomable className="!border !bg-card" nodeColor="var(--foreground)" maskColor="color-mix(in oklab, var(--background) 72%, transparent)" />
          <Controls showInteractive={false} className="!overflow-hidden !rounded-lg !border !shadow-sm" />
        </ReactFlow>
        <div className="pointer-events-none absolute left-3 top-3 flex gap-2">
          {!readOnly && (
            <Button type="button" size="sm" variant="outline" className="pointer-events-auto gap-1.5 bg-background/85 backdrop-blur" onClick={autoArrange}>
              <LayoutGrid className="h-3.5 w-3.5" />
              Auto-arrange
            </Button>
          )}
          <Button type="button" size="sm" variant="outline" className="pointer-events-auto gap-1.5 bg-background/85 backdrop-blur" onClick={exportPng}>
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
                <p className="text-sm font-semibold">Node</p>
                <Button variant="ghost" size="icon" onClick={removeSelected}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Label</Label>
                <Input value={selectedNode.data.label} onChange={(e) => patchSelected({ label: e.target.value })} />
              </div>
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
