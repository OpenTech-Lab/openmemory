/**
 * Security regression tests for the QA surface.
 *
 * These are not hypothetical. Each one pins a defence that was written
 * deliberately and would fail silently if it regressed:
 *
 *   - the plan body reaches an argv spawn, never a shell
 *   - a written test file cannot escape the project root
 *   - a run belonging to project A is not readable through project B's URL
 *   - user-controlled query values are bound, not interpolated
 *
 * The shell-injection tests are the important ones: they execute a payload that
 * WOULD create an observable side effect if the body were ever passed through a
 * shell, then assert the side effect did not happen. A test that merely checks
 * for a 200 would pass just as happily on a vulnerable server.
 *
 * Requires the server on OPENMEMORY_URL (default http://127.0.0.1:18080).
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
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

let serverUp = false;
let projectId = '';
let otherProjectId = '';
const createdPlans: string[] = [];
const createdRuns: string[] = [];

/** Canary paths a shell payload would create. Nothing should ever write these. */
const CANARIES = [
  join(tmpdir(), 'openmemory-qa-shell-canary-1'),
  join(tmpdir(), 'openmemory-qa-shell-canary-2'),
];

before(async () => {
  try {
    serverUp = (await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3000) })).ok;
  } catch {
    serverUp = false;
  }
  if (!serverUp) {
    console.error(`qa-security: server unreachable at ${BASE} — skipping security tests`);
    return;
  }
  const projects = (await (await api('/projects')).json())?.projects ?? [];
  projectId = projects[0]?.id ?? '';
  otherProjectId = projects.find((p: { id: string }) => p.id !== projectId)?.id ?? '';
  for (const canary of CANARIES) rmSync(canary, { force: true });
});

after(async () => {
  for (const canary of CANARIES) rmSync(canary, { force: true });
  if (!serverUp) return;
  for (const id of createdPlans) {
    await api(`/projects/${projectId}/qa/plans/${id}`, { method: 'DELETE' }).catch(() => {});
  }
  for (const id of createdRuns) {
    await api(`/projects/${projectId}/qa/runs/${id}`, { method: 'DELETE' }).catch(() => {});
  }
});

function requireServer(t: { skip: (reason?: string) => void }): boolean {
  if (!serverUp || !projectId) {
    t.skip('server unreachable');
    return false;
  }
  return true;
}

async function createPlan(fields: Record<string, unknown>): Promise<string | null> {
  const res = await api(`/projects/${projectId}/qa/plans`, { method: 'POST', body: JSON.stringify(fields) });
  if (!res.ok) return null;
  const plan = await res.json();
  if (plan?.id) createdPlans.push(plan.id);
  return plan?.id ?? null;
}

test('a plan body containing shell metacharacters does not reach a shell', async (t) => {
  if (!requireServer(t)) return;

  // If any layer built a shell string from this body, running it would create the
  // canary file. The test itself is a valid, passing node:test file, so a green
  // run is expected — the assertion that matters is the canary's absence.
  const body = [
    "import test from 'node:test';",
    `// $(touch ${CANARIES[0]}) \`touch ${CANARIES[0]}\` ; touch ${CANARIES[0]}`,
    "test('inert', () => {});",
    '',
  ].join('\n');

  const planId = await createPlan({
    name: `security shell probe ${Date.now()}`,
    kind: 'other',
    language: 'typescript',
    body,
  });
  assert.ok(planId, 'plan creation failed');

  const res = await api(`/projects/${projectId}/qa/plans/${planId}/run`, { method: 'POST' });
  const result = await res.json().catch(() => ({}));
  if (result?.run_id) createdRuns.push(result.run_id);

  assert.equal(
    existsSync(CANARIES[0]),
    false,
    'the plan body was interpreted by a shell — command substitution executed',
  );
});

test('a plan NAME containing shell metacharacters does not reach a shell', async (t) => {
  if (!requireServer(t)) return;

  // The name becomes part of the written filename, which is the other place a
  // naive implementation would concatenate into a command string.
  const planId = await createPlan({
    name: `sec $(touch ${CANARIES[1]}); echo pwned ${Date.now()}`,
    kind: 'other',
    language: 'typescript',
    body: "import test from 'node:test';\ntest('inert', () => {});\n",
  });
  assert.ok(planId, 'plan creation failed');

  const res = await api(`/projects/${projectId}/qa/plans/${planId}/run`, { method: 'POST' });
  const result = await res.json().catch(() => ({}));
  if (result?.run_id) createdRuns.push(result.run_id);

  assert.equal(existsSync(CANARIES[1]), false, 'the plan name was interpreted by a shell');
});

test('a plan whose provenance points outside the project cannot write there', async (t) => {
  if (!requireServer(t)) return;

  // The run path is derived from the `file:` line in the description. A traversal
  // there must be refused rather than followed out of the project root.
  for (const file of ['../../../../../../tmp/escape.test.ts', '/etc/openmemory-escape.test.ts']) {
    const planId = await createPlan({
      name: `security escape probe ${Date.now()}`,
      kind: 'other',
      language: 'typescript',
      description: `Duplicated from a recorded test run.\n\nfile:       ${file}\n`,
      body: "import test from 'node:test';\ntest('inert', () => {});\n",
    });
    assert.ok(planId, 'plan creation failed');

    const res = await api(`/projects/${projectId}/qa/plans/${planId}/run`, { method: 'POST' });
    const result = await res.json().catch(() => ({}));
    if (result?.run_id) createdRuns.push(result.run_id);

    assert.equal(existsSync('/tmp/escape.test.ts'), false, `wrote outside the project via ${file}`);
    assert.equal(existsSync('/etc/openmemory-escape.test.ts'), false, `wrote outside the project via ${file}`);
  }
});

test('a run is not readable through another project\'s URL', async (t) => {
  if (!requireServer(t)) return;
  if (!otherProjectId) {
    t.skip('needs a second project');
    return;
  }

  const created = await (
    await api(`/projects/${projectId}/qa/ingest`, {
      method: 'POST',
      body: JSON.stringify({
        title: `security isolation probe ${Date.now()}`,
        kind: 'api',
        runner: 'node:test',
        cases: [{ name: 'isolated', status: 'passed' }],
      }),
    })
  ).json();
  const runId = created.run_id ?? created.id;
  assert.ok(runId);
  createdRuns.push(runId);

  // Same run id, wrong project in the path. Ownership is enforced server-side or
  // this is a cross-tenant read.
  const leaked = await api(`/projects/${otherProjectId}/qa/runs/${runId}`);
  assert.equal(leaked.status, 404, 'a run leaked across project scopes');

  const leakedCases = await api(`/projects/${otherProjectId}/qa/runs/${runId}/cases`);
  assert.equal(leakedCases.status, 404, 'run cases leaked across project scopes');
});

test('SQL metacharacters in query values are bound, not interpolated', async (t) => {
  if (!requireServer(t)) return;

  const payloads = [
    "' OR '1'='1",
    "'; DROP TABLE project_qa_runs; --",
    "\\'; SELECT pg_sleep(5); --",
  ];

  for (const payload of payloads) {
    const status = await api(`/projects/${projectId}/qa/runs?status=${encodeURIComponent(payload)}`);
    assert.ok(status.status < 500, `status filter 500'd on ${payload}`);
    const runs = (await status.json())?.runs;
    // A tautology payload must not act as "match everything".
    if (Array.isArray(runs)) assert.equal(runs.length, 0, `status filter matched rows for ${payload}`);

    const history = await api(`/projects/${projectId}/qa/cases/history?case_key=${encodeURIComponent(payload)}`);
    assert.ok(history.status < 500, `case history 500'd on ${payload}`);
  }

  // The table is still there.
  const after = await api(`/projects/${projectId}/qa/runs?limit=1`);
  assert.equal(after.status, 200, 'the runs table did not survive the injection probes');
});

test('a traversal in a path parameter cannot escape its route', async (t) => {
  if (!requireServer(t)) return;
  for (const sha of ['../../../../etc/passwd', '..%2F..%2F..%2Fetc%2Fpasswd']) {
    const res = await api(`/projects/${projectId}/qa/test-sources/${sha}`);
    assert.ok(res.status === 400 || res.status === 404, `unexpected ${res.status} for ${sha}`);
    const text = await res.text();
    assert.ok(!text.includes('root:x:'), 'a system file was served through the source route');
  }
});

test('oversized input is refused or truncated, never crashes the server', async (t) => {
  if (!requireServer(t)) return;

  const huge = 'x'.repeat(2 * 1024 * 1024);
  const res = await api(`/projects/${projectId}/qa/ingest`, {
    method: 'POST',
    body: JSON.stringify({
      title: 'security size probe',
      kind: 'api',
      cases: [{ name: 'big', status: 'failed', failure_detail: huge }],
    }),
  });
  assert.ok(res.status < 500 || res.status === 413, `oversized payload produced ${res.status}`);
  const body = await res.json().catch(() => ({}));
  if (body?.run_id) createdRuns.push(body.run_id);

  // Whatever it decided, the server is still answering.
  const health = await fetch(`${BASE}/health`);
  assert.equal(health.status, 200, 'the server did not survive an oversized payload');
});
