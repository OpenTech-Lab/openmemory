//! Integration test for orphaned blob cleanup on design delete.
//! Requires the full stack running: docker compose --profile api up -d
//! Run with: cargo test design_blob_cleanup -- --test-threads=1 --ignored

#[cfg(test)]
mod design_blob_cleanup {
    const BASE: &str = "http://localhost:18080";

    fn api_token() -> String {
        std::env::var("OPENMEMORY_API_TOKEN")
            .expect("set OPENMEMORY_API_TOKEN to run design blob cleanup integration tests")
    }

    fn blob_dir() -> std::path::PathBuf {
        std::env::var("OPENMEMORY_DESIGN_BLOB_DIR")
            .unwrap_or_else(|_| "/data/design-blobs".to_string())
            .into()
    }

    async fn create_project(client: &reqwest::Client, token: &str) -> String {
        let resp = client
            .post(format!("{BASE}/projects"))
            .header("authorization", format!("Bearer {token}"))
            .json(&serde_json::json!({
                "name": "blob-cleanup-test",
                "path": "/tmp/blob-cleanup-test"
            }))
            .send()
            .await
            .expect("create project failed");
        assert!(resp.status().is_success(), "project create should succeed");
        resp.json::<serde_json::Value>().await.unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string()
    }

    #[tokio::test]
    #[ignore]
    async fn deleting_a_design_removes_its_blob_file() {
        let token = api_token();
        let client = reqwest::Client::new();

        let project_id = create_project(&client, &token).await;

        let create_resp = client
            .post(format!("{BASE}/projects/{project_id}/designs"))
            .header("authorization", format!("Bearer {token}"))
            .json(&serde_json::json!({
                "title": "orphan check",
                "kind": "architecture",
                "diagram_type": "pen"
            }))
            .send()
            .await
            .expect("create design failed");
        assert!(create_resp.status().is_success());
        let design_id = create_resp.json::<serde_json::Value>().await.unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string();

        let put_resp = client
            .put(format!("{BASE}/projects/{project_id}/designs/{design_id}/blob"))
            .header("authorization", format!("Bearer {token}"))
            .body(vec![0u8; 16])
            .send()
            .await
            .expect("put blob failed");
        assert!(put_resp.status().is_success(), "blob write should succeed");

        let blob_path = blob_dir().join(format!("{design_id}.fig"));
        assert!(blob_path.exists(), "blob file should exist right after PUT");

        let delete_resp = client
            .delete(format!("{BASE}/projects/{project_id}/designs/{design_id}"))
            .header("authorization", format!("Bearer {token}"))
            .send()
            .await
            .expect("delete design failed");
        assert!(delete_resp.status().is_success(), "design delete should succeed");

        assert!(
            !blob_path.exists(),
            "blob file must be removed after design delete, found orphan at {blob_path:?}"
        );
    }
}
