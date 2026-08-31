// Tests for the revision-history view-model helpers. Run with:
// node --test lib/design-history.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DIFF_KIND_STYLES, describeDiffEntry, formatDiffValue, formatRevisionLabel, summarizeDiff } from './design-history.ts';
import type { DiffEntry } from './design-diff.ts';

test('formatDiffValue passes a plain string through untouched', () => {
  assert.equal(formatDiffValue('Amazon ECS'), 'Amazon ECS');
  assert.equal(formatDiffValue(''), '');
});

test('formatDiffValue renders a position as "x, y"', () => {
  assert.equal(formatDiffValue({ x: 240, y: 120 }), '240, 120');
  assert.equal(formatDiffValue({ x: 0, y: -40 }), '0, -40');
});

test('formatDiffValue prefers the icon over the kind in a style snapshot', () => {
  assert.equal(formatDiffValue({ icon: 'fargate', kind: 'compute' }), 'fargate');
  assert.equal(formatDiffValue({ kind: 'compute' }), 'compute');
  // Both fields are optional on a style snapshot — a node with neither has nothing to show.
  assert.equal(formatDiffValue({ icon: undefined, kind: undefined }), '');
});

test('formatDiffValue renders edge endpoints as "source → target"', () => {
  assert.equal(formatDiffValue({ source: 'api', target: 'db' }), 'api → db');
});

test('formatDiffValue renders a missing side as an empty string', () => {
  assert.equal(formatDiffValue(undefined), '');
  assert.equal(formatDiffValue(null), '');
  assert.equal(formatDiffValue(42), '');
  assert.equal(formatDiffValue(['a', 'b']), '');
});

test('describeDiffEntry flattens both sides of a renamed node', () => {
  const entry: DiffEntry = {
    kind: 'renamed', entity: 'node', baseId: 'svc', headId: 'svc', label: 'AWS Fargate',
    before: 'Amazon ECS', after: 'AWS Fargate',
  };
  assert.deepEqual(describeDiffEntry(entry), {
    kind: 'renamed', entity: 'node', label: 'AWS Fargate',
    before: 'Amazon ECS', after: 'AWS Fargate', lowConfidence: false,
  });
});

test('describeDiffEntry leaves the absent side empty for an added entry', () => {
  const view = describeDiffEntry({ kind: 'added', entity: 'node', headId: 'cache', label: 'ElastiCache' });
  assert.equal(view.before, '');
  assert.equal(view.after, '');
  assert.equal(view.label, 'ElastiCache');
});

test('describeDiffEntry substitutes a placeholder for an unlabelled edge', () => {
  const view = describeDiffEntry({ kind: 'added', entity: 'edge', headId: 'e9', label: '' });
  assert.equal(view.label, '(unlabelled)');
  assert.equal(view.entity, 'edge');
});

test('describeDiffEntry reports low confidence only when the engine flagged it', () => {
  const base = { kind: 'moved', entity: 'node', baseId: 'n1', headId: 'n1', label: 'Queue' } as const;
  assert.equal(describeDiffEntry({ ...base }).lowConfidence, false);
  assert.equal(describeDiffEntry({ ...base, confidence: 'low' }).lowConfidence, true);
});

test('summarizeDiff counts added and removed separately and folds the rest into "changed"', () => {
  const entries: DiffEntry[] = [
    { kind: 'added', entity: 'node', headId: 'a', label: 'A' },
    { kind: 'added', entity: 'edge', headId: 'e1', label: '' },
    { kind: 'added', entity: 'node', headId: 'b', label: 'B' },
    { kind: 'removed', entity: 'node', baseId: 'c', label: 'C' },
    { kind: 'renamed', entity: 'node', baseId: 'd', headId: 'd', label: 'D' },
    { kind: 'moved', entity: 'node', baseId: 'd', headId: 'd', label: 'D' },
  ];
  assert.equal(summarizeDiff(entries), '3 added, 1 removed, 2 changed');
});

test('summarizeDiff omits the counts that are zero', () => {
  assert.equal(summarizeDiff([{ kind: 'removed', entity: 'node', baseId: 'c', label: 'C' }]), '1 removed');
  assert.equal(summarizeDiff([
    { kind: 'restyled', entity: 'node', baseId: 'd', headId: 'd', label: 'D' },
    { kind: 'rerouted', entity: 'edge', baseId: 'e', headId: 'e', label: '' },
  ]), '2 changed');
});

test('summarizeDiff reports no changes for an empty diff', () => {
  assert.equal(summarizeDiff([]), 'No changes');
});

test('formatRevisionLabel appends the label only when the revision has one', () => {
  assert.equal(formatRevisionLabel({ revision_num: 3, label: 'pre-Aurora baseline' }), 'r3 — pre-Aurora baseline');
  assert.equal(formatRevisionLabel({ revision_num: 2, label: null }), 'r2');
  assert.equal(formatRevisionLabel({ revision_num: 1, label: '   ' }), 'r1');
});

test('DIFF_KIND_STYLES covers every diff kind the engine emits', () => {
  const kinds = ['added', 'removed', 'renamed', 'moved', 'restyled', 'rerouted'];
  assert.deepEqual(Object.keys(DIFF_KIND_STYLES).sort(), [...kinds].sort());
  for (const kind of kinds) assert.match(DIFF_KIND_STYLES[kind as keyof typeof DIFF_KIND_STYLES], /^border-\S+ text-\S+ dark:text-\S+$/);
});
