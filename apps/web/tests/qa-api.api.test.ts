/**
 * API tests for the QA surface, run against a live OpenMemory server.
 *
 * These exercise the endpoints that unit tests cannot reach: auth, the CHECK
 * constraints the database enforces, and the ingest → read-back round trip.
 * Several of the bugs shipped in this feature (a 404 route, a payload the CHECK
 * rejected) were invisible to every type check and only an HTTP call finds them.
 *
 * Requires the server on OPENMEMORY_URL (default http://127.0.0.1:18080).
 * Skips itself, loudly, when the server is unreachable — a developer without the
 * stack up should not see a wall of red they cannot act on.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

const BASE = (process.env.OPENMEMORY_URL || 'http://127.0.0.1:18080').replace(/\/+$/u, '');

function apiToken(): string {
  if (process.env.OPENMEMORY_API_TOKEN) return process.env.OPENMEMORY_API_TOKEN;
  try {
    return readFileSync(join(homedir(), '.openmemory', 'api_token'), 'utf8').trim();
  } catch {
    return 'dev-token-change-me';
  }
}

const TOKEN = apiToken();

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

let projectId = '';
let serverUp = false;
const createdPlans: string[] = [];
const createdRuns: string[] = [];

before(async () => {
  try {
    const health = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3000) });
    serverUp = health.ok;
  } catch {
    serverUp = false;
  }
  if (!serverUp) {
    console.error(`qa-api: server unreachable at ${BASE} — skipping API tests`);
    return;
  }
  const res = await api('/projects');
  const body = await res.json();
  projectId = body?.projects?.[0]?.id ?? '';
});

// Every test body starts with this: node:test has no "skip the whole file"
// switch that also reports the reason once.
function requireServer(t: { skip: (reason?: string) => void }): boolean {
  if (!serverUp || !projectId) {
    t.skip('server unreachable');
    return false;
  }
  return true;
}

after(async () => {
  if (!serverUp) return;
  for (const id of createdPlans) {
    await api(`/projects/${projectId}/qa/plans/${id}`, { method: 'DELETE' }).catch(() => {});
  }
  for (const id of createdRuns) {
    await api(`/projects/${projectId}/qa/runs/${id}`, { method: 'DELETE' }).catch(() => {});
  }
});

test('health responds without a token', async () => {
  if (!serverUp) return;
  const res = await fetch(`${BASE}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok' });
});

test('every QA read endpoint rejects a missing token', async (t) => {
  if (!requireServer(t)) return;
  for (const path of [
    `/projects/${projectId}/qa/runs`,
    `/projects/${projectId}/qa/plans`,
    `/projects/${projectId}/qa/plans/00000000-0000-0000-0000-000000000000/revisions`,
    `/projects/${projectId}/qa/plans/00000000-0000-0000-0000-000000000000/revisions/1`,
    `/projects/${projectId}/qa/events`,
    `/projects/${projectId}/qa/metrics`,
  ]) {
    const res = await fetch(`${BASE}${path}`);
    assert.equal(res.status, 401, `${path} allowed an unauthenticated read`);
  }
});

test('a bad token is rejected, not merely a missing one', async (t) => {
  if (!requireServer(t)) return;
  const res = await fetch(`${BASE}/projects/${projectId}/qa/runs`, {
    headers: { Authorization: 'Bearer not-the-real-token' },
  });
  assert.equal(res.status, 401);
});

test('the run list returns the denormalised counters the panel renders', async (t) => {
  if (!requireServer(t)) return;
  const res = await api(`/projects/${projectId}/qa/runs?limit=1`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.runs));
  if (body.runs.length === 0) return;

  const run = body.runs[0];
  // The panel reads these directly; a missing one renders as blank, not an error,
  // so assert their presence rather than trusting the UI to complain.
  for (const field of ['kind', 'total_cases', 'passed_cases', 'failed_cases', 'skipped_cases', 'evidence_count']) {
    assert.ok(field in run, `run list is missing ${field}`);
  }
  assert.equal(typeof run.evidence_count, 'number');
});

test('ingest round-trips a run and its cases', async (t) => {
  if (!requireServer(t)) return;
  const marker = `api-test-${Date.now()}`;
  const res = await api(`/projects/${projectId}/qa/ingest`, {
    method: 'POST',
    body: JSON.stringify({
      title: marker,
      kind: 'api',
      runner: 'node:test',
      duration_ms: 42,
      cases: [
        { name: 'first case', file: 'tests/qa-api.api.test.ts', status: 'passed', duration_ms: 1.5 },
        {
          name: 'second case',
          file: 'tests/qa-api.api.test.ts',
          status: 'failed',
          duration_ms: 2.5,
          failure_message: 'expected true',
        },
      ],
      metrics: [{ metric_key: 'latency_p95_ms', value: 12.5, unit: 'ms' }],
    }),
  });
  // Read the body exactly once: a template literal in an assert message is
  // evaluated eagerly, so `await res.text()` there consumes it before json().
  const rawBody = await res.text();
  // 201 Created is the correct answer here; accept either rather than pinning a
  // number the server is free to choose.
  assert.ok(res.status === 200 || res.status === 201, `ingest returned ${res.status}: ${rawBody}`);
  const created = JSON.parse(rawBody);
  const runId = created.run_id ?? created.id ?? created.run?.id;
  assert.ok(runId, `ingest did not return a run id: ${JSON.stringify(created)}`);
  createdRuns.push(runId);

  const detail = await (await api(`/projects/${projectId}/qa/runs/${runId}`)).json();
  const run = detail.run ?? detail;
  // One failing case must make the whole run failed; a run that reports "passed"
  // while holding a failure is the worst possible lie for this feature to tell.
  assert.equal(run.status, 'failed');
  assert.equal(run.kind, 'api');
  assert.equal(run.total_cases, 2);
  assert.equal(run.passed_cases, 1);
  assert.equal(run.failed_cases, 1);

  const cases = await (await api(`/projects/${projectId}/qa/runs/${runId}/cases`)).json();
  assert.equal(cases.total, 2);

  const failedOnly = await (await api(`/projects/${projectId}/qa/runs/${runId}/cases?status=failed`)).json();
  assert.equal(failedOnly.total, 1);
  assert.equal(failedOnly.cases[0].failure_message, 'expected true');

  const metrics = await (await api(`/projects/${projectId}/qa/metrics?run_id=${runId}`)).json();
  assert.equal(metrics.total, 1);
  assert.equal(metrics.metrics[0].metric_key, 'latency_p95_ms');
  assert.equal(metrics.metrics[0].value, 12.5);
});

test('case history is ordered newest first and carries both durations', async (t) => {
  if (!requireServer(t)) return;
  const name = `history probe ${Date.now()}`;
  let caseKey = '';

  for (const [index, status] of ['passed', 'failed'].entries()) {
    const res = await api(`/projects/${projectId}/qa/ingest`, {
      method: 'POST',
      body: JSON.stringify({
        title: `history probe ${index}`,
        kind: 'api',
        runner: 'node:test',
        duration_ms: 1000 + index,
        cases: [
          { name, file: 'tests/qa-api.api.test.ts', status, duration_ms: index + 1 },
        ],
      }),
    });
    const body = await res.json();
    const runId = body.run_id ?? body.id;
    if (runId) {
      createdRuns.push(runId);
      // The server derives case_key from file/suite/name; read the real one back
      // rather than guessing its format, which is exactly the sort of assumption
      // that rots the moment the derivation changes.
      if (!caseKey) {
        const cases = await (await api(`/projects/${projectId}/qa/runs/${runId}/cases`)).json();
        caseKey = cases.cases?.[0]?.case_key ?? '';
      }
    }
  }
  assert.ok(caseKey, 'could not read back a case_key');

  const history = await (
    await api(`/projects/${projectId}/qa/cases/history?case_key=${encodeURIComponent(caseKey)}`)
  ).json();
  assert.ok(Array.isArray(history), 'history must be a bare array');
  assert.equal(history.length, 2);
  assert.equal(history[0].status, 'failed', 'newest entry must come first');
  assert.equal(history[1].status, 'passed');
  // The distinction that a UI bug already erased once: the case's own time and
  // the whole run's wall time are different quantities.
  assert.notEqual(history[0].case_duration_ms, history[0].run_duration_ms);
});

test('case history requires a case_key rather than returning everything', async (t) => {
  if (!requireServer(t)) return;
  const res = await api(`/projects/${projectId}/qa/cases/history`);
  assert.equal(res.status, 400);
});

test('the database CHECK constraints are enforced through the API', async (t) => {
  if (!requireServer(t)) return;

  const badKind = await api(`/projects/${projectId}/qa/plans`, {
    method: 'POST',
    body: JSON.stringify({ name: 'bad kind probe', kind: 'not-a-real-kind', language: 'typescript' }),
  });
  assert.ok(badKind.status >= 400, 'an out-of-set plan kind must be rejected');

  const badLanguage = await api(`/projects/${projectId}/qa/plans`, {
    method: 'POST',
    body: JSON.stringify({ name: 'bad language probe', kind: 'jest', language: 'klingon' }),
  });
  assert.ok(badLanguage.status >= 400, 'an out-of-set plan language must be rejected');

  const blankName = await api(`/projects/${projectId}/qa/plans`, {
    method: 'POST',
    body: JSON.stringify({ name: '   ', kind: 'jest', language: 'typescript' }),
  });
  assert.ok(blankName.status >= 400, 'a blank plan name must be rejected');
});

test('a plan round-trips through create, read, update and delete', async (t) => {
  if (!requireServer(t)) return;
  const created = await (
    await api(`/projects/${projectId}/qa/plans`, {
      method: 'POST',
      body: JSON.stringify({
        name: `api round-trip ${Date.now()}`,
        kind: 'jest',
        language: 'typescript',
        body: 'test("x", () => {});\n',
      }),
    })
  ).json();
  assert.ok(created.id);
  createdPlans.push(created.id);

  const patched = await api(`/projects/${projectId}/qa/plans/${created.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ description: 'updated by the API suite' }),
  });
  assert.equal(patched.status, 200);
  const after = await (await api(`/projects/${projectId}/qa/plans/${created.id}`)).json();
  assert.equal((after.plan ?? after).description, 'updated by the API suite');

  const deleted = await api(`/projects/${projectId}/qa/plans/${created.id}`, { method: 'DELETE' });
  assert.ok(deleted.ok);
  createdPlans.pop();

  const gone = await api(`/projects/${projectId}/qa/plans/${created.id}`);
  assert.equal(gone.status, 404);
});

test('plan revisions cut, list, get, restore, and pin an explicit run', async (t) => {
  if (!requireServer(t)) return;

  const v1Body = "const test = require('node:test');\ntest('home page only', () => {});\n";
  const v2Body = `${v1Body}test('about page', () => {});\n`;
  const createdResponse = await api(`/projects/${projectId}/qa/plans`, {
    method: 'POST',
    body: JSON.stringify({
      name: `api versioned plan ${Date.now()}`,
      kind: 'other',
      language: 'javascript',
      body: v1Body,
    }),
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.ok(created.id);
  createdPlans.push(created.id);

  const v1Response = await api(`/projects/${projectId}/qa/plans/${created.id}/revisions`, {
    method: 'POST',
    body: JSON.stringify({ label: 'home page only', created_by: 'human' }),
  });
  assert.equal(v1Response.status, 201);
  const v1 = await v1Response.json();
  assert.equal(v1.revision_num, 1);
  assert.equal(v1.body, v1Body);

  const updateResponse = await api(`/projects/${projectId}/qa/plans/${created.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ body: v2Body }),
  });
  assert.equal(updateResponse.status, 200);

  const v2Response = await api(`/projects/${projectId}/qa/plans/${created.id}/revisions`, {
    method: 'POST',
    body: JSON.stringify({ label: 'home page plus about', created_by: 'human' }),
  });
  assert.equal(v2Response.status, 201);
  const v2 = await v2Response.json();
  assert.equal(v2.revision_num, 2);

  const listedResponse = await api(`/projects/${projectId}/qa/plans/${created.id}/revisions`);
  assert.equal(listedResponse.status, 200);
  const listed = await listedResponse.json();
  assert.deepEqual(listed.revisions.map((revision: { revision_num: number }) => revision.revision_num), [2, 1]);
  assert.ok(!('body' in listed.revisions[0]), 'revision lists must omit the source body');

  const gotV1Response = await api(`/projects/${projectId}/qa/plans/${created.id}/revisions/1`);
  assert.equal(gotV1Response.status, 200);
  assert.equal((await gotV1Response.json()).body, v1Body);

  const restoreResponse = await api(`/projects/${projectId}/qa/plans/${created.id}/revisions/1/restore`, {
    method: 'POST',
    body: JSON.stringify({ created_by: 'human' }),
  });
  assert.equal(restoreResponse.status, 200);
  assert.equal((await restoreResponse.json()).body, v1Body);

  // The state replaced by restore remains recoverable as v2; restore did not
  // rewrite or delete the prior frozen source.
  const gotV2Response = await api(`/projects/${projectId}/qa/plans/${created.id}/revisions/2`);
  assert.equal((await gotV2Response.json()).body, v2Body);

  const runResponse = await api(`/projects/${projectId}/qa/plans/${created.id}/run`, {
    method: 'POST',
    body: JSON.stringify({ revision_num: 1 }),
  });
  const runRaw = await runResponse.text();
  assert.ok(runResponse.status === 200 || runResponse.status === 503, `run returned ${runResponse.status}: ${runRaw}`);
  const runBody = JSON.parse(runRaw);
  const runId = runBody.run_id ?? runBody.id;
  assert.ok(runId, `explicit revision run did not create a run: ${runRaw}`);
  createdRuns.push(runId);

  const runDetail = await (await api(`/projects/${projectId}/qa/runs/${runId}`)).json();
  const run = runDetail.run ?? runDetail;
  assert.equal(run.plan_id, created.id);
  assert.equal(run.plan_revision_num, 1);
});

test('an unknown test source sha is a 404, not a 500', async (t) => {
  if (!requireServer(t)) return;
  const res = await api(`/projects/${projectId}/qa/test-sources/${'0'.repeat(64)}`);
  assert.equal(res.status, 404);
});
