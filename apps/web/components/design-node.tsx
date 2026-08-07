'use client';

// The 'design' React Flow node type — AWS Architecture Icons style: a small icon floating over
// the canvas (no card/border/background) with a centered label below it. Handles sit on all four
// sides, each doubling as source+target, so edges can enter/exit from whichever side reads best
// for orthogonal ('step') routing — matching docs/refer/aws_strcuture_sample.png.

import { Handle, Position, type NodeProps } from '@xyflow/react';
import { awsIcon } from '@/lib/aws-icons';
import { designKindMeta } from '@/lib/design-meta';
import type { DesignNode as DesignNodeType } from '@/lib/design-graph';

const HANDLE_POSITIONS = [Position.Top, Position.Right, Position.Bottom, Position.Left] as const;

// The canvas surface follows the app's light/dark theme (see design-canvas.tsx), so node chrome
// uses fixed neutral colors branched via Tailwind's `dark:` variant rather than theme CSS vars
// like `text-foreground` — those resolve relative to the *app* theme, not necessarily matching
// what the canvas itself is doing, and vanished entirely during earlier iterations of this canvas
// when it was briefly forced fixed-light against a dark app.
const HANDLE_CLASS = '!h-2.5 !w-2.5 !border-2 !border-white dark:!border-neutral-950 !bg-neutral-500/70 opacity-0 transition-opacity group-hover:opacity-100';

export function DesignNode({ data, selected }: NodeProps<DesignNodeType>) {
  const icon = data.icon ? awsIcon(data.icon) : null;
  const FallbackIcon = designKindMeta(data.kind ?? '').icon;

  return (
    // Width kept in sync with design-canvas.tsx's DEFAULT_NODE_WIDTH and design-layout.ts's
    // NODE_WIDTH — those two need to already agree with this for dagre spacing/measurement.
    <div className="group flex w-[96px] flex-col items-center gap-1 px-1 py-1">
      {HANDLE_POSITIONS.map((position) => (
        <span key={position}>
          <Handle type="target" position={position} id={`${position}-target`} className={HANDLE_CLASS} />
          <Handle type="source" position={position} id={`${position}-source`} className={HANDLE_CLASS} />
        </span>
      ))}
      <span
        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-md transition-all ${
          selected ? 'ring-2 ring-blue-500 ring-offset-2 ring-offset-white dark:ring-offset-neutral-950' : ''
        }`}
      >
        {icon ? (
          <svg viewBox={icon.viewBox} className="h-10 w-10" dangerouslySetInnerHTML={{ __html: icon.body }} />
        ) : (
          // Iconless nodes sit beside full-bleed AWS tiles, so the fallback gets a tile of its own
          // — a bare glyph at this size reads as a missing icon rather than a generic one.
          <span className="flex h-10 w-10 items-center justify-center rounded-md border border-neutral-300 bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800">
            <FallbackIcon className="h-5 w-5 text-neutral-500 dark:text-neutral-400" />
          </span>
        )}
      </span>
      {/* `line-clamp-2` within the 96px-wide parent already wraps the label onto a second line
          instead of overflowing — this is the "change line" behavior for node labels specifically;
          design-group-node.tsx's box title needed the same treatment separately (it isn't clamped
          by a parent flex column the same way). */}
      <span className="line-clamp-2 text-center text-[11px] font-medium leading-tight text-neutral-800 dark:text-neutral-200">
        {data.label || 'Untitled'}
      </span>
    </div>
  );
}
