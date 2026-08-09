import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DRAWIO_AWS_STARTER_SOURCE,
  DRAWIO_BLANK_SOURCE,
  drawioEditorSrc,
  drawioStarterSource,
  drawioViewerSrc,
  isDrawioSource,
  parseDrawioMessage,
} from './drawio.ts';

test('starter sources are valid draw.io XML documents', () => {
  assert.equal(isDrawioSource(DRAWIO_BLANK_SOURCE), true);
  assert.equal(isDrawioSource(DRAWIO_AWS_STARTER_SOURCE), true);
  assert.equal(drawioStarterSource('aws'), DRAWIO_AWS_STARTER_SOURCE);
  assert.equal(drawioStarterSource('workflow'), DRAWIO_BLANK_SOURCE);
});

test('draw.io source detection rejects unrelated text', () => {
  assert.equal(isDrawioSource('flowchart LR\n  a --> b'), false);
  assert.equal(isDrawioSource('{"nodes":[]}'), false);
  assert.equal(isDrawioSource('<mxGraphModel><root /></mxGraphModel>'), true);
});

test('message parser accepts editor JSON and viewer ready events', () => {
  assert.deepEqual(parseDrawioMessage('ready'), { event: 'ready' });
  assert.deepEqual(parseDrawioMessage('{"event":"autosave","xml":"<mxfile />"}'), {
    event: 'autosave',
    xml: '<mxfile />',
    data: undefined,
    error: undefined,
  });
  assert.equal(parseDrawioMessage('not-json'), null);
});

test('embed URLs enable JSON autosave and read-only client protocols', () => {
  const editor = new URL(drawioEditorSrc());
  assert.equal(editor.searchParams.get('embed'), '1');
  assert.equal(editor.searchParams.get('proto'), 'json');
  assert.equal(editor.searchParams.get('libs')?.includes('aws4'), true);
  assert.equal(editor.searchParams.get('noSaveBtn'), '1');
  assert.equal(editor.searchParams.get('offline'), '1');
  assert.equal(editor.searchParams.get('stealth'), '1');
  assert.equal(editor.searchParams.get('dark'), '0');
  assert.equal(editor.origin, 'http://localhost:18081');

  const darkEditor = new URL(drawioEditorSrc(true));
  assert.equal(darkEditor.searchParams.get('dark'), '1');

  const viewer = new URL(drawioViewerSrc());
  assert.equal(viewer.searchParams.get('client'), '1');
  assert.equal(viewer.searchParams.get('lightbox'), '1');
  assert.equal(viewer.searchParams.get('nav'), '1');
  assert.equal(viewer.searchParams.get('offline'), '1');
  assert.equal(viewer.searchParams.get('dark'), '0');
  assert.equal(viewer.origin, 'http://localhost:18081');

  const darkViewer = new URL(drawioViewerSrc(true));
  assert.equal(darkViewer.searchParams.get('dark'), '1');
});
