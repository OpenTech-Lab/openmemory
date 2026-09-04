import assert from 'node:assert/strict';
import test from 'node:test';
import {
  diffQaPlanBodies,
  formatQaPlanRevisionLabel,
  formatQaPlanVersionLabel,
  LIVE_VERSION_KEY,
  summarizeQaPlanDiff,
} from './qa-plan-history.ts';

test('formatQaPlanRevisionLabel includes a non-blank label after the version number', () => {
  assert.equal(formatQaPlanRevisionLabel({ revision_num: 2, label: 'home and about' }), 'v2 — home and about');
  assert.equal(formatQaPlanRevisionLabel({ revision_num: 1, label: '   ' }), 'v1');
  assert.equal(formatQaPlanRevisionLabel({ revision_num: 3, label: null }), 'v3');
});

test('formatQaPlanVersionLabel uses the LIVE pseudo-key and resolves frozen labels', () => {
  const revisions = [{ revision_num: 2, label: 'home and about' }, { revision_num: 1, label: null }];
  assert.equal(formatQaPlanVersionLabel(LIVE_VERSION_KEY, revisions), 'Live (current)');
  assert.equal(formatQaPlanVersionLabel('2', revisions), 'v2 — home and about');
  assert.equal(formatQaPlanVersionLabel('1', revisions), 'v1');
  assert.equal(formatQaPlanVersionLabel('9', revisions), 'v9');
});

test('diffQaPlanBodies reports unchanged, removed, and added lines in source order', () => {
  assert.deepEqual(diffQaPlanBodies('home\ncheckout', 'home\nabout\ncheckout'), [
    { kind: 'unchanged', text: 'home', lineNumber: 1 },
    { kind: 'added', text: 'about', lineNumber: 2 },
    { kind: 'unchanged', text: 'checkout', lineNumber: 3 },
  ]);
  assert.deepEqual(diffQaPlanBodies('old', 'new'), [
    { kind: 'removed', text: 'old', lineNumber: null },
    { kind: 'added', text: 'new', lineNumber: 1 },
  ]);
});

test('diffQaPlanBodies returns no rows for two empty bodies', () => {
  assert.deepEqual(diffQaPlanBodies('', ''), []);
});

test('summarizeQaPlanDiff counts only changed source lines', () => {
  const lines = diffQaPlanBodies('home\ncheckout', 'home\nabout\ncheckout');
  assert.equal(summarizeQaPlanDiff(lines), '1 added');
  assert.equal(summarizeQaPlanDiff(diffQaPlanBodies('same', 'same')), 'No changes');
});
