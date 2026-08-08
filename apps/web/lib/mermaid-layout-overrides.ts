// Persists drag positions for a derived-mode (architecture-beta) mermaid design as a trailing
// `%%` comment appended to the mermaid source, so `diagram_type` stays 'mermaid' and the source
// stays valid, portable mermaid text. See docs/superpowers/plans/2026-08-08-mermaid-architecture-
// draggable-canvas.md Decision 2 for the full rationale. Pure module — no runtime imports, safe
// for `node --test`.
//
// The space after `%%` is mandatory: mermaid's lexer has two competing terminals —
// `SINGLE_LINE_COMMENT: /[\t ]*%%[^\n\r]*/` (discarded harmlessly) and
// `DIRECTIVE: /[\t ]*%%\{[\S\s]*?\}%%.../` (mermaid tries to parse the payload as config). A line
// written `%%{...}` would tokenize as a directive; `%% {` cannot match DIRECTIVE.

export const LAYOUT_COMMENT_MARKER = '%% openmemory:layout:v1 ';

// Matches a marker line regardless of leading indentation. Deliberately permissive about what
// follows — corrupt/non-JSON payloads are handled by parseLayoutComment, not filtered out here,
// so stripLayoutComment removes every candidate marker line (including corrupted ones).
const MARKER_LINE_RE = /^[ \t]*%% openmemory:layout:v1 (.*)$/;

export interface LayoutOverride {
  x: number;
  y: number;
  /** Parent id at drag time; absent means top-level. Required for correct reconciliation — a
   * relative coordinate against a different parent is meaningless, not merely stale. */
  p?: string;
}

export type LayoutOverrides = Record<string, LayoutOverride>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The payload text of the LAST marker line in `source` (hand editing/duplicated saves shouldn't
 * crash — later lines win), or `null` if there is no marker line at all. Shared by
 * `parseLayoutComment` and `hasCorruptLayoutComment` so both agree on what counts as "present". */
function lastMarkerPayload(source: string): string | null {
  if (!source) return null;
  let lastPayload: string | null = null;
  for (const line of source.split(/\r?\n/)) {
    const match = MARKER_LINE_RE.exec(line);
    if (match) lastPayload = match[1];
  }
  return lastPayload;
}

/** Extracts the saved position overrides from `source`. Never throws: a missing comment,
 * JSON.parse failure, or non-object payload all fall back to `{}` — pure computed layout. */
export function parseLayoutComment(source: string): LayoutOverrides {
  const payload = lastMarkerPayload(source);
  if (payload === null) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return {};
  }
  if (!isRecord(parsed) || !isRecord(parsed.pos)) return {};

  const overrides: LayoutOverrides = {};
  for (const [id, raw] of Object.entries(parsed.pos)) {
    if (!isRecord(raw)) continue;
    const { x, y, p } = raw;
    if (typeof x !== 'number' || typeof y !== 'number') continue;
    overrides[id] = typeof p === 'string' ? { x, y, p } : { x, y };
  }
  return overrides;
}

/** True when `source` has a marker line that `parseLayoutComment` couldn't read (bad JSON, or
 * valid JSON that isn't `{"pos": {...}}`) — the editor surfaces this as a dismissible warning
 * ("saved node positions couldn't be read and were reset") rather than silently discarding it. A
 * source with no marker line at all (the normal, untouched case) is not corrupt. */
export function hasCorruptLayoutComment(source: string): boolean {
  const payload = lastMarkerPayload(source);
  if (payload === null) return false;
  try {
    const parsed: unknown = JSON.parse(payload);
    return !(isRecord(parsed) && isRecord(parsed.pos));
  } catch {
    return true;
  }
}

/** Removes every layout-comment line from `source`, leaving the rest of the text untouched (this
 * is what feeds the editor's textarea — a drag can never rewrite text under the user's caret). */
export function stripLayoutComment(source: string): string {
  if (!source) return source;
  const kept = source.split(/\r?\n/).filter((line) => !MARKER_LINE_RE.test(line));
  // withLayoutComment always appends the marker as its own trailing line; removing it should also
  // remove the trailing blank line it left behind so stripLayoutComment is a stable fixed point
  // (stripLayoutComment(withLayoutComment(s, o)) === s for a clean s).
  return kept.join('\n').replace(/\n+$/, '');
}

/** Re-attaches `overrides` to `source` as a single trailing comment line, replacing any existing
 * one. Emits nothing (and strips any prior line) when `overrides` is empty, so an untouched
 * diagram never grows a comment. Idempotent. */
export function withLayoutComment(source: string, overrides: LayoutOverrides): string {
  const stripped = stripLayoutComment(source);
  if (Object.keys(overrides).length === 0) return stripped;
  const line = `${LAYOUT_COMMENT_MARKER}${JSON.stringify({ pos: overrides })}`;
  return stripped.length > 0 ? `${stripped}\n${line}` : line;
}

export interface ReconcileNode {
  id: string;
  parentId?: string;
  width?: number;
  height?: number;
}

/** Reapplies `overrides` against the freshly parsed/laid-out `nodes`, dropping anything that no
 * longer makes sense and clamping the rest into their (possibly-shrunk) parent box:
 * 1. Drop overrides whose id no longer exists.
 * 2. Drop overrides whose recorded parent no longer matches the node's current parent.
 * 3. Clamp survivors into the parent's derived size (removing siblings shrinks the box).
 * Pure — takes only plain node shapes, no DesignNode/layout imports. */
export function reconcileOverrides(overrides: LayoutOverrides, nodes: ReconcileNode[]): LayoutOverrides {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const result: LayoutOverrides = {};
  for (const [id, override] of Object.entries(overrides)) {
    const node = byId.get(id);
    if (!node) continue; // rule 1: vanished
    if ((override.p ?? undefined) !== (node.parentId ?? undefined)) continue; // rule 2: reparented

    let { x, y } = override;
    if (node.parentId) {
      const parent = byId.get(node.parentId);
      if (parent && typeof parent.width === 'number' && typeof parent.height === 'number') {
        const width = node.width ?? 0;
        const height = node.height ?? 0;
        const maxX = Math.max(0, parent.width - width);
        const maxY = Math.max(0, parent.height - height);
        x = Math.min(Math.max(x, 0), maxX);
        y = Math.min(Math.max(y, 0), maxY);
      }
    }
    result[id] = override.p !== undefined ? { x, y, p: override.p } : { x, y };
  }
  return result;
}

export interface OverridableNode {
  id: string;
  position: { x: number; y: number };
  parentId?: string;
}

/** Merges saved overrides onto laid-out node positions: `position = override[id] ?? laidOut[id]`
 * — no coordinate math, since overrides are stored parent-relative, the same space as
 * `node.position`. */
export function applyOverrides<T extends OverridableNode>(nodes: T[], overrides: LayoutOverrides): T[] {
  return nodes.map((node) => {
    const override = overrides[node.id];
    if (!override) return node;
    return { ...node, position: { x: override.x, y: override.y } };
  });
}

/** Computes the overrides implied by `current` (the live, possibly-dragged canvas state) versus
 * `baseline` (the freshly computed layout with no overrides applied) — the save-time counterpart
 * to `applyOverrides`: "emit only ids that differ from the computed layout, so an untouched
 * diagram never grows a comment." A node present in `current` but missing from `baseline` is
 * skipped (nothing to diff against). */
export function diffOverrides<T extends OverridableNode>(current: T[], baseline: T[]): LayoutOverrides {
  const baselineById = new Map(baseline.map((node) => [node.id, node]));
  const result: LayoutOverrides = {};
  for (const node of current) {
    const base = baselineById.get(node.id);
    if (!base) continue;
    const dx = Math.abs(node.position.x - base.position.x);
    const dy = Math.abs(node.position.y - base.position.y);
    if (dx < 0.5 && dy < 0.5) continue;
    result[node.id] = node.parentId
      ? { x: node.position.x, y: node.position.y, p: node.parentId }
      : { x: node.position.x, y: node.position.y };
  }
  return result;
}
