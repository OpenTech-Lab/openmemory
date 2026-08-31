// Tests for the side-by-side highlight helpers. Run with:
// node --test lib/design-highlight.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HIGHLIGHT_COLORS, diffHighlightMap, highlightDrawioCells } from './design-highlight.ts';
import { parseDrawioGraph } from './drawio-graph.ts';
import type { DiffEntry } from './design-diff.ts';

test('base side keys off baseId and skips the additions, which have none', () => {
  const entries: DiffEntry[] = [
    { kind: 'removed', entity: 'node', baseId: 'ecs', label: 'Amazon ECS' },
    { kind: 'added', entity: 'node', headId: 'queue', label: 'Amazon SQS' },
    { kind: 'moved', entity: 'node', baseId: 'db', headId: 'db', label: 'Aurora' },
  ];
  assert.deepEqual(diffHighlightMap(entries, 'base'), new Map([['ecs', 'removed'], ['db', 'changed']]));
});

test('head side keys off headId and skips the removals, which have none', () => {
  const entries: DiffEntry[] = [
    { kind: 'removed', entity: 'node', baseId: 'ecs', label: 'Amazon ECS' },
    { kind: 'added', entity: 'node', headId: 'queue', label: 'Amazon SQS' },
    { kind: 'moved', entity: 'node', baseId: 'db', headId: 'db', label: 'Aurora' },
  ];
  assert.deepEqual(diffHighlightMap(entries, 'head'), new Map([['queue', 'added'], ['db', 'changed']]));
});

test('every in-place kind collapses to changed', () => {
  const kinds = ['renamed', 'moved', 'restyled', 'rerouted'] as const;
  const entries: DiffEntry[] = kinds.map((kind, index) => ({
    kind, entity: 'node', baseId: `n${index}`, headId: `n${index}`, label: `n${index}`,
  }));
  assert.deepEqual(
    diffHighlightMap(entries, 'head'),
    new Map([['n0', 'changed'], ['n1', 'changed'], ['n2', 'changed'], ['n3', 'changed']]),
  );
});

test('a swapped service outlines its one cell once, not three times', () => {
  // Replacing ECS with Fargate in place emits renamed + moved + restyled against the same id.
  const entries: DiffEntry[] = [
    { kind: 'renamed', entity: 'node', baseId: 'svc', headId: 'svc', label: 'AWS Fargate', before: 'Amazon ECS', after: 'AWS Fargate' },
    { kind: 'moved', entity: 'node', baseId: 'svc', headId: 'svc', label: 'AWS Fargate', before: { x: 0, y: 0 }, after: { x: 40, y: 0 } },
    { kind: 'restyled', entity: 'node', baseId: 'svc', headId: 'svc', label: 'AWS Fargate', before: { icon: 'ecs' }, after: { icon: 'fargate' } },
  ];
  const highlights = diffHighlightMap(entries, 'head');
  assert.equal(highlights.size, 1);
  assert.equal(highlights.get('svc'), 'changed');
});

test('added and removed win over changed whichever order they arrive in', () => {
  const changedFirst: DiffEntry[] = [
    { kind: 'moved', entity: 'node', baseId: 'x', headId: 'x', label: 'x' },
    { kind: 'added', entity: 'node', baseId: 'x', headId: 'x', label: 'x' },
  ];
  assert.equal(diffHighlightMap(changedFirst, 'head').get('x'), 'added');

  const changedLast: DiffEntry[] = [
    { kind: 'removed', entity: 'node', baseId: 'y', headId: 'y', label: 'y' },
    { kind: 'restyled', entity: 'node', baseId: 'y', headId: 'y', label: 'y' },
  ];
  assert.equal(diffHighlightMap(changedLast, 'base').get('y'), 'removed');
});

test('an empty highlight map returns the source untouched', () => {
  const source = '<mxCell id="a" style="rounded=0;" vertex="1" parent="1" />';
  assert.equal(highlightDrawioCells(source, new Map()), source);
  assert.equal(highlightDrawioCells('', new Map()), '');
});

test('outline tokens are appended after the authored style, so they override it', () => {
  const source = '<mxCell id="a" style="rounded=0;strokeColor=#ffffff;strokeWidth=1;" vertex="1" parent="1" />';
  const highlighted = highlightDrawioCells(source, new Map([['a', 'changed']]));
  // The authored tokens survive: mxStylesheet.getCellStyle takes the LAST occurrence of a key, so
  // the appended pair wins without anything being stripped.
  assert.equal(
    highlighted,
    '<mxCell id="a" style="rounded=0;strokeColor=#ffffff;strokeWidth=1;strokeColor=#1570EF;strokeWidth=4;" vertex="1" parent="1" />',
  );
  assert.ok(highlighted.indexOf('strokeColor=#ffffff') < highlighted.indexOf('strokeColor=#1570EF'));
});

test('a style with no trailing semicolon gets one before the outline', () => {
  const source = '<mxCell id="a" style="rounded=0" vertex="1" parent="1" />';
  assert.match(highlightDrawioCells(source, new Map([['a', 'added']])), /style="rounded=0;strokeColor=#12B76A;strokeWidth=4;"/);

  const empty = '<mxCell id="a" style="" vertex="1" parent="1" />';
  assert.match(highlightDrawioCells(empty, new Map([['a', 'added']])), /style="strokeColor=#12B76A;strokeWidth=4;"/);
});

test('a cell with no style attribute gains one', () => {
  const source = '<mxCell id="a" vertex="1" parent="1" />';
  assert.equal(
    highlightDrawioCells(source, new Map([['a', 'removed']])),
    '<mxCell style="strokeColor=#F04438;strokeWidth=4;" id="a" vertex="1" parent="1" />',
  );
});

test('each kind stamps its own colour', () => {
  const source = `<root>
    <mxCell id="add" style="rounded=0;" vertex="1" parent="1" />
    <mxCell id="del" style="rounded=0;" vertex="1" parent="1" />
    <mxCell id="mod" style="rounded=0;" vertex="1" parent="1" />
  </root>`;
  const highlighted = highlightDrawioCells(source, new Map([
    ['add', 'added'], ['del', 'removed'], ['mod', 'changed'],
  ] as const));
  assert.match(highlighted, /id="add" style="rounded=0;strokeColor=#12B76A;strokeWidth=4;"/);
  assert.match(highlighted, /id="del" style="rounded=0;strokeColor=#F04438;strokeWidth=4;"/);
  assert.match(highlighted, /id="mod" style="rounded=0;strokeColor=#1570EF;strokeWidth=4;"/);
  assert.equal(HIGHLIGHT_COLORS.added, '#12B76A');
  assert.equal(HIGHLIGHT_COLORS.removed, '#F04438');
  assert.equal(HIGHLIGHT_COLORS.changed, '#1570EF');
});

test('cells outside the map are left byte-for-byte alone', () => {
  const source = `<root>
    <mxCell id="0" />
    <mxCell id="1" parent="0" />
    <mxCell id="keep" style="rounded=0;" vertex="1" parent="1"><mxGeometry x="10" y="20" width="78" height="78" as="geometry" /></mxCell>
    <mxCell id="hit" style="rounded=0;" vertex="1" parent="1" />
  </root>`;
  const highlighted = highlightDrawioCells(source, new Map([['hit', 'changed']]));
  assert.ok(highlighted.includes('<mxCell id="keep" style="rounded=0;" vertex="1" parent="1"><mxGeometry x="10" y="20" width="78" height="78" as="geometry" /></mxCell>'));
  assert.ok(highlighted.includes('<mxCell id="0" />'));
  assert.match(highlighted, /id="hit" style="rounded=0;strokeColor=#1570EF;strokeWidth=4;"/);
});

test('an <object>-wrapped cell is matched on the wrapper id and stamped on the inner mxCell', () => {
  // The wrapper carries `id` (and the custom attributes); only the inner cell has a `style`.
  const source = `<root>
    <object label="Payments API" owner="platform" id="api">
      <mxCell style="shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.api_gateway;" vertex="1" parent="1">
        <mxGeometry x="200" y="160" width="78" height="78" as="geometry" />
      </mxCell>
    </object>
  </root>`;
  const highlighted = highlightDrawioCells(source, new Map([['api', 'changed']]));
  assert.match(highlighted, /resIcon=mxgraph\.aws4\.api_gateway;strokeColor=#1570EF;strokeWidth=4;/);
  // The wrapper itself must not be rewritten — its `label` is the cell's value, not a style.
  assert.ok(highlighted.includes('<object label="Payments API" owner="platform" id="api">'));
  assert.equal(highlighted.match(/strokeColor=#1570EF/g)?.length, 1);
});

test('a <UserObject>-wrapped cell behaves the same, including when it has no style', () => {
  const source = `<root>
    <UserObject label="Nightly ETL" id="etl">
      <mxCell vertex="1" parent="1"><mxGeometry x="0" y="0" width="120" height="60" as="geometry" /></mxCell>
    </UserObject>
  </root>`;
  const highlighted = highlightDrawioCells(source, new Map([['etl', 'added']]));
  assert.ok(highlighted.includes('<mxCell style="strokeColor=#12B76A;strokeWidth=4;" vertex="1" parent="1">'));
  assert.ok(highlighted.includes('<UserObject label="Nightly ETL" id="etl">'));
});

test('a wrapper outside the map leaves its inner cell alone', () => {
  // Regression guard for the split: matching the INNER cell would find no id and silently skip,
  // but a naive scan that also visited the inner tag could double-stamp the wrapped cell.
  const source = `<root>
    <object label="Untouched" id="skip"><mxCell style="rounded=0;" vertex="1" parent="1" /></object>
    <mxCell id="hit" style="rounded=0;" vertex="1" parent="1" />
  </root>`;
  const highlighted = highlightDrawioCells(source, new Map([['hit', 'removed']]));
  assert.ok(highlighted.includes('<object label="Untouched" id="skip"><mxCell style="rounded=0;" vertex="1" parent="1" /></object>'));
  assert.equal(highlighted.match(/strokeColor=#F04438/g)?.length, 1);
});

test('edges are outlined the same way vertices are', () => {
  const source = '<mxCell id="e1" style="edgeStyle=orthogonalEdgeStyle;" edge="1" parent="1" source="api" target="db" />';
  assert.match(
    highlightDrawioCells(source, new Map([['e1', 'added']])),
    /style="edgeStyle=orthogonalEdgeStyle;strokeColor=#12B76A;strokeWidth=4;"/,
  );
});

test('highlighting is idempotent in effect — a second pass still ends on the outline', () => {
  const source = '<mxCell id="a" style="rounded=0;" vertex="1" parent="1" />';
  const once = highlightDrawioCells(source, new Map([['a', 'changed']]));
  const twice = highlightDrawioCells(once, new Map([['a', 'changed']]));
  assert.ok(twice.endsWith('style="rounded=0;strokeColor=#1570EF;strokeWidth=4;strokeColor=#1570EF;strokeWidth=4;" vertex="1" parent="1" />'));
});

test('the highlighted document still parses to the same graph', () => {
  const source = `<mxfile host="OpenMemory" compressed="false">
  <diagram id="d1" name="Architecture">
    <mxGraphModel dx="1422" dy="794" grid="1">
      <root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
        <mxCell id="api" value="API Gateway" style="shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.api_gateway;" vertex="1" parent="1">
          <mxGeometry x="200" y="160" width="78" height="78" as="geometry" />
        </mxCell>
        <mxCell id="db" value="Aurora" style="shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.aurora;" vertex="1" parent="1">
          <mxGeometry x="400" y="160" width="78" height="78" as="geometry" />
        </mxCell>
        <mxCell id="e1" style="edgeStyle=orthogonalEdgeStyle;" edge="1" parent="1" source="api" target="db">
          <mxGeometry relative="1" as="geometry" />
        </mxCell>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>`;
  const highlighted = highlightDrawioCells(source, new Map([['api', 'changed'], ['e1', 'added']]));
  // Outlining must not disturb what the diff engine reads back out — same nodes, labels, icons,
  // positions and endpoints, or the two panes would stop agreeing with the change list.
  assert.deepEqual(parseDrawioGraph(highlighted), parseDrawioGraph(source));
  assert.match(highlighted, /resIcon=mxgraph\.aws4\.api_gateway;strokeColor=#1570EF;strokeWidth=4;/);
  assert.match(highlighted, /edgeStyle=orthogonalEdgeStyle;strokeColor=#12B76A;strokeWidth=4;/);
  // The untouched cell keeps its exact original style string.
  assert.ok(highlighted.includes('style="shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.aurora;"'));
});

test('an id present in the map but absent from the document changes nothing', () => {
  const source = '<mxCell id="a" style="rounded=0;" vertex="1" parent="1" />';
  assert.equal(highlightDrawioCells(source, new Map([['ghost', 'added']])), source);
});
