export const LESSON_CATEGORIES = ['correction', 'preference', 'pattern', 'gotcha'] as const;

export const LESSON_SEVERITIES = ['low', 'medium', 'high'] as const;

export const CATEGORY_COLORS: Record<string, string> = {
  correction: 'border-red-400 text-red-600 dark:text-red-400',
  preference: 'border-blue-400 text-blue-600 dark:text-blue-400',
  pattern: 'border-purple-400 text-purple-600 dark:text-purple-400',
  gotcha: 'border-yellow-400 text-yellow-600 dark:text-yellow-400',
};

export const SEVERITY_COLORS: Record<string, string> = {
  low: 'border-border text-muted-foreground',
  medium: 'border-yellow-400 text-yellow-600 dark:text-yellow-400',
  high: 'border-red-400 text-red-600 dark:text-red-400',
};

export const CUSTOM_META_COLOR = 'border-border text-muted-foreground';

// Both `category` and `severity` are unconstrained TEXT columns in the DB, so
// free-text values are possible — fall back gracefully instead of crashing.
export function categoryColor(category: string): string {
  return CATEGORY_COLORS[category] ?? CUSTOM_META_COLOR;
}

export function severityColor(severity: string): string {
  return SEVERITY_COLORS[severity] ?? CUSTOM_META_COLOR;
}

// The backend's `ORDER BY severity DESC` sorts the raw text column
// (`medium` > `low` > `high` alphabetically), which reads wrong to a human.
// The panel re-sorts client-side using this rank instead.
export const SEVERITY_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };

export function severityRank(severity: string): number {
  return SEVERITY_RANK[severity] ?? 0;
}
