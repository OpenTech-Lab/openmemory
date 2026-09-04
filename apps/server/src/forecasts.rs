use anyhow::Context;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

pub const APPLICATION_TYPES: [&str; 7] = [
    "web_saas",
    "mobile",
    "ai",
    "data",
    "internal",
    "ecommerce",
    "other",
];
pub const STRESS_TOLERANCES: [&str; 3] = ["conservative", "balanced", "aggressive"];
pub const USAGE_PATTERNS: [&str; 3] = ["steady", "bursty", "seasonal"];

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct ForecastProfile {
    pub id: Uuid,
    pub name: String,
    pub description: Option<String>,
    pub application_type: String,
    pub user_count: i64,
    pub monthly_budget_usd: i64,
    pub stress_tolerance: String,
    pub usage_pattern: String,
    pub engagement_percent: i32,
    pub planning_horizon_months: i32,
    pub annual_growth_percent: i32,
    pub notes: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ForecastInput {
    pub name: String,
    pub description: Option<String>,
    pub application_type: String,
    pub user_count: i64,
    pub monthly_budget_usd: i64,
    pub stress_tolerance: String,
    pub usage_pattern: String,
    pub engagement_percent: i32,
    pub planning_horizon_months: i32,
    pub annual_growth_percent: i32,
    pub notes: Option<String>,
}

impl ForecastInput {
    pub fn validate(&self) -> Result<(), String> {
        if self.name.trim().is_empty() || self.name.chars().count() > 100 {
            return Err("name must be between 1 and 100 characters".into());
        }
        if !APPLICATION_TYPES.contains(&self.application_type.as_str()) {
            return Err("invalid application_type".into());
        }
        if !STRESS_TOLERANCES.contains(&self.stress_tolerance.as_str()) {
            return Err("invalid stress_tolerance".into());
        }
        if !USAGE_PATTERNS.contains(&self.usage_pattern.as_str()) {
            return Err("invalid usage_pattern".into());
        }
        if !(1..=100).contains(&self.engagement_percent) {
            return Err("engagement_percent must be between 1 and 100".into());
        }
        if !(1..=1_000_000_000).contains(&self.user_count) {
            return Err("user_count must be between 1 and 1,000,000,000".into());
        }
        if !(0..=1_000_000_000).contains(&self.monthly_budget_usd) {
            return Err("monthly_budget_usd must be between 0 and 1,000,000,000".into());
        }
        if !(1..=120).contains(&self.planning_horizon_months) {
            return Err("planning_horizon_months must be between 1 and 120".into());
        }
        if !(0..=1000).contains(&self.annual_growth_percent) {
            return Err("annual_growth_percent must be between 0 and 1000".into());
        }
        Ok(())
    }
}

pub async fn ensure_table(db: &PgPool) -> anyhow::Result<()> {
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS forecast_profiles (
            id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            name                    TEXT NOT NULL UNIQUE,
            description             TEXT,
            application_type        TEXT NOT NULL,
            user_count              BIGINT NOT NULL CHECK (user_count > 0),
            monthly_budget_usd      BIGINT NOT NULL CHECK (monthly_budget_usd >= 0),
            stress_tolerance        TEXT NOT NULL,
            usage_pattern           TEXT NOT NULL,
            engagement_percent      INTEGER NOT NULL DEFAULT 100,
            planning_horizon_months INTEGER NOT NULL,
            annual_growth_percent   INTEGER NOT NULL DEFAULT 0,
            notes                   TEXT,
            created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        "#,
    )
    .execute(db)
    .await
    .context("failed to create forecast_profiles table")?;
    sqlx::query("ALTER TABLE forecast_profiles ADD COLUMN IF NOT EXISTS engagement_percent INTEGER NOT NULL DEFAULT 100")
        .execute(db)
        .await
        .context("failed to add engagement_percent column")?;
    Ok(())
}

pub async fn list(db: &PgPool) -> anyhow::Result<Vec<ForecastProfile>> {
    sqlx::query_as::<_, ForecastProfile>(
        "SELECT * FROM forecast_profiles ORDER BY updated_at DESC, name ASC",
    )
    .fetch_all(db)
    .await
    .context("failed to list forecast profiles")
}

pub async fn get(db: &PgPool, id: Uuid) -> anyhow::Result<Option<ForecastProfile>> {
    sqlx::query_as::<_, ForecastProfile>("SELECT * FROM forecast_profiles WHERE id = $1")
        .bind(id)
        .fetch_optional(db)
        .await
        .context("failed to get forecast profile")
}

pub async fn create(db: &PgPool, input: &ForecastInput) -> anyhow::Result<ForecastProfile> {
    input.validate().map_err(anyhow::Error::msg)?;
    sqlx::query_as::<_, ForecastProfile>(
        r#"INSERT INTO forecast_profiles
           (name, description, application_type, user_count, monthly_budget_usd,
            stress_tolerance, usage_pattern, engagement_percent, planning_horizon_months, annual_growth_percent, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *"#,
    )
    .bind(input.name.trim())
    .bind(&input.description)
    .bind(&input.application_type)
    .bind(input.user_count)
    .bind(input.monthly_budget_usd)
    .bind(&input.stress_tolerance)
    .bind(&input.usage_pattern)
    .bind(input.engagement_percent)
    .bind(input.planning_horizon_months)
    .bind(input.annual_growth_percent)
    .bind(&input.notes)
    .fetch_one(db)
    .await
    .context("failed to create forecast profile")
}

pub async fn update(
    db: &PgPool,
    id: Uuid,
    input: &ForecastInput,
) -> anyhow::Result<Option<ForecastProfile>> {
    input.validate().map_err(anyhow::Error::msg)?;
    sqlx::query_as::<_, ForecastProfile>(
        r#"UPDATE forecast_profiles SET name=$1, description=$2, application_type=$3,
           user_count=$4, monthly_budget_usd=$5, stress_tolerance=$6, usage_pattern=$7,
           engagement_percent=$8, planning_horizon_months=$9, annual_growth_percent=$10, notes=$11, updated_at=NOW()
           WHERE id=$12 RETURNING *"#,
    )
    .bind(input.name.trim()).bind(&input.description).bind(&input.application_type)
    .bind(input.user_count).bind(input.monthly_budget_usd).bind(&input.stress_tolerance)
    .bind(&input.usage_pattern).bind(input.engagement_percent).bind(input.planning_horizon_months)
    .bind(input.annual_growth_percent).bind(&input.notes).bind(id)
    .fetch_optional(db).await.context("failed to update forecast profile")
}

pub fn design_context(profile: &ForecastProfile) -> String {
    format!(
        "Planning forecast: profile={}; application_type={}; users={}; monthly_budget_usd={}; \
         stress_tolerance={}; usage_pattern={}; engagement={}% of MAU active on a typical day; \
         horizon_months={}; annual_growth_percent={}%.{}",
        profile.name,
        profile.application_type,
        profile.user_count,
        profile.monthly_budget_usd,
        profile.stress_tolerance,
        profile.usage_pattern,
        profile.engagement_percent,
        profile.planning_horizon_months,
        profile.annual_growth_percent,
        profile
            .notes
            .as_deref()
            .map(|n| format!(" Additional constraints: {n}"))
            .unwrap_or_default()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_input() -> ForecastInput {
        ForecastInput {
            name: "Growth SaaS".into(),
            description: None,
            application_type: "web_saas".into(),
            user_count: 10_000,
            monthly_budget_usd: 2_000,
            stress_tolerance: "balanced".into(),
            usage_pattern: "bursty".into(),
            engagement_percent: 50,
            planning_horizon_months: 18,
            annual_growth_percent: 80,
            notes: None,
        }
    }

    #[test]
    fn validates_forecast_boundaries() {
        assert!(valid_input().validate().is_ok());
        let mut invalid = valid_input();
        invalid.user_count = 0;
        assert!(invalid.validate().unwrap_err().contains("user_count"));
    }

    #[test]
    fn validates_engagement_percent_boundaries() {
        let mut invalid = valid_input();
        invalid.engagement_percent = 0;
        assert!(invalid
            .validate()
            .unwrap_err()
            .contains("engagement_percent"));
        invalid.engagement_percent = 101;
        assert!(invalid
            .validate()
            .unwrap_err()
            .contains("engagement_percent"));
    }
}
