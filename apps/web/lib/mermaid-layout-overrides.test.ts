// Tests for the drag-position `%%` comment codec. Run with:
// node --test lib/mermaid-layout-overrides.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LAYOUT_COMMENT_MARKER,
  applyOverrides,
  diffOverrides,
  hasCorruptLayoutComment,
  parseLayoutComment,
  reconcileOverrides,
  stripLayoutComment,
  withLayoutComment,
} from './mermaid-layout-overrides.ts';

const SOURCE = `architecture-beta
    group cloud(logos:aws)["AWS Cloud"]
    service api(logos:aws-api-gateway)["API Gateway"] in cloud`;

test('withLayoutComment -> stripLayoutComment round-trips to the original source', () => {
  const overrides = { api: { x: 120, y: 40, p: 'cloud' } };
  const withComment = withLayoutComment(SOURCE, overrides);
  assert.equal(stripLayoutComment(withComment), SOURCE);
});

test('withLayoutComment -> parseLayoutComment round-trips to the original overrides', () => {
  const overrides = { api: { x: 120, y: 40, p: 'cloud' }, cloud: { x: 0, y: 0 } };
  const withComment = withLayoutComment(SOURCE, overrides);
  assert.deepEqual(parseLayoutComment(withComment), overrides);
});

test('withLayoutComment emits nothing for empty overrides, so an untouched diagram never grows a comment', () => {
  assert.equal(withLayoutComment(SOURCE, {}), SOURCE);
});

test('emitted marker line starts with "%% " (a space) — cannot match the directive terminal', () => {
  const withComment = withLayoutComment(SOURCE, { api: { x: 1, y: 2 } });
  const line = withComment.split('\n').at(-1)!;
  assert.ok(line.startsWith(LAYOUT_COMMENT_MARKER));
  assert.ok(line.startsWith('%% '));
  assert.doesNotMatch(line, /^[\t ]*%%\{/);
});

test('parseLayoutComment returns {} when there is no comment', () => {
  assert.deepEqual(parseLayoutComment(SOURCE), {});
  assert.deepEqual(parseLayoutComment(''), {});
});

test('parseLayoutComment returns {} on corrupt JSON payload', () => {
  const corrupt = `${SOURCE}\n%% openmemory:layout:v1 {not valid json`;
  assert.deepEqual(parseLayoutComment(corrupt), {});
});

test('parseLayoutComment returns {} when the payload is not an object / has no pos field', () => {
  assert.deepEqual(parseLayoutComment(`${SOURCE}\n%% openmemory:layout:v1 [1,2,3]`), {});
  assert.deepEqual(parseLayoutComment(`${SOURCE}\n%% openmemory:layout:v1 {"other":1}`), {});
});

test('parseLayoutComment takes the LAST of two marker lines', () => {
  const doubled = `${SOURCE}\n%% openmemory:layout:v1 {"pos":{"api":{"x":1,"y":1}}}\n%% openmemory:layout:v1 {"pos":{"api":{"x":99,"y":99}}}`;
  assert.deepEqual(parseLayoutComment(doubled), { api: { x: 99, y: 99 } });
});

test('reconcileOverrides drops overrides whose id no longer exists', () => {
  const overrides = { gone: { x: 1, y: 1 }, api: { x: 2, y: 2, p: 'cloud' } };
  const nodes = [{ id: 'cloud', width: 300, height: 200 }, { id: 'api', parentId: 'cloud', width: 96, height: 96 }];
  const result = reconcileOverrides(overrides, nodes);
  assert.ok(!('gone' in result));
  assert.ok('api' in result);
});

test('reconcileOverrides drops overrides whose recorded parent no longer matches', () => {
  const overrides = { api: { x: 2, y: 2, p: 'old-parent' } };
  const nodes = [{ id: 'cloud', width: 300, height: 200 }, { id: 'api', parentId: 'cloud', width: 96, height: 96 }];
  const result = reconcileOverrides(overrides, nodes);
  assert.ok(!('api' in result));
});

test('reconcileOverrides keeps unchanged overrides (including top-level, parent absent on both sides)', () => {
  const overrides = { top: { x: 5, y: 5 } };
  const nodes = [{ id: 'top', width: 96, height: 96 }];
  const result = reconcileOverrides(overrides, nodes);
  assert.deepEqual(result, { top: { x: 5, y: 5 } });
});

test('reconcileOverrides clamps a survivor into its (possibly shrunk) parent box', () => {
  const overrides = { api: { x: 900, y: 900, p: 'cloud' } };
  const nodes = [{ id: 'cloud', width: 200, height: 150 }, { id: 'api', parentId: 'cloud', width: 96, height: 96 }];
  const result = reconcileOverrides(overrides, nodes);
  assert.equal(result.api.x, 104); // 200 - 96
  assert.equal(result.api.y, 54); // 150 - 96
});

test('hasCorruptLayoutComment is false when there is no marker line at all', () => {
  assert.equal(hasCorruptLayoutComment(SOURCE), false);
});

test('hasCorruptLayoutComment is false for a valid marker line', () => {
  const withComment = withLayoutComment(SOURCE, { api: { x: 1, y: 2 } });
  assert.equal(hasCorruptLayoutComment(withComment), false);
});

test('hasCorruptLayoutComment is true for bad JSON or a non-{pos} payload', () => {
  assert.equal(hasCorruptLayoutComment(`${SOURCE}\n%% openmemory:layout:v1 {broken`), true);
  assert.equal(hasCorruptLayoutComment(`${SOURCE}\n%% openmemory:layout:v1 {"other":1}`), true);
});

test('diffOverrides emits only ids whose position differs from baseline', () => {
  const baseline = [
    { id: 'a', position: { x: 0, y: 0 } },
    { id: 'b', position: { x: 10, y: 10 }, parentId: 'g' },
  ];
  const current = [
    { id: 'a', position: { x: 0, y: 0 } }, // unchanged
    { id: 'b', position: { x: 50, y: 60 }, parentId: 'g' }, // dragged
  ];
  assert.deepEqual(diffOverrides(current, baseline), { b: { x: 50, y: 60, p: 'g' } });
});

test('diffOverrides skips ids missing from baseline', () => {
  const baseline = [{ id: 'a', position: { x: 0, y: 0 } }];
  const current = [{ id: 'gone', position: { x: 5, y: 5 } }];
  assert.deepEqual(diffOverrides(current, baseline), {});
});

test('applyOverrides merges override[id] onto laidOut[id] with no coordinate math', () => {
  const laidOut = [
    { id: 'a', position: { x: 0, y: 0 } },
    { id: 'b', position: { x: 10, y: 10 } },
  ];
  const overrides = { a: { x: 55, y: 66 } };
  const merged = applyOverrides(laidOut, overrides);
  assert.deepEqual(merged.find((n) => n.id === 'a')?.position, { x: 55, y: 66 });
  assert.deepEqual(merged.find((n) => n.id === 'b')?.position, { x: 10, y: 10 });
});
