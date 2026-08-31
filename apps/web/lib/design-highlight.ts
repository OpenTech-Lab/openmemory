// Turns a `DiffEntry[]` (design-diff.ts) into draw.io source with the changed cells outlined, for
// the side-by-side comparison dialog. Pure string/Map work — no React, no DOM, no network — so it
// stays reachable from `node --test lib/design-highlight.test.ts` (this repo's only working test
// mechanism for `lib/`; package.json's "test" script is a stub).
//
// Same import discipline as design-history.ts: `@/`-aliased VALUE imports don't resolve under
// node's type-stripping, so anything imported for runtime would need a relative `.ts` specifier.
// This module needs types only, which are erased either way — the tag/attribute helpers below are
// deliberately re-implemented rather than lifted out of drawio.ts, which keeps its own copies
// private and is out of bounds for this feature.

import type { DiffEntry } from './design-diff.ts';

export type HighlightKind = 'added' | 'removed' | 'changed';

/** Outline colour per kind, exported so the dialog's legend and the stroke actually stamped into
 * the XML can't drift apart. Deliberately literal hex, not a CSS variable: these end up inside a
 * draw.io `style` string rendered in a cross-origin iframe, where this app's theme tokens don't
 * exist. */
// 'changed' is blue rather than the more conventional amber because AWS4's compute icons are
// orange (#ED7100) — Fargate, ECS, EC2, Lambda — and an amber outline on them is nearly invisible.
// Compute is also the most frequently edited category, so that collision would be the common case.
export const HIGHLIGHT_COLORS: Record<HighlightKind, string> = {
  added: '#12B76A',
  removed: '#F04438',
  changed: '#1570EF',
};

/**
 * Which cells to outline on one side of the comparison, keyed by mxCell id. `baseId` is absent on
 * an 'added' entry and `headId` on a 'removed' one, so each side simply skips the entries that
 * don't exist there.
 *
 * The four in-place kinds collapse into 'changed' for the same reason `summarizeDiff` collapses
 * them in the header: swapping one service emits renamed + moved + restyled against a SINGLE cell,
 * and a cell can only carry one outline. added/removed win over changed on a collision — whether
 * the cell exists at all outranks how it was edited.
 */
export function diffHighlightMap(entries: DiffEntry[], side: 'base' | 'head'): Map<string, HighlightKind> {
  const highlights = new Map<string, HighlightKind>();
  for (const entry of entries) {
    const id = side === 'base' ? entry.baseId : entry.headId;
    if (id === undefined) continue;
    const kind: HighlightKind = entry.kind === 'added' ? 'added' : entry.kind === 'removed' ? 'removed' : 'changed';
    if (kind === 'changed' && highlights.has(id)) continue;
    highlights.set(id, kind);
  }
  return highlights;
}

/** One attribute out of an already-extracted open tag's attribute text. */
function cellAttribute(attributes: string, name: string): string | undefined {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(attributes)?.[1];
}

/** Appends the outline tokens to the FIRST `<mxCell>` open tag in `text` — which for a bare cell
 * is the element itself, and for a wrapped one is the tag inside the wrapper (see
 * `highlightDrawioCells`). A cell with no `style` at all (draw.io omits the attribute for a
 * default-styled shape) gains one. */
function withOutline(text: string, kind: HighlightKind): string {
  const outline = `strokeColor=${HIGHLIGHT_COLORS[kind]};strokeWidth=4;`;
  return text.replace(/<mxCell\b([^>]*?)(\/?)>/, (_tag, attributes: string, selfClosing: string) => {
    const close = selfClosing === '/' ? '/>' : '>';
    if (/\bstyle="/.test(attributes)) {
      const styled = attributes.replace(/\bstyle="([^"]*)"/, (_attribute, style: string) =>
        `style="${style && !style.endsWith(';') ? `${style};` : style}${outline}"`);
      return `<mxCell${styled}${close}`;
    }
    // Inserted first rather than appended, so the document's own attribute spacing (including the
    // space draw.io leaves before a self-closing `/>`) is reproduced verbatim.
    return `<mxCell style="${outline}"${attributes}${close}`;
  });
}

/**
 * Outlines every cell named in `highlights` by appending `strokeColor`/`strokeWidth` to its style.
 *
 * Appending is a safe override rather than a hope: `mxStylesheet.getCellStyle` splits the style on
 * `;` and assigns each `key=value` left-to-right into one map, so a LATER key overwrites an earlier
 * one (mxgraph/src/view/mxStylesheet.js in the bundled draw.io). Nothing needs stripping first —
 * and stripping would be strictly worse, since it would lose whatever else the author put there.
 *
 * The `<object>`/`<UserObject>` split: a cell carrying custom attributes is wrapped, and the
 * wrapper holds the `id` while the inner `<mxCell>` holds the `style` — so the id is matched on the
 * wrapper and the rewrite lands on the tag inside it. Same split `scanPaintCells` documents in
 * drawio.ts, and the same linear scan: cells never nest (mxGraphModel keeps them flat under
 * `<root>`, hierarchy lives in the `parent` attribute), so skipping past a wrapper's close tag is
 * enough to keep its inner cell from being visited twice.
 */
export function highlightDrawioCells(source: string, highlights: Map<string, HighlightKind>): string {
  if (highlights.size === 0) return source;

  const openRe = /<(mxCell|object|UserObject)\b([^>]*?)(\/?)>/g;
  let out = '';
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = openRe.exec(source))) {
    const [, tag, attributes, selfClosing] = match;
    if (selfClosing !== '/') {
      const closeIndex = source.indexOf(`</${tag}>`, openRe.lastIndex);
      openRe.lastIndex = closeIndex === -1 ? source.length : closeIndex + `</${tag}>`.length;
    }
    const end = openRe.lastIndex;
    const text = source.slice(match.index, end);
    // The wrapper's id wins where there is one; a bare `<mxCell>` reaches the same attribute text
    // by the same lookup.
    const id = cellAttribute(attributes, 'id') ?? cellAttribute(/<mxCell\b([^>]*?)\/?>/.exec(text)?.[1] ?? '', 'id');
    const kind = id === undefined ? undefined : highlights.get(id);
    out += source.slice(cursor, match.index) + (kind ? withOutline(text, kind) : text);
    cursor = end;
  }
  return out + source.slice(cursor);
}
