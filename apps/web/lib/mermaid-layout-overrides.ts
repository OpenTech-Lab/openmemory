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

/** Extracts the saved position overrides from `source`. Takes the LAST matching line (hand
 * editing/duplicated saves shouldn't crash), and never throws: a missing comment, JSON.parse
 * failure, or non-object payload all fall back to `{}` — pure computed layout. */
export function parseLayoutComment(source: string): LayoutOverrides {
  if (!source) return {};
  const lines = source.split(/\r?\n/);
  let lastPayload: string | null = null;
  for (const line of lines) {
    const match = MARKER_LINE_RE.exec(line);
    if (match) lastPayload = match[1];
  }
  if (lastPayload === null) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(lastPayload);
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
