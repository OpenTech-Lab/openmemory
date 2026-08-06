// Merge-invariant tests for AI autofill: a user-supplied value must always
// survive a conflicting suggestion. Run with: node --test lib/autofill-merge.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeAutofillField, isNonEmptyArray } from './autofill-merge.ts';

test('touched field is never overwritten by a conflicting suggestion', () => {
  const result = mergeAutofillField(true, 'user typed this', 'llm suggested this');
  assert.equal(result, 'user typed this');
});

test('untouched field is filled from a present suggestion', () => {
  const result = mergeAutofillField(false, '', 'llm suggested this');
  assert.equal(result, 'llm suggested this');
});

test('untouched field keeps its current value when the suggestion is absent', () => {
  const result = mergeAutofillField(false, 'default', undefined);
  assert.equal(result, 'default');
});

test('untouched numeric field is filled when the suggestion is 0 (falsy but present)', () => {
  const result = mergeAutofillField(false, 0.5, 0, (v) => typeof v === 'number');
  assert.equal(result, 0);
});

test('touched numeric field survives even when the suggestion differs', () => {
  const result = mergeAutofillField(true, 0.9, 0.2, (v) => typeof v === 'number');
  assert.equal(result, 0.9);
});

test('isNonEmptyArray rejects empty arrays, non-arrays, and null/undefined', () => {
  assert.equal(isNonEmptyArray([]), false);
  assert.equal(isNonEmptyArray(undefined), false);
  assert.equal(isNonEmptyArray(null), false);
  assert.equal(isNonEmptyArray('not an array'), false);
});

test('isNonEmptyArray accepts a populated array', () => {
  assert.equal(isNonEmptyArray(['a', 'b']), true);
});
