'use client';

import { ArrowRight } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { DrawioDiagram } from '@/components/drawio-diagram';
import type { DiffEntry } from '@/lib/design-diff';
import { HIGHLIGHT_COLORS, type HighlightKind } from '@/lib/design-highlight';
import { summarizeDiff } from '@/lib/design-history';

interface DesignCompareDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  kind: string;
  /** Picker text for each side — `formatRevisionLabel`'s output, or 'Live (current)'. Doubles as
   * the pane's remount key (see the `key` note below), so it has to change with the version. */
  baseName: string;
  headName: string;
  /** draw.io XML with the changed cells already outlined — the history sheet applies
   * `highlightDrawioCells` before handing it over, since it is what resolves the two sides. */
  baseSource: string;
  headSource: string;
  /** Only for the header's change summary; the outlines are already baked into the sources. */
  entries: DiffEntry[];
}

const LEGEND: { kind: HighlightKind; label: string }[] = [
  { kind: 'added', label: 'Added' },
  { kind: 'removed', label: 'Removed' },
  { kind: 'changed', label: 'Changed' },
];

function ComparePane({ name, source, title, kind }: { name: string; source: string; title: string; kind: string }) {
  return <div className="flex h-full min-h-0 flex-col">
    <div className="sticky top-0 z-10 shrink-0 border-b bg-muted/40 px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">{name}</div>
    <div className="min-h-0 flex-1">
      {/* DrawioDiagram posts its source into the iframe only when the viewer emits `ready`, which
          fires once per iframe load — changing the `source` prop does NOT update a mounted viewer.
          Keying on the version name forces a fresh iframe whenever the user reopens the dialog on a
          different pair, so the pane can never show the previous comparison's diagram. Removing
          this key silently reintroduces that staleness; it does not just cost a re-render. */}
      <DrawioDiagram key={name} source={source} mode="viewer" title={title} kind={kind} flush />
    </div>
  </div>;
}

/**
 * The two versions rendered side by side, VS Code diff-editor style, with the changed shapes
 * outlined in place. draw.io only: the outlines are mxCell style rewrites, so there is nothing to
 * stamp on a mermaid or React Flow design — the history sheet disables its entry point for those
 * rather than opening a half-working pane.
 */
export function DesignCompareDialog({
  open, onOpenChange, title, kind, baseName, headName, baseSource, headSource, entries,
}: DesignCompareDialogProps) {
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="flex h-[92vh] w-[96vw] max-w-[96vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[96vw]">
      <div className="shrink-0 border-b bg-card px-5 py-4 pr-12">
        <DialogHeader>
          <DialogTitle className="text-base">{title}</DialogTitle>
          <DialogDescription asChild>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
              <span className="flex items-center gap-1.5 font-medium text-foreground">
                {baseName} <ArrowRight className="h-3.5 w-3.5 shrink-0" /> {headName}
              </span>
              <span>{summarizeDiff(entries)}</span>
              <span className="flex items-center gap-3">
                {LEGEND.map(({ kind: highlightKind, label }) => <span key={highlightKind} className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: HIGHLIGHT_COLORS[highlightKind] }} />
                  {label}
                </span>)}
              </span>
            </div>
          </DialogDescription>
        </DialogHeader>
      </div>

      <ResizablePanelGroup direction="horizontal" className="min-h-0 flex-1">
        <ResizablePanel defaultSize={50} minSize={20}>
          <ComparePane name={baseName} source={baseSource} title={title} kind={kind} />
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize={50} minSize={20}>
          <ComparePane name={headName} source={headSource} title={title} kind={kind} />
        </ResizablePanel>
      </ResizablePanelGroup>
    </DialogContent>
  </Dialog>;
}
