export const BUILTIN_TASK_LABELS = ['bug', 'feature', 'chore', 'docs', 'question'] as const;

export const TASK_LABEL_COLORS: Record<string, string> = {
  bug: 'border-red-400 text-red-600 dark:text-red-400',
  feature: 'border-blue-400 text-blue-600 dark:text-blue-400',
  chore: 'border-border text-muted-foreground',
  docs: 'border-purple-400 text-purple-600 dark:text-purple-400',
  question: 'border-yellow-400 text-yellow-600 dark:text-yellow-400',
};

export const CUSTOM_LABEL_COLOR = 'border-border text-muted-foreground';

export function labelColor(label: string): string {
  return TASK_LABEL_COLORS[label] ?? CUSTOM_LABEL_COLOR;
}
