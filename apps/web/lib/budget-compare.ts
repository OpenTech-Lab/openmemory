// View-model layer for the budget tab of the side-by-side compare dialog: everything that turns a
// `BudgetDiff` from budget-diff.ts into display text or a badge count lives here rather than in the
// component, so it stays reachable from `node --test lib/budget-compare.test.ts` (this repo's only
// working test mechanism for `lib/` — package.json's "test" script is a stub).
//
// Same import discipline as design-history.ts: `@/`-aliased VALUE imports don't resolve under
// node's type-stripping, so anything imported for runtime would need a relative `.ts` specifier.
// This module needs types only, which are erased either way.

import type { BudgetDiff, BudgetPairDiff } from './budget-diff.ts';
import type { BudgetLineItem } from './budget-types.ts';

/** Whole units read best and match design-budget-sheet.tsx's `usd()`, so the same forecast shows
 * the same figure on both surfaces. The exception is a value small enough to round away: "+$0"
 * against a real change reads as "no change", which is the one thing a change receipt must never
 * say, so anything under half a unit falls back to showing the fraction. */
function fractionDigits(value: number, oneUnit: number): number {
  return value !== 0 && Math.abs(value) < oneUnit / 2 ? 2 : 0;
}

// Fixed locale rather than the runtime default: this renders on both the server and the client,
// and a machine-dependent grouping/symbol would be a hydration mismatch.
function money(cents: number, currency: string): string {
  const digits = fractionDigits(cents, 100);
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(cents / 100);
}

/**
 * A forecast total or line-item cost in its OWN currency — never assume USD. Budgets are stored
 * per-scenario with a free-text currency code (a EUR scenario sits next to USD ones in the same
 * design), which is why design-budget-sheet.tsx's USD-only `usd()` helper is not reusable here.
 */
export function formatMoney(cents: number, currency: string): string {
  return money(cents, currency);
}

/** A signed amount for a delta: `+$1,234` / `−$56`. The sign is prefixed by hand — `Intl` renders
 * negatives with an ASCII hyphen, and it never marks a positive at all. Zero carries no sign. */
export function formatMoneyDelta(cents: number, currency: string): string {
  const magnitude = money(Math.abs(cents), currency);
  if (cents > 0) return `+${magnitude}`;
  if (cents < 0) return `−${magnitude}`;
  return magnitude;
}

/** `+284%` / `−17%`, or null passthrough — `BudgetTotalDelta.percentChange` is null when the base
 * total is 0, where no percentage means anything and the absolute delta has to carry the story. */
export function formatPercentChange(percentChange: number | null): string | null {
  if (percentChange === null) return null;
  const digits = fractionDigits(percentChange, 1);
  const magnitude = Math.abs(percentChange).toFixed(digits);
  if (percentChange > 0) return `+${magnitude}%`;
  if (percentChange < 0) return `−${magnitude}%`;
  return `${magnitude}%`;
}

/** True when a matched pair carries nothing worth reading — used to decide whether it counts
 * toward the tab badge. A currency swap counts even with no other edit: the pair renders an
 * explicit "currencies differ" note, so a badge that ignored it would contradict the receipt. */
function pairChanged(pair: BudgetPairDiff): boolean {
  return pair.currencyMismatch
    || pair.lineItems.length > 0
    || (pair.totalDelta !== null && pair.totalDelta.deltaCents !== 0)
    || pair.confidence !== null
    || pair.conditions !== null
    || pair.pricingBasis !== null;
}

/**
 * One ROW of the side-by-side budget table: a single service with whichever of the two sides
 * carries it. `BudgetPairDiff.lineItems` cannot fill this role — it is a list of change events, so
 * it omits unchanged services entirely and emits a service whose cost AND usage both moved twice.
 */
export interface AlignedLineItem {
  service: string;
  /** Absent when the item was added on the head side. */
  base?: BudgetLineItem;
  /** Absent when the item was removed on the head side. */
  head?: BudgetLineItem;
  status: 'added' | 'removed' | 'changed' | 'unchanged';
  /** Signed head − base cost, present only where the two costs are comparable AND moved (i.e.
   * `costChanged`) — never on a currency-mismatched pair, and never as a meaningless `0`. */
  costDeltaCents?: number;
  costChanged: boolean;
  usageChanged: boolean;
}

/**
 * Both versions' line items zipped into one row per service, base order first, then the services
 * only head has — the reading order of a diff, where every row is a service and every column is a
 * version.
 *
 * The pairing deliberately reproduces budget-diff.ts's `diffLineItems` step for step (trimmed
 * service name, first unconsumed head candidate wins, leftovers are additions) rather than
 * importing it: that module's `findUnconsumedIndex` is private, and its output is change events,
 * not rows. If the two rules ever drift, the table and the tab's badge count start telling the
 * reader different stories about the same pair.
 */
export function alignLineItems(pair: BudgetPairDiff): AlignedLineItem[] {
  const headItems = pair.head.line_items;
  const consumed = new Array(headItems.length).fill(false);
  const rows: AlignedLineItem[] = [];

  for (const base of pair.base.line_items) {
    const service = base.service.trim();
    const idx = headItems.findIndex((item, i) => !consumed[i] && item.service.trim() === service);
    if (idx === -1) {
      rows.push({ service, base, status: 'removed', costChanged: false, usageChanged: false });
      continue;
    }
    consumed[idx] = true;
    const head = headItems[idx];

    // A currency mismatch makes the two costs non-comparable (see BudgetPairDiff.currencyMismatch),
    // so the cost simply does not participate: the row can still be 'changed' on usage alone, and
    // both raw figures are still rendered — they are just never subtracted.
    const costChanged = !pair.currencyMismatch && base.monthly_cost_cents !== head.monthly_cost_cents;
    const usageChanged = base.usage !== head.usage;

    rows.push({
      service,
      base,
      head,
      status: costChanged || usageChanged ? 'changed' : 'unchanged',
      ...(costChanged ? { costDeltaCents: head.monthly_cost_cents - base.monthly_cost_cents } : {}),
      costChanged,
      usageChanged,
    });
  }

  headItems.forEach((head, i) => {
    if (!consumed[i]) rows.push({ service: head.service.trim(), head, status: 'added', costChanged: false, usageChanged: false });
  });

  return rows;
}

/** Nothing on either side — no pairs, no unpaired rows. The sheet gates the whole budget tab on
 * this rather than opening it on an empty panel. */
export function budgetDiffIsEmpty(diff: BudgetDiff): boolean {
  return diff.matched.length === 0 && diff.onlyInBase.length === 0 && diff.onlyInHead.length === 0;
}

/**
 * Badge count for the tab label: how many rows the reader actually has to look at. Unpaired rows
 * on either side always count — appearing or disappearing is itself the change — while a matched
 * pair only counts if something about it moved, so comparing a version to itself reads as 0.
 */
export function countBudgetChanges(diff: BudgetDiff): number {
  return diff.matched.filter(pairChanged).length + diff.onlyInBase.length + diff.onlyInHead.length;
}

/** One-line tab header, e.g. `3 compared · 1 only in r2 · 2 only in Live (current)`. The version
 * names are the picker text, so the line reads the same way the two dropdowns do. Empty segments
 * are dropped rather than printed as "0 only in …". */
export function summarizeBudgetDiff(diff: BudgetDiff, baseName: string, headName: string): string {
  if (budgetDiffIsEmpty(diff)) return 'No budgets on either version';
  const parts: string[] = [];
  if (diff.matched.length) parts.push(`${diff.matched.length} compared`);
  if (diff.onlyInBase.length) parts.push(`${diff.onlyInBase.length} only in ${baseName}`);
  if (diff.onlyInHead.length) parts.push(`${diff.onlyInHead.length} only in ${headName}`);
  return parts.join(' · ');
}
