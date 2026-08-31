// View-model layer for the design revision-history sheet: everything that turns a raw `DiffEntry`
// from design-diff.ts into display text, a summary line, or a badge colour lives here rather than
// in the component, so it stays reachable from `node --test lib/design-history.test.ts` (this
// repo's only working test mechanism for `lib/` — package.json's "test" script is a stub).
//
// Same import discipline as design-diff.ts: `@/`-aliased VALUE imports don't resolve under node's
// type-stripping, so anything imported for runtime would need a relative `.ts` specifier. This
// module needs types only, which are erased either way.

import type { DesignBudgetForecast } from './budget-types.ts';
import type { DiffEntity, DiffEntry, DiffEntryKind } from './design-diff.ts';

/** One row of `GET /revisions` — the listing carries no `source` (only the single-revision
 * endpoint does), which is why the sheet fetches a side's source lazily. */
export interface DesignRevisionSummary {
  id: string;
  revision_num: number;
  title: string;
  label: string | null;
  diagram_type: string;
  source_sha: string;
  created_by: string;
  created_at: string;
  budget_count: number;
}

/** `GET /revisions/:revisionNum` — a flat object, not wrapped. The history sheet reads `source`
 * and `budgets` from it; the budgets ride along here rather than needing a second request, and
 * note the key is `budgets`, unlike the live endpoint's `{ forecasts }` wrapper. */
export interface DesignRevisionDetail extends DesignRevisionSummary {
  design_id: string;
  kind: string;
  notes: string | null;
  source: string;
  budgets: DesignBudgetForecast[];
}

export interface DiffEntryView {
  kind: DiffEntryKind;
  entity: DiffEntity;
  label: string;
  before: string;
  after: string;
  /** The engine sets `confidence: 'low'` only when it had to pick between equally-good candidates
   * and fell back to document order — surface that rather than presenting a guess as a fact. */
  lowConfidence: boolean;
}

export const DIFF_KIND_STYLES: Record<DiffEntryKind, string> = {
  added: 'border-green-400 text-green-600 dark:text-green-400',
  removed: 'border-red-400 text-red-600 dark:text-red-400',
  renamed: 'border-amber-400 text-amber-600 dark:text-amber-400',
  moved: 'border-blue-400 text-blue-600 dark:text-blue-400',
  restyled: 'border-violet-400 text-violet-600 dark:text-violet-400',
  rerouted: 'border-cyan-400 text-cyan-600 dark:text-cyan-400',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Renders a `DiffEntry`'s `before`/`after`, whose shape varies by kind (string, `{x,y}`,
 * `{icon,kind}` or `{source,target}`). Narrows on the fields present instead of switching on the
 * entry kind, so a caller can format a value it holds on its own. Anything unrecognised — and the
 * absent side of an 'added'/'removed' entry — renders as empty.
 */
export function formatDiffValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!isRecord(value)) return '';
  if (typeof value.x === 'number' && typeof value.y === 'number') return `${value.x}, ${value.y}`;
  if (typeof value.source === 'string' && typeof value.target === 'string') return `${value.source} → ${value.target}`;
  // A style snapshot's two fields are both optional; the icon is the more specific of the pair.
  if (typeof value.icon === 'string') return value.icon;
  if (typeof value.kind === 'string') return value.kind;
  return '';
}

/** Flattens one entry into the strings a row renders. Edges routinely carry no label (draw.io
 * connectors are unlabelled by default), so an empty label gets a placeholder rather than
 * collapsing the row to a bare badge. */
export function describeDiffEntry(entry: DiffEntry): DiffEntryView {
  return {
    kind: entry.kind,
    entity: entry.entity,
    label: entry.label.trim() || '(unlabelled)',
    before: formatDiffValue(entry.before),
    after: formatDiffValue(entry.after),
    lowConfidence: entry.confidence === 'low',
  };
}

/**
 * One-line header summary. Additions and removals are counted on their own because they change
 * what the diagram contains; the four in-place kinds (renamed/moved/restyled/rerouted) collapse
 * into "changed" — a single swapped service produces three of them and listing each count would
 * read as three separate edits.
 */
export function summarizeDiff(entries: DiffEntry[]): string {
  if (entries.length === 0) return 'No changes';
  const added = entries.filter((entry) => entry.kind === 'added').length;
  const removed = entries.filter((entry) => entry.kind === 'removed').length;
  const changed = entries.length - added - removed;
  const parts: string[] = [];
  if (added) parts.push(`${added} added`);
  if (removed) parts.push(`${removed} removed`);
  if (changed) parts.push(`${changed} changed`);
  return parts.join(', ');
}

/** Dropdown text for a revision: `r3 — pre-Aurora baseline`, or just `r3` when unlabelled
 * (automatic pre-save snapshots have no label; only explicit ones do). */
export function formatRevisionLabel(revision: Pick<DesignRevisionSummary, 'revision_num' | 'label'>): string {
  const label = revision.label?.trim();
  return label ? `r${revision.revision_num} — ${label}` : `r${revision.revision_num}`;
}
