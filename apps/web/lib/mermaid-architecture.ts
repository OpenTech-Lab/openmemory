// Hand-written parser for mermaid `architecture-beta` diagrams — the grammar below is transcribed
// from the compiled Langium grammar in
// node_modules/@mermaid-js/parser/dist/chunks/mermaid-parser.core/chunk-KEIR6QF5.mjs (verified:
// the Arrow rule's literals in order are `--` or `-` ... `-`). Mermaid's internal parser/AST is
// not a stable public API, so this is deliberately independent of it.
//
//   header    ::= 'architecture-beta'                      (required, first non-skip line)
//   group     ::= 'group'    ID ARCH_ICON? ARCH_TITLE? ('in' ID)?
//   service   ::= 'service'  ID (STRING | ARCH_ICON)? ARCH_TITLE? ('in' ID)?
//   junction  ::= 'junction' ID ('in' ID)?
//   edge      ::= ID '{group}'? ':' DIR ('<'|'>')? ('--' | '-' ARCH_TITLE '-') ('<'|'>')? DIR ':' ID '{group}'?
//   align     ::= 'align' ('row'|'column') ID ID+          (accepted, ignored in v1)
//   meta      ::= 'title' … | 'accTitle' ':' … | 'accDescr' …   (accepted, ignored)
//
//   ID         = /\w(?:[-\w]*\w)?/
//   DIR        = /L|R|T|B/
//   ARCH_ICON  = /\([\w\-:]+\)/
//   ARCH_TITLE = /\[(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[\w ]+)\]/
//
// Statements are line-oriented; `%%` comments, `%%{…}%%` directives, `---` YAML frontmatter and
// blank lines are skipped. Never throws — matches parseDesignGraph's resilience (design-graph.ts),
// and additionally *reports* parse issues since this text is hand-written.
//
// `@/`-aliased imports here must stay `import type` only (erased by node's type-stripping) so
// `node --test lib/mermaid-architecture.test.ts` can run this file directly with no bundler.

import type { Edge } from '@xyflow/react';
import type { DesignGraph, DesignNode, DesignNodeData } from '@/lib/design-graph';

export interface ParseIssue {
  line: number;
  text: string;
  message: string;
}

type Dir = 'L' | 'R' | 'T' | 'B';

interface ParsedGroup {
  kind: 'group';
  id: string;
  icon?: string;
  title?: string;
  parentIdRaw?: string;
  line: number;
}
interface ParsedService {
  kind: 'service';
  id: string;
  icon?: string;
  title?: string;
  parentIdRaw?: string;
  line: number;
}
interface ParsedJunction {
  kind: 'junction';
  id: string;
  parentIdRaw?: string;
  line: number;
}
interface ParsedEdge {
  sourceId: string;
  sourceGroupSuffix: boolean;
  sourceDir: Dir;
  targetId: string;
  targetGroupSuffix: boolean;
  targetDir: Dir;
  lhsInto: boolean;
  rhsInto: boolean;
  label?: string;
  line: number;
}

export interface ArchitectureParse {
  /** false only when the `architecture-beta` header itself is missing/wrong. */
  ok: boolean;
  groups: ParsedGroup[];
  services: ParsedService[];
  junctions: ParsedJunction[];
  edges: ParsedEdge[];
  issues: ParseIssue[];
}

// --- grammar tokens -------------------------------------------------------

const ID_SRC = '\\w(?:[-\\w]*\\w)?';
const ARCH_ICON_SRC = '\\([\\w:-]+\\)';
const DQ_STRING_SRC = '"(?:[^"\\\\]|\\\\.)*"';
const SQ_STRING_SRC = "'(?:[^'\\\\]|\\\\.)*'";
const ARCH_TITLE_SRC = `\\[(?:${DQ_STRING_SRC}|${SQ_STRING_SRC}|[\\w ]+)\\]`;
const GROUP_SUFFIX_SRC = '\\{group\\}';

const GROUP_RE = new RegExp(
  `^group\\s+(${ID_SRC})\\s*(${ARCH_ICON_SRC})?\\s*(${ARCH_TITLE_SRC})?(?:\\s+in\\s+(${ID_SRC}))?\\s*$`
);
const SERVICE_RE = new RegExp(
  `^service\\s+(${ID_SRC})\\s*(${DQ_STRING_SRC}|${ARCH_ICON_SRC})?\\s*(${ARCH_TITLE_SRC})?(?:\\s+in\\s+(${ID_SRC}))?\\s*$`
);
const JUNCTION_RE = new RegExp(`^junction\\s+(${ID_SRC})(?:\\s+in\\s+(${ID_SRC}))?\\s*$`);
const EDGE_RE = new RegExp(
  `^(${ID_SRC})(${GROUP_SUFFIX_SRC})?\\s*:\\s*(L|R|T|B)\\s*(<|>)?\\s*(?:--|-(${ARCH_TITLE_SRC})-)\\s*(<|>)?\\s*(L|R|T|B)\\s*:\\s*(${ID_SRC})(${GROUP_SUFFIX_SRC})?\\s*$`
);
const ALIGN_RE = /^align\s+(row|column)\s+.+$/;
const TITLE_RE = /^title(\s+.*)?$/;
const ACC_TITLE_RE = /^accTitle\s*:.*$/;
const ACC_DESCR_RE = /^accDescr\b.*$/;

function isCommentOrDirective(line: string): boolean {
  return /^[ \t]*%%/.test(line);
}

// --- value extraction -------------------------------------------------------

function unescapeTitle(inner: string): string {
  const trimmed = inner.trim();
  const isQuoted =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"));
  if (!isQuoted) return trimmed;
  const body = trimmed.slice(1, -1);
  return body.replace(/\\(.)/g, (_match, ch: string) => {
    if (ch === 'n') return '\n';
    if (ch === 't') return '\t';
    return ch;
  });
}

/** Strips the enclosing `[...]` and unescapes/unquotes the ARCH_TITLE payload. */
function extractTitle(bracketed: string | undefined): string | undefined {
  if (!bracketed) return undefined;
  return unescapeTitle(bracketed.slice(1, -1));
}

/** Strips the enclosing `(...)` and the `logos:` prefix. A STRING pseudo-icon (`"DB"`) has no
 * real icon key, so it maps to `undefined` — accepted by the grammar, just not renderable as an
 * AWS icon. */
function extractIcon(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  if (raw.startsWith('"') || raw.startsWith("'")) return undefined;
  const inner = raw.slice(1, -1);
  return inner.startsWith('logos:') ? inner.slice('logos:'.length) : inner;
}

const DIR_TO_POSITION: Record<Dir, string> = { L: 'left', R: 'right', T: 'top', B: 'bottom' };

// --- parsing -------------------------------------------------------

/** Parses `source` as an `architecture-beta` diagram. Never throws — any malformed input reports
 * `ParseIssue`s rather than crashing, matching `parseDesignGraph`'s resilience contract. */
export function parseArchitectureDiagram(source: string): ArchitectureParse {
  const empty: ArchitectureParse = { ok: false, groups: [], services: [], junctions: [], edges: [], issues: [] };
  if (!source || !source.trim()) {
    return { ...empty, issues: [{ line: 0, text: '', message: 'empty source' }] };
  }

  const rawLines = source.split(/\r?\n/);
  let headerFound = false;
  let inFrontmatter = false;
  let sawAnyLine = false;

  const groups: ParsedGroup[] = [];
  const services: ParsedService[] = [];
  const junctions: ParsedJunction[] = [];
  const edges: ParsedEdge[] = [];
  const issues: ParseIssue[] = [];

  for (let i = 0; i < rawLines.length; i++) {
    const lineNo = i + 1;
    const raw = rawLines[i];
    const trimmed = raw.trim();

    if (trimmed === '') continue;
    if (isCommentOrDirective(raw)) continue;

    if (!headerFound) {
      // YAML frontmatter is only meaningful before the header is found.
      if (trimmed === '---') {
        if (!sawAnyLine) {
          inFrontmatter = true;
          sawAnyLine = true;
          continue;
        }
        if (inFrontmatter) {
          inFrontmatter = false;
          continue;
        }
      }
      if (inFrontmatter) {
        sawAnyLine = true;
        continue;
      }
      sawAnyLine = true;
      if (trimmed !== 'architecture-beta') {
        return {
          ...empty,
          issues: [{ line: lineNo, text: raw, message: 'not an architecture-beta diagram' }],
        };
      }
      headerFound = true;
      continue;
    }

    if (ALIGN_RE.test(trimmed) || TITLE_RE.test(trimmed) || ACC_TITLE_RE.test(trimmed) || ACC_DESCR_RE.test(trimmed)) {
      continue;
    }

    const groupMatch = GROUP_RE.exec(trimmed);
    if (groupMatch) {
      const [, id, icon, title, parentIdRaw] = groupMatch;
      groups.push({ kind: 'group', id, icon: extractIcon(icon), title: extractTitle(title), parentIdRaw, line: lineNo });
      continue;
    }

    const serviceMatch = SERVICE_RE.exec(trimmed);
    if (serviceMatch) {
      const [, id, icon, title, parentIdRaw] = serviceMatch;
      services.push({ kind: 'service', id, icon: extractIcon(icon), title: extractTitle(title), parentIdRaw, line: lineNo });
      continue;
    }

    const junctionMatch = JUNCTION_RE.exec(trimmed);
    if (junctionMatch) {
      const [, id, parentIdRaw] = junctionMatch;
      junctions.push({ kind: 'junction', id, parentIdRaw, line: lineNo });
      continue;
    }

    const edgeMatch = EDGE_RE.exec(trimmed);
    if (edgeMatch) {
      const [, sourceId, srcSuffix, sourceDir, leftMarker, label, rightMarker, targetDir, targetId, tgtSuffix] = edgeMatch;
      edges.push({
        sourceId,
        sourceGroupSuffix: Boolean(srcSuffix),
        sourceDir: sourceDir as Dir,
        targetId,
        targetGroupSuffix: Boolean(tgtSuffix),
        targetDir: targetDir as Dir,
        lhsInto: leftMarker === '<',
        rhsInto: rightMarker === '>',
        label: extractTitle(label),
        line: lineNo,
      });
      continue;
    }

    issues.push({ line: lineNo, text: raw, message: 'unrecognized line' });
  }

  if (!headerFound) {
    return { ...empty, issues: [{ line: 1, text: rawLines[0] ?? '', message: 'not an architecture-beta diagram' }] };
  }

  // Second pass: validate `in <group>` references now that the full id set is known.
  const allIds = new Set<string>([...groups.map((g) => g.id), ...services.map((s) => s.id), ...junctions.map((j) => j.id)]);
  const groupIds = new Set(groups.map((g) => g.id));

  const validateParent = (node: { id: string; parentIdRaw?: string; line: number }): string | undefined => {
    if (!node.parentIdRaw) return undefined;
    if (!groupIds.has(node.parentIdRaw)) {
      issues.push({ line: node.line, text: node.parentIdRaw, message: `"${node.id}" references unknown group "${node.parentIdRaw}"` });
      return undefined;
    }
    return node.parentIdRaw;
  };

  for (const g of groups) g.parentIdRaw = validateParent(g);
  for (const s of services) s.parentIdRaw = validateParent(s);
  for (const j of junctions) j.parentIdRaw = validateParent(j);

  const parentOf = new Map<string, string | undefined>([
    ...groups.map((g) => [g.id, g.parentIdRaw] as const),
    ...services.map((s) => [s.id, s.parentIdRaw] as const),
    ...junctions.map((j) => [j.id, j.parentIdRaw] as const),
  ]);

  const resolveEndpoint = (id: string, groupSuffix: boolean): string => {
    if (!groupSuffix || groupIds.has(id)) return id; // no-op if already a group
    return parentOf.get(id) ?? id; // no-op if no parent
  };

  const validEdges: ParsedEdge[] = [];
  for (const edge of edges) {
    if (!allIds.has(edge.sourceId)) {
      issues.push({ line: edge.line, text: edge.sourceId, message: `edge references unknown id "${edge.sourceId}"` });
      continue;
    }
    if (!allIds.has(edge.targetId)) {
      issues.push({ line: edge.line, text: edge.targetId, message: `edge references unknown id "${edge.targetId}"` });
      continue;
    }
    const resolvedSource = resolveEndpoint(edge.sourceId, edge.sourceGroupSuffix);
    const resolvedTarget = resolveEndpoint(edge.targetId, edge.targetGroupSuffix);
    if (resolvedSource === resolvedTarget) {
      issues.push({ line: edge.line, text: `${edge.sourceId}..${edge.targetId}`, message: 'edge collapses to a self-loop after {group} remap' });
      continue;
    }
    validEdges.push({ ...edge, sourceId: resolvedSource, targetId: resolvedTarget });
  }

  return { ok: true, groups, services, junctions, edges: validEdges, issues };
}

// --- graph construction -------------------------------------------------------

/** Re-sorts nodes so every parent precedes its children — React Flow's hard requirement for
 * `parentId` nesting. Deliberately reimplemented rather than importing design-graph.ts's
 * `sanitizeNodeHierarchy` at runtime, since `@/`-aliased VALUE imports don't resolve under plain
 * `node --test` (only `import type` is erased and therefore safe). Same algorithm. */
function orderParentsBeforeChildren(nodes: DesignNode[]): DesignNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
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
  for (const node of nodes) visit(node);
  return ordered;
}

/** Converts a successful `ArchitectureParse` into a `DesignGraph` — nodes land at `{x:0,y:0}`,
 * ungrouped by any layout; `applyNestedLayout` (design-layout.ts) must run before rendering. */
export function architectureToDesignGraph(parse: ArchitectureParse): DesignGraph {
  const nodes: DesignNode[] = [];

  for (const g of parse.groups) {
    const data: DesignNodeData = { label: g.title ?? g.id, icon: g.icon, derivedSize: true };
    const node: DesignNode = { id: g.id, type: 'group', position: { x: 0, y: 0 }, data };
    if (g.parentIdRaw) {
      node.parentId = g.parentIdRaw;
      node.extent = 'parent';
    }
    nodes.push(node);
  }
  for (const s of parse.services) {
    const data: DesignNodeData = { label: s.title ?? s.id, icon: s.icon };
    const node: DesignNode = { id: s.id, type: 'design', position: { x: 0, y: 0 }, data };
    if (s.parentIdRaw) {
      node.parentId = s.parentIdRaw;
      node.extent = 'parent';
    }
    nodes.push(node);
  }
  for (const j of parse.junctions) {
    const data: DesignNodeData = { label: '' };
    const node: DesignNode = { id: j.id, type: 'junction', position: { x: 0, y: 0 }, width: 12, height: 12, data };
    if (j.parentIdRaw) {
      node.parentId = j.parentIdRaw;
      node.extent = 'parent';
    }
    nodes.push(node);
  }

  const orderedNodes = orderParentsBeforeChildren(nodes);

  const edges: Edge[] = parse.edges.map((edge, index) => {
    const srcPos = DIR_TO_POSITION[edge.sourceDir];
    const tgtPos = DIR_TO_POSITION[edge.targetDir];

    let source = edge.sourceId;
    let target = edge.targetId;
    let sourceHandle = `${srcPos}-source`;
    let targetHandle = `${tgtPos}-target`;
    let markerStart: Edge['markerStart'];
    let markerEnd: Edge['markerEnd'];

    if (edge.lhsInto && !edge.rhsInto) {
      // Arrow points INTO the declared source: swap endpoints so only markerEnd is ever needed,
      // keeping each handle anchored at its originally declared side.
      source = edge.targetId;
      target = edge.sourceId;
      sourceHandle = `${tgtPos}-source`;
      targetHandle = `${srcPos}-target`;
      markerEnd = { type: 'arrowclosed' };
    } else if (edge.rhsInto && !edge.lhsInto) {
      markerEnd = { type: 'arrowclosed' };
    } else if (edge.lhsInto && edge.rhsInto) {
      markerStart = { type: 'arrowclosed' };
      markerEnd = { type: 'arrowclosed' };
    }
    // neither → no marker at all: both keys left undefined/omitted.

    const edgeOut: Edge = {
      id: `edge_${source}_${target}_${index}`,
      source,
      target,
      sourceHandle,
      targetHandle,
    };
    if (edge.label) edgeOut.label = edge.label;
    if (markerStart) edgeOut.markerStart = markerStart;
    if (markerEnd) edgeOut.markerEnd = markerEnd;
    return edgeOut;
  });

  return { nodes: orderedNodes, edges };
}
