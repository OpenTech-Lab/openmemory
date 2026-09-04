/**
 * Pressure tests for the QA read paths, run against a live OpenMemory server.
 *
 * The point is not to prove the server is fast. It is to measure it under
 * concurrency and record the numbers as a `load` run, so a regression shows up
 * as a trend in the QA panel rather than as a vague "feels slower".
 *
 * Thresholds are deliberately loose: this runs on a developer machine alongside
 * whatever else is happening, and a flaky perf test that cries wolf gets muted,
 * which is worse than no test. The assertions catch collapse — timeouts, 5xx,
 * pathological tail latency — not ordinary variance. The recorded metrics carry
 * the precision.
 *
 * Metrics are ingested with kind=load, which is what the metrics chart renders.
 * Set QA_PRESSURE_INGEST=0 to measure without recording.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

const BASE = (process.env.OPENMEMORY_URL || 'http://127.0.0.1:18080').replace(/\/+$/u, '');
const CONCURRENCY = Number(process.env.QA_PRESSURE_CONCURRENCY || 20);
const REQUESTS = Number(process.env.QA_PRESSURE_REQUESTS || 200);
const SHOULD_INGEST = process.env.QA_PRESSURE_INGEST !== '0';

function apiToken(): string {
  if (process.env.OPENMEMORY_API_TOKEN) return process.env.OPENMEMORY_API_TOKEN;
  try {
    return readFileSync(join(homedir(), '.openmemory', 'api_token'), 'utf8').trim();
  } catch {
    return 'dev-token-change-me';
  }
}

const TOKEN = apiToken();
const authHeaders = { Authorization: `Bearer ${TOKEN}` };

let serverUp = false;
let projectId = '';
const metrics: { metric_key: string; value: number; unit: string }[] = [];

interface Sample {
  ms: number;
  ok: boolean;
  status: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  // Nearest-rank: with 200 samples the index is unambiguous and there is no
  // interpolation to argue about when comparing runs.
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

function summarise(label: string, samples: Sample[], wallMs: number) {
  const durations = samples.map((s) => s.ms).sort((a, b) => a - b);
  const failures = samples.filter((s) => !s.ok);
  const summary = {
    count: samples.length,
    failures: failures.length,
    p50: percentile(durations, 50),
    p95: percentile(durations, 95),
    p99: percentile(durations, 99),
    max: durations[durations.length - 1] ?? 0,
    rps: wallMs > 0 ? (samples.length / wallMs) * 1000 : 0,
  };

  const round = (n: number) => Math.round(n * 100) / 100;
  metrics.push(
    { metric_key: `${label}.p50_ms`, value: round(summary.p50), unit: 'ms' },
    { metric_key: `${label}.p95_ms`, value: round(summary.p95), unit: 'ms' },
    { metric_key: `${label}.p99_ms`, value: round(summary.p99), unit: 'ms' },
    { metric_key: `${label}.max_ms`, value: round(summary.max), unit: 'ms' },
    { metric_key: `${label}.rps`, value: round(summary.rps), unit: 'req/s' },
    { metric_key: `${label}.failures`, value: summary.failures, unit: 'count' },
  );

  console.log(
    `${label}: n=${summary.count} fail=${summary.failures} ` +
      `p50=${round(summary.p50)}ms p95=${round(summary.p95)}ms p99=${round(summary.p99)}ms ` +
      `max=${round(summary.max)}ms rps=${round(summary.rps)}`,
  );
  return summary;
}

/** Fixed-size worker pool: keeps exactly `concurrency` requests in flight. */
async function hammer(path: string, concurrency: number, total: number): Promise<{ samples: Sample[]; wallMs: number }> {
  const samples: Sample[] = [];
  let issued = 0;
  const wallStart = performance.now();

  async function worker() {
    while (issued < total) {
      issued += 1;
      const started = performance.now();
      try {
        const res = await fetch(`${BASE}${path}`, {
          headers: authHeaders,
          signal: AbortSignal.timeout(15_000),
        });
        // Drain the body: leaving it unread distorts timing and leaks sockets.
        await res.arrayBuffer();
        samples.push({ ms: performance.now() - started, ok: res.ok, status: res.status });
      } catch {
        samples.push({ ms: performance.now() - started, ok: false, status: 0 });
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return { samples, wallMs: performance.now() - wallStart };
}

before(async () => {
  try {
    serverUp = (await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3000) })).ok;
  } catch {
    serverUp = false;
  }
  if (!serverUp) {
    console.error(`qa-pressure: server unreachable at ${BASE} — skipping pressure tests`);
    return;
  }
  const projects = (await (await fetch(`${BASE}/projects`, { headers: authHeaders })).json())?.projects ?? [];
  projectId = projects[0]?.id ?? '';
});

after(async () => {
  if (!serverUp || !projectId || !SHOULD_INGEST || metrics.length === 0) return;
  // Record the measurement as a load run so the numbers become a trend line
  // instead of scrollback. A failure here must not fail the suite: the
  // measurement already happened and the assertions already ran.
  try {
    const res = await fetch(`${BASE}/projects/${projectId}/qa/ingest`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'QA read-path pressure test',
        kind: 'load',
        runner: 'node:test',
        cases: [],
        metrics,
      }),
    });
    console.log(`qa-pressure: metrics ingested (${res.status})`);
  } catch (error) {
    console.error(`qa-pressure: metric ingest skipped (${error instanceof Error ? error.message : error})`);
  }
});

function requireServer(t: { skip: (reason?: string) => void }): boolean {
  if (!serverUp || !projectId) {
    t.skip('server unreachable');
    return false;
  }
  return true;
}

test('health survives sustained concurrency without a single failure', async (t) => {
  if (!requireServer(t)) return;
  const { samples, wallMs } = await hammer('/health', CONCURRENCY, REQUESTS);
  const summary = summarise('health', samples, wallMs);

  // Health does no database work. If this one drops requests, nothing else in
  // the measurement means anything.
  assert.equal(summary.failures, 0, 'health dropped requests under load');
  assert.ok(summary.p99 < 2000, `health p99 was ${summary.p99}ms`);
});

test('the run list holds up under concurrency', async (t) => {
  if (!requireServer(t)) return;
  // This is the endpoint the QA panel hits on every open, and the one whose 1+N
  // regression would show here first: 201 queries per load instead of one.
  const { samples, wallMs } = await hammer(`/projects/${projectId}/qa/runs?limit=50`, CONCURRENCY, REQUESTS);
  const summary = summarise('qa_runs_list', samples, wallMs);

  assert.equal(summary.failures, 0, 'the run list dropped requests under load');
  assert.ok(summary.p95 < 3000, `run list p95 was ${summary.p95}ms`);
});

test('the per-case read holds up under concurrency', async (t) => {
  if (!requireServer(t)) return;
  const runs = (await (await fetch(`${BASE}/projects/${projectId}/qa/runs?limit=1`, { headers: authHeaders })).json())?.runs ?? [];
  if (runs.length === 0) {
    t.skip('no recorded runs to read');
    return;
  }
  const { samples, wallMs } = await hammer(
    `/projects/${projectId}/qa/runs/${runs[0].id}/cases?limit=200`,
    CONCURRENCY,
    REQUESTS,
  );
  const summary = summarise('qa_cases_read', samples, wallMs);

  assert.equal(summary.failures, 0, 'the case read dropped requests under load');
  assert.ok(summary.p95 < 3000, `case read p95 was ${summary.p95}ms`);
});

test('the connection pool recovers rather than degrading run over run', async (t) => {
  if (!requireServer(t)) return;
  // The server holds a 10-connection pool. Two identical bursts back to back
  // catch exhaustion that a single burst hides: if connections are leaked, the
  // second round is dramatically worse than the first.
  const first = await hammer(`/projects/${projectId}/qa/runs?limit=20`, CONCURRENCY, 100);
  const second = await hammer(`/projects/${projectId}/qa/runs?limit=20`, CONCURRENCY, 100);

  const a = summarise('pool_round1', first.samples, first.wallMs);
  const b = summarise('pool_round2', second.samples, second.wallMs);

  assert.equal(a.failures + b.failures, 0, 'requests were dropped across repeated bursts');
  // 5x is enormous; anything short of leak-shaped degradation stays under it.
  assert.ok(
    b.p95 < Math.max(a.p95 * 5, 500),
    `second burst p95 (${b.p95}ms) degraded sharply from the first (${a.p95}ms) — suspect pool exhaustion`,
  );
});
