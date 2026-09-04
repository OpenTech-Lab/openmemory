export type PlanKind = 'jest' | 'playwright' | 'maestro' | 'other';
export type PlanLanguage = 'typescript' | 'javascript' | 'yaml' | 'python' | 'other';

export interface RunnablePlan {
  name: string;
  /** The plan's description. When it carries the `file:` provenance line written
   *  by qa-duplicate.ts, the snippet writes next to that origin file so the
   *  test's relative imports still resolve. */
  description?: string | null;
  /** Accepts any string: an unrecognised kind degrades to the language-based
   *  runner rather than throwing, matching how qa-meta.ts handles drift. */
  kind: string;
  language: string;
  body: string;
}

export interface PlanRunRecipe {
  /** Repo-relative path the snippet writes the plan body to. */
  path: string;
  /** `--runner` label recorded on the ingested run, matching what actually ran. */
  runner: string;
  /** `--kind` recorded on the ingested run. */
  ingestKind: 'unit' | 'e2e';
  /** The full copy-paste block, or null when no runner fits this plan. */
  script: string | null;
  /** Why no script was produced. Null when `script` is set. */
  unsupportedReason: string | null;
}

const PLAN_DIR = '.qa-plans';
const JUNIT_PATH = '.junit.xml';
const DEFAULT_DELIMITER = 'QA_PLAN_EOF';

export function planFileExtension(plan: Pick<RunnablePlan, 'kind' | 'language'>): string {
  switch (plan.kind) {
    case 'jest':
      return plan.language === 'javascript' ? 'test.js' : 'test.ts';
    case 'playwright':
      if (plan.language === 'javascript') return 'spec.js';
      if (plan.language === 'python') return 'spec.py';
      return 'spec.ts';
    case 'maestro':
      return 'yaml';
    default:
      if (plan.language === 'javascript') return 'test.js';
      if (plan.language === 'typescript') return 'test.ts';
      if (plan.language === 'python') return 'test.py';
      if (plan.language === 'yaml') return 'yaml';
      return 'txt';
  }
}

/**
 * The directory a duplicated test came from, from the `file:` line that
 * qa-duplicate.ts writes into the description.
 *
 * This matters because a duplicated test keeps its original relative imports:
 * `./qa-cases.ts` resolves in apps/web/lib and nowhere else. Writing the copy
 * anywhere but beside its origin produces ERR_MODULE_NOT_FOUND on the very
 * first run. Returns null for a hand-written plan, which has no origin and is
 * assumed self-contained.
 */
export function originDirFromDescription(description: string | null | undefined): string | null {
  if (!description) return null;
  const match = /^file:\s+(\S.*)$/m.exec(description);
  if (!match) return null;

  const file = match[1].trim();
  // Only accept a plain repo-relative path. Anything absolute, escaping, or
  // shell-significant is discarded rather than pasted into a command.
  if (!file || file === '—' || file.startsWith('/') || file.includes('..') || /[^A-Za-z0-9._/-]/.test(file)) return null;

  const slash = file.lastIndexOf('/');
  return slash > 0 ? file.slice(0, slash) : null;
}

export function planSlug(name: string): string {
  return name.trim().replace(/[^a-z0-9._-]+/gi, '_').replace(/^_+|_+$/g, '') || 'plan';
}

/**
 * A delimiter guaranteed not to appear on its own line in the body.
 *
 * The body is user-authored text going into a shell heredoc. Quoting the
 * delimiter (`<<'X'`) already stops the shell expanding anything inside, so the
 * only way the body can break out is by containing the delimiter itself. Walk
 * suffixes until the collision is gone.
 */
export function heredocDelimiter(body: string): string {
  const lines = new Set(body.split('\n').map((line) => line.trim()));
  if (!lines.has(DEFAULT_DELIMITER)) return DEFAULT_DELIMITER;

  for (let suffix = 1; suffix < 1000; suffix += 1) {
    const candidate = `${DEFAULT_DELIMITER}_${suffix}`;
    if (!lines.has(candidate)) return candidate;
  }
  return `${DEFAULT_DELIMITER}_${Date.now()}`;
}

interface RunnerChoice {
  command: string;
  runner: string;
  ingestKind: 'unit' | 'e2e';
}

function runnerFor(plan: RunnablePlan, path: string): RunnerChoice | null {
  if (plan.kind === 'maestro' || plan.language === 'yaml') {
    return { command: `maestro test ${path} --format junit --output ${JUNIT_PATH}`, runner: 'maestro', ingestKind: 'e2e' };
  }
  if (plan.language === 'python') {
    // Covers playwright-python too — it drives Playwright through pytest.
    return { command: `pytest ${path} --junitxml=${JUNIT_PATH}`, runner: 'pytest', ingestKind: plan.kind === 'playwright' ? 'e2e' : 'unit' };
  }
  if (plan.kind === 'playwright') {
    return {
      command: `PLAYWRIGHT_JUNIT_OUTPUT_NAME=${JUNIT_PATH} npx playwright test ${path} --reporter=junit`,
      runner: 'playwright',
      ingestKind: 'e2e',
    };
  }
  if (plan.language === 'typescript' || plan.language === 'javascript') {
    return {
      command: `node --test --test-reporter=junit --test-reporter-destination=${JUNIT_PATH} ${path}`,
      runner: 'node:test',
      ingestKind: 'unit',
    };
  }
  return null;
}

export function runRecipeForPlan(plan: RunnablePlan): PlanRunRecipe {
  const dir = originDirFromDescription(plan.description) ?? PLAN_DIR;
  const path = `${dir}/${planSlug(plan.name)}.${planFileExtension(plan)}`;
  const choice = runnerFor(plan, path);

  if (!choice) {
    return {
      path,
      runner: 'unknown',
      ingestKind: 'unit',
      script: null,
      unsupportedReason:
        `No runner fits kind "${plan.kind}" with language "${plan.language}". Set the plan's language to typescript, javascript, python or yaml to get a command.`,
    };
  }

  const delimiter = heredocDelimiter(plan.body);
  // No `exit $s` — this block is pasted into an interactive shell, where exit
  // would close the terminal. The status is echoed instead, and the ingest is
  // allowed to fail without masking a red suite.
  const script = [
    `mkdir -p ${dir}`,
    `cat > ${path} <<'${delimiter}'`,
    plan.body.endsWith('\n') ? plan.body.slice(0, -1) : plan.body,
    delimiter,
    `${choice.command}; s=$?`,
    `node scripts/qa-ingest.mjs --junit ${JUNIT_PATH} --kind ${choice.ingestKind} --runner ${choice.runner} || true`,
    `echo "test exit: $s"`,
  ].join('\n');

  return { path, runner: choice.runner, ingestKind: choice.ingestKind, script, unsupportedReason: null };
}
