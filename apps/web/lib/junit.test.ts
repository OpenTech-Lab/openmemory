import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { decodeXmlEntities } from './drawio-graph.ts';
import { parseJUnit } from './junit.ts';

const LIB_ROOT = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(LIB_ROOT, '..');
const FIXTURE_PATH = resolve(LIB_ROOT, 'fixtures/budget-compare.junit.xml');

test('drops node reporter classname="test" and parses a direct testcase', () => {
  const result = parseJUnit(`<?xml version="1.0"?>
    <testsuites>
      <testcase name="direct &amp; &quot;case&quot;" time="0.0015" classname="test"
        file="/home/toyofumi/projects/openmemory/apps/web/lib/direct.test.ts"/>
    </testsuites>`);

  assert.deepEqual(result.errors, []);
  assert.equal(result.cases.length, 1);
  assert.deepEqual(result.cases[0], {
    suite: null,
    name: 'direct & "case"',
    file: '/home/toyofumi/projects/openmemory/apps/web/lib/direct.test.ts',
    status: 'passed',
    duration_ms: 1.5,
    failure_message: null,
    failure_detail: null,
  });
});

test('uses nested testsuite names when classname is absent', () => {
  const result = parseJUnit(`<testsuites>
    <testsuite name="outer">
      <testsuite name="inner">
        <testcase name="nested case" file="tests/nested.test.ts"/>
      </testsuite>
    </testsuite>
  </testsuites>`);

  assert.deepEqual(result.errors, []);
  assert.equal(result.cases[0].suite, 'outer::inner');
  assert.equal(result.cases[0].name, 'nested case');
});

test('keeps a real classname as the suite', () => {
  const result = parseJUnit(`<testsuites>
    <testsuite name="wrapper">
      <testcase classname="package.Widget" name="renders" file="widget.test.ts"/>
    </testsuite>
  </testsuites>`);

  assert.deepEqual(result.errors, []);
  assert.equal(result.cases[0].suite, 'package.Widget');
});

test('maps failure message attributes and CDATA bodies separately', () => {
  const result = parseJUnit(`<testsuites>
    <testcase name="fails" time="2.25">
      <failure message="expected &amp; actual"><![CDATA[
        Error: expected 2
        at test.ts:12:3
      ]]></failure>
    </testcase>
    <testcase name="fails with text"><failure>plain &amp; escaped detail</failure></testcase>
  </testsuites>`);

  assert.deepEqual(result.errors, []);
  assert.equal(result.cases.length, 2);
  assert.equal(result.cases[0].status, 'failed');
  assert.equal(result.cases[0].duration_ms, 2250);
  assert.equal(result.cases[0].failure_message, 'expected & actual');
  assert.equal(result.cases[0].failure_detail, 'Error: expected 2\n        at test.ts:12:3');
  assert.equal(result.cases[1].failure_message, null);
  assert.equal(result.cases[1].failure_detail, 'plain & escaped detail');
});

test('distinguishes skipped, assertion failure, and execution error', () => {
  const result = parseJUnit(`<testsuites>
    <testcase name="skipped"><skipped/></testcase>
    <testcase name="failed"><failure message="assertion was false"/></testcase>
    <testcase name="errored"><error message="setup could not run"><![CDATA[import failed]]></error></testcase>
  </testsuites>`);

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.cases.map((item) => item.status), ['skipped', 'failed', 'error']);
  assert.equal(result.cases[2].failure_message, 'setup could not run');
  assert.equal(result.cases[2].failure_detail, 'import failed');
});

test('decodes XML entities in test names without double-unescaping', () => {
  const result = parseJUnit(`<testsuites>
    <testcase name="A &amp; B &lt; C &quot;quoted&quot; &amp;amp; literal &amp;quot;token&amp;quot;"/>
  </testsuites>`);

  assert.deepEqual(result.errors, []);
  assert.equal(result.cases[0].name, 'A & B < C "quoted" &amp; literal &quot;token&quot;');
  assert.equal(decodeXmlEntities('&amp;quot;'), '&quot;');
});

test('preserves absolute files and different long names for case identity', () => {
  const prefix = 'n'.repeat(480);
  const result = parseJUnit(`<testsuites>
    <testcase name="${prefix}a" classname="test" file="/home/toyofumi/projects/openmemory/apps/web/lib/long.test.ts"/>
    <testcase name="${prefix}b" classname="test" file="/home/toyofumi/projects/openmemory/apps/web/lib/long.test.ts"/>
  </testsuites>`);

  assert.deepEqual(result.errors, []);
  assert.equal(result.cases[0].file, '/home/toyofumi/projects/openmemory/apps/web/lib/long.test.ts');
  assert.equal(result.cases[0].name.slice(0, 480), result.cases[1].name.slice(0, 480));
  assert.notEqual(result.cases[0].name, result.cases[1].name);
});

test('malformed or truncated XML returns no partial cases and an error', () => {
  for (const xml of [
    '<testsuites><testcase name="partial"/></testsuites><testsuites/>',
    '<testsuites><testcase name="partial">',
    '<testsuites><testcase name="partial"></testsuites>',
    '<testsuites><testcase name="partial"',
    'not XML',
  ]) {
    assert.doesNotThrow(() => parseJUnit(xml));
    const result = parseJUnit(xml);
    assert.deepEqual(result.cases, [], xml);
    assert.ok(result.errors.length > 0, xml);
  }
});

test('the committed fixture parses as the Node 26 JUnit shape', () => {
  const fixture = readFileSync(FIXTURE_PATH, 'utf8');
  const result = parseJUnit(fixture);

  assert.deepEqual(result.errors, []);
  // The reporter emits one <testcase> per `test()`, not one per file: 25 here,
  // matching the `<!-- tests 25 -->` trailer the fixture also carries. A
  // file-level shape would mean per-case history could never be recorded.
  assert.equal(result.cases.length, 25);
  assert.equal(result.cases[0].suite, null);
  assert.equal(
    result.cases[0].name,
    'formatMoney renders whole units, matching the budget sheet for the same forecast',
  );
  assert.ok(result.cases[0].file?.endsWith('/apps/web/lib/budget-compare.test.ts'));
  assert.equal(result.cases[0].status, 'passed');
  assert.equal(result.cases[0].duration_ms, 9.99);
  assert.equal(result.cases[0].failure_message, null);
  assert.equal(result.cases[0].failure_detail, null);
  assert.ok(result.cases.every((c) => c.status === 'passed'));
});

test('the fixture stays in sync with the installed Node JUnit reporter format', () => {
  const directory = mkdtempSync(join(tmpdir(), 'openmemory-junit-'));
  const generatedPath = join(directory, 'budget-compare.junit.xml');

  try {
    const child = spawnSync(
      process.execPath,
      [
        '--test',
        '--test-reporter=junit',
        `--test-reporter-destination=${generatedPath}`,
        'lib/budget-compare.test.ts',
      ],
      { cwd: WEB_ROOT, encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: undefined } },
    );
    assert.equal(child.status, 0, child.stderr || child.stdout);

    const normalizeReporterEnvironment = (xml: string) =>
      xml
        .replace(/ file="[^"]*\/apps\/web\//gu, ' file="<repo>/apps/web/')
        .replace(/ time="[^"]*"/gu, ' time="<duration>"')
        .replace(/(<!-- duration_ms )[^ ]+( -->)/u, '$1<duration>$2');
    assert.equal(
      normalizeReporterEnvironment(readFileSync(generatedPath, 'utf8')),
      normalizeReporterEnvironment(readFileSync(FIXTURE_PATH, 'utf8')),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
