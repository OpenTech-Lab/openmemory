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

export const PLAN_KINDS = ['jest', 'playwright', 'maestro', 'other'] as const;

export const PLAN_KIND_COLORS: Record<string, string> = {
  jest: 'border-rose-400 text-rose-600 dark:text-rose-400',
  playwright: 'border-emerald-400 text-emerald-600 dark:text-emerald-400',
  maestro: 'border-violet-400 text-violet-600 dark:text-violet-400',
  other: CUSTOM_STATUS_COLOR,
};

// `kind` is a CHECK-constrained column server-side, but the frontend and
// backend can still drift during a rollout — fall back gracefully instead of
// crashing on an unrecognized value.
export function planKindColor(kind: string): string {
  return PLAN_KIND_COLORS[kind] ?? CUSTOM_STATUS_COLOR;
}

export const PLAN_KIND_LABELS: Record<string, string> = {
  jest: 'Jest',
  playwright: 'Playwright',
  maestro: 'Maestro',
  other: 'Other',
};

export function planKindLabel(kind: string): string {
  return PLAN_KIND_LABELS[kind] ?? kind;
}

export const RUN_KINDS = ['manual', 'unit', 'integration', 'api', 'e2e', 'load', 'other'] as const;

export const RUN_KIND_COLORS: Record<string, string> = {
  manual: 'border-slate-400 text-slate-600 dark:text-slate-400',
  unit: 'border-blue-400 text-blue-600 dark:text-blue-400',
  integration: 'border-cyan-400 text-cyan-600 dark:text-cyan-400',
  api: 'border-indigo-400 text-indigo-600 dark:text-indigo-400',
  e2e: 'border-emerald-400 text-emerald-600 dark:text-emerald-400',
  load: 'border-orange-400 text-orange-600 dark:text-orange-400',
  other: CUSTOM_STATUS_COLOR,
};

// `kind` is a CHECK-constrained column server-side, but the frontend and
// backend can still drift during a rollout — fall back gracefully instead of
// crashing on an unrecognized value.
export function runKindColor(kind: string): string {
  return RUN_KIND_COLORS[kind] ?? CUSTOM_STATUS_COLOR;
}

export const RUN_KIND_LABELS: Record<string, string> = {
  manual: 'Manual',
  unit: 'Unit',
  integration: 'Integration',
  api: 'API',
  e2e: 'E2E',
  load: 'Load',
  other: 'Other',
};

export function runKindLabel(kind: string): string {
  return RUN_KIND_LABELS[kind] ?? kind;
}

export const CASE_STATUSES = ['passed', 'failed', 'skipped', 'error'] as const;

export const CASE_STATUS_COLORS: Record<string, string> = {
  passed: 'border-green-400 text-green-600 dark:text-green-400',
  failed: 'border-red-400 text-red-600 dark:text-red-400',
  skipped: 'border-amber-400 text-amber-600 dark:text-amber-400',
  error: 'border-rose-500 text-rose-600 dark:text-rose-400',
};

// `status` is a CHECK-constrained column server-side, but the frontend and
// backend can still drift during a rollout — fall back gracefully instead of
// crashing on an unrecognized value.
export function caseStatusColor(status: string): string {
  return CASE_STATUS_COLORS[status] ?? CUSTOM_STATUS_COLOR;
}
