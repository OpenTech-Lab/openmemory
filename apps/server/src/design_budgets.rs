use anyhow::Context;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

const MAX_LINE_ITEMS: usize = 50;
const VALID_CONFIDENCE: [&str; 3] = ["low", "medium", "high"];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BudgetLineItem {
    pub service: String,
    pub usage: String,
    pub monthly_cost_cents: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct DesignBudgetForecast {
    pub id: Uuid,
    pub design_id: Uuid,
    pub forecast_profile_id: Option<Uuid>,
    pub name: String,
    pub conditions: Option<String>,
    pub currency: String,
    pub monthly_total_cents: i64,
    pub line_items: serde_json::Value,
    pub confidence: String,
    pub pricing_basis: Option<String>,
    pub created_by: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BudgetInput {
    pub name: String,
    #[serde(default)]
    pub forecast_profile_id: Option<Uuid>,
    #[serde(default)]
    pub conditions: Option<String>,
    #[serde(default = "default_currency")]
    pub currency: String,
    pub line_items: Vec<BudgetLineItem>,
    #[serde(default = "default_confidence")]
    pub confidence: String,
    #[serde(default)]
    pub pricing_basis: Option<String>,
    #[serde(default)]
    pub created_by: Option<String>,
}

fn default_currency() -> String { "USD".to_string() }
fn default_confidence() -> String { "low".to_string() }

impl BudgetInput {
    pub fn validate(&self) -> Result<(), String> {
        if self.name.trim().is_empty() || self.name.chars().count() > 100 {
            return Err("name must be between 1 and 100 characters".into());
        }
        if self.currency.len() != 3 || !self.currency.chars().all(|c| c.is_ascii_uppercase()) {
            return Err("currency must be a three-letter uppercase code".into());
        }
        if !VALID_CONFIDENCE.contains(&self.confidence.as_str()) {
            return Err("confidence must be low, medium, or high".into());
        }
        if self.line_items.is_empty() || self.line_items.len() > MAX_LINE_ITEMS {
            return Err(format!("line_items must contain between 1 and {MAX_LINE_ITEMS} entries"));
        }
        for item in &self.line_items {
            if item.service.trim().is_empty() || item.service.chars().count() > 120 {
                return Err("each line item must have a service name under 120 characters".into());
            }
            if item.usage.chars().count() > 300 {
                return Err("line item usage must be under 300 characters".into());
            }
            if !(0..=100_000_000_000).contains(&item.monthly_cost_cents) {
                return Err("line item monthly cost is out of range".into());
            }
        }
        Ok(())
    }

    pub fn monthly_total_cents(&self) -> i64 {
        self.line_items.iter().map(|item| item.monthly_cost_cents).sum()
    }
}

pub async fn ensure_table(db: &PgPool) -> anyhow::Result<()> {
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS design_budget_forecasts (
            id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            design_id             UUID NOT NULL REFERENCES project_designs(id) ON DELETE CASCADE,
            forecast_profile_id   UUID REFERENCES forecast_profiles(id) ON DELETE SET NULL,
            name                  TEXT NOT NULL,
            conditions            TEXT,
            currency              TEXT NOT NULL DEFAULT 'USD' CHECK (char_length(currency) = 3),
            monthly_total_cents   BIGINT NOT NULL CHECK (monthly_total_cents >= 0),
            line_items            JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(line_items) = 'array'),
            confidence            TEXT NOT NULL DEFAULT 'low' CHECK (confidence IN ('low','medium','high')),
            pricing_basis         TEXT,
            created_by            TEXT NOT NULL DEFAULT 'human' CHECK (created_by IN ('human','agent')),
            created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        "#,
    )
    .execute(db).await.context("failed to create design_budget_forecasts table")?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_design_budget_forecasts_design_id ON design_budget_forecasts(design_id)")
        .execute(db).await.ok();
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_design_budget_forecasts_profile_id ON design_budget_forecasts(forecast_profile_id)")
        .execute(db).await.ok();
    Ok(())
}

pub async fn list(db: &PgPool, design_id: Uuid) -> anyhow::Result<Vec<DesignBudgetForecast>> {
    sqlx::query_as::<_, DesignBudgetForecast>(
        "SELECT * FROM design_budget_forecasts WHERE design_id = $1 ORDER BY updated_at DESC",
    ).bind(design_id).fetch_all(db).await.context("failed to list design budget forecasts")
}

pub async fn create(db: &PgPool, design_id: Uuid, input: &BudgetInput) -> anyhow::Result<DesignBudgetForecast> {
    input.validate().map_err(anyhow::Error::msg)?;
    let line_items = serde_json::to_value(&input.line_items)?;
    sqlx::query_as::<_, DesignBudgetForecast>(
        r#"INSERT INTO design_budget_forecasts
           (design_id, forecast_profile_id, name, conditions, currency, monthly_total_cents,
            line_items, confidence, pricing_basis, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *"#,
    )
    .bind(design_id).bind(input.forecast_profile_id).bind(input.name.trim())
    .bind(&input.conditions).bind(&input.currency).bind(input.monthly_total_cents())
    .bind(line_items).bind(&input.confidence).bind(&input.pricing_basis)
    .bind(input.created_by.as_deref().unwrap_or("human"))
    .fetch_one(db).await.context("failed to create design budget forecast")
}

pub async fn update(db: &PgPool, design_id: Uuid, id: Uuid, input: &BudgetInput) -> anyhow::Result<Option<DesignBudgetForecast>> {
    input.validate().map_err(anyhow::Error::msg)?;
    let line_items = serde_json::to_value(&input.line_items)?;
    sqlx::query_as::<_, DesignBudgetForecast>(
        r#"UPDATE design_budget_forecasts SET forecast_profile_id=$1, name=$2, conditions=$3,
           currency=$4, monthly_total_cents=$5, line_items=$6, confidence=$7,
           pricing_basis=$8, updated_at=NOW() WHERE id=$9 AND design_id=$10 RETURNING *"#,
    )
    .bind(input.forecast_profile_id).bind(input.name.trim()).bind(&input.conditions)
    .bind(&input.currency).bind(input.monthly_total_cents()).bind(line_items)
    .bind(&input.confidence).bind(&input.pricing_basis).bind(id).bind(design_id)
    .fetch_optional(db).await.context("failed to update design budget forecast")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn total_is_derived_from_line_items() {
        let input = BudgetInput { name: "Base".into(), forecast_profile_id: None, conditions: None,
            currency: "USD".into(), line_items: vec![
                BudgetLineItem { service: "Lambda".into(), usage: "requests".into(), monthly_cost_cents: 1250, notes: None },
                BudgetLineItem { service: "RDS".into(), usage: "instance".into(), monthly_cost_cents: 8000, notes: None },
            ], confidence: "low".into(), pricing_basis: None, created_by: None };
        assert!(input.validate().is_ok());
        assert_eq!(input.monthly_total_cents(), 9250);
    }
}
