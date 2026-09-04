export interface QaTestCase {
  id: string;
  run_id: string;
  project_id: string;
  case_key: string;
  suite: string | null;
  name: string;
  file: string | null;
  status: string;
  duration_ms: number | null;
  failure_message: string | null;
  failure_detail: string | null;
  source_sha: string | null;
  external_ref: string | null;
  created_at: string;
}

export interface QaCaseHistoryEntry {
  run_id: string;
  started_at: string;
  status: string;
  case_duration_ms: number | null;
  run_duration_ms: number | null;
  commit_sha: string | null;
  branch: string | null;
  source_sha: string | null;
}

export interface QaRunMetric {
  id: string;
  run_id: string;
  project_id: string;
  metric_key: string;
  value: number;
  unit: string | null;
  created_at: string;
}

export interface QaTestSource {
  project_id: string;
  source_sha: string;
  file: string;
  language: string | null;
  body: string;
  byte_size: number;
  first_seen: string;
  last_seen: string;
}

export interface CasePartition {
  failed: QaTestCase[];
  passed: QaTestCase[];
  skipped: QaTestCase[];
}

export function partitionCases(cases: QaTestCase[]): CasePartition {
  const partition: CasePartition = { failed: [], passed: [], skipped: [] };

  for (const testCase of cases) {
    if (testCase.status === 'failed' || testCase.status === 'error') {
      partition.failed.push(testCase);
    } else if (testCase.status === 'passed') {
      partition.passed.push(testCase);
    } else {
      // Preserve future/unknown statuses in the non-passing bucket so a new
      // server status remains visible instead of silently disappearing.
      partition.skipped.push(testCase);
    }
  }

  return partition;
}

function trimNumber(value: number, maximumFractionDigits: number): string {
  return value.toFixed(maximumFractionDigits).replace(/\.?0+$/u, '');
}

export function formatCaseDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';

  const absoluteMs = Math.abs(ms);
  if (absoluteMs < 1000) return `${trimNumber(ms, 2)} ms`;
  if (absoluteMs < 60_000) return `${trimNumber(ms / 1000, 2)} s`;
  if (absoluteMs < 3_600_000) return `${trimNumber(ms / 60_000, 1)} min`;
  return `${trimNumber(ms / 3_600_000, 1)} h`;
}

export function shortSha(sha: string | null): string | null {
  if (sha === null || sha.length <= 7) return sha;
  return sha.slice(0, 7);
}

export interface CaseHistorySummary {
  firstFailingRunId: string | null;
  firstFailingStartedAt: string | null;
}

export function caseHistorySummary(entries: QaCaseHistoryEntry[]): CaseHistorySummary {
  for (let index = 0; index < entries.length - 1; index += 1) {
    const current = entries[index];
    const previous = entries[index + 1];
    const currentIsFailure = current.status === 'failed' || current.status === 'error';
    if (currentIsFailure && previous.status === 'passed') {
      return {
        firstFailingRunId: current.run_id,
        firstFailingStartedAt: current.started_at,
      };
    }
  }

  return { firstFailingRunId: null, firstFailingStartedAt: null };
}
