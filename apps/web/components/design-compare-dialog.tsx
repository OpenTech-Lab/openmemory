'use client';

import type { ReactNode } from 'react';
import { ArrowRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { DrawioDiagram } from '@/components/drawio-diagram';
import { alignLineItems, countBudgetChanges, formatMoney, formatMoneyDelta, formatPercentChange, summarizeBudgetDiff } from '@/lib/budget-compare';
import type { AlignedLineItem } from '@/lib/budget-compare';
import type { BudgetDiff, BudgetPairDiff } from '@/lib/budget-diff';
import type { BudgetLineItem, DesignBudgetForecast } from '@/lib/budget-types';
import type { DiffEntry } from '@/lib/design-diff';
import { HIGHLIGHT_COLORS, type HighlightKind } from '@/lib/design-highlight';
import { summarizeDiff } from '@/lib/design-history';
import { cn } from '@/lib/utils';

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
  /** Null when the design has no budgets on either side — the dialog then renders exactly as it
   * did before budgets existed, with no tab bar at all, rather than a tab onto an empty panel. */
  budgetDiff?: BudgetDiff | null;
}

const LEGEND: { kind: HighlightKind; label: string }[] = [
  { kind: 'added', label: 'Added' },
  { kind: 'removed', label: 'Removed' },
  { kind: 'changed', label: 'Changed' },
];

// The budget tab borrows the diagram tab's colour language so the two read as one feature: a
// service appearing or vanishing gets the same green/red as a shape does, and everything else —
// a cost move, a usage rewrite, a confidence downgrade — is 'changed' blue. Cost DIRECTION is
// deliberately not colour-coded: red-for-more would collide with red-for-removed.
//
// Which HALF carries the accent is what makes the layout a diff rather than two lists: a removed
// service only ever existed on the left and an added one only on the right, so tinting the empty
// side would claim a change happened somewhere nothing is. 'changed' is the only status that
// colours both, and 'unchanged' colours neither — it is context for the rows around it.
function cellAccent(status: AlignedLineItem['status'], side: 'base' | 'head'): HighlightKind | undefined {
  if (status === 'changed') return 'changed';
  if (status === 'removed') return side === 'base' ? 'removed' : undefined;
  if (status === 'added') return side === 'head' ? 'added' : undefined;
  return undefined;
}

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

/** Every row of the budget panel is the same two equal halves — base left, head right — so line
 * items, totals and field changes stay column-aligned with each other and with the sticky header.
 * Tailwind's `grid-cols-2` tracks are `minmax(0, 1fr)`, which is what keeps a long service name or
 * a wall of conditions text from widening a column into a horizontal scrollbar. */
function DiffRow({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-2">{children}</div>;
}

/** One half of a row. `absent` is a dashed empty well rather than nothing at all: on an added or
 * removed row it is the empty side that tells the reader which direction the change went, so it
 * has to be visible. */
function DiffCell({ accent, absent, muted, children }: { accent?: HighlightKind; absent?: boolean; muted?: boolean; children?: ReactNode }) {
  if (absent) return <div className="min-w-0 rounded-md border border-dashed bg-muted/20" />;
  return <div
    className={cn('min-w-0 rounded-md border px-2.5 py-1.5', muted && 'text-muted-foreground')}
    // Tinted from the shared outline colour with an alpha suffix rather than from a second palette,
    // so the two tabs can never drift apart on what 'added' looks like.
    style={accent ? { borderColor: `${HIGHLIGHT_COLORS[accent]}59`, backgroundColor: `${HIGHLIGHT_COLORS[accent]}14` } : undefined}
  >{children}</div>;
}

/** One version's view of a service: name and cost on one baseline, usage under it. */
function LineItemCell({ item, currency, delta, costMuted, usageMuted, usageChanged }: {
  item: BudgetLineItem; currency: string; delta?: string; costMuted: boolean; usageMuted: boolean; usageChanged: boolean;
}) {
  const usage = item.usage.trim();
  return <div className="space-y-0.5 text-sm">
    {/* Wrapping at both levels rather than pinning the figures with `shrink-0`: at the narrow end
        of the dialog a service name plus a cost plus a delta will not fit on one line, and the
        panel is not allowed to answer that with a horizontal scrollbar. */}
    <div className="flex flex-wrap items-baseline justify-between gap-x-2">
      <span className="min-w-0 break-words font-medium">{item.service.trim()}</span>
      <span className="flex flex-wrap items-baseline justify-end gap-x-1.5 tabular-nums">
        <span className={cn(costMuted && 'text-muted-foreground')}>{formatMoney(item.monthly_cost_cents, currency)}</span>
        {delta && <span className="font-medium" style={{ color: HIGHLIGHT_COLORS.changed }}>{delta}</span>}
      </span>
    </div>
    {/* A usage string that was cleared has to show as '—' rather than vanish, or a real edit reads
        as a rendering bug; a usage that was always blank just takes no line. */}
    {(usage || usageChanged) && <p className={cn('break-words text-xs', usageMuted ? 'text-muted-foreground' : 'text-foreground')}>{usage || '—'}</p>}
  </div>;
}

function AlignedLineItemRow({ row, baseCurrency, headCurrency }: { row: AlignedLineItem; baseCurrency: string; headCurrency: string }) {
  // Inside a 'changed' row the field that actually moved has to outrank the one that did not, or
  // the reader is left diffing two nearly identical cells by eye. An 'unchanged' row recedes
  // wholesale: it is there so the two budgets can be read in full, not because it is news.
  const costMuted = row.status === 'changed' && !row.costChanged;
  const usageMuted = !(row.status === 'changed' && row.usageChanged);

  return <DiffRow>
    <DiffCell accent={cellAccent(row.status, 'base')} absent={!row.base} muted={row.status === 'unchanged'}>
      {row.base && <LineItemCell item={row.base} currency={baseCurrency} costMuted={costMuted} usageMuted={usageMuted} usageChanged={row.usageChanged} />}
    </DiffCell>
    <DiffCell accent={cellAccent(row.status, 'head')} absent={!row.head} muted={row.status === 'unchanged'}>
      {row.head && <LineItemCell
        item={row.head}
        currency={headCurrency}
        costMuted={costMuted}
        usageMuted={usageMuted}
        usageChanged={row.usageChanged}
        delta={row.costDeltaCents === undefined ? undefined : formatMoneyDelta(row.costDeltaCents, headCurrency)}
      />}
    </DiffCell>
  </DiffRow>;
}

/** A changed scalar field — confidence, conditions, pricing basis — in the same two columns as
 * every other row, captioned once above the pair rather than repeated in both halves. Both sides
 * are nullable, and an empty cell reads as a rendering bug rather than "this was never set". */
function FieldChangeRow({ label, before, after }: { label: string; before: string | null; after: string | null }) {
  return <div className="space-y-1">
    <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</span>
    <DiffRow>
      <DiffCell accent="changed"><p className="break-words text-sm text-muted-foreground">{before?.trim() || '—'}</p></DiffCell>
      <DiffCell accent="changed"><p className="break-words text-sm">{after?.trim() || '—'}</p></DiffCell>
    </DiffRow>
  </div>;
}

/** The totals row for a matched pair: each version's own total in its own column, with the signed
 * delta on the head side. A currency mismatch has no delta to show — budget-diff.ts refuses to
 * invent an FX rate — so each total is stamped with its own code and the reader is told why there
 * is no arithmetic, rather than being shown a misleading "no change". */
function PairTotalRow({ pair }: { pair: BudgetPairDiff }) {
  const moved = pair.totalDelta !== null && pair.totalDelta.deltaCents !== 0;
  const accent: HighlightKind | undefined = moved || pair.currencyMismatch ? 'changed' : undefined;
  const percent = pair.totalDelta ? formatPercentChange(pair.totalDelta.percentChange) : null;

  return <div className="space-y-1.5">
    <DiffRow>
      <DiffCell accent={accent}>
        <div className="flex flex-wrap items-baseline gap-x-1.5 text-lg font-semibold tabular-nums">
          {/* Only a real delta demotes the base figure to "before". Under a currency mismatch
              neither total is the other's baseline, so both keep full weight. */}
          <span className={cn(moved && 'text-muted-foreground')}>{formatMoney(pair.base.monthly_total_cents, pair.base.currency)}</span>
          {pair.currencyMismatch && <span className="text-xs font-normal text-muted-foreground">{pair.base.currency}</span>}
        </div>
      </DiffCell>
      <DiffCell accent={accent}>
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-lg font-semibold tabular-nums">
          <span>{formatMoney(pair.head.monthly_total_cents, pair.head.currency)}</span>
          {pair.currencyMismatch && <span className="text-xs font-normal text-muted-foreground">{pair.head.currency}</span>}
          {pair.totalDelta && (moved
            ? <span className="text-sm font-normal" style={{ color: HIGHLIGHT_COLORS.changed }}>
                {formatMoneyDelta(pair.totalDelta.deltaCents, pair.head.currency)}{percent && ` (${percent})`}
              </span>
            : <span className="text-sm font-normal text-muted-foreground">no change</span>)}
        </div>
      </DiffCell>
    </DiffRow>
    {pair.currencyMismatch && <p className="text-xs" style={{ color: HIGHLIGHT_COLORS.changed }}>Currencies differ — no delta computed.</p>}
  </div>;
}

function MatchedPairSection({ pair }: { pair: BudgetPairDiff }) {
  const renamed = pair.base.name.trim() !== pair.head.name.trim();
  // Every service on either side, not just the ones that moved: pair.lineItems is a change log,
  // and a column pair built from it would be the old receipt wearing two columns.
  const rows = alignLineItems(pair);
  return <section className="rounded-xl border p-4">
    <div className="flex flex-wrap items-center gap-2">
      <h3 className="font-semibold">{pair.head.name}</h3>
      {/* Matching by name is the weaker join — a rename on one side silently unpairs the scenario,
          and two scenarios that merely share a name get paired as one. Say which was used. */}
      <Tooltip>
        <TooltipTrigger asChild><Badge variant="secondary" className="cursor-help text-[10px]">{pair.matchedBy === 'forecast_profile_id' ? 'profile' : 'name'}</Badge></TooltipTrigger>
        <TooltipContent className="max-w-xs">{pair.matchedBy === 'forecast_profile_id'
          ? 'Paired by usage profile, so a rename on either side does not break the match.'
          : 'Paired by name — neither side is tied to a saved usage profile, so a rename would show up as one scenario removed and another added.'}</TooltipContent>
      </Tooltip>
      {renamed && <span className="text-xs text-muted-foreground">was “{pair.base.name}”</span>}
    </div>

    <div className="mt-3 space-y-1.5">
      <PairTotalRow pair={pair} />
      {rows.map((row, index) => <AlignedLineItemRow
        key={`${row.service}-${index}`}
        row={row}
        baseCurrency={pair.base.currency}
        headCurrency={pair.head.currency}
      />)}
      {pair.confidence && <FieldChangeRow label="Confidence" before={pair.confidence.base} after={pair.confidence.head} />}
      {pair.conditions && <FieldChangeRow label="Conditions" before={pair.conditions.base} after={pair.conditions.head} />}
      {pair.pricingBasis && <FieldChangeRow label="Pricing basis" before={pair.pricingBasis.base} after={pair.pricingBasis.head} />}
    </div>
  </section>;
}

/** `onlyInBase` / `onlyInHead`, headed with the version the scenarios actually live on and drawn
 * in that version's column with the other half left empty — so the direction reads the same way a
 * removed line item does, without the heading having to carry it alone. */
function UnpairedSection({ heading, side, forecasts }: { heading: string; side: 'base' | 'head'; forecasts: DesignBudgetForecast[] }) {
  const accent: HighlightKind = side === 'base' ? 'removed' : 'added';
  return <section className="rounded-xl border p-4">
    <h3 className="font-semibold">{heading}</h3>
    <div className="mt-3 space-y-1.5">
      {forecasts.map((forecast) => {
        const cell = <DiffCell accent={accent}>
          <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-sm">
            <span className="min-w-0 break-words font-medium">{forecast.name}</span>
            <span className="tabular-nums">{formatMoney(forecast.monthly_total_cents, forecast.currency)}<span className="ml-1 text-xs text-muted-foreground">/ month</span></span>
          </div>
          {forecast.conditions?.trim() && <p className="break-words text-xs text-muted-foreground">{forecast.conditions}</p>}
        </DiffCell>;
        return <DiffRow key={forecast.id}>
          {side === 'base' ? cell : <DiffCell absent />}
          {side === 'head' ? cell : <DiffCell absent />}
        </DiffRow>;
      })}
    </div>
  </section>;
}

/** The version names pinned above the columns. A two-column wall of money is ambiguous in exactly
 * the way the diagram tab never is, so these carry ComparePane's header styling verbatim — same
 * feature, same signposting, and they stay put while the scenarios scroll past. */
function ColumnHeaders({ baseName, headName }: { baseName: string; headName: string }) {
  return <div className="sticky top-0 z-10 bg-background pb-2 pt-1">
    <DiffRow>
      <div className="min-w-0 truncate border-b px-2.5 pb-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">{baseName}</div>
      <div className="min-w-0 truncate border-b px-2.5 pb-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">{headName}</div>
    </DiffRow>
  </div>;
}

function BudgetDiffPanel({ diff, baseName, headName }: { diff: BudgetDiff; baseName: string; headName: string }) {
  return <div className="px-5 pb-8">
    <div className="mx-auto max-w-6xl space-y-3">
      <p className="pt-1 text-sm text-muted-foreground">{summarizeBudgetDiff(diff, baseName, headName)}</p>
      <ColumnHeaders baseName={baseName} headName={headName} />
      {diff.matched.map((pair) => <MatchedPairSection key={`${pair.base.id}-${pair.head.id}`} pair={pair} />)}
      {diff.onlyInBase.length > 0 && <UnpairedSection heading={`Only in ${baseName}`} side="base" forecasts={diff.onlyInBase} />}
      {diff.onlyInHead.length > 0 && <UnpairedSection heading={`Only in ${headName}`} side="head" forecasts={diff.onlyInHead} />}
    </div>
  </div>;
}

/**
 * The two versions rendered side by side, VS Code diff-editor style, with the changed shapes
 * outlined in place. draw.io only: the outlines are mxCell style rewrites, so there is nothing to
 * stamp on a mermaid or React Flow design — the history sheet disables its entry point for those
 * rather than opening a half-working pane.
 *
 * When the design carries budgets the panes move under a Diagram tab and a Budget tab joins it;
 * with none, the dialog stays exactly the single-view thing it was.
 */
export function DesignCompareDialog({
  open, onOpenChange, title, kind, baseName, headName, baseSource, headSource, entries, budgetDiff = null,
}: DesignCompareDialogProps) {
  const panes = <ResizablePanelGroup direction="horizontal" className="min-h-0 flex-1">
    <ResizablePanel defaultSize={50} minSize={20}>
      <ComparePane name={baseName} source={baseSource} title={title} kind={kind} />
    </ResizablePanel>
    <ResizableHandle withHandle />
    <ResizablePanel defaultSize={50} minSize={20}>
      <ComparePane name={headName} source={headSource} title={title} kind={kind} />
    </ResizablePanel>
  </ResizablePanelGroup>;

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

      {budgetDiff === null ? panes : <Tabs defaultValue="diagram" className="min-h-0 flex-1 gap-0">
        <TabsList className="mx-5 mt-3 shrink-0">
          <TabsTrigger value="diagram">Diagram</TabsTrigger>
          <TabsTrigger value="budget">Budget<Badge variant="secondary" className="text-[10px]">{countBudgetChanges(budgetDiff)}</Badge></TabsTrigger>
        </TabsList>
        {/* Radix unmounts the inactive tab, which remounts the draw.io iframes on every switch back
            — that is the correct trade here, since a mounted viewer ignores later `source` props
            (see ComparePane) and a force-mounted, hidden pane would size its canvas to zero. */}
        <TabsContent value="diagram" className="mt-3 flex min-h-0 flex-col">{panes}</TabsContent>
        {/* Scrolling lives on the tab panel itself rather than an inner `h-full` wrapper: as a
            flex child with min-h-0 this has a resolved height, where a percentage would depend on
            the parent chain staying flex all the way up. */}
        <TabsContent value="budget" className="mt-3 min-h-0 overflow-y-auto">
          <BudgetDiffPanel diff={budgetDiff} baseName={baseName} headName={headName} />
        </TabsContent>
      </Tabs>}
    </DialogContent>
  </Dialog>;
}
