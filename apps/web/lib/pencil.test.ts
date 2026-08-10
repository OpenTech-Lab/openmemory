import assert from 'node:assert/strict';
import test from 'node:test';
import {
  blankPencilSource,
  isPencilSource,
  parsePencilMessage,
  parsePencilRef,
  pencilEmbedSrc,
  serializePencilRef,
} from './pencil.ts';

test('pencil refs round-trip through serialize and parse', () => {
  const ref = { providerId: 'openmemory' as const };
  const parsed = parsePencilRef(serializePencilRef(ref));
  assert.deepEqual(parsed, ref);
});

test('blank source is a valid pencil ref', () => {
  const source = blankPencilSource();
  assert.equal(isPencilSource(source), true);
  assert.deepEqual(parsePencilRef(source), { providerId: 'openmemory' });
});

test('pencil source detection rejects other diagram formats', () => {
  assert.equal(isPencilSource('flowchart TD\n  A --> B'), false);
  assert.equal(isPencilSource('<mxfile host="OpenMemory"></mxfile>'), false);
  assert.equal(isPencilSource(''), false);
  assert.equal(isPencilSource('{"nodes":[],"edges":[]}'), false);
});

test('malformed refs parse to null rather than throwing', () => {
  assert.equal(parsePencilRef('not json'), null);
  assert.equal(parsePencilRef('{}'), null);
  assert.equal(parsePencilRef('{"providerId":"s3"}'), null);
  assert.equal(parsePencilRef('[]'), null);
  assert.equal(parsePencilRef('null'), null);
  assert.equal(parsePencilRef('42'), null);
});

test('embed src carries the embed path', () => {
  const src = pencilEmbedSrc();
  assert.equal(src.includes('/embed.html'), true);
});

test('message parsing tolerates hostile input', () => {
  assert.deepEqual(parsePencilMessage('{"event":"ready"}'), {
    event: 'ready',
    documentId: undefined,
    error: undefined,
  });
  assert.equal(parsePencilMessage('not json'), null);
  assert.equal(parsePencilMessage(null), null);
  assert.equal(parsePencilMessage([]), null);
  assert.equal(parsePencilMessage(42), null);
  assert.deepEqual(parsePencilMessage({ event: 'saved', documentId: 'd1' }), {
    event: 'saved',
    documentId: 'd1',
    error: undefined,
  });
});
