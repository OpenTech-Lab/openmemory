import assert from 'node:assert/strict';
import test from 'node:test';
import {
  caseHistorySummary,
  formatCaseDuration,
  partitionCases,
  shortSha,
  type QaCaseHistoryEntry,
  type QaTestCase,
} from './qa-cases.ts';

function testCase(status: string, name = status): QaTestCase {
  return {
    id: name,
    run_id: 'run-1',
    project_id: 'project-1',
    case_key: name,
    suite: null,
    name,
    file: null,
    status,
    duration_ms: null,
    failure_message: null,
    failure_detail: null,
    source_sha: null,
    external_ref: null,
    created_at: '2026-09-04T00:00:00.000Z',
  };
}

test('partitionCases puts errors with failures and preserves unknown statuses', () => {
  const result = partitionCases([
    testCase('passed', 'pass'),
    testCase('error', 'error'),
    testCase('failed', 'fail'),
    testCase('skipped', 'skip'),
    testCase('quarantined', 'unknown'),
  ]);

  assert.deepEqual(result.failed.map((item) => item.name), ['error', 'fail']);
  assert.deepEqual(result.passed.map((item) => item.name), ['pass']);
  assert.deepEqual(result.skipped.map((item) => item.name), ['skip', 'unknown']);
});

test('partitionCases preserves source order within each bucket', () => {
  const result = partitionCases([
    testCase('failed', 'first failure'),
    testCase('passed', 'first pass'),
    testCase('failed', 'second failure'),
  ]);

  assert.deepEqual(result.failed.map((item) => item.name), ['first failure', 'second failure']);
  assert.deepEqual(result.passed.map((item) => item.name), ['first pass']);
});

test('formatCaseDuration formats null, zero, milliseconds, and seconds compactly', () => {
  assert.equal(formatCaseDuration(null), '—');
  assert.equal(formatCaseDuration(0), '0 ms');
  assert.equal(formatCaseDuration(1.5), '1.5 ms');
  assert.equal(formatCaseDuration(4210), '4.21 s');
});

test('shortSha limits long hashes to seven characters and passes through short values', () => {
  assert.equal(shortSha('0123456789abcdef'), '0123456');
  assert.equal(shortSha('0123456'), '0123456');
  assert.equal(shortSha('abc'), 'abc');
  assert.equal(shortSha(null), null);
});

function historyEntry(runId: string, status: string, startedAt: string): QaCaseHistoryEntry {
  return {
    run_id: runId,
    started_at: startedAt,
    status,
    case_duration_ms: 1.5,
    run_duration_ms: 4210,
    commit_sha: null,
    branch: null,
    source_sha: null,
  };
}

test('caseHistorySummary finds the newest passed-to-failed transition', () => {
  const result = caseHistorySummary([
    historyEntry('run-new-failed', 'failed', '2026-09-04T03:00:00.000Z'),
    historyEntry('run-before', 'passed', '2026-09-04T02:00:00.000Z'),
    historyEntry('run-old-failed', 'failed', '2026-09-04T01:00:00.000Z'),
    historyEntry('run-oldest', 'passed', '2026-09-04T00:00:00.000Z'),
  ]);

  assert.deepEqual(result, {
    firstFailingRunId: 'run-new-failed',
    firstFailingStartedAt: '2026-09-04T03:00:00.000Z',
  });
});

test('caseHistorySummary returns empty fields when no transition exists', () => {
  assert.deepEqual(caseHistorySummary([
    historyEntry('run-1', 'passed', '2026-09-04T01:00:00.000Z'),
    historyEntry('run-2', 'passed', '2026-09-04T00:00:00.000Z'),
  ]), {
    firstFailingRunId: null,
    firstFailingStartedAt: null,
  });
});
