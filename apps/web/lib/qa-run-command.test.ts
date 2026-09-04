import assert from 'node:assert/strict';
import test from 'node:test';
import {
  heredocDelimiter,
  originDirFromDescription,
  planFileExtension,
  planSlug,
  runRecipeForPlan,
  type RunnablePlan,
} from './qa-run-command.ts';

function plan(overrides: Partial<RunnablePlan> = {}): RunnablePlan {
  return { name: 'Checkout smoke', kind: 'jest', language: 'typescript', body: 'test("x", () => {});\n', ...overrides };
}

test('planSlug strips characters that would break a shell path', () => {
  assert.equal(planSlug('Checkout smoke'), 'Checkout_smoke');
  assert.equal(planSlug('a/../../etc/passwd'), 'a_.._.._etc_passwd');
  assert.equal(planSlug('  spaced  '), 'spaced');
  assert.equal(planSlug('日本語'), 'plan');
  assert.equal(planSlug('   '), 'plan');
  assert.equal(planSlug('$(rm -rf /)'), 'rm_-rf');
});

test('planSlug never yields an empty name, which would make a directory-only path', () => {
  for (const name of ['', '!!!', '///', '\t\n']) {
    assert.ok(planSlug(name).length > 0, `empty slug for ${JSON.stringify(name)}`);
  }
});

test('planFileExtension follows kind first, then language', () => {
  assert.equal(planFileExtension({ kind: 'jest', language: 'typescript' }), 'test.ts');
  assert.equal(planFileExtension({ kind: 'jest', language: 'javascript' }), 'test.js');
  assert.equal(planFileExtension({ kind: 'playwright', language: 'typescript' }), 'spec.ts');
  assert.equal(planFileExtension({ kind: 'playwright', language: 'python' }), 'spec.py');
  assert.equal(planFileExtension({ kind: 'maestro', language: 'yaml' }), 'yaml');
  assert.equal(planFileExtension({ kind: 'other', language: 'python' }), 'test.py');
  assert.equal(planFileExtension({ kind: 'other', language: 'other' }), 'txt');
});

test('heredocDelimiter avoids a body that already contains the default', () => {
  assert.equal(heredocDelimiter('nothing special'), 'QA_PLAN_EOF');
  assert.equal(heredocDelimiter('a\nQA_PLAN_EOF\nb'), 'QA_PLAN_EOF_1');
  assert.equal(heredocDelimiter('QA_PLAN_EOF\nQA_PLAN_EOF_1'), 'QA_PLAN_EOF_2');
  // Indented occurrences still collide: the shell strips nothing for <<'X'.
  assert.equal(heredocDelimiter('   QA_PLAN_EOF   '), 'QA_PLAN_EOF_1');
});

test('the script quotes the delimiter so the body is never expanded by the shell', () => {
  const recipe = runRecipeForPlan(plan({ body: 'echo $(whoami) `id` ${HOME}\n' }));
  assert.ok(recipe.script);
  assert.match(recipe.script, /<<'QA_PLAN_EOF'\n/);
  // The dangerous text is present verbatim, inside the quoted heredoc.
  assert.ok(recipe.script.includes('echo $(whoami) `id` ${HOME}'));
});

test('a body containing the delimiter still produces a well-formed heredoc', () => {
  const recipe = runRecipeForPlan(plan({ body: 'line\nQA_PLAN_EOF\nmore\n' }));
  assert.ok(recipe.script);
  assert.match(recipe.script, /<<'QA_PLAN_EOF_1'\n/);
  assert.ok(recipe.script.includes('\nQA_PLAN_EOF_1\n'));
});

test('the script never exits the shell it is pasted into', () => {
  const recipe = runRecipeForPlan(plan());
  assert.ok(recipe.script);
  assert.ok(!/^exit /m.test(recipe.script), 'a bare `exit` would close the user\'s terminal');
  assert.match(recipe.script, /echo "test exit: \$s"/);
});

test('the ingest call cannot mask a failing suite', () => {
  const recipe = runRecipeForPlan(plan());
  assert.ok(recipe.script);
  // The status is captured from the runner, before ingest runs at all.
  const runnerLine = recipe.script.split('\n').find((l) => l.includes('; s=$?'));
  assert.ok(runnerLine && runnerLine.includes('node --test'));
  // `|| true` appears only on the ingest line.
  const tolerant = recipe.script.split('\n').filter((l) => l.includes('|| true'));
  assert.equal(tolerant.length, 1);
  assert.ok(tolerant[0].includes('qa-ingest.mjs'));
});

test('each supported kind and language picks the runner that can actually run it', () => {
  const node = runRecipeForPlan(plan({ kind: 'jest', language: 'typescript' }));
  assert.equal(node.runner, 'node:test');
  assert.equal(node.ingestKind, 'unit');
  assert.match(node.script ?? '', /node --test/);

  const pw = runRecipeForPlan(plan({ kind: 'playwright', language: 'typescript' }));
  assert.equal(pw.runner, 'playwright');
  assert.equal(pw.ingestKind, 'e2e');
  assert.match(pw.script ?? '', /npx playwright test/);

  const maestro = runRecipeForPlan(plan({ kind: 'maestro', language: 'yaml' }));
  assert.equal(maestro.runner, 'maestro');
  assert.equal(maestro.ingestKind, 'e2e');

  const py = runRecipeForPlan(plan({ kind: 'other', language: 'python' }));
  assert.equal(py.runner, 'pytest');
  assert.equal(py.ingestKind, 'unit');

  // playwright-python runs through pytest but is still an e2e run.
  const pwPy = runRecipeForPlan(plan({ kind: 'playwright', language: 'python' }));
  assert.equal(pwPy.runner, 'pytest');
  assert.equal(pwPy.ingestKind, 'e2e');
});

test('an unrunnable plan says so instead of emitting a command that cannot work', () => {
  const recipe = runRecipeForPlan(plan({ kind: 'other', language: 'other' }));
  assert.equal(recipe.script, null);
  assert.ok(recipe.unsupportedReason);
  assert.match(recipe.unsupportedReason, /language/);
});

test('the ingested kind and runner match what the command actually invokes', () => {
  for (const p of [
    plan({ kind: 'jest', language: 'typescript' }),
    plan({ kind: 'playwright', language: 'typescript' }),
    plan({ kind: 'maestro', language: 'yaml' }),
    plan({ kind: 'other', language: 'python' }),
  ]) {
    const recipe = runRecipeForPlan(p);
    assert.ok(recipe.script);
    assert.ok(
      recipe.script.includes(`--kind ${recipe.ingestKind} --runner ${recipe.runner}`),
      `ingest flags drifted from the runner for ${p.kind}/${p.language}`,
    );
  }
});

test('the body is written to the path the run command then executes', () => {
  const recipe = runRecipeForPlan(plan({ name: 'Budget compare' }));
  assert.equal(recipe.path, '.qa-plans/Budget_compare.test.ts');
  assert.ok(recipe.script);
  assert.ok(recipe.script.includes(`cat > ${recipe.path} <<'`));
  assert.ok(recipe.script.includes(`${recipe.path}; s=$?`));
});

test('originDirFromDescription finds the directory a duplicated test came from', () => {
  const description = [
    'Duplicated from a recorded test run.',
    '',
    'case_key:   apps/web/lib/qa-cases.test.ts::formats money',
    'file:       apps/web/lib/qa-cases.test.ts',
    'status:     failed',
  ].join('\n');
  assert.equal(originDirFromDescription(description), 'apps/web/lib');
});

test('originDirFromDescription refuses anything that is not a plain relative path', () => {
  const wrap = (file: string) => `file:       ${file}`;
  assert.equal(originDirFromDescription(wrap('/etc/passwd')), null);
  assert.equal(originDirFromDescription(wrap('../../etc/passwd')), null);
  assert.equal(originDirFromDescription(wrap('a/$(whoami)/b.ts')), null);
  assert.equal(originDirFromDescription(wrap('a b/c.ts')), null);
  assert.equal(originDirFromDescription(wrap('—')), null);
  assert.equal(originDirFromDescription(wrap('toplevel.ts')), null);
  assert.equal(originDirFromDescription(null), null);
  assert.equal(originDirFromDescription('no file line here'), null);
});

test('a duplicated plan is written beside its origin so relative imports resolve', () => {
  const recipe = runRecipeForPlan({
    name: 'formats money (copy)',
    kind: 'other',
    language: 'typescript',
    body: "import { x } from './qa-cases.ts';\n",
    description: 'file:       apps/web/lib/qa-cases.test.ts',
  });
  assert.equal(recipe.path, 'apps/web/lib/formats_money_copy.test.ts');
  assert.ok(recipe.script);
  assert.ok(recipe.script.includes('mkdir -p apps/web/lib'));
});

test('a hand-written plan with no origin still lands in the scratch directory', () => {
  const recipe = runRecipeForPlan({
    name: 'Smoke',
    kind: 'jest',
    language: 'typescript',
    body: 'test("x", () => {});\n',
    description: 'Written by hand.',
  });
  assert.equal(recipe.path, '.qa-plans/Smoke.test.ts');
});
