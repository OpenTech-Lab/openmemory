use std::path::{Path, PathBuf};

use axum::{
    body::Bytes,
    extract::{Path as AxumPath, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    Json,
};
use tracing::error;
use uuid::Uuid;

use crate::{is_authenticated, AppState};

/// Upper bound on a single design document. Real `.fig` files reach ~82 MB.
pub const MAX_DESIGN_BLOB_BYTES: usize = 128 * 1024 * 1024;

/// Directory holding `.fig` documents, overridable for tests and local runs.
pub fn blob_root() -> PathBuf {
    std::env::var("OPENMEMORY_DESIGN_BLOB_DIR")
        .unwrap_or_else(|_| "/data/design-blobs".to_string())
        .into()
}

/// A `Uuid` renders only as hex and dashes, so the filename can never contain a
/// path separator or `..` — traversal is structurally impossible rather than filtered.
pub fn blob_path(root: &Path, design_id: Uuid) -> PathBuf {
    root.join(format!("{design_id}.fig"))
}

/// Confirms the design exists and belongs to this project before any file touch,
/// so blob URLs cannot be used to probe or write across projects.
async fn design_exists(state: &AppState, project_id: Uuid, design_id: Uuid) -> Result<bool, sqlx::Error> {
    let row: Option<(Uuid,)> =
        sqlx::query_as("SELECT id FROM project_designs WHERE id = $1 AND project_id = $2")
            .bind(design_id)
            .bind(project_id)
            .fetch_optional(&state.db)
            .await?;
    Ok(row.is_some())
}

pub async fn get_design_blob(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath((project_id, design_id)): AxumPath<(Uuid, Uuid)>,
) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }

    match design_exists(&state, project_id, design_id).await {
        Ok(false) => {
            return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "design not found"}))).into_response()
        }
        Err(e) => {
            error!("get_design_blob lookup error: {e}");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response();
        }
        Ok(true) => {}
    }

    match tokio::fs::read(blob_path(&blob_root(), design_id)).await {
        Ok(bytes) => (
            StatusCode::OK,
            [(axum::http::header::CONTENT_TYPE, "application/octet-stream")],
            bytes,
        )
            .into_response(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "blob not found"}))).into_response()
        }
        Err(e) => {
            error!("get_design_blob read error: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response()
        }
    }
}

pub async fn put_design_blob(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath((project_id, design_id)): AxumPath<(Uuid, Uuid)>,
    body: Bytes,
) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }

    if body.len() > MAX_DESIGN_BLOB_BYTES {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(serde_json::json!({
                "error": format!("design exceeds {} MB limit", MAX_DESIGN_BLOB_BYTES / (1024 * 1024))
            })),
        )
            .into_response();
    }

    match design_exists(&state, project_id, design_id).await {
        Ok(false) => {
            return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "design not found"}))).into_response()
        }
        Err(e) => {
            error!("put_design_blob lookup error: {e}");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response();
        }
        Ok(true) => {}
    }

    let root = blob_root();
    if let Err(e) = tokio::fs::create_dir_all(&root).await {
        error!("put_design_blob mkdir error: {e}");
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response();
    }

    // Write to a temp file then rename, so a failed or partial write can never leave a
    // corrupt document where a previously good one was.
    let final_path = blob_path(&root, design_id);
    let temp_path = root.join(format!("{design_id}.fig.tmp"));
    if let Err(e) = tokio::fs::write(&temp_path, &body).await {
        error!("put_design_blob write error: {e}");
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response();
    }
    if let Err(e) = tokio::fs::rename(&temp_path, &final_path).await {
        error!("put_design_blob rename error: {e}");
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response();
    }

    (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn blob_path_uses_design_id_as_filename() {
        let id = Uuid::parse_str("11111111-2222-3333-4444-555555555555").unwrap();
        let path = blob_path(std::path::Path::new("/data/design-blobs"), id);
        assert_eq!(
            path,
            std::path::PathBuf::from(
                "/data/design-blobs/11111111-2222-3333-4444-555555555555.fig"
            )
        );
    }

    #[test]
    fn blob_path_cannot_escape_root() {
        // A Uuid can only render as hex + dashes, so traversal is structurally
        // impossible. This test documents and locks that guarantee.
        let id = Uuid::new_v4();
        let root = std::path::Path::new("/data/design-blobs");
        let path = blob_path(root, id);
        assert!(path.starts_with(root));
        assert!(!path.to_string_lossy().contains(".."));
    }
}
