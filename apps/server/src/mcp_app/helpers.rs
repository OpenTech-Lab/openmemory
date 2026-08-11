use super::*;

/// Trim/lowercase/dedupe lesson tags — mirrors main.rs's normalize_labels for the REST path.
pub(super) fn normalize_lesson_tags(tags: &[String]) -> Vec<String> {
    let mut out: Vec<String> = tags
        .iter()
        .map(|t| t.trim().to_lowercase())
        .filter(|t| !t.is_empty())
        .collect();
    out.sort();
    out.dedup();
    out
}

pub(super) fn is_routine_due_mcp(
    frequency: &str,
    last_task_date: Option<chrono::NaiveDate>,
) -> bool {
    use chrono::{Datelike, Utc};
    let today = Utc::now().date_naive();
    let Some(last) = last_task_date else {
        return true;
    };
    match frequency {
        "daily" => last < today,
        "weekly" => (today - last).num_days() >= 7,
        "monthly" => {
            let first =
                chrono::NaiveDate::from_ymd_opt(today.year(), today.month(), 1).unwrap_or(today);
            last < first
        }
        "yearly" => {
            let first = chrono::NaiveDate::from_ymd_opt(today.year(), 1, 1).unwrap_or(today);
            last < first
        }
        cron_expr => {
            use std::str::FromStr;
            let full = format!("0 {} *", cron_expr);
            match cron::Schedule::from_str(&full) {
                Ok(schedule) => {
                    let last_dt = last.and_time(chrono::NaiveTime::MIN).and_utc();
                    schedule
                        .after(&last_dt)
                        .next()
                        .map(|n| n <= Utc::now())
                        .unwrap_or(false)
                }
                Err(_) => false,
            }
        }
    }
}
pub(super) fn format_facts(facts: &[falkordb::FactResult], label: &str) -> String {
    if facts.is_empty() {
        return format!("No facts found for {}.", label);
    }
    let mut text = format!("Found {} fact(s) for {}:\n\n", facts.len(), label);
    for (i, f) in facts.iter().enumerate() {
        let status = if f.is_current { "current" } else { "expired" };
        text.push_str(&format!(
            "{}. [{}] {} -[{}]-> {}\n   Fact: {}\n   Valid: {}{}\n\n",
            i + 1,
            status,
            f.subject_name,
            f.relationship,
            f.object_name,
            f.fact,
            f.valid_at,
            f.invalid_at
                .as_deref()
                .map(|t| format!(" → {}", t))
                .unwrap_or_default(),
        ));
    }
    text
}

/// Render a memory_search result set as a mermaid `graph TD` block: result memories
/// as nodes, RELATED_TO/LINKED_TO edges between them, plus any related entities/facts.
pub(super) fn build_mermaid(
    results: &[SearchResult],
    edges: &[(Uuid, Uuid, String)],
    facts: &[falkordb::FactResult],
) -> String {
    let mut out = String::from("graph TD\n");
    for r in results {
        let node_id = format!("M_{}", &r.id.simple().to_string()[..8]);
        let label = r.summary.clone().unwrap_or_else(|| r.content.clone());
        out.push_str(&format!("  {node_id}[\"{}\"]\n", mermaid_escape(&label)));
    }
    for (a, b, rel) in edges {
        let a_id = format!("M_{}", &a.simple().to_string()[..8]);
        let b_id = format!("M_{}", &b.simple().to_string()[..8]);
        out.push_str(&format!("  {a_id} ---|{}| {b_id}\n", mermaid_escape(rel)));
    }
    let mut seen_entities = std::collections::HashSet::new();
    for f in facts {
        let a_id = format!("E_{}", mermaid_id(&f.subject_name));
        let b_id = format!("E_{}", mermaid_id(&f.object_name));
        if seen_entities.insert(f.subject_name.clone()) {
            out.push_str(&format!(
                "  {a_id}[\"{}\"]\n",
                mermaid_escape(&f.subject_name)
            ));
        }
        if seen_entities.insert(f.object_name.clone()) {
            out.push_str(&format!(
                "  {b_id}[\"{}\"]\n",
                mermaid_escape(&f.object_name)
            ));
        }
        out.push_str(&format!(
            "  {a_id} -->|{}| {b_id}\n",
            mermaid_escape(&f.relationship)
        ));
    }
    out
}

pub(super) fn mermaid_escape(s: &str) -> String {
    s.chars()
        .take(60)
        .collect::<String>()
        .replace('"', "'")
        .replace(['[', ']', '{', '}', '|', '\n'], " ")
}

pub(super) fn mermaid_id(name: &str) -> String {
    let id: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '_' })
        .collect();
    if id.is_empty() {
        "unknown".to_string()
    } else {
        id
    }
}

/// Tags shared by more than this fraction of all memories are excluded from
/// RELATED_TO auto-linking — see `frequent_tags` doc comment.
pub(super) const AUTO_LINK_TAG_MAX_FRACTION: f64 = 0.02;

/// Tags present on more than `min_fraction` of all memories — excluded from the
/// RELATED_TO auto-linking predicate since they're boilerplate/administrative
/// (e.g. "session"/"watcher" injected on every auto-captured memory), not a
/// meaningful relatedness signal. Without this, a handful of near-universal tags
/// turn the whole graph into a supernode (millions of edges, unqueryable).
/// `candidate_tags = Some(...)` scopes the check to just those tags (cheap, used
/// on the hot memory_save path); `None` scans all distinct tags (used by the
/// bulk rebuild, which needs the full picture).
/// Walks the ancestor chain starting at `new_parent_id` to check whether making it the
/// parent of `task_id` would introduce a cycle (including `new_parent_id == task_id`).
pub(super) async fn would_create_cycle(
    db: &PgPool,
    task_id: Uuid,
    new_parent_id: Uuid,
) -> Result<bool, sqlx::Error> {
    let mut current = new_parent_id;
    loop {
        if current == task_id {
            return Ok(true);
        }
        let parent: Option<Uuid> =
            sqlx::query_scalar("SELECT parent_id FROM project_tasks WHERE id = $1")
                .bind(current)
                .fetch_optional(db)
                .await?
                .flatten();
        match parent {
            Some(next) => current = next,
            None => return Ok(false),
        }
    }
}

pub(super) async fn frequent_tags(
    db: &PgPool,
    candidate_tags: Option<&[String]>,
    min_fraction: f64,
) -> Vec<String> {
    let rows: Vec<(String,)> = match candidate_tags {
        Some(tags) if !tags.is_empty() => sqlx::query_as(
            "WITH total AS (SELECT count(*)::float8 AS n FROM memory_index), \
             freq AS (SELECT tag, count(*) AS c FROM (SELECT unnest(tags) AS tag FROM memory_index) t \
                      WHERE tag = ANY($1) GROUP BY tag) \
             SELECT freq.tag FROM freq, total WHERE freq.c > total.n * $2"
        )
        .bind(tags)
        .bind(min_fraction)
        .fetch_all(db)
        .await
        .unwrap_or_default(),
        Some(_) => vec![],
        None => sqlx::query_as(
            "WITH total AS (SELECT count(*)::float8 AS n FROM memory_index), \
             freq AS (SELECT tag, count(*) AS c FROM (SELECT unnest(tags) AS tag FROM memory_index) t GROUP BY tag) \
             SELECT freq.tag FROM freq, total WHERE freq.c > total.n * $1"
        )
        .bind(min_fraction)
        .fetch_all(db)
        .await
        .unwrap_or_default(),
    };
    rows.into_iter().map(|(t,)| t).collect()
}

/// Truncated, single-line preview of memory content — used as a graph-node label
/// fallback when no explicit summary was set (e.g. watcher-captured memories).
pub(super) fn content_preview(content: &str) -> String {
    let flat: String = content.split_whitespace().collect::<Vec<_>>().join(" ");
    let truncated: String = flat.chars().take(100).collect();
    if flat.chars().count() > 100 {
        format!("{truncated}…")
    } else {
        truncated
    }
}

pub(super) fn compute_combined_score(importance: f32, created_at: DateTime<Utc>) -> f32 {
    let recency = recency_score(created_at);
    (importance * 0.6) + (recency * 0.4)
}

pub(super) fn recency_score(created_at: DateTime<Utc>) -> f32 {
    let age = Utc::now().signed_duration_since(created_at);
    let age_days = age.num_seconds().max(0) as f32 / (60.0 * 60.0 * 24.0);
    (-age_days / 30.0).exp().clamp(0.0, 1.0)
}
