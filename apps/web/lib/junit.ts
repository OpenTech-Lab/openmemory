// Dependency-free JUnit XML parsing for plain Node. DOMParser is undefined under plain Node
// (verified on v26.1.0), so this follows drawio-graph.ts's hand-rolled XML micro-parser instead.
// JUnit is flatter than mxfile XML, but it still needs balanced-tag validation: a truncated report
// must never turn into a partially recorded run.

import { decodeXmlEntities, parseAttrs } from './drawio-graph.ts';

export type ParsedCaseStatus = 'passed' | 'failed' | 'skipped' | 'error';

export interface ParsedCase {
  suite: string | null;
  name: string;
  file: string | null;
  status: ParsedCaseStatus;
  duration_ms: number | null;
  failure_message: string | null;
  failure_detail: string | null;
}

interface Diagnostic {
  message: string | null;
  detail: string | null;
}

interface CaseBuilder {
  suite: string | null;
  name: string;
  file: string | null;
  duration_ms: number | null;
  skipped: boolean;
  failure: Diagnostic | null;
  error: Diagnostic | null;
}

interface ElementFrame {
  name: string;
  kind: 'element' | 'testcase' | 'failure' | 'error' | 'skipped';
  testcase?: CaseBuilder;
  diagnostic?: {
    testcase: CaseBuilder;
    text: string[];
  };
  attrs: Record<string, string>;
}

class JUnitParseError extends Error {}

const XML_NAME = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;
const XML_ATTR_NAME = /^[A-Za-z_][A-Za-z0-9_.:-]*/;
const ROOT_NAMES = new Set(['testsuites', 'testsuite']);

function fail(message: string): never {
  throw new JUnitParseError(message);
}

function findTagEnd(xml: string, start: number): number {
  let quote: string | null = null;
  for (let index = start + 1; index < xml.length; index += 1) {
    const character = xml[index];
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return index;
    }
  }
  return -1;
}

function skipWhitespace(value: string, index: number): number {
  while (index < value.length && /\s/u.test(value[index])) index += 1;
  return index;
}

/** Validate the attribute grammar before handing decoding to the shared draw.io helper. */
function parseTagAttributes(raw: string): Record<string, string> {
  let index = 0;
  const seen = new Set<string>();

  while (index < raw.length) {
    index = skipWhitespace(raw, index);
    if (index === raw.length) break;

    const nameMatch = XML_ATTR_NAME.exec(raw.slice(index));
    if (!nameMatch) fail('malformed XML attribute list');
    const name = nameMatch[0];
    if (seen.has(name)) fail(`duplicate XML attribute: ${name}`);
    seen.add(name);
    index += name.length;
    index = skipWhitespace(raw, index);
    if (raw[index] !== '=') fail(`XML attribute ${name} is missing '='`);
    index = skipWhitespace(raw, index + 1);

    const quote = raw[index];
    if (quote !== '"' && quote !== "'") fail(`XML attribute ${name} is not quoted`);
    index += 1;
    while (index < raw.length && raw[index] !== quote) index += 1;
    if (index === raw.length) fail(`XML attribute ${name} is unterminated`);
    index += 1;
  }

  // Keep decoding in the shared draw.io helper after validating the grammar.
  return parseAttrs(raw);
}

function parseOpenTag(xml: string, start: number, end: number): {
  name: string;
  attrs: Record<string, string>;
  selfClosing: boolean;
} {
  let raw = xml.slice(start + 1, end).trim();
  let selfClosing = false;
  if (raw.endsWith('/')) {
    selfClosing = true;
    raw = raw.slice(0, -1).trimEnd();
  }

  const nameMatch = /^([^\s/>]+)/u.exec(raw);
  if (!nameMatch || !XML_NAME.test(nameMatch[1])) fail('malformed XML opening tag');
  const name = nameMatch[1];
  const attrs = parseTagAttributes(raw.slice(name.length));
  return { name, attrs, selfClosing };
}

function parseCloseTag(xml: string, start: number, end: number): string {
  const raw = xml.slice(start + 2, end).trim();
  if (!XML_NAME.test(raw)) fail('malformed XML closing tag');
  return raw;
}

function findDeclarationEnd(xml: string, start: number): number {
  let quote: string | null = null;
  let subsetDepth = 0;
  for (let index = start + 2; index < xml.length; index += 1) {
    const character = xml[index];
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '[') {
      subsetDepth += 1;
    } else if (character === ']' && subsetDepth > 0) {
      subsetDepth -= 1;
    } else if (character === '>' && subsetDepth === 0) {
      return index;
    }
  }
  return -1;
}

function optionalText(value: string | undefined): string | null {
  if (value === undefined || value.trim() === '') return null;
  return value;
}

function parseDuration(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) fail(`invalid testcase time: ${value}`);
  return seconds * 1000;
}

function suitePath(stack: ElementFrame[]): string | null {
  const names = stack
    .filter((frame) => frame.name === 'testsuite')
    .map((frame) => optionalText(frame.attrs.name))
    .filter((name): name is string => name !== null);
  return names.length > 0 ? names.join('::') : null;
}

function nearestTestcase(stack: ElementFrame[]): CaseBuilder | null {
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    if (stack[index].kind === 'testcase') return stack[index].testcase ?? null;
  }
  return null;
}

function diagnosticFromFrame(frame: ElementFrame): Diagnostic {
  const detail = frame.diagnostic?.text.join('').trim() || null;
  return {
    message: optionalText(frame.attrs.message),
    detail,
  };
}

function finishCase(builder: CaseBuilder): ParsedCase {
  const diagnostic = builder.error ?? builder.failure;
  return {
    suite: builder.suite,
    name: builder.name,
    file: builder.file,
    status: builder.error ? 'error' : builder.failure ? 'failed' : builder.skipped ? 'skipped' : 'passed',
    duration_ms: builder.duration_ms,
    failure_message: diagnostic?.message ?? null,
    failure_detail: diagnostic?.detail ?? null,
  };
}

function addDiagnostic(builder: CaseBuilder, kind: 'failure' | 'error', diagnostic: Diagnostic): void {
  if (kind === 'error') {
    if (!builder.error) builder.error = diagnostic;
  } else if (!builder.failure) {
    builder.failure = diagnostic;
  }
}

function appendText(stack: ElementFrame[], text: string, cdata: boolean): void {
  const decoded = cdata ? text : decodeXmlEntities(text);
  for (const frame of stack) {
    if (frame.kind === 'failure' || frame.kind === 'error') {
      frame.diagnostic?.text.push(decoded);
    }
  }
}

function isValidCaseParent(stack: ElementFrame[]): boolean {
  const parent = stack[stack.length - 1]?.name;
  return parent === 'testsuites' || parent === 'testsuite';
}

function makeCaseBuilder(attrs: Record<string, string>, stack: ElementFrame[]): CaseBuilder {
  const name = attrs.name;
  if (name === undefined || name.trim() === '') fail('testcase is missing a name');

  const classname = attrs.classname === 'test' ? null : optionalText(attrs.classname);
  return {
    // Node's reporter uses classname="test" for every file. It is a constant, not a suite.
    suite: classname ?? suitePath(stack),
    name,
    file: optionalText(attrs.file),
    duration_ms: parseDuration(attrs.time),
    skipped: false,
    failure: null,
    error: null,
  };
}

export function parseJUnit(xml: string): { cases: ParsedCase[]; errors: string[] } {
  const cases: ParsedCase[] = [];
  const errors: string[] = [];

  try {
    if (typeof xml !== 'string' || xml.trim() === '') fail('JUnit XML is empty');

    const stack: ElementFrame[] = [];
    let rootSeen = false;
    let rootClosed = false;
    let cursor = 0;

    while (cursor < xml.length) {
      const textEnd = xml.indexOf('<', cursor);
      if (textEnd === cursor) {
        // Continue below with the markup at cursor.
      } else {
        const textEndOrEof = textEnd === -1 ? xml.length : textEnd;
        const text = xml.slice(cursor, textEndOrEof);
        if (stack.length === 0) {
          if (text.trim() !== '') fail('non-whitespace text outside the JUnit root');
        } else {
          appendText(stack, text, false);
        }
        cursor = textEndOrEof;
        if (cursor === xml.length) break;
      }

      if (xml.startsWith('<!--', cursor)) {
        const commentEnd = xml.indexOf('-->', cursor + 4);
        if (commentEnd === -1) fail('unterminated XML comment');
        cursor = commentEnd + 3;
        continue;
      }

      if (xml.startsWith('<![CDATA[', cursor)) {
        const cdataStart = cursor + '<![CDATA['.length;
        const cdataEnd = xml.indexOf(']]>', cdataStart);
        if (cdataEnd === -1) fail('unterminated XML CDATA section');
        if (stack.length === 0) fail('CDATA outside the JUnit root');
        appendText(stack, xml.slice(cdataStart, cdataEnd), true);
        cursor = cdataEnd + 3;
        continue;
      }

      if (xml.startsWith('<?', cursor)) {
        const instructionEnd = xml.indexOf('?>', cursor + 2);
        if (instructionEnd === -1) fail('unterminated XML processing instruction');
        cursor = instructionEnd + 2;
        continue;
      }

      if (xml.startsWith('<!', cursor)) {
        const declarationEnd = findDeclarationEnd(xml, cursor);
        if (declarationEnd === -1) fail('unterminated XML declaration');
        cursor = declarationEnd + 1;
        continue;
      }

      if (xml[cursor] !== '<') fail('malformed XML markup');
      const tagEnd = findTagEnd(xml, cursor);
      if (tagEnd === -1) fail('unterminated XML tag');

      if (xml.startsWith('</', cursor)) {
        const name = parseCloseTag(xml, cursor, tagEnd);
        const frame = stack.pop();
        if (!frame) fail(`unexpected closing tag: ${name}`);
        if (frame.name !== name) fail(`mismatched closing tag: expected </${frame.name}>`);

        if (frame.kind === 'failure' || frame.kind === 'error') {
          if (!frame.diagnostic) fail(`malformed <${frame.name}> element`);
          addDiagnostic(frame.diagnostic.testcase, frame.kind, diagnosticFromFrame(frame));
        } else if (frame.kind === 'testcase') {
          if (!frame.testcase) fail('malformed <testcase> element');
          cases.push(finishCase(frame.testcase));
        }
        cursor = tagEnd + 1;
        if (stack.length === 0) rootClosed = true;
        continue;
      }

      const { name, attrs, selfClosing } = parseOpenTag(xml, cursor, tagEnd);
      if (!rootSeen) {
        if (!ROOT_NAMES.has(name)) fail(`JUnit root must be <testsuites> or <testsuite>, got <${name}>`);
        rootSeen = true;
      } else if (rootClosed) {
        fail(`multiple XML roots; found <${name}> after the JUnit root`);
      }

      if (name === 'testcase') {
        if (!isValidCaseParent(stack)) fail('<testcase> must be inside <testsuites> or <testsuite>');
        if (nearestTestcase(stack)) fail('nested <testcase> elements are not valid JUnit');
        const testcase = makeCaseBuilder(attrs, stack);
        if (selfClosing) {
          cases.push(finishCase(testcase));
        } else {
          stack.push({ name, kind: 'testcase', testcase, attrs });
        }
      } else if (name === 'failure' || name === 'error') {
        const testcase = nearestTestcase(stack);
        if (!testcase) fail(`<${name}> must be inside <testcase>`);
        const frame: ElementFrame = {
          name,
          kind: name,
          attrs,
          diagnostic: { testcase, text: [] },
        };
        if (selfClosing) {
          addDiagnostic(testcase, name, diagnosticFromFrame(frame));
        } else {
          stack.push(frame);
        }
      } else if (name === 'skipped') {
        const testcase = nearestTestcase(stack);
        if (!testcase) fail('<skipped> must be inside <testcase>');
        testcase.skipped = true;
        if (!selfClosing) stack.push({ name, kind: 'skipped', attrs });
      } else {
        if (!selfClosing) stack.push({ name, kind: 'element', attrs });
      }

      if (selfClosing && stack.length === 0) rootClosed = true;
      cursor = tagEnd + 1;
    }

    if (!rootSeen) fail('JUnit XML has no root element');
    if (stack.length > 0) fail(`truncated XML: unclosed <${stack[stack.length - 1].name}>`);
    if (!rootClosed) fail('truncated XML: JUnit root is not closed');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(message || 'invalid JUnit XML');
  }

  return errors.length > 0 ? { cases: [], errors } : { cases, errors };
}
