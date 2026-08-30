// Tests for the base/head budget comparison engine. Run with:
// node --test lib/budget-diff.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
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

test('pairs by forecast_profile_id when both sides share a non-null id, even if names differ', () => {
  const base = [forecast({ id: 'b1', name: 'Base name', forecast_profile_id: 'profile-1' })];
  const head = [forecast({ id: 'h1', name: 'Head name', forecast_profile_id: 'profile-1' })];
  const diff = diffBudgets(base, head);
  assert.equal(diff.matched.length, 1);
  assert.equal(diff.matched[0].matchedBy, 'forecast_profile_id');
  assert.equal(diff.matched[0].base.id, 'b1');
  assert.equal(diff.matched[0].head.id, 'h1');
  assert.deepEqual(diff.onlyInBase, []);
  assert.deepEqual(diff.onlyInHead, []);
});

test('falls back to trimmed name matching when both profile ids are null — the majority case', () => {
  // The budget sheet's own default persists custom-conditions scenarios with a null profile id
  // (design-budget-sheet.tsx's 'custom' sentinel), so this path is what most rows hit.
  const base = [forecast({ id: 'b1', name: '  Custom Scenario  ', forecast_profile_id: null })];
  const head = [forecast({ id: 'h1', name: 'Custom Scenario', forecast_profile_id: null })];
  const diff = diffBudgets(base, head);
  assert.equal(diff.matched.length, 1);
  assert.equal(diff.matched[0].matchedBy, 'name');
  assert.equal(diff.matched[0].base.id, 'b1');
  assert.equal(diff.matched[0].head.id, 'h1');
});

test('rows with no match on either side are reported as unpaired, never force-paired', () => {
  const base = [forecast({ id: 'b1', name: 'Only in base', forecast_profile_id: 'profile-1' })];
  const head = [forecast({ id: 'h1', name: 'Only in head', forecast_profile_id: 'profile-2' })];
  const diff = diffBudgets(base, head);
  assert.equal(diff.matched.length, 0);
  assert.equal(diff.onlyInBase.length, 1);
  assert.equal(diff.onlyInBase[0].id, 'b1');
  assert.equal(diff.onlyInHead.length, 1);
  assert.equal(diff.onlyInHead[0].id, 'h1');
});

test('a usage-only change on a matched service is its own change kind, cost left untouched', () => {
  const base = [forecast({
    id: 'b1', name: 'Scenario', monthly_total_cents: 500,
    line_items: [lineItem({ service: 'Lambda', usage: '10k req/mo', monthly_cost_cents: 500 })],
  })];
  const head = [forecast({
    id: 'h1', name: 'Scenario', monthly_total_cents: 500,
    line_items: [lineItem({ service: 'Lambda', usage: '1M req/mo', monthly_cost_cents: 500 })],
  })];
  const diff = diffBudgets(base, head);
  assert.equal(diff.matched[0].lineItems.length, 1);
  assert.deepEqual(diff.matched[0].lineItems[0], {
    kind: 'usage_changed', service: 'Lambda',
    base: base[0].line_items[0], head: head[0].line_items[0],
  });
});

test('currency mismatch flags the pair and computes no delta, at the total or line-item level', () => {
  const base = [forecast({
    id: 'b1', name: 'Scenario', currency: 'USD', monthly_total_cents: 10000,
    line_items: [lineItem({ service: 'Lambda', usage: 'steady', monthly_cost_cents: 10000 })],
  })];
  const head = [forecast({
    id: 'h1', name: 'Scenario', currency: 'EUR', monthly_total_cents: 9000,
    line_items: [lineItem({ service: 'Lambda', usage: 'steady', monthly_cost_cents: 9000 })],
  })];
  const diff = diffBudgets(base, head);
  const pair = diff.matched[0];
  assert.equal(pair.currencyMismatch, true);
  assert.equal(pair.totalDelta, null);
  // Raw figures stay reachable on each side for the UI to show side by side.
  assert.equal(pair.base.currency, 'USD');
  assert.equal(pair.base.monthly_total_cents, 10000);
  assert.equal(pair.head.currency, 'EUR');
  assert.equal(pair.head.monthly_total_cents, 9000);
  // The Lambda line differs in cost (10000 vs 9000) but that comparison is only meaningful
  // within one currency, so no cost_changed entry is invented for it.
  assert.deepEqual(pair.lineItems, []);
});

test('percentChange is null when the base total is 0, guarding a division by zero', () => {
  const base = [forecast({ id: 'b1', name: 'Scenario', monthly_total_cents: 0 })];
  const head = [forecast({ id: 'h1', name: 'Scenario', monthly_total_cents: 5000 })];
  const diff = diffBudgets(base, head);
  const totalDelta = diff.matched[0].totalDelta;
  assert.ok(totalDelta);
  assert.equal(totalDelta.baseCents, 0);
  assert.equal(totalDelta.headCents, 5000);
  assert.equal(totalDelta.deltaCents, 5000);
  assert.equal(totalDelta.percentChange, null);
});

test('totalDelta reports both the absolute and percentage change for a normal matched pair', () => {
  const base = [forecast({ id: 'b1', name: 'Scenario', monthly_total_cents: 10000 })];
  const head = [forecast({ id: 'h1', name: 'Scenario', monthly_total_cents: 12000 })];
  const diff = diffBudgets(base, head);
  assert.deepEqual(diff.matched[0].totalDelta, {
    baseCents: 10000, headCents: 12000, deltaCents: 2000, percentChange: 20,
  });
});

test('line items report added and removed services; an unchanged service produces no entry', () => {
  const base = [forecast({
    id: 'b1', name: 'Scenario',
    line_items: [
      lineItem({ service: 'Lambda', usage: 'steady', monthly_cost_cents: 500 }),
      lineItem({ service: 'RDS', usage: 'db.t3.micro', monthly_cost_cents: 800 }),
    ],
  })];
  const head = [forecast({
    id: 'h1', name: 'Scenario',
    line_items: [
      lineItem({ service: 'Lambda', usage: 'steady', monthly_cost_cents: 500 }),
      lineItem({ service: 'S3', usage: 'standard storage', monthly_cost_cents: 300 }),
    ],
  })];
  const diff = diffBudgets(base, head);
  const kinds = diff.matched[0].lineItems.map((change) => `${change.kind}:${change.service}`).sort();
  assert.deepEqual(kinds, ['added:S3', 'removed:RDS']);
});

test('cost_changed line item reports the integer-cent delta', () => {
  const base = [forecast({
    id: 'b1', name: 'Scenario',
    line_items: [lineItem({ service: 'Lambda', usage: 'steady', monthly_cost_cents: 500 })],
  })];
  const head = [forecast({
    id: 'h1', name: 'Scenario',
    line_items: [lineItem({ service: 'Lambda', usage: 'steady', monthly_cost_cents: 800 })],
  })];
  const diff = diffBudgets(base, head);
  assert.deepEqual(diff.matched[0].lineItems, [{
    kind: 'cost_changed', service: 'Lambda',
    base: base[0].line_items[0], head: head[0].line_items[0], costDeltaCents: 300,
  }]);
});

test('confidence, conditions, and pricing_basis changes are surfaced; unchanged fields report null', () => {
  const base = [forecast({
    id: 'b1', name: 'Scenario', confidence: 'low', conditions: 'steady traffic', pricing_basis: 'on-demand',
  })];
  const head = [forecast({
    id: 'h1', name: 'Scenario', confidence: 'high', conditions: 'steady traffic', pricing_basis: 'reserved',
  })];
  const diff = diffBudgets(base, head);
  const pair = diff.matched[0];
  assert.deepEqual(pair.confidence, { base: 'low', head: 'high' });
  assert.equal(pair.conditions, null);
  assert.deepEqual(pair.pricingBasis, { base: 'on-demand', head: 'reserved' });
});

test('multiple base rows never claim the same head row twice', () => {
  // Two custom (null-profile) scenarios sharing a name: without consumed-tracking, both base
  // rows could match the same head row and the second head row would wrongly show as unpaired.
  const base = [
    forecast({ id: 'b1', name: 'Scenario' }),
    forecast({ id: 'b2', name: 'Scenario' }),
  ];
  const head = [
    forecast({ id: 'h1', name: 'Scenario' }),
    forecast({ id: 'h2', name: 'Scenario' }),
  ];
  const diff = diffBudgets(base, head);
  assert.equal(diff.matched.length, 2);
  assert.deepEqual(diff.onlyInBase, []);
  assert.deepEqual(diff.onlyInHead, []);
  const headIds = diff.matched.map((pair) => pair.head.id).sort();
  assert.deepEqual(headIds, ['h1', 'h2']);
});
