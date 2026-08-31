// Tests for the budget-comparison view-model helpers. Run with:
// node --test lib/budget-compare.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alignLineItems, budgetDiffIsEmpty, countBudgetChanges, formatMoney, formatMoneyDelta, formatPercentChange, summarizeBudgetDiff } from './budget-compare.ts';
import { diffBudgets } from './budget-diff.ts';
import type { BudgetLineItem, DesignBudgetForecast } from './budget-types.ts';

function forecast(overrides: Partial<DesignBudgetForecast> & Pick<DesignBudgetForecast, 'id' | 'name'>): DesignBudgetForecast {
  return {
    design_id: 'design-1',
    forecast_profile_id: null,
    conditions: null,
    currency: 'USD',
    monthly_total_cents: 0,
    line_items: [],
    confidence: 'low',
    pricing_basis: null,
    created_by: 'human',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function lineItem(overrides: Partial<BudgetLineItem> & Pick<BudgetLineItem, 'service'>): BudgetLineItem {
  return { usage: '', monthly_cost_cents: 0, ...overrides };
}

test('formatMoney renders whole units, matching the budget sheet for the same forecast', () => {
  assert.equal(formatMoney(123400, 'USD'), '$1,234');
  assert.equal(formatMoney(0, 'USD'), '$0');
  // 199.95 rounds up the same way design-budget-sheet.tsx's usd() does.
  assert.equal(formatMoney(19995, 'USD'), '$200');
});

test('formatMoney uses the row\'s own currency rather than assuming USD', () => {
  assert.equal(formatMoney(27300, 'EUR'), '€273');
  assert.equal(formatMoney(27300, 'GBP'), '£273');
  // An unrecognised code still formats — the column is free text server-side, so it must not throw.
  // Intl separates the code from the number with a non-breaking space, not a plain one.
  assert.equal(formatMoney(27300, 'XYZ'), 'XYZ\u00a0273');
});

test('formatMoney keeps a sub-unit amount visible instead of rounding it to a flat zero', () => {
  assert.equal(formatMoney(10, 'USD'), '$0.10');
  assert.equal(formatMoney(-10, 'USD'), '-$0.10');
});

test('formatMoneyDelta signs the amount and uses a real minus, not an ASCII hyphen', () => {
  assert.equal(formatMoneyDelta(123400, 'USD'), '+$1,234');
  assert.equal(formatMoneyDelta(-5600, 'USD'), '−$56');
  assert.equal(formatMoneyDelta(-5600, 'USD').startsWith('−'), true);
  // Zero is not a direction, so it carries no sign.
  assert.equal(formatMoneyDelta(0, 'USD'), '$0');
});

test('formatMoneyDelta never renders a real change as "$0"', () => {
  assert.equal(formatMoneyDelta(25, 'USD'), '+$0.25');
  assert.equal(formatMoneyDelta(-25, 'USD'), '−$0.25');
});

test('formatPercentChange signs and rounds to whole percent', () => {
  assert.equal(formatPercentChange(284.4), '+284%');
  assert.equal(formatPercentChange(-17.2), '−17%');
  assert.equal(formatPercentChange(0), '0%');
});

test('formatPercentChange passes null through for a zero base total', () => {
  // diffBudgets sets percentChange to null when the base total is 0 — there is no percentage a
  // zero base could report, and the caller has to fall back to the absolute delta.
  const diff = diffBudgets(
    [forecast({ id: 'b1', name: 'Scenario', monthly_total_cents: 0 })],
    [forecast({ id: 'h1', name: 'Scenario', monthly_total_cents: 45000 })],
  );
  assert.equal(diff.matched[0].totalDelta?.percentChange, null);
  assert.equal(formatPercentChange(diff.matched[0].totalDelta?.percentChange ?? null), null);
});

test('formatPercentChange keeps a sub-percent move visible', () => {
  assert.equal(formatPercentChange(0.4), '+0.40%');
  assert.equal(formatPercentChange(-0.4), '−0.40%');
});

test('budgetDiffIsEmpty is true only when neither side has any forecast', () => {
  assert.equal(budgetDiffIsEmpty(diffBudgets([], [])), true);
  assert.equal(budgetDiffIsEmpty(diffBudgets([], [forecast({ id: 'h1', name: 'Only head' })])), false);
  assert.equal(budgetDiffIsEmpty(diffBudgets([forecast({ id: 'b1', name: 'Only base' })], [])), false);
  // Matched but identical is still not "empty" — there is a pair to render, just nothing changed.
  assert.equal(budgetDiffIsEmpty(diffBudgets([forecast({ id: 'b1', name: 'Same' })], [forecast({ id: 'h1', name: 'Same' })])), false);
});

test('countBudgetChanges ignores a pair where nothing moved', () => {
  const same = () => forecast({
    id: 'x', name: 'Small scale', monthly_total_cents: 20864,
    line_items: [lineItem({ service: 'Lambda', usage: '10k req/mo', monthly_cost_cents: 20864 })],
  });
  assert.equal(countBudgetChanges(diffBudgets([same()], [same()])), 0);
});

test('countBudgetChanges counts a pair once however many things moved in it', () => {
  const diff = diffBudgets(
    [forecast({
      id: 'b1', name: 'Alpha test', monthly_total_cents: 1832, confidence: 'low',
      line_items: [lineItem({ service: 'DynamoDB', usage: '50k WCU/mo', monthly_cost_cents: 325 })],
    })],
    [forecast({
      id: 'h1', name: 'Alpha test', monthly_total_cents: 7039, confidence: 'high',
      line_items: [lineItem({ service: 'Aurora Serverless v2', usage: '0.5 ACU minimum', monthly_cost_cents: 4380 })],
    })],
  );
  assert.equal(diff.matched[0].lineItems.length, 2);
  assert.equal(diff.matched[0].confidence !== null, true);
  assert.equal(countBudgetChanges(diff), 1);
});

test('countBudgetChanges counts every unpaired row on both sides', () => {
  const diff = diffBudgets(
    [forecast({ id: 'b1', name: 'Disaster recovery standby' })],
    [forecast({ id: 'h1', name: 'EU region estimate' }), forecast({ id: 'h2', name: 'Black Friday spike' })],
  );
  assert.equal(countBudgetChanges(diff), 3);
});

test('countBudgetChanges counts a currency swap even when nothing else moved', () => {
  // A EUR scenario against a USD one produces no totalDelta and no cost deltas by design, so the
  // enumerated "something moved" checks would all miss it — but the tab renders a prominent
  // "currencies differ" note for the pair, and a badge that ignored it would contradict that.
  const diff = diffBudgets(
    [forecast({ id: 'b1', name: 'EU region estimate', currency: 'USD', monthly_total_cents: 19995 })],
    [forecast({ id: 'h1', name: 'EU region estimate', currency: 'EUR', monthly_total_cents: 19995 })],
  );
  assert.equal(diff.matched[0].currencyMismatch, true);
  assert.equal(diff.matched[0].totalDelta, null);
  assert.equal(diff.matched[0].lineItems.length, 0);
  assert.equal(countBudgetChanges(diff), 1);
});

test('summarizeBudgetDiff names both versions and drops the zero segments', () => {
  const diff = diffBudgets(
    [forecast({ id: 'b1', name: 'Small scale' }), forecast({ id: 'b2', name: 'Retired scenario' })],
    [forecast({ id: 'h1', name: 'Small scale' }), forecast({ id: 'h2', name: 'New scenario' }), forecast({ id: 'h3', name: 'Another new one' })],
  );
  assert.equal(summarizeBudgetDiff(diff, 'r2', 'Live (current)'), '1 compared · 1 only in r2 · 2 only in Live (current)');
});

test('summarizeBudgetDiff omits the unpaired segments entirely when every row paired', () => {
  const diff = diffBudgets(
    [forecast({ id: 'b1', name: 'Small scale' })],
    [forecast({ id: 'h1', name: 'Small scale' })],
  );
  assert.equal(summarizeBudgetDiff(diff, 'r2', 'Live (current)'), '1 compared');
});

test('summarizeBudgetDiff says so rather than printing an empty line when neither side has budgets', () => {
  assert.equal(summarizeBudgetDiff(diffBudgets([], []), 'r2', 'Live (current)'), 'No budgets on either version');
});

test('a currency-mismatched pair leaves the caller both raw totals and no delta to render', () => {
  const diff = diffBudgets(
    [forecast({
      id: 'b1', name: 'EU region estimate', currency: 'USD', monthly_total_cents: 19995,
      line_items: [lineItem({ service: 'ECS Fargate', usage: '4 tasks x 0.5 vCPU', monthly_cost_cents: 13120 })],
    })],
    [forecast({
      id: 'h1', name: 'EU region estimate', currency: 'EUR', monthly_total_cents: 27300,
      line_items: [lineItem({ service: 'ECS Fargate', usage: '4 tasks x 0.5 vCPU', monthly_cost_cents: 12840 })],
    })],
  );
  const pair = diff.matched[0];
  assert.equal(pair.currencyMismatch, true);
  assert.equal(pair.totalDelta, null);
  // No FX rate is invented, so the two totals can only be shown side by side, each in its own
  // currency — never subtracted, and never collapsed to "no change".
  assert.equal(formatMoney(pair.base.monthly_total_cents, pair.base.currency), '$200');
  assert.equal(formatMoney(pair.head.monthly_total_cents, pair.head.currency), '€273');
  assert.equal(pair.lineItems.filter((item) => item.kind === 'cost_changed').length, 0);
});

/** A one-pair diff, so the alignment tests can talk about line items without restating the
 * scenario scaffolding each time. */
function pairOf(baseItems: BudgetLineItem[], headItems: BudgetLineItem[], currencies: [string, string] = ['USD', 'USD']) {
  const diff = diffBudgets(
    [forecast({ id: 'b1', name: 'Medium scale', currency: currencies[0], line_items: baseItems })],
    [forecast({ id: 'h1', name: 'Medium scale', currency: currencies[1], line_items: headItems })],
  );
  return diff.matched[0];
}

test('alignLineItems keeps an unchanged service in the table', () => {
  // The whole point of the two-column layout: pair.lineItems is a change log and omits this row
  // entirely, so an alignment built from it would be the old single-column receipt in disguise.
  const pair = pairOf(
    [lineItem({ service: 'API Gateway', usage: '2M req/mo', monthly_cost_cents: 700 })],
    [lineItem({ service: 'API Gateway', usage: '2M req/mo', monthly_cost_cents: 700 })],
  );
  assert.equal(pair.lineItems.length, 0);
  const rows = alignLineItems(pair);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'unchanged');
  assert.equal(rows[0].base?.monthly_cost_cents, 700);
  assert.equal(rows[0].head?.monthly_cost_cents, 700);
  assert.equal(rows[0].costDeltaCents, undefined);
});

test('alignLineItems marks a head-only service added and leaves the base side empty', () => {
  const rows = alignLineItems(pairOf(
    [],
    [lineItem({ service: 'NAT Gateway', usage: '1 gateway', monthly_cost_cents: 3285 })],
  ));
  assert.deepEqual(rows.map((row) => [row.service, row.status]), [['NAT Gateway', 'added']]);
  assert.equal(rows[0].base, undefined);
  assert.equal(rows[0].head?.monthly_cost_cents, 3285);
  // Nothing to subtract from, so no delta is invented for the column to render.
  assert.equal(rows[0].costDeltaCents, undefined);
  assert.equal(rows[0].costChanged, false);
});

test('alignLineItems marks a base-only service removed and leaves the head side empty', () => {
  const rows = alignLineItems(pairOf(
    [lineItem({ service: 'Elasticache', usage: 'cache.t4g.micro', monthly_cost_cents: 1200 })],
    [],
  ));
  assert.deepEqual(rows.map((row) => [row.service, row.status]), [['Elasticache', 'removed']]);
  assert.equal(rows[0].head, undefined);
  assert.equal(rows[0].base?.monthly_cost_cents, 1200);
  assert.equal(rows[0].costDeltaCents, undefined);
});

test('alignLineItems collapses a cost AND usage change into a single row', () => {
  // diffLineItems emits cost_changed and usage_changed separately for one service (CloudFront does
  // exactly this in the seeded data). A table that rendered one row per event would print the same
  // service twice and make the two budgets look longer than they are.
  const pair = pairOf(
    [lineItem({ service: 'CloudFront', usage: '500 GB/mo', monthly_cost_cents: 4250 })],
    [lineItem({ service: 'CloudFront', usage: '300 GB/mo', monthly_cost_cents: 2550 })],
  );
  assert.deepEqual(pair.lineItems.map((item) => item.kind), ['cost_changed', 'usage_changed']);
  const rows = alignLineItems(pair);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'changed');
  assert.equal(rows[0].costChanged, true);
  assert.equal(rows[0].usageChanged, true);
  assert.equal(rows[0].costDeltaCents, -1700);
});

test('alignLineItems reports a usage-only change without a cost delta', () => {
  const rows = alignLineItems(pairOf(
    [lineItem({ service: 'S3', usage: '200 GB', monthly_cost_cents: 460 })],
    [lineItem({ service: 'S3', usage: '400 GB', monthly_cost_cents: 460 })],
  ));
  assert.equal(rows[0].status, 'changed');
  assert.equal(rows[0].usageChanged, true);
  assert.equal(rows[0].costChanged, false);
  // 0 would render as "+$0" against a row the reader can see is highlighted — the one thing the
  // formatters exist to avoid saying.
  assert.equal(rows[0].costDeltaCents, undefined);
});

test('alignLineItems computes no cost delta anywhere on a currency-mismatched pair', () => {
  // Same refusal budget-diff.ts makes: no FX rate is invented, so the two figures are shown side
  // by side and never subtracted. A usage edit still makes the row 'changed'.
  const pair = pairOf(
    [
      lineItem({ service: 'ECS Fargate', usage: '4 tasks x 0.5 vCPU', monthly_cost_cents: 13120 }),
      lineItem({ service: 'S3', usage: '200 GB', monthly_cost_cents: 460 }),
    ],
    [
      lineItem({ service: 'ECS Fargate', usage: '6 tasks x 0.5 vCPU', monthly_cost_cents: 12840 }),
      lineItem({ service: 'S3', usage: '200 GB', monthly_cost_cents: 430 }),
    ],
    ['USD', 'EUR'],
  );
  assert.equal(pair.currencyMismatch, true);
  const rows = alignLineItems(pair);
  assert.equal(rows.every((row) => row.costDeltaCents === undefined), true);
  assert.equal(rows.every((row) => row.costChanged === false), true);
  assert.equal(rows[0].status, 'changed');
  // S3's cost moved but its usage did not, and cost is not comparable here — so nothing changed
  // that this pair is allowed to claim.
  assert.equal(rows[1].status, 'unchanged');
});

test('alignLineItems lists base items in their own order, then the head-only additions', () => {
  const rows = alignLineItems(pairOf(
    [
      lineItem({ service: 'ECS Fargate', monthly_cost_cents: 13120 }),
      lineItem({ service: 'DynamoDB', monthly_cost_cents: 325 }),
      lineItem({ service: 'Elasticache', monthly_cost_cents: 1200 }),
    ],
    [
      lineItem({ service: 'DynamoDB', monthly_cost_cents: 480 }),
      lineItem({ service: 'NAT Gateway', monthly_cost_cents: 3285 }),
      lineItem({ service: 'ECS Fargate', monthly_cost_cents: 13120 }),
    ],
  ));
  assert.deepEqual(rows.map((row) => [row.service, row.status]), [
    ['ECS Fargate', 'unchanged'],
    ['DynamoDB', 'changed'],
    ['Elasticache', 'removed'],
    ['NAT Gateway', 'added'],
  ]);
});

test('alignLineItems pairs repeated and untrimmed service names exactly as diffLineItems does', () => {
  // Two rows for one service is legal in the editor, so the first unconsumed head candidate has to
  // win on both sides of the feature — if the rules drifted, the table and the tab badge would
  // describe the same pair differently.
  const pair = pairOf(
    [lineItem({ service: 'Lambda', monthly_cost_cents: 100 }), lineItem({ service: ' Lambda ', monthly_cost_cents: 200 })],
    [lineItem({ service: 'Lambda', monthly_cost_cents: 250 })],
  );
  assert.deepEqual(pair.lineItems.map((item) => [item.kind, item.service]), [['cost_changed', 'Lambda'], ['removed', 'Lambda']]);
  const rows = alignLineItems(pair);
  assert.deepEqual(rows.map((row) => [row.service, row.status]), [['Lambda', 'changed'], ['Lambda', 'removed']]);
  assert.equal(rows[0].costDeltaCents, 150);
});
