import assert from 'node:assert/strict';
import test from 'node:test';
import { DRAWIO_AWS_STARTER_SOURCE, DRAWIO_BLANK_SOURCE } from './drawio.ts';
import { parseDrawioGraph } from './drawio-graph.ts';

test('AWS starter round-trips into 6 nodes and 3 edges', () => {
  const graph = parseDrawioGraph(DRAWIO_AWS_STARTER_SOURCE);
  assert.equal(graph.nodes.length, 6);
  assert.equal(graph.edges.length, 3);

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  assert.deepEqual(new Set(byId.keys()), new Set(['cloud', 'vpc', 'api', 'lambda', 'database', 'bucket']));

  assert.equal(byId.get('cloud')?.data.label, 'AWS Cloud');
  assert.equal(byId.get('cloud')?.parentId, undefined); // parent="1" is the root sentinel
  assert.equal(byId.get('cloud')?.data.kind, 'mxgraph.aws4.group');

  assert.equal(byId.get('vpc')?.data.label, 'VPC');
  assert.equal(byId.get('vpc')?.parentId, 'cloud');

  assert.equal(byId.get('api')?.data.label, 'Amazon API Gateway');
  assert.equal(byId.get('api')?.parentId, 'vpc');
  assert.equal(byId.get('api')?.data.icon, 'api_gateway');
  assert.equal(byId.get('api')?.data.kind, 'mxgraph.aws4.resourceIcon');

  assert.equal(byId.get('lambda')?.data.icon, 'lambda');
  assert.equal(byId.get('lambda')?.parentId, 'vpc');

  assert.equal(byId.get('database')?.data.label, 'Amazon DynamoDB');
  assert.equal(byId.get('database')?.data.icon, 'dynamodb');
  assert.equal(byId.get('database')?.parentId, 'vpc');

  assert.equal(byId.get('bucket')?.data.label, 'Amazon S3');
  assert.equal(byId.get('bucket')?.data.icon, 's3');
  assert.equal(byId.get('bucket')?.parentId, 'cloud'); // sibling of vpc, not nested inside it

  const geometry = byId.get('api');
  assert.deepEqual(geometry?.position, { x: 65, y: 105 });
  assert.equal(geometry?.width, 60);
  assert.equal(geometry?.height, 60);

  const byPair = new Map(graph.edges.map((e) => [`${e.source}->${e.target}`, e]));
  assert.equal(byPair.get('api->lambda')?.label, 'request');
  assert.equal(byPair.get('lambda->database')?.label, 'read / write');
  assert.equal(byPair.get('lambda->bucket')?.label, 'objects');
});

test('parents precede children for every node in the AWS starter', () => {
  const graph = parseDrawioGraph(DRAWIO_AWS_STARTER_SOURCE);
  const seen = new Set<string>();
  for (const node of graph.nodes) {
    if (node.parentId) assert.ok(seen.has(node.parentId), `${node.id}'s parent ${node.parentId} must precede it`);
    seen.add(node.id);
  }
});

test('blank starter (root sentinels only) parses to an empty graph', () => {
  const graph = parseDrawioGraph(DRAWIO_BLANK_SOURCE);
  assert.deepEqual(graph, { nodes: [], edges: [] });
});

test('handles self-closing cells, single-quoted attributes, and scrambled attribute order', () => {
  const source = `<mxfile><diagram id="d1" name="Page-1"><mxGraphModel>
    <root>
      <mxCell id="0" />
      <mxCell id='1' parent="0" />
      <mxCell style="shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.lambda;" vertex='1' id="fn" parent='1' value="Fn">
        <mxGeometry width="60" x="10" height='60' y="20" as="geometry" />
      </mxCell>
    </root>
  </mxGraphModel></diagram></mxfile>`;
  const graph = parseDrawioGraph(source);
  assert.equal(graph.nodes.length, 1);
  const node = graph.nodes[0];
  assert.equal(node.id, 'fn');
  assert.equal(node.data.label, 'Fn');
  assert.equal(node.data.icon, 'lambda');
  assert.equal(node.parentId, undefined);
  assert.deepEqual(node.position, { x: 10, y: 20 });
  assert.equal(node.width, 60);
  assert.equal(node.height, 60);
});

test('decodes XML entities and strips HTML markup from labels', () => {
  const source = `<mxfile><diagram><mxGraphModel><root>
    <mxCell id="0" /><mxCell id="1" parent="0" />
    <mxCell id="n1" value="Cache &amp; Queue &lt;b&gt;(hot)&lt;/b&gt;" style="shape=rectangle;" vertex="1" parent="1">
      <mxGeometry x="0" y="0" width="40" height="40" as="geometry" />
    </mxCell>
  </root></mxGraphModel></diagram></mxfile>`;
  const graph = parseDrawioGraph(source);
  assert.equal(graph.nodes[0].data.label, 'Cache & Queue (hot)');
  assert.equal(graph.nodes[0].data.kind, 'rectangle');
});

test('parses only the first <diagram> when an mxfile has multiple pages', () => {
  const source = `<mxfile>
    <diagram id="page-1"><mxGraphModel><root>
      <mxCell id="0" /><mxCell id="1" parent="0" />
      <mxCell id="a" value="Page One Node" style="shape=rectangle;" vertex="1" parent="1">
        <mxGeometry x="0" y="0" width="40" height="40" as="geometry" />
      </mxCell>
    </root></mxGraphModel></diagram>
    <diagram id="page-2"><mxGraphModel><root>
      <mxCell id="0" /><mxCell id="1" parent="0" />
      <mxCell id="b" value="Page Two Node" style="shape=rectangle;" vertex="1" parent="1">
        <mxGeometry x="0" y="0" width="40" height="40" as="geometry" />
      </mxCell>
    </root></mxGraphModel></diagram>
  </mxfile>`;
  const graph = parseDrawioGraph(source);
  assert.equal(graph.nodes.length, 1);
  assert.equal(graph.nodes[0].id, 'a');
});

test('a bare <mxGraphModel> with no <mxfile>/<diagram> wrapper still parses', () => {
  const source = `<mxGraphModel><root>
    <mxCell id="0" /><mxCell id="1" parent="0" />
    <mxCell id="solo" value="Solo" style="shape=rectangle;" vertex="1" parent="1">
      <mxGeometry x="0" y="0" width="40" height="40" as="geometry" />
    </mxCell>
  </root></mxGraphModel>`;
  const graph = parseDrawioGraph(source);
  assert.equal(graph.nodes.length, 1);
  assert.equal(graph.nodes[0].id, 'solo');
});

test('an edge missing source or target is dropped', () => {
  const source = `<mxfile><diagram><mxGraphModel><root>
    <mxCell id="0" /><mxCell id="1" parent="0" />
    <mxCell id="dangling" value="" style="" edge="1" parent="1" source="ghost">
      <mxGeometry relative="1" as="geometry" />
    </mxCell>
  </root></mxGraphModel></diagram></mxfile>`;
  const graph = parseDrawioGraph(source);
  assert.equal(graph.edges.length, 0);
});

test('a parentId referencing a node outside the parsed set is dropped, not left dangling', () => {
  const source = `<mxfile><diagram><mxGraphModel><root>
    <mxCell id="0" /><mxCell id="1" parent="0" />
    <mxCell id="orphan" value="Orphan" style="shape=rectangle;" vertex="1" parent="nosuchgroup">
      <mxGeometry x="0" y="0" width="40" height="40" as="geometry" />
    </mxCell>
  </root></mxGraphModel></diagram></mxfile>`;
  const graph = parseDrawioGraph(source);
  assert.equal(graph.nodes.length, 1);
  assert.equal(graph.nodes[0].parentId, undefined);
});

test('children listed before their parent in document order are still reordered parent-first', () => {
  const source = `<mxfile><diagram><mxGraphModel><root>
    <mxCell id="0" /><mxCell id="1" parent="0" />
    <mxCell id="child" value="Child" style="shape=rectangle;" vertex="1" parent="group">
      <mxGeometry x="10" y="10" width="20" height="20" as="geometry" />
    </mxCell>
    <mxCell id="group" value="Group" style="shape=mxgraph.aws4.group;" vertex="1" parent="1">
      <mxGeometry x="0" y="0" width="100" height="100" as="geometry" />
    </mxCell>
  </root></mxGraphModel></diagram></mxfile>`;
  const graph = parseDrawioGraph(source);
  const order = graph.nodes.map((n) => n.id);
  assert.ok(order.indexOf('group') < order.indexOf('child'), 'group must precede child after sanitization');
});

test('never throws on empty or garbage input', () => {
  assert.doesNotThrow(() => parseDrawioGraph(''));
  assert.deepEqual(parseDrawioGraph(''), { nodes: [], edges: [] });
  assert.doesNotThrow(() => parseDrawioGraph('not xml at all $$$'));
  assert.deepEqual(parseDrawioGraph('not xml at all $$$'), { nodes: [], edges: [] });
});
