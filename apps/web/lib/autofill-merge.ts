/**
 * Merge invariant for AI autofill: a field the user has already touched
 * (typed into, edited, or otherwise set by hand) is never overwritten by a
 * suggestion — regardless of what the suggestion contains. Shared by the
 * memory Add dialog, the resource Add dialog, and the task create dialogs.
 */
export function mergeAutofillField<T>(
  touched: boolean,
  current: T,
  suggested: T | null | undefined,
  isPresent: (v: T | null | undefined) => boolean = (v) => v !== null && v !== undefined && v !== ('' as unknown as T)
): T {
  if (touched) return current;
  if (!isPresent(suggested)) return current;
  return suggested as T;
}

/**
 * Presence check for a suggested tags/labels array: only fill if non-empty.
 *
 * Overloaded so a typed suggestion field (`string[] | undefined`) is narrowed
 * to `string[]` in the true branch — without it, callers merging into a
 * non-optional form field have to assert. The `unknown` overload keeps the
 * predicate usable on untyped/arbitrary values.
 */
export function isNonEmptyArray<T>(v: T[] | null | undefined): v is T[];
export function isNonEmptyArray(v: unknown): boolean;
export function isNonEmptyArray(v: unknown): boolean {
  return Array.isArray(v) && v.length > 0;
}
