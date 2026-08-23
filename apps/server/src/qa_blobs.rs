use axum::{
    body::Bytes,
    extract::{Path as AxumPath, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    Json,
};
use tracing::error;
use uuid::Uuid;

use crate::qa::{self, MAX_QA_BLOB_BYTES};
use crate::{is_authenticated, AppState};

/// Confirms the evidence exists and belongs to this project — walking
/// `evidence → run → project` in one query — before any file touch, so blob
/// URLs cannot be used to probe or write across projects. Mirrors
/// `design_blobs::design_exists`.
async fn evidence_belongs_to_project(state: &AppState, project_id: Uuid, evidence_id: Uuid) -> Result<bool, sqlx::Error> {
    let row: Option<(Uuid,)> = sqlx::query_as(
        "SELECT e.id FROM project_qa_evidence e \
         JOIN project_qa_runs r ON r.id = e.run_id \
         WHERE e.id = $1 AND r.project_id = $2",
    )
    .bind(evidence_id)
    .bind(project_id)
    .fetch_optional(&state.db)
    .await?;
    Ok(row.is_some())
}

pub async fn get_qa_evidence_blob(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath((project_id, evidence_id)): AxumPath<(Uuid, Uuid)>,
) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }

    match evidence_belongs_to_project(&state, project_id, evidence_id).await {
        Ok(false) => {
            return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "evidence not found"}))).into_response()
        }
        Err(e) => {
            error!("get_qa_evidence_blob lookup error: {e}");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response();
        }
        Ok(true) => {}
    }

    let content_type = match qa::get_evidence(&state.db, evidence_id).await {
        Ok(Some(evidence)) => evidence.mime_type.unwrap_or_else(|| "application/octet-stream".to_string()),
        Ok(None) => {
            return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "evidence not found"}))).into_response()
        }
        Err(e) => {
            error!("get_qa_evidence_blob mime lookup error: {e}");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response();
        }
    };

    match tokio::fs::read(qa::blob_path(&qa::blob_root(), evidence_id)).await {
        Ok(bytes) => (StatusCode::OK, [(axum::http::header::CONTENT_TYPE, content_type)], bytes).into_response(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "blob not found"}))).into_response()
        }
        Err(e) => {
            error!("get_qa_evidence_blob read error: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response()
        }
    }
}

pub async fn put_qa_evidence_blob(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath((project_id, evidence_id)): AxumPath<(Uuid, Uuid)>,
    body: Bytes,
) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }

    if body.len() > MAX_QA_BLOB_BYTES {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(serde_json::json!({
                "error": format!("evidence image exceeds {} MB limit", MAX_QA_BLOB_BYTES / (1024 * 1024))
            })),
        )
        .into_response();
    }

    match evidence_belongs_to_project(&state, project_id, evidence_id).await {
        Ok(false) => {
            return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "evidence not found"}))).into_response()
        }
        Err(e) => {
            error!("put_qa_evidence_blob lookup error: {e}");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response();
        }
        Ok(true) => {}
    }

    let Some(mime_type) = qa::sniff_image_mime(&body) else {
        return (
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            Json(serde_json::json!({"error": "evidence image must be png, jpeg, or webp"})),
        )
            .into_response();
    };

    let root = qa::blob_root();
    if let Err(e) = tokio::fs::create_dir_all(&root).await {
        error!("put_qa_evidence_blob mkdir error: {e}");
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response();
    }

    // Write to a temp file then rename, so a failed or partial write can never leave a
    // corrupt image where a previously good one was. The temp filename includes a
    // fresh request-scoped UUID so two concurrent PUTs for the same evidence_id never
    // share a path — sharing one would let their writes interleave and let the
    // eventual rename land a corrupted, mixed-content file.
    let final_path = qa::blob_path(&root, evidence_id);
    let temp_path = qa::temp_blob_path(&root, evidence_id);
    if let Err(e) = tokio::fs::write(&temp_path, &body).await {
        error!("put_qa_evidence_blob write error: {e}");
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response();
    }
    if let Err(e) = tokio::fs::rename(&temp_path, &final_path).await {
        error!("put_qa_evidence_blob rename error: {e}");
        // Best-effort cleanup so a rename failure doesn't orphan the temp file.
        let _ = tokio::fs::remove_file(&temp_path).await;
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response();
    }

    let update = sqlx::query("UPDATE project_qa_evidence SET mime_type = $1, byte_size = $2 WHERE id = $3")
        .bind(mime_type)
        .bind(body.len() as i64)
        .bind(evidence_id)
        .execute(&state.db)
        .await;
    if let Err(e) = update {
        error!("put_qa_evidence_blob row update error: {e}");
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response();
    }

    (StatusCode::OK, Json(serde_json::json!({"ok": true, "mime_type": mime_type, "byte_size": body.len()}))).into_response()
}
