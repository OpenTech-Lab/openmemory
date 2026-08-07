'use client';

// The 'group' React Flow node type — a plain bordered container box (AWS diagram "group" style).
// With no `data.icon` it reads as a generic labeled box (label centered on the top edge); with
// `data.icon` set it reads as an "AWS Cloud"-style outer wrapper (icon chip + label pinned to the
// top-left corner). Both are the same node type — purely data-driven, no name special-casing.
// Follows the app's light/dark theme (see design-canvas.tsx).

import { NodeResizer, type NodeProps } from '@xyflow/react';
import { awsIcon } from '@/lib/aws-icons';
import type { BoxColor, DesignNode as DesignNodeType } from '@/lib/design-graph';

const BORDER_WIDTH = 1.5;

// AWS diagram convention: color distinguishes nesting level (VPC vs. subnet vs. outer cloud
// box), not fill — the box interior stays neutral (see the fill layer below) and only the
// border stroke + label text pick up the accent, matching how the reference AWS diagrams use
// color purely as an outline/label cue.
const BORDER_COLOR_CLASSES: Record<BoxColor, string> = {
  none: 'border-neutral-400 dark:border-neutral-600',
  slate: 'border-slate-600 dark:border-slate-400',
  purple: 'border-purple-500 dark:border-purple-400',
  teal: 'border-teal-500 dark:border-teal-400',
  orange: 'border-orange-500 dark:border-orange-400',
  green: 'border-green-600 dark:border-green-400',
};
const LABEL_COLOR_CLASSES: Record<BoxColor, string> = {
  none: 'text-neutral-700 dark:text-neutral-300',
  slate: 'text-slate-700 dark:text-slate-300',
  purple: 'text-purple-700 dark:text-purple-300',
  teal: 'text-teal-700 dark:text-teal-300',
  orange: 'text-orange-700 dark:text-orange-300',
  green: 'text-green-700 dark:text-green-300',
};

export function DesignGroupNode({ data, selected }: NodeProps<DesignNodeType>) {
  const icon = data.icon ? awsIcon(data.icon) : null;
  const borderStyle = data.borderStyle ?? 'solid';
  const label = data.label || 'Box';
  const borderColor = data.borderColor ?? 'none';

  return (
    <div className="relative h-full w-full">
      <NodeResizer
        isVisible={selected}
        minWidth={120}
        minHeight={80}
        lineClassName="!border-blue-500 dark:!border-blue-400"
        handleClassName="!h-2.5 !w-2.5 !rounded-sm !border !border-blue-500 dark:!border-blue-400 !bg-white dark:!bg-neutral-900"
      />

      {/* Border layer — pointer-events none so dragged/dropped children underneath (and the pane
          behind an empty box) stay clickable/draggable through the box's interior.
          Deliberately unfilled: the reference AWS diagrams draw containers as outlines only, and
          a translucent fill compounds with every nesting level (Cloud > VPC > subnet stacking to
          a muddy grey), which also washes out the border colors that mark those levels apart.
          Canvas follows the app theme, so colors here branch via Tailwind's `dark:` variant
          rather than theme CSS vars (see design-node.tsx for why those don't track correctly). */}
      <div
        className={`pointer-events-none absolute inset-0 rounded-md ${
          selected ? 'border-blue-500 dark:border-blue-400' : BORDER_COLOR_CLASSES[borderColor]
        }`}
        style={{ borderWidth: BORDER_WIDTH, borderStyle }}
      />

      {/* Labels sit INSIDE the box, leaving the border unbroken — that's how the reference AWS
          diagram reads. Icon present => corner-anchored wrapper ("AWS Cloud"); otherwise a plain
          container with its title centered along the top. */}
      {/* `right-2`/`max-w-[...]` cap the label's width to the box's own width (minus padding) so a
          long title wraps onto further lines instead of forcing the box wider or overflowing it —
          `whitespace-nowrap` used to do exactly that. */}
      {icon ? (
        <div className={`pointer-events-none absolute left-2 right-2 top-2 flex items-start gap-1.5 ${LABEL_COLOR_CLASSES[borderColor]}`}>
          <span className="flex h-5 w-5 shrink-0 items-center justify-center">
            <svg viewBox={icon.viewBox} className="h-5 w-5" dangerouslySetInnerHTML={{ __html: icon.body }} />
          </span>
          <span className="break-words text-[11px] font-semibold leading-tight">{label}</span>
        </div>
      ) : (
        <div className="pointer-events-none absolute left-1/2 top-2 max-w-[calc(100%-1.5rem)] -translate-x-1/2 text-center">
          <span className={`break-words text-[11px] font-semibold leading-tight ${LABEL_COLOR_CLASSES[borderColor]}`}>{label}</span>
        </div>
      )}
    </div>
  );
}
