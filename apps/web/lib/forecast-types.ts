export type ApplicationType = 'web_saas' | 'mobile' | 'ai' | 'data' | 'internal' | 'ecommerce' | 'other';
export type StressTolerance = 'conservative' | 'balanced' | 'aggressive';
export type UsagePattern = 'steady' | 'bursty' | 'seasonal';

export interface ForecastProfile {
  id: string;
  name: string;
  description: string | null;
  application_type: ApplicationType;
  user_count: number;
  monthly_budget_usd: number;
  stress_tolerance: StressTolerance;
  usage_pattern: UsagePattern;
  engagement_percent: number;
  planning_horizon_months: number;
  annual_growth_percent: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export type ForecastDraft = Omit<ForecastProfile, 'id' | 'created_at' | 'updated_at'>;

export const APPLICATION_LABELS: Record<ApplicationType, string> = {
  web_saas: 'Web / SaaS', mobile: 'Mobile app', ai: 'AI product', data: 'Data platform',
  internal: 'Internal tool', ecommerce: 'E-commerce', other: 'Other',
};

// Short label + plain-language hint for each traffic shape, since the bare
// enum values ("bursty", "seasonal") read as jargon in the UI.
export const USAGE_PATTERN_LABELS: Record<UsagePattern, { label: string; hint: string }> = {
  steady: { label: 'Steady', hint: 'Consistent traffic day to day' },
  bursty: { label: 'Bursty', hint: 'Spiky, peak-driven traffic' },
  seasonal: { label: 'Seasonal', hint: 'Varies by time of year' },
};

export const EMPTY_FORECAST: ForecastDraft = {
  name: '', description: null, application_type: 'web_saas', user_count: 1000,
  monthly_budget_usd: 500, stress_tolerance: 'balanced', usage_pattern: 'steady',
  engagement_percent: 100, planning_horizon_months: 12, annual_growth_percent: 50, notes: null,
};
