import assert from 'node:assert/strict';
import test from 'node:test';
import { PLAN_KINDS } from './qa-meta.ts';
import {
  duplicateDescription,
  duplicatePlanName,
  planKindForSource,
  planLanguageForSource,
  type DuplicateProvenance,
} from './qa-duplicate.ts';

test('planKindForSource reaches every allowed plan kind', () => {
  const sources = [
    ['jest', 'apps/web/lib/example.test.ts'],
    ['playwright', 'apps/web/e2e/login.spec.ts'],
    ['maestro', 'apps/web/e2e/login.yaml'],
    ['other', 'apps/web/scripts/check.ts'],
  ] as const;

  const kinds = sources.map(([runner, file]) => planKindForSource(runner, file));
  assert.deepEqual(new Set(kinds), new Set(PLAN_KINDS));
});

test('planKindForSource maps node:test and cargo nextest to other', () => {
  assert.equal(planKindForSource('node:test', 'apps/web/lib/qa-cases.test.ts'), 'other');
  assert.equal(planKindForSource('cargo nextest', 'apps/server/src/qa.rs'), 'other');
});

test('planKindForSource recognizes case-insensitive runner and YAML source names', () => {
  assert.equal(planKindForSource('VITEST', 'apps/web/lib/example.ts'), 'jest');
  assert.equal(planKindForSource(null, 'flows/Smoke.YML'), 'maestro');
});

test('planLanguageForSource only passes through allowed languages', () => {
  assert.equal(planLanguageForSource(' TypeScript '), 'typescript');
  assert.equal(planLanguageForSource('JAVASCRIPT'), 'javascript');
  assert.equal(planLanguageForSource('yaml'), 'yaml');
  assert.equal(planLanguageForSource('python'), 'python');
  assert.equal(planLanguageForSource('rust'), 'other');
  assert.equal(planLanguageForSource(null), 'other');
});

test('duplicatePlanName falls back when the case name is blank', () => {
  assert.equal(duplicatePlanName('   ', 'Checkout'), 'Duplicated test (copy)');
  assert.equal(duplicatePlanName('\t\n', null), 'Duplicated test (copy)');
});

test('duplicatePlanName includes the suite and truncates long names safely', () => {
  assert.equal(duplicatePlanName('formats null', 'qa-cases'), 'qa-cases › formats null (copy)');

  const name = duplicatePlanName(`${'😀'.repeat(150)} end`, 'suite');
  assert.ok(name.length <= 200);
  assert.ok(name.length > 0);
  assert.doesNotMatch(name, /\uD800|\uDC00/u);
});

test('duplicateDescription preserves recorded provenance verbatim', () => {
  const provenance: DuplicateProvenance = {
    case_key: 'apps/web/lib/qa-cases.test.ts::formatCaseDuration formats null',
    file: 'apps/web/lib/qa-cases.test.ts',
    status: 'failed',
    run_id: 'b9f683bc-98eb-42c6-90a7-552066e9854f',
    started_at: '2026-09-04T00:57:00.000Z',
    commit_sha: '5dbb345',
    branch: 'main',
    source_sha: 'c26b08603257f5ce',
  };

  const description = duplicateDescription(provenance);
  assert.ok(description.includes(provenance.case_key));
  assert.ok(description.includes(provenance.run_id));
  assert.ok(description.includes(provenance.source_sha));
});
