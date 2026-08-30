// Pure comparison engine for two sets of design budget forecasts (base vs. head — either two
// designs, or two revisions of one design). No React, no DOM, no network: everything here is a
// plain function over BudgetLineItem[] / DesignBudgetForecast[] so it can be unit tested and
// reused from any surface that ends up rendering the comparison.
import type { BudgetLineItem, DesignBudgetForecast } from '@/lib/budget-types';

export type BudgetMatchStrategy = 'forecast_profile_id' | 'name';

export interface FieldChange<T> {
  base: T;
  head: T;
}

export interface BudgetTotalDelta {
  baseCents: number;
  headCents: number;
  deltaCents: number;
  /** Percentage change from base to head, e.g. 15 means +15%. `null` when the base total is 0
   * — there is no percentage a zero base could meaningfully report. */
  percentChange: number | null;
}

// A discriminated union rather than one shape with optional fields: 'added' only ever has a
// head-side item, 'removed' only a base-side item, and only 'cost_changed' carries a delta.
export type LineItemDiff =
  | { kind: 'added'; service: string; head: BudgetLineItem }
  | { kind: 'removed'; service: string; base: BudgetLineItem }
  | { kind: 'cost_changed'; service: string; base: BudgetLineItem; head: BudgetLineItem; costDeltaCents: number }
  | { kind: 'usage_changed'; service: string; base: BudgetLineItem; head: BudgetLineItem };

export type LineItemDiffKind = LineItemDiff['kind'];

export interface BudgetPairDiff {
  base: DesignBudgetForecast;
  head: DesignBudgetForecast;
  matchedBy: BudgetMatchStrategy;
  /** True when base.currency !== head.currency. No FX rate is ever invented: totalDelta is
   * null and line items never report a cost_changed delta for this pair — compare
   * base/head's raw currency + monthly_total_cents (and line item costs) side by side instead. */
  currencyMismatch: boolean;
  totalDelta: BudgetTotalDelta | null;
  lineItems: LineItemDiff[];
  confidence: FieldChange<DesignBudgetForecast['confidence']> | null;
  conditions: FieldChange<DesignBudgetForecast['conditions']> | null;
  pricingBasis: FieldChange<DesignBudgetForecast['pricing_basis']> | null;
}

export interface BudgetDiff {
  matched: BudgetPairDiff[];
  onlyInBase: DesignBudgetForecast[];
  onlyInHead: DesignBudgetForecast[];
}

/** First unconsumed candidate satisfying `predicate`, or -1. `consumed[i]` tracks candidates
 * already claimed by an earlier match so nothing is paired twice. */
function findUnconsumedIndex<T>(candidates: T[], consumed: boolean[], predicate: (candidate: T) => boolean): number {
  return candidates.findIndex((candidate, i) => !consumed[i] && predicate(candidate));
}

function diffLineItems(baseItems: BudgetLineItem[], headItems: BudgetLineItem[], currencyMismatch: boolean): LineItemDiff[] {
  const consumed = new Array(headItems.length).fill(false);
  const diffs: LineItemDiff[] = [];

  for (const base of baseItems) {
    const service = base.service.trim();
    const idx = findUnconsumedIndex(headItems, consumed, (item) => item.service.trim() === service);
    if (idx === -1) {
      diffs.push({ kind: 'removed', service, base });
      continue;
    }
    consumed[idx] = true;
    const head = headItems[idx];

    // A currency mismatch on the parent pair makes monthly_cost_cents non-comparable (see
    // BudgetPairDiff.currencyMismatch) — presence and usage-text changes are still meaningful,
    // so only the cost comparison is skipped.
    if (!currencyMismatch && base.monthly_cost_cents !== head.monthly_cost_cents) {
      diffs.push({ kind: 'cost_changed', service, base, head, costDeltaCents: head.monthly_cost_cents - base.monthly_cost_cents });
    }
    if (base.usage !== head.usage) {
      diffs.push({ kind: 'usage_changed', service, base, head });
    }
  }

  headItems.forEach((head, i) => {
    if (!consumed[i]) diffs.push({ kind: 'added', service: head.service.trim(), head });
  });

  return diffs;
}

function diffPair(base: DesignBudgetForecast, head: DesignBudgetForecast, matchedBy: BudgetMatchStrategy): BudgetPairDiff {
  const currencyMismatch = base.currency !== head.currency;

  const totalDelta: BudgetTotalDelta | null = currencyMismatch ? null : {
    baseCents: base.monthly_total_cents,
    headCents: head.monthly_total_cents,
    deltaCents: head.monthly_total_cents - base.monthly_total_cents,
    percentChange: base.monthly_total_cents === 0
      ? null
      : ((head.monthly_total_cents - base.monthly_total_cents) / base.monthly_total_cents) * 100,
  };

  return {
    base,
    head,
    matchedBy,
    currencyMismatch,
    totalDelta,
    lineItems: diffLineItems(base.line_items, head.line_items, currencyMismatch),
    confidence: base.confidence !== head.confidence ? { base: base.confidence, head: head.confidence } : null,
    conditions: base.conditions !== head.conditions ? { base: base.conditions, head: head.conditions } : null,
    pricingBasis: base.pricing_basis !== head.pricing_basis ? { base: base.pricing_basis, head: head.pricing_basis } : null,
  };
}

/**
 * Pair up base and head budget forecasts and report what changed.
 *
 * Pairing order matters: forecast_profile_id is nullable (FK ON DELETE SET NULL) and the budget
 * sheet's own default persists custom-conditions scenarios with a null profile id — plausibly
 * the majority of rows — so profile id alone would leave most of them unmatched. Each base row
 * is matched, in order:
 *   1. by forecast_profile_id, when both sides are non-null and equal;
 *   2. else by exact name match (after trim);
 *   3. else it is unpaired (onlyInBase) — a pairing is never forced.
 * Any head row nothing claims ends up in onlyInHead.
 */
export function diffBudgets(base: DesignBudgetForecast[], head: DesignBudgetForecast[]): BudgetDiff {
  const consumed = new Array(head.length).fill(false);
  const matched: BudgetPairDiff[] = [];
  const onlyInBase: DesignBudgetForecast[] = [];

  for (const b of base) {
    let idx = -1;
    let matchedBy: BudgetMatchStrategy = 'name';

    if (b.forecast_profile_id) {
      idx = findUnconsumedIndex(head, consumed, (h) => h.forecast_profile_id === b.forecast_profile_id);
      if (idx !== -1) matchedBy = 'forecast_profile_id';
    }
    if (idx === -1) {
      const name = b.name.trim();
      idx = findUnconsumedIndex(head, consumed, (h) => h.name.trim() === name);
      if (idx !== -1) matchedBy = 'name';
    }

    if (idx === -1) {
      onlyInBase.push(b);
      continue;
    }

    consumed[idx] = true;
    matched.push(diffPair(b, head[idx], matchedBy));
  }

  const onlyInHead = head.filter((_, i) => !consumed[i]);

  return { matched, onlyInBase, onlyInHead };
}
