use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::qa::QaPlanView;

/// A complete, immutable snapshot of a QA plan. The live `project_qa_plans` row
/// remains the editor's working copy; this table is what makes an old run
/// reproducible after that row changes.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct QaPlanRevision {
    pub id: Uuid,
    pub plan_id: Uuid,
    pub project_id: Uuid,
    pub revision_num: i32,
    pub name: String,
    pub kind: String,
    pub language: String,
    pub description: Option<String>,
    pub body: String,
    pub body_sha: String,
    pub label: Option<String>,
    pub created_by: String,
    pub created_at: DateTime<Utc>,
}

/// Metadata-only projection used by the plan picker and history sheet. The
/// source body is intentionally absent from list responses because scripts can
/// be large and callers usually need it only for the selected revision.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct QaPlanRevisionSummary {
    pub id: Uuid,
    pub plan_id: Uuid,
    pub project_id: Uuid,
    pub revision_num: i32,
    pub name: String,
    pub kind: String,
    pub language: String,
    pub description: Option<String>,
    pub body_sha: String,
    pub label: Option<String>,
    pub created_by: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, FromRow)]
struct PlanSnapshot {
    id: Uuid,
    project_id: Uuid,
    name: String,
    kind: String,
    language: String,
    description: Option<String>,
    body: String,
}

fn body_sha(body: &str) -> String {
    format!("{:x}", Sha256::digest(body.as_bytes()))
}

fn validate_label(label: Option<&str>) -> Result<()> {
    if let Some(label) = label {
        let trimmed = label.trim();
        if trimmed.is_empty() {
            anyhow::bail!("label must be between 1 and 100 characters");
        }
        if trimmed.chars().count() > 100 {
            anyhow::bail!("label must be between 1 and 100 characters");
        }
    }
    Ok(())
}

fn validate_created_by(created_by: &str) -> Result<()> {
    if !crate::qa::CREATED_BY_VALUES.contains(&created_by) {
        anyhow::bail!("created_by must be one of: agent, human");
    }
    Ok(())
}

fn same_snapshot(plan: &PlanSnapshot, revision: &QaPlanRevision, sha: &str) -> bool {
    revision.body_sha == sha
        && revision.name == plan.name
        && revision.kind == plan.kind
        && revision.language == plan.language
        && revision.description == plan.description
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum CutDecision {
    Skip,
    Write { revision_num: i32 },
}

/// Pure cut policy. The database still performs the actual allocation under
/// the parent-row lock below; this helper makes the no-op and monotonic rules
/// independently testable without requiring a database for every unit test.
fn plan_cut(latest_num: Option<i32>, unchanged: bool, label: Option<&str>) -> CutDecision {
    if label.is_none() && latest_num.is_some() && unchanged {
        return CutDecision::Skip;
    }
    CutDecision::Write {
        revision_num: latest_num.map_or(1, |number| number + 1),
    }
}

/// The parent plan row is the serialization point for cuts. Locking it also
/// covers the empty-history case, where there is no revision row available to
/// lock before two transactions try to allocate revision 1.
async fn cut_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    plan_id: Uuid,
    label: Option<&str>,
    created_by: &str,
) -> Result<Option<QaPlanRevision>> {
    let plan: Option<PlanSnapshot> = sqlx::query_as(
        "SELECT id, project_id, name, kind, language, description, body \
         FROM project_qa_plans WHERE id = $1 FOR UPDATE",
    )
    .bind(plan_id)
    .fetch_optional(&mut **tx)
    .await
    .context("failed to load QA plan for revision cut")?;
    let Some(plan) = plan else {
        return Ok(None);
    };

    let sha = body_sha(&plan.body);
    let latest: Option<QaPlanRevision> = sqlx::query_as(
        "SELECT * FROM project_qa_plan_revisions \
         WHERE plan_id = $1 ORDER BY revision_num DESC LIMIT 1",
    )
    .bind(plan_id)
    .fetch_optional(&mut **tx)
    .await
    .context("failed to load latest QA plan revision")?;

    // Explicitly labelled cuts are human milestones and remain meaningful even
    // when the body is unchanged. Automatic unlabelled cuts reuse an identical
    // latest snapshot, including its id and label, so an idle editor cannot
    // manufacture an endless stream of duplicate versions.
    if let Some(latest) = latest.as_ref() {
        if matches!(
            plan_cut(
                Some(latest.revision_num),
                same_snapshot(&plan, latest, &sha),
                label
            ),
            CutDecision::Skip
        ) {
            return Ok(Some(latest.clone()));
        }
    }

    // The nested `FOR UPDATE` locks the parent row in the same transaction as
    // this MAX+1 allocation. The parent was already read above for the
    // snapshot, but keeping the locking clause here makes the allocation's
    // serialization guarantee explicit and protects the no-revision case too.
    let revision_num: i32 = sqlx::query_scalar(
        r#"
        SELECT COALESCE(MAX(revision_num), 0) + 1
        FROM project_qa_plan_revisions
        WHERE plan_id = (
            SELECT id FROM project_qa_plans WHERE id = $1 FOR UPDATE
        )
        "#,
    )
    .bind(plan_id)
    .fetch_one(&mut **tx)
    .await
    .context("failed to allocate QA plan revision number")?;

    let revision: QaPlanRevision = sqlx::query_as(
        r#"
        INSERT INTO project_qa_plan_revisions
            (plan_id, project_id, revision_num, name, kind, language,
             description, body, body_sha, label, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING *
        "#,
    )
    .bind(plan.id)
    .bind(plan.project_id)
    .bind(revision_num)
    .bind(&plan.name)
    .bind(&plan.kind)
    .bind(&plan.language)
    .bind(&plan.description)
    .bind(&plan.body)
    .bind(&sha)
    .bind(label.map(str::trim))
    .bind(created_by)
    .fetch_one(&mut **tx)
    .await
    .context("failed to insert QA plan revision")?;

    Ok(Some(revision))
}

/// Create the revision table. There is no migration runner, so this must stay
/// safe to execute on every server and MCP startup.
pub async fn ensure_table(db: &PgPool) -> Result<()> {
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS project_qa_plan_revisions (
            id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            plan_id       UUID NOT NULL REFERENCES project_qa_plans(id) ON DELETE CASCADE,
            project_id    UUID NOT NULL REFERENCES project_graphs(id) ON DELETE CASCADE,
            revision_num  INTEGER NOT NULL,
            name          TEXT NOT NULL,
            kind          TEXT NOT NULL,
            language      TEXT NOT NULL,
            description   TEXT,
            body          TEXT NOT NULL,
            body_sha      TEXT NOT NULL,
            label         TEXT,
            created_by    TEXT NOT NULL DEFAULT 'agent' CHECK (created_by IN ('agent','human')),
            created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (plan_id, revision_num)
        )
        "#,
    )
    .execute(db)
    .await
    .context("failed to create project_qa_plan_revisions table")?;
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_project_qa_plan_revisions_plan_num \
         ON project_qa_plan_revisions(plan_id, revision_num DESC)",
    )
    .execute(db)
    .await
    .ok();
    Ok(())
}

pub async fn list(db: &PgPool, plan_id: Uuid) -> Result<Vec<QaPlanRevisionSummary>> {
    sqlx::query_as(
        r#"
        SELECT id, plan_id, project_id, revision_num, name, kind, language,
               description, body_sha, label, created_by, created_at
        FROM project_qa_plan_revisions
        WHERE plan_id = $1
        ORDER BY revision_num DESC
        "#,
    )
    .bind(plan_id)
    .fetch_all(db)
    .await
    .context("failed to list QA plan revisions")
}

pub async fn get(db: &PgPool, plan_id: Uuid, revision_num: i32) -> Result<Option<QaPlanRevision>> {
    sqlx::query_as(
        "SELECT * FROM project_qa_plan_revisions \
         WHERE plan_id = $1 AND revision_num = $2",
    )
    .bind(plan_id)
    .bind(revision_num)
    .fetch_optional(db)
    .await
    .context("failed to load QA plan revision")
}

/// Automatic cuts are attributed to agents by default. The HTTP UI uses
/// `cut_as` with `human` for its explicit labelled milestone, while MCP agents
/// can leave that provenance at the default.
pub async fn cut(
    db: &PgPool,
    plan_id: Uuid,
    label: Option<&str>,
) -> Result<Option<QaPlanRevision>> {
    cut_as(db, plan_id, label, "agent").await
}

pub async fn cut_as(
    db: &PgPool,
    plan_id: Uuid,
    label: Option<&str>,
    created_by: &str,
) -> Result<Option<QaPlanRevision>> {
    validate_label(label)?;
    validate_created_by(created_by)?;
    let mut tx = db
        .begin()
        .await
        .context("failed to begin QA plan revision cut")?;
    let revision = cut_in_tx(&mut tx, plan_id, label, created_by).await?;
    tx.commit()
        .await
        .context("failed to commit QA plan revision cut")?;
    Ok(revision)
}

/// Restore a frozen revision into the live row. The current live state is cut
/// in this same transaction first, so restoring can always be undone by
/// restoring the immediately-created pre-restore revision.
pub async fn restore(db: &PgPool, plan_id: Uuid, revision_num: i32) -> Result<Option<QaPlanView>> {
    restore_as(db, plan_id, revision_num, "agent").await
}

pub async fn restore_as(
    db: &PgPool,
    plan_id: Uuid,
    revision_num: i32,
    created_by: &str,
) -> Result<Option<QaPlanView>> {
    validate_created_by(created_by)?;
    let mut tx = db
        .begin()
        .await
        .context("failed to begin QA plan restore")?;

    let _previous = cut_in_tx(&mut tx, plan_id, None, created_by).await?;
    let revision: Option<QaPlanRevision> = sqlx::query_as(
        "SELECT * FROM project_qa_plan_revisions \
         WHERE plan_id = $1 AND revision_num = $2",
    )
    .bind(plan_id)
    .bind(revision_num)
    .fetch_optional(&mut *tx)
    .await
    .context("failed to load QA plan revision for restore")?;
    let Some(revision) = revision else {
        return Ok(None);
    };

    let restored: Option<QaPlanView> = sqlx::query_as(
        r#"
        UPDATE project_qa_plans SET
            name = $1,
            kind = $2,
            language = $3,
            description = $4,
            body = $5,
            updated_at = NOW()
        WHERE id = $6
        RETURNING *
        "#,
    )
    .bind(&revision.name)
    .bind(&revision.kind)
    .bind(&revision.language)
    .bind(&revision.description)
    .bind(&revision.body)
    .bind(plan_id)
    .fetch_optional(&mut *tx)
    .await
    .context("failed to restore QA plan revision")?;

    tx.commit()
        .await
        .context("failed to commit QA plan restore")?;
    Ok(restored)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(body: &str, description: Option<&str>) -> PlanSnapshot {
        PlanSnapshot {
            id: Uuid::new_v4(),
            project_id: Uuid::new_v4(),
            name: "Checkout smoke".to_string(),
            kind: "jest".to_string(),
            language: "typescript".to_string(),
            description: description.map(str::to_string),
            body: body.to_string(),
        }
    }

    fn revision(plan: &PlanSnapshot, revision_num: i32, body: &str) -> QaPlanRevision {
        QaPlanRevision {
            id: Uuid::new_v4(),
            plan_id: plan.id,
            project_id: plan.project_id,
            revision_num,
            name: plan.name.clone(),
            kind: plan.kind.clone(),
            language: plan.language.clone(),
            description: plan.description.clone(),
            body: body.to_string(),
            body_sha: body_sha(body),
            label: None,
            created_by: "agent".to_string(),
            created_at: Utc::now(),
        }
    }

    #[test]
    fn revision_numbers_are_monotonic_and_start_at_one() {
        assert_eq!(
            plan_cut(None, false, None),
            CutDecision::Write { revision_num: 1 }
        );
        assert_eq!(
            plan_cut(Some(4), false, None),
            CutDecision::Write { revision_num: 5 }
        );
    }

    #[test]
    fn identical_body_and_metadata_reuses_the_latest_revision() {
        let live = plan("test('home', () => {});", Some("home only"));
        let latest = revision(&live, 3, &live.body);
        assert!(same_snapshot(&live, &latest, &body_sha(&live.body)));
        assert_eq!(
            plan_cut(Some(latest.revision_num), true, None),
            CutDecision::Skip
        );
    }

    #[test]
    fn changed_metadata_does_not_reuse_an_identical_body() {
        let latest_plan = plan("test('home', () => {});", Some("home only"));
        let mut live = latest_plan.clone();
        live.description = Some("home and about".to_string());
        let latest = revision(&latest_plan, 3, &latest_plan.body);
        assert!(!same_snapshot(&live, &latest, &body_sha(&live.body)));
        assert_eq!(
            plan_cut(Some(latest.revision_num), false, None),
            CutDecision::Write { revision_num: 4 }
        );
    }

    #[test]
    fn explicit_label_is_allowed_to_create_a_human_milestone_over_same_state() {
        let live = plan("body", None);
        let latest = revision(&live, 3, &live.body);
        assert!(same_snapshot(&live, &latest, &body_sha(&live.body)));
        assert_eq!(
            plan_cut(Some(latest.revision_num), true, Some("milestone")),
            CutDecision::Write { revision_num: 4 }
        );
    }

    async fn test_pool() -> PgPool {
        let database_url = std::env::var("DATABASE_URL").unwrap_or_else(|_| {
            "postgres://openmemory:openmemory@localhost:5432/openmemory".to_string()
        });
        sqlx::postgres::PgPoolOptions::new()
            .max_connections(8)
            .connect(&database_url)
            .await
            .expect("DATABASE_URL must point to a PostgreSQL database")
    }

    async fn test_plan(db: &PgPool, body: &str) -> (Uuid, Uuid) {
        crate::qa::ensure_qa_tables(db).await.unwrap();
        ensure_table(db).await.unwrap();
        let project_id = Uuid::new_v4();
        let plan_id = Uuid::new_v4();
        let path = format!("/tmp/openmemory-qa-revision-{project_id}");
        sqlx::query(
            "INSERT INTO project_graphs (id, name, path, canonical_path) VALUES ($1, $2, $3, $3)",
        )
        .bind(project_id)
        .bind("QA revision test project")
        .bind(path)
        .execute(db)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO project_qa_plans (id, project_id, name, kind, language, body) \
             VALUES ($1, $2, 'Checkout smoke', 'jest', 'typescript', $3)",
        )
        .bind(plan_id)
        .bind(project_id)
        .bind(body)
        .execute(db)
        .await
        .unwrap();
        (project_id, plan_id)
    }

    async fn cleanup_test_plan(db: &PgPool, project_id: Uuid) {
        sqlx::query("DELETE FROM project_graphs WHERE id = $1")
            .bind(project_id)
            .execute(db)
            .await
            .unwrap();
    }

    #[tokio::test]
    #[ignore = "requires a PostgreSQL test database; run explicitly with --ignored"]
    async fn identical_cuts_create_one_row_and_return_the_existing_revision() {
        let db = test_pool().await;
        let (project_id, plan_id) = test_plan(&db, "home").await;
        let first = cut_as(&db, plan_id, None, "agent").await.unwrap().unwrap();
        let second = cut_as(&db, plan_id, None, "agent").await.unwrap().unwrap();
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM project_qa_plan_revisions WHERE plan_id = $1")
                .bind(plan_id)
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(first.id, second.id);
        assert_eq!(count, 1);
        cleanup_test_plan(&db, project_id).await;
    }

    #[tokio::test]
    #[ignore = "requires a PostgreSQL test database; run explicitly with --ignored"]
    async fn concurrent_labelled_cuts_serialize_allocation_without_unique_collisions() {
        let db = test_pool().await;
        let (project_id, plan_id) = test_plan(&db, "home").await;
        let left_db = db.clone();
        let right_db = db.clone();
        let left =
            tokio::spawn(async move { cut_as(&left_db, plan_id, Some("left"), "human").await });
        let right =
            tokio::spawn(async move { cut_as(&right_db, plan_id, Some("right"), "human").await });
        let left = left.await.unwrap().unwrap().unwrap();
        let right = right.await.unwrap().unwrap().unwrap();
        let mut numbers = [left.revision_num, right.revision_num];
        numbers.sort_unstable();
        assert_eq!(numbers, [1, 2]);
        cleanup_test_plan(&db, project_id).await;
    }

    #[tokio::test]
    #[ignore = "requires a PostgreSQL test database; run explicitly with --ignored"]
    async fn restore_cuts_the_previous_state_before_replacing_the_live_plan() {
        let db = test_pool().await;
        let (project_id, plan_id) = test_plan(&db, "home").await;
        let first = cut_as(&db, plan_id, Some("v1 home only"), "human")
            .await
            .unwrap()
            .unwrap();
        sqlx::query("UPDATE project_qa_plans SET body = 'home and about' WHERE id = $1")
            .bind(plan_id)
            .execute(&db)
            .await
            .unwrap();

        let restored = restore_as(&db, plan_id, first.revision_num, "human")
            .await
            .unwrap()
            .unwrap();
        let live_body: String =
            sqlx::query_scalar("SELECT body FROM project_qa_plans WHERE id = $1")
                .bind(plan_id)
                .fetch_one(&db)
                .await
                .unwrap();
        let previous = get(&db, plan_id, 2).await.unwrap().unwrap();
        assert_eq!(restored.body, "home");
        assert_eq!(live_body, "home");
        assert_eq!(previous.body, "home and about");
        cleanup_test_plan(&db, project_id).await;
    }
}
