'use client';

// The 'junction' React Flow node type — architecture-beta's plain routing dot (no icon, no
// label), used to bend an edge without attaching it to a real service/group. 12x12, matching the
// width/height mermaid-architecture.ts sets on parsed junction nodes. Dual-purpose handles on all
// four sides so an edge can enter/exit whichever side reads best, same pattern as design-node.tsx
// and design-group-node.tsx. Colors are literal (not theme CSS vars) — see design-node.tsx for why.

import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { DesignNode as DesignNodeType } from '@/lib/design-graph';

const HANDLE_POSITIONS = [Position.Top, Position.Right, Position.Bottom, Position.Left] as const;

const HANDLE_CLASS = '!h-2 !w-2 !border !border-white dark:!border-neutral-950 !bg-neutral-500/70 opacity-0 transition-opacity group-hover:opacity-100';

export function DesignJunctionNode({ selected }: NodeProps<DesignNodeType>) {
  return (
    <div className="group relative flex h-3 w-3 items-center justify-center">
      {HANDLE_POSITIONS.map((position) => (
        <span key={position}>
          <Handle type="target" position={position} id={`${position}-target`} className={HANDLE_CLASS} />
          <Handle type="source" position={position} id={`${position}-source`} className={HANDLE_CLASS} />
        </span>
      ))}
      <span
        className={`h-2 w-2 rounded-full bg-neutral-400 dark:bg-neutral-600 ${
          selected ? 'ring-2 ring-blue-500 ring-offset-1 ring-offset-white dark:ring-offset-neutral-950' : ''
        }`}
      />
    </div>
  );
}
