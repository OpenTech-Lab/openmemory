export const QA_STATUSES = ['in_progress', 'passed', 'failed', 'blocked'] as const;

export type QaStatus = (typeof QA_STATUSES)[number];

export const STATUS_COLORS: Record<string, string> = {
  in_progress: 'border-blue-400 text-blue-600 dark:text-blue-400',
  passed: 'border-green-400 text-green-600 dark:text-green-400',
  failed: 'border-red-400 text-red-600 dark:text-red-400',
  blocked: 'border-amber-400 text-amber-600 dark:text-amber-400',
};

export const CUSTOM_STATUS_COLOR = 'border-border text-muted-foreground';

// `status` is a CHECK-constrained column server-side, but the frontend and
// backend can still drift during a rollout — fall back gracefully instead of
// crashing on an unrecognized value.
export function statusColor(status: string): string {
  return STATUS_COLORS[status] ?? CUSTOM_STATUS_COLOR;
}

export const STATUS_LABELS: Record<string, string> = {
  in_progress: 'In progress',
  passed: 'Passed',
  failed: 'Failed',
  blocked: 'Blocked',
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}
