'use client';

// The 'design' React Flow node type — structurally follows workflows-panel.tsx's HttpStepNode
// (bordered card, left/right handles, same selected-state ring) so the design canvas visually
// matches the existing workflow canvas. No inline label editing here — that lives in
// design-canvas.tsx's inspector panel.

import { Handle, Position, type NodeProps } from '@xyflow/react';
import { awsIcon } from '@/lib/aws-icons';
import { designKindMeta } from '@/lib/design-meta';
import type { DesignNode as DesignNodeType } from '@/lib/design-graph';

export function DesignNode({ data, selected }: NodeProps<DesignNodeType>) {
  const icon = data.icon ? awsIcon(data.icon) : null;
  const FallbackIcon = designKindMeta(data.kind ?? '').icon;

  return (
    <div
      className={`group w-[200px] overflow-hidden rounded-xl border bg-card text-card-foreground shadow-[0_12px_35px_-18px_rgba(0,0,0,.7)] transition-all ${
        selected ? 'border-primary ring-2 ring-primary/20' : 'border-border hover:border-foreground/25'
      }`}
    >
      <Handle type="target" position={Position.Left} className="!h-3 !w-3 !border-2 !border-background !bg-foreground" />
      <div className="flex items-center gap-2 px-3 py-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted/60">
          {icon ? (
            <svg viewBox={icon.viewBox} className="h-5 w-5" dangerouslySetInnerHTML={{ __html: icon.body }} />
          ) : (
            <FallbackIcon className="h-4 w-4 text-muted-foreground" />
          )}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs font-semibold">{data.label || 'Untitled'}</span>
      </div>
      <Handle type="source" position={Position.Right} className="!h-3 !w-3 !border-2 !border-background !bg-primary" />
    </div>
  );
}
