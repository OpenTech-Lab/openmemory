use anyhow::Context;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

use crate::design_budgets::DesignBudgetForecast;

/// Revisions retained per design before the oldest unlabelled ones are pruned. A revision
/// carrying a user-set `label` (an explicit "Snapshot" milestone) is never pruned, even if
/// that leaves more than this many rows for the design.
const MAX_REVISIONS_PER_DESIGN: usize = 50;

/// A full revision snapshot, including the (potentially large) `source` document and its
/// budget snapshot. Fetched one at a time via `get`, never as a list — see
/// `DesignRevisionSummary` for the list projection.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct DesignRevision {
    pub id: Uuid,
    pub design_id: Uuid,
    pub revision_num: i32,
    pub title: String,
    pub kind: String,
    pub diagram_type: String,
    pub source: String,
    pub notes: Option<String>,
    pub label: Option<String>,
    pub source_sha: String,
    pub budgets: serde_json::Value,
    pub created_by: String,
    pub created_at: DateTime<Utc>,
}

/// Metadata-only projection for list views. Omits `source` and `budgets`, which can be
/// large, in favor of a cheap `budget_count`.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct DesignRevisionSummary {
    pub id: Uuid,
    pub revision_num: i32,
    pub title: String,
    pub label: Option<String>,
    pub diagram_type: String,
    pub source_sha: String,
    pub created_by: String,
    pub created_at: DateTime<Utc>,
    pub budget_count: i32,
}

/// Row shape used only to read a design's current state under `FOR UPDATE` at the top of
/// `cut`. Not `pub`: callers only ever see `DesignRevision`/`DesignRevisionSummary`.
#[derive(Debug, FromRow)]
struct DesignSnapshot {
    title: String,
    kind: String,
    diagram_type: String,
    source: String,
    notes: Option<String>,
}

/// What `cut` should do, decided without touching the database so the decision itself is
/// unit-testable. See `plan_cut`.
#[derive(Debug, Clone, PartialEq, Eq)]
enum CutDecision {
    /// Nothing worth recording.
    Skip,
    /// Insert a new revision with this number.
    Write { revision_num: i32 },
}

/// Pure decision logic for `cut`: whether a new revision is worth writing, and if so, what
/// number it gets. `latest` is the most recent existing revision's `(revision_num,
/// source_sha)` for this design, if any.
///
/// Pen designs are always skipped — their `source` is just the fixed
/// `design_blobs::PENCIL_SOURCE` marker, not real content, so a revision row would capture
/// nothing diffable. Otherwise, an implicit cut (`force_label: None`, ahead of a normal
/// save) is skipped when the content hash matches the newest revision, so autosave churn
/// doesn't pile up duplicate snapshots. An explicit "Snapshot" request (`force_label:
/// Some(_)`) always writes, even over identical content.
fn plan_cut(
    diagram_type: &str,
    source_sha: &str,
    latest: Option<(i32, &str)>,
    force_label: Option<&str>,
) -> CutDecision {
    if diagram_type == "pen" {
        return CutDecision::Skip;
    }
    match latest {
        Some((_, latest_sha)) if force_label.is_none() && latest_sha == source_sha => CutDecision::Skip,
        Some((num, _)) => CutDecision::Write { revision_num: num + 1 },
        None => CutDecision::Write { revision_num: 1 },
    }
}

/// Pure retention selection: given every existing revision's `(id, revision_num,
/// has_label)` for one design, returns the ids to delete so at most `keep` remain —
/// dropping the oldest by `revision_num` first — while never selecting a labelled
/// revision, even if that leaves more than `keep` rows standing.
fn revisions_to_prune(mut rows: Vec<(Uuid, i32, bool)>, keep: usize) -> Vec<Uuid> {
    rows.sort_by(|a, b| b.1.cmp(&a.1)); // revision_num descending: newest first
    rows.into_iter()
        .skip(keep)
        .filter(|(_, _, has_label)| !has_label)
        .map(|(id, _, _)| id)
        .collect()
}

pub async fn ensure_table(db: &PgPool) -> anyhow::Result<()> {
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS project_design_revisions (
            id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
            design_id     UUID        NOT NULL REFERENCES project_designs(id) ON DELETE CASCADE,
            revision_num  INTEGER     NOT NULL,
            title         TEXT        NOT NULL,
            kind          TEXT        NOT NULL,
            diagram_type  TEXT        NOT NULL,
            source        TEXT        NOT NULL,
            notes         TEXT,
            label         TEXT,
            source_sha    TEXT        NOT NULL,
            budgets       JSONB       NOT NULL DEFAULT '[]'::jsonb,
            created_by    TEXT        NOT NULL DEFAULT 'user',
            created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (design_id, revision_num)
        )
        "#,
    )
    .execute(db).await.context("failed to create project_design_revisions table")?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_project_design_revisions_design_id ON project_design_revisions(design_id)")
        .execute(db).await.ok();
    Ok(())
}

pub async fn list(db: &PgPool, design_id: Uuid) -> anyhow::Result<Vec<DesignRevisionSummary>> {
    sqlx::query_as::<_, DesignRevisionSummary>(
        r#"SELECT id, revision_num, title, label, diagram_type, source_sha, created_by,
                  created_at, jsonb_array_length(budgets) AS budget_count
           FROM project_design_revisions WHERE design_id = $1 ORDER BY revision_num DESC"#,
    ).bind(design_id).fetch_all(db).await.context("failed to list design revisions")
}

pub async fn get(db: &PgPool, design_id: Uuid, revision_num: i32) -> anyhow::Result<Option<DesignRevision>> {
    sqlx::query_as::<_, DesignRevision>(
        "SELECT * FROM project_design_revisions WHERE design_id = $1 AND revision_num = $2",
    ).bind(design_id).bind(revision_num).fetch_optional(db).await.context("failed to load design revision")
}

/// Snapshots a design's current state into `project_design_revisions` before it is
/// overwritten. Returns `Ok(None)` when there is nothing worth snapshotting — the design
/// does not exist, it's a pen design, or (for an implicit cut) the content is unchanged
/// since the last revision — see `plan_cut`.
///
/// `force_label`: `Some(_)` is an explicit "Snapshot" request — it always writes (bypassing
/// the dedup check) and stamps the new revision with that label. `None` is an implicit cut
/// ahead of a normal save.
///
/// Runs as one transaction: the design row is read with `FOR UPDATE` so a concurrent save
/// cannot interleave with this snapshot, and the retention prune that follows a successful
/// insert is part of the same commit.
pub async fn cut(db: &PgPool, design_id: Uuid, force_label: Option<&str>) -> anyhow::Result<Option<DesignRevision>> {
    let mut tx = db.begin().await.context("failed to begin design revision cut")?;

    let design = sqlx::query_as::<_, DesignSnapshot>(
        "SELECT title, kind, diagram_type, source, notes FROM project_designs WHERE id = $1 FOR UPDATE",
    )
    .bind(design_id)
    .fetch_optional(&mut *tx)
    .await
    .context("failed to load design for revision cut")?;
    let Some(design) = design else { return Ok(None) };

    let mut hasher = Sha256::new();
    hasher.update(design.source.as_bytes());
    let source_sha = format!("{:x}", hasher.finalize());

    let latest: Option<(i32, String)> = sqlx::query_as(
        "SELECT revision_num, source_sha FROM project_design_revisions \
         WHERE design_id = $1 ORDER BY revision_num DESC LIMIT 1",
    )
    .bind(design_id)
    .fetch_optional(&mut *tx)
    .await
    .context("failed to load latest design revision")?;

    let revision_num = match plan_cut(
        &design.diagram_type,
        &source_sha,
        latest.as_ref().map(|(num, sha)| (*num, sha.as_str())),
        force_label,
    ) {
        CutDecision::Skip => return Ok(None),
        CutDecision::Write { revision_num } => revision_num,
    };

    // Snapshot the design's current budgets alongside it, so "compare these two versions"
    // answers the architecture question and the cost question as one atomic unit.
    let budget_rows: Vec<DesignBudgetForecast> = sqlx::query_as(
        "SELECT * FROM design_budget_forecasts WHERE design_id = $1 ORDER BY updated_at DESC",
    )
    .bind(design_id)
    .fetch_all(&mut *tx)
    .await
    .context("failed to load budgets for revision cut")?;
    let budgets = serde_json::to_value(&budget_rows).context("failed to serialize revision budgets")?;

    let revision = sqlx::query_as::<_, DesignRevision>(
        r#"INSERT INTO project_design_revisions
           (design_id, revision_num, title, kind, diagram_type, source, notes, label, source_sha, budgets, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *"#,
    )
    .bind(design_id)
    .bind(revision_num)
    .bind(&design.title)
    .bind(&design.kind)
    .bind(&design.diagram_type)
    .bind(&design.source)
    .bind(&design.notes)
    .bind(force_label)
    .bind(&source_sha)
    .bind(budgets)
    .bind("user")
    .fetch_one(&mut *tx)
    .await
    .context("failed to insert design revision")?;

    let existing: Vec<(Uuid, i32, bool)> = sqlx::query_as(
        "SELECT id, revision_num, label IS NOT NULL FROM project_design_revisions WHERE design_id = $1",
    )
    .bind(design_id)
    .fetch_all(&mut *tx)
    .await
    .context("failed to load design revisions for retention")?;
    let prune_ids = revisions_to_prune(existing, MAX_REVISIONS_PER_DESIGN);
    if !prune_ids.is_empty() {
        sqlx::query("DELETE FROM project_design_revisions WHERE id = ANY($1)")
            .bind(&prune_ids)
            .execute(&mut *tx)
            .await
            .context("failed to prune old design revisions")?;
    }

    tx.commit().await.context("failed to commit design revision cut")?;
    Ok(Some(revision))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn revision_num_increments_from_latest() {
        let decision = plan_cut("mermaid", "new-hash", Some((3, "old-hash")), None);
        assert_eq!(decision, CutDecision::Write { revision_num: 4 });
    }

    #[test]
    fn revision_num_starts_at_one_when_no_prior_revision() {
        let decision = plan_cut("mermaid", "new-hash", None, None);
        assert_eq!(decision, CutDecision::Write { revision_num: 1 });
    }

    #[test]
    fn identical_hash_skips_implicit_cut() {
        let decision = plan_cut("mermaid", "same-hash", Some((5, "same-hash")), None);
        assert_eq!(decision, CutDecision::Skip);
    }

    #[test]
    fn explicit_label_forces_cut_over_identical_hash() {
        let decision = plan_cut("mermaid", "same-hash", Some((5, "same-hash")), Some("v1 milestone"));
        assert_eq!(decision, CutDecision::Write { revision_num: 6 });
    }

    #[test]
    fn pen_designs_are_always_skipped() {
        // Even with changed content and no prior revision — pen `source` is just the
        // opaque marker, never real content to diff.
        assert_eq!(plan_cut("pen", "any-hash", None, None), CutDecision::Skip);
        // And an explicit Snapshot request doesn't override the exclusion either.
        assert_eq!(plan_cut("pen", "any-hash", Some((1, "any-hash")), Some("label")), CutDecision::Skip);
    }

    #[test]
    fn retention_prunes_oldest_unlabelled_beyond_keep_count() {
        let rows = vec![
            (Uuid::new_v4(), 1, false),
            (Uuid::new_v4(), 2, false),
            (Uuid::new_v4(), 3, false),
        ];
        let oldest_id = rows[0].0;
        let pruned = revisions_to_prune(rows, 2);
        assert_eq!(pruned, vec![oldest_id]);
    }

    #[test]
    fn retention_never_prunes_labelled_revisions() {
        let labelled_old_id = Uuid::new_v4();
        let rows = vec![
            (labelled_old_id, 1, true),  // labelled, oldest — must survive
            (Uuid::new_v4(), 2, false),
            (Uuid::new_v4(), 3, false),
        ];
        // keep = 1 would normally prune revisions 1 and 2, but 1 is labelled.
        let pruned = revisions_to_prune(rows, 1);
        assert_eq!(pruned.len(), 1);
        assert!(!pruned.contains(&labelled_old_id));
    }
}
