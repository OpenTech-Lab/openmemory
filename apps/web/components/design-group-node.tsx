'use client';

// The 'group' React Flow node type — a plain bordered container box (AWS diagram "group" style).
// With no `data.icon` it reads as a generic labeled box (label centered on the top edge); with
// `data.icon` set it reads as an "AWS Cloud"-style outer wrapper (icon chip + label pinned to the
// top-left corner). Both are the same node type — purely data-driven, no name special-casing.
// Follows the app's light/dark theme (see design-canvas.tsx).

import { NodeResizer, type NodeProps } from '@xyflow/react';
import { awsIcon } from '@/lib/aws-icons';
import type { DesignNode as DesignNodeType } from '@/lib/design-graph';

const BORDER_WIDTH = 1.5;

export function DesignGroupNode({ data, selected }: NodeProps<DesignNodeType>) {
  const icon = data.icon ? awsIcon(data.icon) : null;
  const borderStyle = data.borderStyle ?? 'solid';
  const label = data.label || 'Box';

  return (
    <div className="relative h-full w-full">
      <NodeResizer
        isVisible={selected}
        minWidth={120}
        minHeight={80}
        lineClassName="!border-blue-500 dark:!border-blue-400"
        handleClassName="!h-2.5 !w-2.5 !rounded-sm !border !border-blue-500 dark:!border-blue-400 !bg-white dark:!bg-neutral-900"
      />

      {/* Fill + border layer — pointer-events none so dragged/dropped children underneath (and
          the pane behind an empty box) stay clickable/draggable through the box's interior.
          Canvas follows the app theme, so colors here branch via Tailwind's `dark:` variant
          rather than theme CSS vars (see design-node.tsx for why those don't track correctly). */}
      <div
        className={`pointer-events-none absolute inset-0 rounded-md bg-neutral-900/[0.02] dark:bg-white/[0.04] ${
          selected ? 'border-blue-500 dark:border-blue-400' : 'border-neutral-400 dark:border-neutral-600'
        }`}
        style={{ borderWidth: BORDER_WIDTH, borderStyle }}
      />

      {/* Labels sit INSIDE the box, leaving the border unbroken — that's how the reference AWS
          diagram reads. Icon present => corner-anchored wrapper ("AWS Cloud"); otherwise a plain
          container with its title centered along the top. */}
      {icon ? (
        <div className="pointer-events-none absolute left-2 top-2 flex items-center gap-1.5 text-neutral-800 dark:text-neutral-200">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center">
            <svg viewBox={icon.viewBox} className="h-5 w-5" dangerouslySetInnerHTML={{ __html: icon.body }} />
          </span>
          <span className="text-[11px] font-semibold leading-none">{label}</span>
        </div>
      ) : (
        <div className="pointer-events-none absolute left-1/2 top-2 -translate-x-1/2">
          <span className="whitespace-nowrap text-[11px] font-semibold leading-none text-neutral-700 dark:text-neutral-300">{label}</span>
        </div>
      )}
    </div>
  );
}
