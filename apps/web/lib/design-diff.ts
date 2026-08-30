// Archify-style "change receipt" between two designs (or two revisions of one design): what was
// added, removed, renamed, moved, restyled, or rerouted. Pure functions only — no React, no DOM,
// no network. Operates entirely on `DesignGraph`, the existing IR (design-graph.ts) that two of
// the three diagram formats already normalise into; drawio-graph.ts supplies the third.
//
// Types come from the `@/`-aliased path (erased at runtime by node's type-stripping, so they're
// safe under plain `node --test`). The actual parser CALLS below need to run at runtime, though,
// and `@/`-aliased VALUE imports don't resolve under plain node (see mermaid-architecture.ts's
// file-header note) — so those go through relative `.ts`-extension imports instead, which is why
// `apps/web/tsconfig.json` now has `allowImportingTsExtensions: true` (harmless for every other
// file: nothing else in the project uses an extension-ful specifier).

import type { DesignDiagramType, DesignGraph, DesignNode } from '@/lib/design-graph';
import type { Edge } from '@xyflow/react';
import { parseDesignGraph } from './design-graph.ts';
import { architectureToDesignGraph, parseArchitectureDiagram } from './mermaid-architecture.ts';
import { parseDrawioGraph } from './drawio-graph.ts';

/**
 * Parses `source` (in the shape `diagramType` implies) into the common `DesignGraph` IR, or
 * `null` when the format has no graph structure to diff ('pen' is freeform ink, 'text' is prose).
 */
export function toDiffGraph(diagramType: DesignDiagramType, source: string): DesignGraph | null {
  switch (diagramType) {
    case 'drawio':
      return parseDrawioGraph(source);
    case 'reactflow':
      return parseDesignGraph(source);
    case 'mermaid':
      return architectureToDesignGraph(parseArchitectureDiagram(source));
    case 'pen':
    case 'text':
      return null;
    default:
      return null;
  }
}

export type DiffEntity = 'node' | 'edge';
export type DiffEntryKind = 'added' | 'removed' | 'renamed' | 'moved' | 'restyled' | 'rerouted';

export interface DiffEntry {
  kind: DiffEntryKind;
  entity: DiffEntity;
  /** Present for every kind except 'added' (nothing existed in `base` to reference). */
  baseId?: string;
  /** Present for every kind except 'removed' (nothing exists in `head` to reference). */
  headId?: string;
  /** Display label: head's label when the entity survives, otherwise base's. */
  label: string;
  before?: string | Position | StyleSnapshot | Endpoints;
  after?: string | Position | StyleSnapshot | Endpoints;
  /** Set when this entry came from an ambiguous match — more than one equally-good candidate
   * existed on at least one side and the pairing was resolved by document order. Absent (not
   * `false`) when the match was unambiguous. */
  confidence?: 'low';
}

interface Position { x: number; y: number }
interface StyleSnapshot { icon?: string; kind?: string }
interface Endpoints { source: string; target: string }

export interface DesignDiff {
  matchBy: 'id' | 'label';
  entries: DiffEntry[];
}

export interface DiffOptions {
  matchBy: 'id' | 'label';
}

/** `Edge.label` is typed `ReactNode` by @xyflow/react, but every adapter in this codebase only
 * ever writes a plain string or leaves it unset (design-graph.ts's `toDesignEdge`,
 * mermaid-architecture.ts's edge construction, drawio-graph.ts's `toEdge`) — narrow defensively
 * the same way `toDesignEdge` does, rather than assuming. */
function edgeLabel(edge: Edge): string {
  return typeof edge.label === 'string' ? edge.label : '';
}

/** Confidence is meaningful only when low — omit the key entirely rather than carry an explicit
 * `confidence: undefined` on every unambiguous entry (matches how optional fields are built
 * elsewhere in this codebase, e.g. design-graph.ts's `toDesignNode`). */
function withConfidence<T extends object>(entry: T, confidence: 'low' | undefined): T | (T & { confidence: 'low' }) {
  return confidence ? { ...entry, confidence } : entry;
}

// --- shared pair comparison (both matchBy modes emit through these) --------------------------

function compareNodePair(base: DesignNode, head: DesignNode, confidence?: 'low'): DiffEntry[] {
  const entries: DiffEntry[] = [];
  const label = head.data.label;
  const common = { entity: 'node' as const, baseId: base.id, headId: head.id, label };

  if (base.data.label !== head.data.label) {
    entries.push(withConfidence({ kind: 'renamed', ...common, before: base.data.label, after: head.data.label }, confidence));
  }
  if (base.position.x !== head.position.x || base.position.y !== head.position.y) {
    entries.push(withConfidence({
      kind: 'moved', ...common,
      before: { x: base.position.x, y: base.position.y },
      after: { x: head.position.x, y: head.position.y },
    }, confidence));
  }
  if (base.data.icon !== head.data.icon || base.data.kind !== head.data.kind) {
    entries.push(withConfidence({
      kind: 'restyled', ...common,
      before: { icon: base.data.icon, kind: base.data.kind },
      after: { icon: head.data.icon, kind: head.data.kind },
    }, confidence));
  }
  return entries;
}

/** Full comparison for matchBy:'id' edges — identity (the edge id) is stable across a revision,
 * so a source/target change is observable as 'rerouted' here. Not used for matchBy:'label': see
 * `diffByLabel`, where an edge's identity IS its (matched) endpoint pair, so there's nothing
 * independent left to detect a reroute against. */
function compareEdgePairById(base: Edge, head: Edge, confidence?: 'low'): DiffEntry[] {
  const entries: DiffEntry[] = [];
  const label = edgeLabel(head);
  const common = { entity: 'edge' as const, baseId: base.id, headId: head.id, label };

  if (edgeLabel(base) !== edgeLabel(head)) {
    entries.push(withConfidence({ kind: 'renamed', ...common, before: edgeLabel(base), after: edgeLabel(head) }, confidence));
  }
  if (base.source !== head.source || base.target !== head.target) {
    entries.push(withConfidence({
      kind: 'rerouted', ...common,
      before: { source: base.source, target: base.target },
      after: { source: head.source, target: head.target },
    }, confidence));
  }
  return entries;
}

function compareEdgePairByLabel(base: Edge, head: Edge, confidence?: 'low'): DiffEntry[] {
  if (edgeLabel(base) === edgeLabel(head)) return [];
  return [withConfidence({
    kind: 'renamed' as const, entity: 'edge' as const, baseId: base.id, headId: head.id, label: edgeLabel(head),
    before: edgeLabel(base), after: edgeLabel(head),
  }, confidence)];
}

function groupPush<T>(map: Map<string, T[]>, key: string, item: T): void {
  const list = map.get(key);
  if (list) list.push(item);
  else map.set(key, [item]);
}

// --- matchBy: 'id' -------------------------------------------------------------------------
// Revision-to-revision within ONE design: mxGraphModel.cellAdded (and this app's own id
// generation) only mints an id when none exists, so move/rename/restyle/reparent/reconnect all
// preserve identity — matching directly on id is safe and exact.

function diffById(base: DesignGraph, head: DesignGraph): DesignDiff {
  const entries: DiffEntry[] = [];

  const baseNodes = new Map(base.nodes.map((n) => [n.id, n]));
  const headNodes = new Map(head.nodes.map((n) => [n.id, n]));
  for (const b of base.nodes) {
    const h = headNodes.get(b.id);
    if (!h) entries.push({ kind: 'removed', entity: 'node', baseId: b.id, label: b.data.label });
    else entries.push(...compareNodePair(b, h));
  }
  for (const h of head.nodes) {
    if (!baseNodes.has(h.id)) entries.push({ kind: 'added', entity: 'node', headId: h.id, label: h.data.label });
  }

  const baseEdges = new Map(base.edges.map((e) => [e.id, e]));
  const headEdges = new Map(head.edges.map((e) => [e.id, e]));
  for (const b of base.edges) {
    const h = headEdges.get(b.id);
    if (!h) entries.push({ kind: 'removed', entity: 'edge', baseId: b.id, label: edgeLabel(b) });
    else entries.push(...compareEdgePairById(b, h));
  }
  for (const h of head.edges) {
    if (!baseEdges.has(h.id)) entries.push({ kind: 'added', entity: 'edge', headId: h.id, label: edgeLabel(h) });
  }

  return { matchBy: 'id', entries };
}

// --- matchBy: 'label' ------------------------------------------------------------------------
// Cross-design comparison: two designs forked from the same starter share template-slot ids
// (DRAWIO_AWS_STARTER_SOURCE hard-codes "database", "lambda", etc.), so an id match there would
// be coincidence, not identity — id="database" may be Aurora in one fork and DynamoDB in another.
// Worse, cells a user ADDS get fresh/GUID-ish ids that can never collide across designs, so an
// id-aware matcher would (wrongly) treat the untouched half as "the same" by id and the genuinely
// edited half as unrelated additions — backwards. Match on substance instead: label + shape,
// resolved parent-first so identically-labelled siblings in different containers don't collide.

const ROOT_KEY = ' root';

function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

function shapeToken(node: DesignNode): string {
  return node.data.icon ?? node.data.kind ?? '';
}

/** label + shape only — the caller supplies the (already-resolved) parent component separately,
 * since parent resolution happens progressively, top-down, as matched groups are discovered. */
function labelShapeKey(node: DesignNode): string {
  return `${normalizeLabel(node.data.label)} ${shapeToken(node)}`;
}

function diffByLabel(base: DesignGraph, head: DesignGraph): DesignDiff {
  const entries: DiffEntry[] = [];
  let counter = 0;
  const freshKey = () => `k${counter++}`;

  // Direct-children lookups, keyed by the RAW (unresolved) parent id — used once, at the moment
  // a node's own resolved key is minted, to seed its children's candidate pool.
  const baseChildrenOf = new Map<string, DesignNode[]>();
  for (const n of base.nodes) if (n.parentId) groupPush(baseChildrenOf, n.parentId, n);
  const headChildrenOf = new Map<string, DesignNode[]>();
  for (const n of head.nodes) if (n.parentId) groupPush(headChildrenOf, n.parentId, n);

  // Candidate pools, keyed by RESOLVED parent key (shared between a matched base/head parent
  // pair; unique-per-node for an unmatched parent) — populated progressively as the queue below
  // resolves each level before descending into the next.
  const baseGroupOf = new Map<string, DesignNode[]>([[ROOT_KEY, base.nodes.filter((n) => !n.parentId)]]);
  const headGroupOf = new Map<string, DesignNode[]>([[ROOT_KEY, head.nodes.filter((n) => !n.parentId)]]);

  const baseResolvedKey = new Map<string, string>(); // base node id -> its resolved key
  const headResolvedKey = new Map<string, string>(); // head node id -> its resolved key

  const queue: string[] = [ROOT_KEY];
  while (queue.length) {
    const parentKey = queue.shift()!;
    const baseByKey = new Map<string, DesignNode[]>();
    for (const n of baseGroupOf.get(parentKey) ?? []) groupPush(baseByKey, labelShapeKey(n), n);
    const headByKey = new Map<string, DesignNode[]>();
    for (const n of headGroupOf.get(parentKey) ?? []) groupPush(headByKey, labelShapeKey(n), n);

    for (const key of new Set([...baseByKey.keys(), ...headByKey.keys()])) {
      const bList = baseByKey.get(key) ?? [];
      const hList = headByKey.get(key) ?? [];
      const pairCount = Math.min(bList.length, hList.length);
      // More than one candidate on either side means document-order pairing is a guess, not a
      // certainty — flag every entry this key's group produces, matched pairs included.
      const ambiguous = pairCount >= 1 && (bList.length > 1 || hList.length > 1);

      for (let i = 0; i < pairCount; i++) {
        const b = bList[i];
        const h = hList[i];
        const resolved = freshKey();
        baseResolvedKey.set(b.id, resolved);
        headResolvedKey.set(h.id, resolved);
        entries.push(...compareNodePair(b, h, ambiguous ? 'low' : undefined));
        baseGroupOf.set(resolved, baseChildrenOf.get(b.id) ?? []);
        headGroupOf.set(resolved, headChildrenOf.get(h.id) ?? []);
        queue.push(resolved);
      }
      // Leftovers are an unambiguous fact ("one more/fewer node with this key exists") regardless
      // of how the pairing above was resolved, so they never carry low confidence.
      for (let i = pairCount; i < bList.length; i++) {
        const b = bList[i];
        const resolved = freshKey();
        baseResolvedKey.set(b.id, resolved);
        entries.push({ kind: 'removed', entity: 'node', baseId: b.id, label: b.data.label });
        baseGroupOf.set(resolved, baseChildrenOf.get(b.id) ?? []);
        headGroupOf.set(resolved, []);
        queue.push(resolved);
      }
      for (let i = pairCount; i < hList.length; i++) {
        const h = hList[i];
        const resolved = freshKey();
        headResolvedKey.set(h.id, resolved);
        entries.push({ kind: 'added', entity: 'node', headId: h.id, label: h.data.label });
        baseGroupOf.set(resolved, []);
        headGroupOf.set(resolved, headChildrenOf.get(h.id) ?? []);
        queue.push(resolved);
      }
    }
  }

  // Edges match on their matched endpoints, not on edge ids: every node above (matched or not)
  // now has a resolved key, so an edge's identity for this mode is the (resolved source, resolved
  // target) pair. Endpoints that never resolved (shouldn't happen for a well-formed DesignGraph —
  // see toDiffGraph's adapters, which all sanitize dangling references) fall back to a stable
  // per-side placeholder rather than crashing.
  const endpointsKey = (resolvedSource: string | undefined, resolvedTarget: string | undefined) =>
    `${resolvedSource ?? ' ?'} ${resolvedTarget ?? ' ?'}`;

  const baseEdgesByEndpoints = new Map<string, Edge[]>();
  for (const e of base.edges) {
    groupPush(baseEdgesByEndpoints, endpointsKey(baseResolvedKey.get(e.source), baseResolvedKey.get(e.target)), e);
  }
  const headEdgesByEndpoints = new Map<string, Edge[]>();
  for (const e of head.edges) {
    groupPush(headEdgesByEndpoints, endpointsKey(headResolvedKey.get(e.source), headResolvedKey.get(e.target)), e);
  }

  for (const key of new Set([...baseEdgesByEndpoints.keys(), ...headEdgesByEndpoints.keys()])) {
    const bList = baseEdgesByEndpoints.get(key) ?? [];
    const hList = headEdgesByEndpoints.get(key) ?? [];
    const pairCount = Math.min(bList.length, hList.length);
    const ambiguous = pairCount >= 1 && (bList.length > 1 || hList.length > 1);

    for (let i = 0; i < pairCount; i++) {
      entries.push(...compareEdgePairByLabel(bList[i], hList[i], ambiguous ? 'low' : undefined));
    }
    for (let i = pairCount; i < bList.length; i++) {
      entries.push({ kind: 'removed', entity: 'edge', baseId: bList[i].id, label: edgeLabel(bList[i]) });
    }
    for (let i = pairCount; i < hList.length; i++) {
      entries.push({ kind: 'added', entity: 'edge', headId: hList[i].id, label: edgeLabel(hList[i]) });
    }
  }

  return { matchBy: 'label', entries };
}

/**
 * Produces the change receipt between `base` (the "before") and `head` (the "after"). See the
 * `matchBy` sections above for exactly when each mode is correct — in short: 'id' within one
 * design's revision history, 'label' across two different designs.
 */
export function diffDesignGraphs(base: DesignGraph, head: DesignGraph, options: DiffOptions): DesignDiff {
  return options.matchBy === 'id' ? diffById(base, head) : diffByLabel(base, head);
}
