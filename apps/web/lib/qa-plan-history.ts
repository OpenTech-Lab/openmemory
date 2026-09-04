/** Pure view-model helpers for versioned QA plans.
 *
 * This file intentionally has no React, DOM, or aliased runtime imports. The
 * web unit suites execute TypeScript directly with `node --test`, so keeping
 * the history vocabulary here makes it testable without a Next build.
 */

export interface QaPlan {
  id: string;
  project_id: string;
  name: string;
  kind: string;
  language: string;
  description: string | null;
  body: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface QaPlanRevisionSummary {
  id: string;
  plan_id: string;
  project_id: string;
  revision_num: number;
  name: string;
  kind: string;
  language: string;
  description: string | null;
  body_sha: string;
  label: string | null;
  created_by: string;
  created_at: string;
}

export interface QaPlanRevisionDetail extends QaPlanRevisionSummary {
  body: string;
}

export const LIVE_VERSION_KEY = 'live';

export type QaPlanDiffLineKind = 'added' | 'removed' | 'unchanged';

export interface QaPlanDiffLine {
  kind: QaPlanDiffLineKind;
  text: string;
  /** One-based line number on the side represented by this row, when present. */
  lineNumber: number | null;
}

/** Dropdown text for a frozen version: `v3 — before cache rollout`, or `v3`. */
export function formatQaPlanRevisionLabel(
  revision: Pick<QaPlanRevisionSummary, 'revision_num' | 'label'>,
): string {
  const label = revision.label?.trim();
  return label ? `v${revision.revision_num} — ${label}` : `v${revision.revision_num}`;
}

/** The LIVE pseudo-key is the editable parent row, not a synthetic revision. */
export function formatQaPlanVersionLabel(
  key: string,
  revisions: Array<Pick<QaPlanRevisionSummary, 'revision_num' | 'label'>>,
): string {
  if (key === LIVE_VERSION_KEY) return 'Live (current)';
  const revision = revisions.find((candidate) => String(candidate.revision_num) === key);
  return revision ? formatQaPlanRevisionLabel(revision) : `v${key}`;
}

function splitLines(body: string): string[] {
  return body.length === 0 ? [] : body.replace(/\r\n/g, '\n').split('\n');
}

/**
 * Produce a small, deterministic line diff using the longest common
 * subsequence. Keeping unchanged lines in the result gives the history sheet
 * enough context to be useful without adding a diff dependency.
 */
export function diffQaPlanBodies(baseBody: string, headBody: string): QaPlanDiffLine[] {
  const base = splitLines(baseBody);
  const head = splitLines(headBody);
  const table = Array.from({ length: base.length + 1 }, () => Array<number>(head.length + 1).fill(0));

  for (let baseIndex = base.length - 1; baseIndex >= 0; baseIndex -= 1) {
    for (let headIndex = head.length - 1; headIndex >= 0; headIndex -= 1) {
      table[baseIndex][headIndex] = base[baseIndex] === head[headIndex]
        ? table[baseIndex + 1][headIndex + 1] + 1
        : Math.max(table[baseIndex + 1][headIndex], table[baseIndex][headIndex + 1]);
    }
  }

  const lines: QaPlanDiffLine[] = [];
  let baseIndex = 0;
  let headIndex = 0;
  while (baseIndex < base.length || headIndex < head.length) {
    if (baseIndex < base.length && headIndex < head.length && base[baseIndex] === head[headIndex]) {
      lines.push({ kind: 'unchanged', text: base[baseIndex], lineNumber: headIndex + 1 });
      baseIndex += 1;
      headIndex += 1;
    } else if (baseIndex < base.length && (headIndex === head.length || table[baseIndex + 1][headIndex] >= table[baseIndex][headIndex + 1])) {
      lines.push({ kind: 'removed', text: base[baseIndex], lineNumber: null });
      baseIndex += 1;
    } else {
      lines.push({ kind: 'added', text: head[headIndex], lineNumber: headIndex + 1 });
      headIndex += 1;
    }
  }
  return lines;
}

export function summarizeQaPlanDiff(lines: QaPlanDiffLine[]): string {
  const added = lines.filter((line) => line.kind === 'added').length;
  const removed = lines.filter((line) => line.kind === 'removed').length;
  if (added === 0 && removed === 0) return 'No changes';
  const parts: string[] = [];
  if (added) parts.push(`${added} added`);
  if (removed) parts.push(`${removed} removed`);
  return parts.join(', ');
}
