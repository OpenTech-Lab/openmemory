// Mirrors apps/server/src/design_budgets.rs's BudgetLineItem / DesignBudgetForecast. Shared
// between design-budget-sheet.tsx (the editor UI) and budget-diff.ts (the pure diff engine) so
// both sides of a comparison speak the same wire shape.
export interface BudgetLineItem {
  service: string;
  usage: string;
  monthly_cost_cents: number;
  notes?: string | null;
}

export interface DesignBudgetForecast {
  id: string;
  design_id: string;
  forecast_profile_id: string | null;
  name: string;
  conditions: string | null;
  currency: string;
  monthly_total_cents: number;
  line_items: BudgetLineItem[];
  confidence: 'low' | 'medium' | 'high';
  pricing_basis: string | null;
  created_by: 'human' | 'agent';
  updated_at: string;
}
