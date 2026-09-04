export type PlanKind = 'jest' | 'playwright' | 'maestro' | 'other';

export type PlanLanguage = 'typescript' | 'javascript' | 'yaml' | 'python' | 'other';

export interface DuplicateProvenance {
  case_key: string;
  file: string | null;
  status: string;
  run_id: string;
  started_at: string | null;
  commit_sha: string | null;
  branch: string | null;
  source_sha: string;
}

export function planKindForSource(runner: string | null, file: string | null): PlanKind {
  const runnerText = runner?.toLowerCase() ?? '';
  const fileText = file?.toLowerCase().trim() ?? '';
  const sourceText = `${runnerText} ${fileText}`;

  if (sourceText.includes('playwright')) return 'playwright';
  if (sourceText.includes('maestro') || fileText.endsWith('.yaml') || fileText.endsWith('.yml')) return 'maestro';
  if (sourceText.includes('jest') || sourceText.includes('vitest')) return 'jest';
  return 'other';
}

export function planLanguageForSource(language: string | null): PlanLanguage {
  switch (language?.trim().toLowerCase()) {
    case 'typescript':
      return 'typescript';
    case 'javascript':
      return 'javascript';
    case 'yaml':
      return 'yaml';
    case 'python':
      return 'python';
    default:
      return 'other';
  }
}

function truncateGraphemeSafe(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;

  const segments = typeof Intl.Segmenter === 'function'
    ? Array.from(new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(value), ({ segment }) => segment)
    : Array.from(value);
  let result = '';

  for (const segment of segments) {
    if (result.length + segment.length > maxLength) break;
    result += segment;
  }

  return result || segments[0] || value.slice(0, maxLength);
}

export function duplicatePlanName(caseName: string, suite: string | null): string {
  const name = caseName.trim();
  if (!name) return 'Duplicated test (copy)';

  const suiteName = suite?.trim();
  const fullName = suiteName ? `${suiteName} › ${name} (copy)` : `${name} (copy)`;
  return truncateGraphemeSafe(fullName, 200);
}

function formatStartedAt(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function duplicateDescription(input: DuplicateProvenance): string {
  const startedAt = formatStartedAt(input.started_at);
  const run = startedAt ? `${input.run_id} (${startedAt})` : input.run_id;
  const commit = input.commit_sha
    ? `${input.commit_sha}${input.branch ? ` on ${input.branch}` : ''}`
    : input.branch
      ? `— on ${input.branch}`
      : '—';

  return [
    'Duplicated from a recorded test run.',
    '',
    `case_key:   ${input.case_key}`,
    `file:       ${input.file ?? '—'}`,
    `status:     ${input.status}`,
    `run:        ${run}`,
    `commit:     ${commit}`,
    `source_sha: ${input.source_sha}`,
  ].join('\n');
}
