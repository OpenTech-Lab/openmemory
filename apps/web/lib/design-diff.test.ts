import assert from 'node:assert/strict';
import test from 'node:test';
import { DRAWIO_AWS_STARTER_SOURCE } from './drawio.ts';
import { diffDesignGraphs, toDiffGraph } from './design-diff.ts';
import type { DesignGraph } from './design-graph.ts';

test('toDiffGraph dispatches by diagram type; pen and text are not diffable', () => {
  const drawio = toDiffGraph('drawio', DRAWIO_AWS_STARTER_SOURCE);
  assert.equal(drawio?.nodes.length, 6);
  assert.equal(drawio?.edges.length, 3);

  const reactflowSource = JSON.stringify({
    nodes: [{ id: 'a', type: 'design', position: { x: 0, y: 0 }, data: { label: 'A' } }],
    edges: [],
  });
  const reactflow = toDiffGraph('reactflow', reactflowSource);
  assert.equal(reactflow?.nodes.length, 1);
  assert.equal(reactflow?.nodes[0].id, 'a');

  const mermaidSource = 'architecture-beta\nservice a(logos:aws-lambda)["Fn"]\nservice b(logos:aws-s3)["Bucket"]\na:R --> L:b';
  const mermaid = toDiffGraph('mermaid', mermaidSource);
  assert.equal(mermaid?.nodes.length, 2);
  assert.equal(mermaid?.edges.length, 1);

  assert.equal(toDiffGraph('pen', 'anything'), null);
  assert.equal(toDiffGraph('text', 'anything'), null);
});

test('matchBy:"id" produces all six receipt kinds for a single revised design', () => {
  const base: DesignGraph = {
    nodes: [
      { id: 'n1', type: 'design', position: { x: 0, y: 0 }, data: { label: 'API Gateway', icon: 'api_gateway' } },
      { id: 'n2', type: 'design', position: { x: 100, y: 0 }, data: { label: 'Lambda', icon: 'lambda' } },
      { id: 'n3', type: 'design', position: { x: 200, y: 0 }, data: { label: 'DynamoDB', icon: 'dynamodb' } },
      { id: 'n4', type: 'design', position: { x: 300, y: 0 }, data: { label: 'S3 Bucket', icon: 's3' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2', label: 'invoke' },
      { id: 'e2', source: 'n2', target: 'n3', label: 'query' },
      { id: 'e3', source: 'n2', target: 'n4', label: 'store' },
    ],
  };
  const head: DesignGraph = {
    nodes: [
      { id: 'n1', type: 'design', position: { x: 0, y: 0 }, data: { label: 'API Gateway v2', icon: 'api_gateway' } }, // renamed
      { id: 'n2', type: 'design', position: { x: 150, y: 0 }, data: { label: 'Lambda', icon: 'lambda' } }, // moved
      { id: 'n3', type: 'design', position: { x: 200, y: 0 }, data: { label: 'DynamoDB', icon: 'aurora' } }, // restyled
      // n4 gone -> removed; n5 new -> added
      { id: 'n5', type: 'design', position: { x: 400, y: 0 }, data: { label: 'Cache', icon: 'elasticache' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2', label: 'invoke' }, // unchanged
      { id: 'e2', source: 'n2', target: 'n5', label: 'query' }, // rerouted: target n3 -> n5
      // e3 gone -> removed; e4 new -> added
      { id: 'e4', source: 'n3', target: 'n5', label: 'new-conn' },
    ],
  };

  const diff = diffDesignGraphs(base, head, { matchBy: 'id' });
  assert.equal(diff.matchBy, 'id');
  assert.equal(diff.entries.length, 8);
  assert.equal(diff.entries.some((e) => e.confidence === 'low'), false); // id-matching is never ambiguous

  const renamed = diff.entries.find((e) => e.kind === 'renamed')!;
  assert.equal(renamed.entity, 'node');
  assert.equal(renamed.baseId, 'n1');
  assert.equal(renamed.before, 'API Gateway');
  assert.equal(renamed.after, 'API Gateway v2');

  const moved = diff.entries.find((e) => e.kind === 'moved')!;
  assert.equal(moved.baseId, 'n2');
  assert.deepEqual(moved.before, { x: 100, y: 0 });
  assert.deepEqual(moved.after, { x: 150, y: 0 });

  const restyled = diff.entries.find((e) => e.kind === 'restyled')!;
  assert.equal(restyled.baseId, 'n3');
  assert.deepEqual(restyled.before, { icon: 'dynamodb', kind: undefined });
  assert.deepEqual(restyled.after, { icon: 'aurora', kind: undefined });

  const removedNode = diff.entries.find((e) => e.kind === 'removed' && e.entity === 'node')!;
  assert.equal(removedNode.baseId, 'n4');
  assert.equal(removedNode.label, 'S3 Bucket');

  const addedNode = diff.entries.find((e) => e.kind === 'added' && e.entity === 'node')!;
  assert.equal(addedNode.headId, 'n5');

  const rerouted = diff.entries.find((e) => e.kind === 'rerouted')!;
  assert.equal(rerouted.entity, 'edge');
  assert.equal(rerouted.baseId, 'e2');
  assert.deepEqual(rerouted.before, { source: 'n2', target: 'n3' });
  assert.deepEqual(rerouted.after, { source: 'n2', target: 'n5' });

  const removedEdge = diff.entries.find((e) => e.kind === 'removed' && e.entity === 'edge')!;
  assert.equal(removedEdge.baseId, 'e3');

  const addedEdge = diff.entries.find((e) => e.kind === 'added' && e.entity === 'edge')!;
  assert.equal(addedEdge.headId, 'e4');
});

test('matchBy:"id" vs matchBy:"label" diverge on two starter-derived designs that share template ids', () => {
  // Both forked from the same AWS starter, so both have a cell id="database" — the plan's own
  // cautionary example: that id is a template SLOT, not a stable identity across designs.
  const base = toDiffGraph('drawio', DRAWIO_AWS_STARTER_SOURCE)!;
  const head = toDiffGraph('drawio', DRAWIO_AWS_STARTER_SOURCE)!;

  // Design A (base): the user swapped the starter's DynamoDB slot for Aurora in place — same
  // cell id ("database"), different real-world entity.
  const baseDb = base.nodes.find((n) => n.id === 'database')!;
  baseDb.data.label = 'Amazon Aurora';
  baseDb.data.icon = 'aurora';

  // Design B (head): the original DynamoDB slot is untouched, but the user separately added a
  // brand-new Aurora node with a fresh id (mirroring draw.io's GUID-ish ids for user-added
  // cells) at the same position/parent/kind as base's edited slot.
  const headDb = head.nodes.find((n) => n.id === 'database')!;
  head.nodes.push({
    id: 'node-xyz789',
    type: 'design',
    position: { ...headDb.position },
    parentId: headDb.parentId,
    data: { label: 'Amazon Aurora', icon: 'aurora', kind: headDb.data.kind },
  });
  // Edge-matching has its own dedicated test below; drop edges here so this one stays focused on
  // node identity — otherwise the untouched "lambda -> database" edge (still literally wired to
  // id="database" on both sides, since real edits never touch it) would also exercise the
  // endpoint-matching path this test isn't about.
  base.edges = [];
  head.edges = [];

  const byId = diffDesignGraphs(base, head, { matchBy: 'id' });
  // id="database" matches directly, so id-matching reports that ONE slot as changed and treats
  // the truly-new node as an unrelated addition — it never notices DynamoDB itself disappeared.
  assert.equal(byId.entries.length, 3);
  assert.equal(byId.entries.filter((e) => e.kind === 'renamed' && e.baseId === 'database').length, 1);
  assert.equal(byId.entries.filter((e) => e.kind === 'restyled' && e.baseId === 'database').length, 1);
  assert.equal(byId.entries.filter((e) => e.kind === 'added' && e.headId === 'node-xyz789').length, 1);
  assert.equal(byId.entries.some((e) => e.kind === 'removed'), false);

  const byLabel = diffDesignGraphs(base, head, { matchBy: 'label' });
  // label-matching recognizes base's edited "database" cell and head's new node as the SAME
  // real-world entity (same label + icon + parent) -> zero entries for Aurora — and correctly
  // reports the untouched DynamoDB cell as the one new thing in head.
  assert.equal(byLabel.entries.length, 1);
  assert.equal(byLabel.entries.some((e) => e.label === 'Amazon Aurora'), false);
  assert.equal(byLabel.entries.some((e) => e.headId === 'node-xyz789' || e.baseId === 'node-xyz789'), false);
  const [added] = byLabel.entries;
  assert.equal(added.kind, 'added');
  assert.equal(added.headId, 'database');
  assert.equal(added.label, 'Amazon DynamoDB');
});

test('label-matching resolves parent-first, so two same-named children in different containers do not collide', () => {
  const base: DesignGraph = {
    nodes: [
      { id: 'vpcA', type: 'design', position: { x: 0, y: 0 }, data: { label: 'VPC A', kind: 'group' } },
      { id: 'lambdaA', type: 'design', position: { x: 0, y: 0 }, parentId: 'vpcA', data: { label: 'Lambda', icon: 'lambda' } },
      { id: 'vpcB', type: 'design', position: { x: 300, y: 0 }, data: { label: 'VPC B', kind: 'group' } },
      { id: 'lambdaB', type: 'design', position: { x: 300, y: 0 }, parentId: 'vpcB', data: { label: 'Lambda', icon: 'lambda' } },
    ],
    edges: [],
  };
  const head: DesignGraph = {
    nodes: [
      { id: 'vpcA2', type: 'design', position: { x: 0, y: 0 }, data: { label: 'VPC A', kind: 'group' } },
      { id: 'lambdaA2', type: 'design', position: { x: 0, y: 0 }, parentId: 'vpcA2', data: { label: 'Lambda', icon: 'lambda' } },
      { id: 'vpcB2', type: 'design', position: { x: 300, y: 0 }, data: { label: 'VPC B', kind: 'group' } },
      // Only VPC B's Lambda moved — VPC A's is byte-identical.
      { id: 'lambdaB2', type: 'design', position: { x: 350, y: 40 }, parentId: 'vpcB2', data: { label: 'Lambda', icon: 'lambda' } },
    ],
    edges: [],
  };

  const diff = diffDesignGraphs(base, head, { matchBy: 'label' });
  assert.equal(diff.entries.length, 1, 'only VPC B\'s Lambda changed; VPC A\'s must match cleanly with no entry');
  const [entry] = diff.entries;
  assert.equal(entry.kind, 'moved');
  assert.equal(entry.baseId, 'lambdaB');
  assert.equal(entry.headId, 'lambdaB2');
  assert.equal(entry.confidence, undefined, 'exactly one candidate per side in each container -> unambiguous');
});

test('a genuine tie (same label+shape+parent, multiple candidates) is paired by document order and marked low confidence', () => {
  const base: DesignGraph = {
    nodes: [
      { id: 'w1', type: 'design', position: { x: 0, y: 0 }, data: { label: 'Worker', icon: 'ecs' } },
      { id: 'w2', type: 'design', position: { x: 100, y: 0 }, data: { label: 'Worker', icon: 'ecs' } },
    ],
    edges: [],
  };
  const head: DesignGraph = {
    nodes: [
      { id: 'w3', type: 'design', position: { x: 0, y: 50 }, data: { label: 'Worker', icon: 'ecs' } },
      { id: 'w4', type: 'design', position: { x: 999, y: 999 }, data: { label: 'Worker', icon: 'ecs' } },
    ],
    edges: [],
  };

  const diff = diffDesignGraphs(base, head, { matchBy: 'label' });
  assert.equal(diff.entries.length, 2);
  assert.ok(diff.entries.every((e) => e.kind === 'moved' && e.confidence === 'low'));
  assert.deepEqual(diff.entries.map((e) => e.baseId), ['w1', 'w2']);
  assert.deepEqual(diff.entries.map((e) => e.headId), ['w3', 'w4']);
});

test('an unambiguous addition alongside a tied group is not itself marked low confidence', () => {
  // Two "Worker" nodes on the base side, three on the head side, all sharing the same key: the
  // pairing of the first two is a guess (low confidence), but "one more Worker exists" is a
  // plain fact regardless of which pairing was chosen.
  const base: DesignGraph = {
    nodes: [
      { id: 'w1', type: 'design', position: { x: 0, y: 0 }, data: { label: 'Worker', icon: 'ecs' } },
      { id: 'w2', type: 'design', position: { x: 100, y: 0 }, data: { label: 'Worker', icon: 'ecs' } },
    ],
    edges: [],
  };
  const head: DesignGraph = {
    nodes: [
      { id: 'w3', type: 'design', position: { x: 0, y: 0 }, data: { label: 'Worker', icon: 'ecs' } },
      { id: 'w4', type: 'design', position: { x: 100, y: 0 }, data: { label: 'Worker', icon: 'ecs' } },
      { id: 'w5', type: 'design', position: { x: 200, y: 0 }, data: { label: 'Worker', icon: 'ecs' } },
    ],
    edges: [],
  };

  const diff = diffDesignGraphs(base, head, { matchBy: 'label' });
  const added = diff.entries.find((e) => e.kind === 'added')!;
  assert.equal(added.headId, 'w5');
  assert.equal(added.confidence, undefined);
});

test('matchBy:"label" edges match on resolved endpoints, not on edge ids', () => {
  const base: DesignGraph = {
    nodes: [
      { id: 'a1', type: 'design', position: { x: 0, y: 0 }, data: { label: 'A', icon: 'api_gateway' } },
      { id: 'b1', type: 'design', position: { x: 100, y: 0 }, data: { label: 'B', icon: 'lambda' } },
    ],
    edges: [{ id: 'old-edge-id', source: 'a1', target: 'b1', label: 'call' }],
  };
  const head: DesignGraph = {
    nodes: [
      { id: 'a2', type: 'design', position: { x: 0, y: 0 }, data: { label: 'A', icon: 'api_gateway' } },
      { id: 'b2', type: 'design', position: { x: 100, y: 0 }, data: { label: 'B', icon: 'lambda' } },
    ],
    // Completely different edge id, but connects the same matched (A,B) pair -> should be
    // recognized as the same edge, just relabeled, not as a remove+add.
    edges: [{ id: 'brand-new-edge-id', source: 'a2', target: 'b2', label: 'invoke' }],
  };

  const diff = diffDesignGraphs(base, head, { matchBy: 'label' });
  const edgeEntries = diff.entries.filter((e) => e.entity === 'edge');
  assert.equal(edgeEntries.length, 1);
  assert.equal(edgeEntries[0].kind, 'renamed');
  assert.equal(edgeEntries[0].before, 'call');
  assert.equal(edgeEntries[0].after, 'invoke');
});
