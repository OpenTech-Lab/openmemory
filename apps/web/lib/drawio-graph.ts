// Hand-written regex/string parser for draw.io `mxfile` XML → DesignGraph. Deliberately NOT
// DOMParser-based: DOMParser is `undefined` under plain Node (verified on v26.1.0), and
// `node --test` on colocated `*.test.ts` is this repo's only working test mechanism for `lib/`
// (package.json's "test" script is a stub) — a DOM-based parser would be untestable by
// construction. Follows the same hand-rolled-grammar precedent as mermaid-architecture.ts.
//
// Scope, deliberately narrow:
//   - Parses only the FIRST <diagram> inside an <mxfile> — a .drawio file's other pages/tabs are
//     not read. Falls back to treating the whole source as the search space when there's no
//     <mxfile>/<diagram> wrapper at all (a bare <mxGraphModel> root is also valid draw.io source —
//     see `isDrawioSource` in drawio.ts, which accepts either form).
//   - Does not decompress `compressed="true"` diagrams (base64+deflate'd XML text content) — every
//     diagram this app reads or writes uses compressed="false" with inline XML (both starter
//     fixtures in drawio.ts do), so this case is unencountered in practice. A compressed <diagram>
//     simply contains no `<mxCell>` tags to match, so it yields an empty graph rather than
//     throwing — same resilience contract as parseDesignGraph.
//   - <mxCell> elements never nest in the XML (mxGraphModel keeps them flat under <root>; the
//     parent/child hierarchy is expressed only through the `parent` attribute), so no
//     recursive/balanced-tag matching is needed — a single left-to-right scan suffices.
//
// `@/`-aliased imports here must stay `import type` only (erased by node's type-stripping) so
// `node --test lib/drawio-graph.test.ts` can run this file directly with no bundler — same
// constraint documented in mermaid-architecture.ts.

import type { Edge } from '@xyflow/react';
import type { DesignGraph, DesignNode, DesignNodeData } from '@/lib/design-graph';

// --- XML micro-parsing -------------------------------------------------------

/** Decodes the five predefined XML entities plus numeric character references. `&amp;` is
 * decoded LAST so an already-escaped ampersand (serialized as `&amp;lt;`) can't double-unescape
 * into `<`. */
function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, '&');
}

/** draw.io renders `value` as HTML whenever the cell's style has `html=1` (the common case), so a
 * label can carry markup (`<b>`, `<br>`, `<div>`...). Strip it down to plain text. */
function stripHtmlTags(text: string): string {
  return text.replace(/<[^>]*>/g, '');
}

function decodeLabel(rawValue: string | undefined): string {
  if (!rawValue) return '';
  return stripHtmlTags(decodeXmlEntities(rawValue)).trim();
}

/** Parses one tag's attribute text (already extracted from between `<mxCell`/`<mxGeometry` and
 * its closing `>`/`/>`) into a plain map. Handles both quote styles and any attribute order. */
function parseAttrs(attrText: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z_][-\w:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrText))) {
    const raw = m[2] !== undefined ? m[2] : m[3];
    attrs[m[1]] = decodeXmlEntities(raw);
  }
  return attrs;
}

/** Extracts one `key=value` token from a draw.io `style` attribute's own `;`-delimited
 * micro-format. Same pattern drawio.ts's `normalizeAws4ResourceIcons` already uses for `resIcon`/
 * `fillColor`, generalised here to any key. */
function styleToken(style: string | undefined, key: string): string | undefined {
  if (!style) return undefined;
  return new RegExp(`(?:^|;)${key}=([^;]*)`).exec(style)?.[1];
}

/** `resIcon=mxgraph.aws4.<name>` → `<name>` — mirrors drawio.ts's own resIcon regex exactly
 * (`/resIcon=mxgraph\.aws4\.([^;]+)/`), so the icon key this parser produces (e.g. "lambda",
 * "api_gateway") lines up with that file's `AWS4_RESOURCE_COLORS` map. */
function extractIcon(style: string | undefined): string | undefined {
  const resIcon = styleToken(style, 'resIcon');
  if (!resIcon) return undefined;
  return resIcon.startsWith('mxgraph.aws4.') ? resIcon.slice('mxgraph.aws4.'.length) : resIcon;
}

interface RawCell {
  attrs: Record<string, string>;
  geometry?: { x?: number; y?: number; width?: number; height?: number };
}

/** Splits `xml` into its `<mxCell>` elements, each carrying its attributes and (if present) its
 * child `<mxGeometry>`'s x/y/width/height. Cells are flat siblings (see file header), so a single
 * left-to-right scan for open tags — checking each for self-closing vs paired — is sufficient. */
function scanCells(xml: string): RawCell[] {
  const cells: RawCell[] = [];
  const openRe = /<mxCell\b([^>]*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(xml))) {
    const attrs = parseAttrs(m[1]);
    const selfClosing = m[2] === '/';
    let geometry: RawCell['geometry'];
    if (!selfClosing) {
      const closeIndex = xml.indexOf('</mxCell>', openRe.lastIndex);
      const body = closeIndex === -1 ? '' : xml.slice(openRe.lastIndex, closeIndex);
      const geomMatch = /<mxGeometry\b([^>]*?)\/?>/.exec(body);
      if (geomMatch) {
        const g = parseAttrs(geomMatch[1]);
        geometry = {
          x: g.x !== undefined ? Number(g.x) : undefined,
          y: g.y !== undefined ? Number(g.y) : undefined,
          width: g.width !== undefined ? Number(g.width) : undefined,
          height: g.height !== undefined ? Number(g.height) : undefined,
        };
      }
      if (closeIndex !== -1) openRe.lastIndex = closeIndex + '</mxCell>'.length;
    }
    cells.push({ attrs, geometry });
  }
  return cells;
}

// --- cell → node/edge -------------------------------------------------------

function toNode(cell: RawCell): DesignNode | null {
  const { attrs, geometry } = cell;
  if (!attrs.id) return null;

  const data: DesignNodeData = { label: decodeLabel(attrs.value) };
  const icon = extractIcon(attrs.style);
  const kind = styleToken(attrs.style, 'shape');
  if (icon) data.icon = icon;
  if (kind) data.kind = kind;

  const node: DesignNode = {
    id: attrs.id,
    type: 'design',
    position: { x: geometry?.x ?? 0, y: geometry?.y ?? 0 },
    data,
  };
  // mxGraphModel's root sentinels are conventionally id="0" (the true root) and id="1" (the
  // default layer, parent="0") — a cell whose `parent` is one of those is top-level, not nested.
  if (attrs.parent && attrs.parent !== '0' && attrs.parent !== '1') node.parentId = attrs.parent;
  if (geometry?.width !== undefined && Number.isFinite(geometry.width)) node.width = geometry.width;
  if (geometry?.height !== undefined && Number.isFinite(geometry.height)) node.height = geometry.height;
  return node;
}

function toEdge(cell: RawCell): Edge | null {
  const { attrs } = cell;
  if (!attrs.id || !attrs.source || !attrs.target) return null;
  const edge: Edge = { id: attrs.id, source: attrs.source, target: attrs.target };
  const label = decodeLabel(attrs.value);
  if (label) edge.label = label;
  return edge;
}

/** Re-sorts nodes so every parent precedes its child (React Flow's hard requirement for
 * `parentId` nesting) and drops any `parentId` that references a node not present in the set.
 * Reimplemented locally rather than imported from design-graph.ts's `sanitizeNodeHierarchy` — see
 * the file-header note on why `@/`-aliased VALUE imports don't resolve under plain `node --test`.
 * Same algorithm as design-graph.ts's version (minus `extent`, which this adapter never sets). */
function sanitizeHierarchy(nodes: DesignNode[]): DesignNode[] {
  const ids = new Set(nodes.map((n) => n.id));
  const cleaned = nodes.map((n) => {
    if (n.parentId && !ids.has(n.parentId)) {
      const { parentId: _parentId, ...rest } = n;
      return rest as DesignNode;
    }
    return n;
  });

  const byId = new Map(cleaned.map((n) => [n.id, n]));
  const visited = new Set<string>();
  const ordered: DesignNode[] = [];
  const visit = (node: DesignNode) => {
    if (visited.has(node.id)) return;
    visited.add(node.id);
    if (node.parentId) {
      const parent = byId.get(node.parentId);
      if (parent) visit(parent);
    }
    ordered.push(node);
  };
  for (const node of cleaned) visit(node);
  return ordered;
}

/** Extracts the first `<diagram>...</diagram>` element's inner XML. Falls back to the whole
 * source when there's no `<mxfile>/<diagram>` wrapper (see the file-header note on bare
 * `<mxGraphModel>` roots). Deliberately only ever the FIRST diagram — see file header. */
function firstDiagramXml(source: string): string {
  const match = /<diagram\b[^>]*>([\s\S]*?)<\/diagram>/.exec(source);
  return match ? match[1] : source;
}

/**
 * Parses `source` — an `<mxfile>`-wrapped (or bare `<mxGraphModel>`) draw.io document — into a
 * `DesignGraph`. Never throws: malformed or unrecognized input yields whatever `<mxCell>`s happen
 * to be found (possibly none), matching `parseDesignGraph`'s resilience contract.
 */
export function parseDrawioGraph(source: string): DesignGraph {
  if (!source || !source.trim()) return { nodes: [], edges: [] };

  const cells = scanCells(firstDiagramXml(source));
  const nodes: DesignNode[] = [];
  const edges: Edge[] = [];

  for (const cell of cells) {
    if (cell.attrs.vertex === '1') {
      const node = toNode(cell);
      if (node) nodes.push(node);
    } else if (cell.attrs.edge === '1') {
      const edge = toEdge(cell);
      if (edge) edges.push(edge);
    }
  }

  return { nodes: sanitizeHierarchy(nodes), edges };
}
