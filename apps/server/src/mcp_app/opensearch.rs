use super::*;

pub(super) struct OpenSearchClient {
    client: HttpClient,
    base_url: String,
    index: String,
}

impl OpenSearchClient {
    pub(super) fn new(base_url: &str) -> Self {
        Self {
            client: HttpClient::new(),
            base_url: base_url.trim_end_matches('/').to_string(),
            index: "memories".to_string(),
        }
    }

    pub(super) async fn create_index(&self) -> Result<()> {
        let url = format!("{}/{}", self.base_url, self.index);

        let resp = self.client.head(&url).send().await;
        if resp.is_ok() && resp.unwrap().status().is_success() {
            return Ok(());
        }

        let mapping = json!({
            "settings": {
                "number_of_shards": 1,
                "number_of_replicas": 0
            },
            "mappings": {
                "properties": {
                    "id": { "type": "keyword" },
                    "user_id": { "type": "keyword" },
                    "content": { "type": "text", "analyzer": "standard" },
                    "summary": { "type": "text" },
                    "importance_score": { "type": "float" },
                    "tags": { "type": "keyword" },
                    "created_at": { "type": "date" },
                    "updated_at": { "type": "date" }
                }
            }
        });

        let resp = self.client.put(&url).json(&mapping).send().await?;
        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            warn!("OpenSearch index creation: {}", body);
        }

        Ok(())
    }

    pub(super) async fn index_document(&self, doc: &MemoryDocument) -> Result<()> {
        let url = format!("{}/{}/_doc/{}", self.base_url, self.index, doc.id);

        let resp = self.client.put(&url).json(doc).send().await?;
        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            anyhow::bail!("Failed to index document: {}", body);
        }

        Ok(())
    }

    pub(super) async fn search(&self, query: &str, limit: usize) -> Result<Vec<MemoryDocument>> {
        let url = format!("{}/{}/_search", self.base_url, self.index);

        let search_body = json!({
            "size": limit,
            "query": {
                "multi_match": {
                    "query": query,
                    "fields": ["content^2", "summary", "tags"],
                    "fuzziness": "AUTO"
                }
            },
            "_source": true
        });

        let resp = self.client.post(&url).json(&search_body).send().await?;
        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            anyhow::bail!("Search failed: {}", body);
        }

        let result: serde_json::Value = resp.json().await?;
        let hits = result["hits"]["hits"].as_array();

        let docs: Vec<MemoryDocument> = hits
            .map(|arr| {
                arr.iter()
                    .filter_map(|hit| serde_json::from_value(hit["_source"].clone()).ok())
                    .collect()
            })
            .unwrap_or_default();

        Ok(docs)
    }

    pub(super) async fn get_by_ids(&self, ids: &[String]) -> Result<Vec<MemoryDocument>> {
        if ids.is_empty() {
            return Ok(vec![]);
        }
        let url = format!("{}/{}/_search", self.base_url, self.index);
        let search_body = json!({
            "size": ids.len(),
            "query": { "ids": { "values": ids } },
            "_source": true
        });

        let resp = self.client.post(&url).json(&search_body).send().await?;
        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            anyhow::bail!("get_by_ids failed: {}", body);
        }

        let result: serde_json::Value = resp.json().await?;
        let hits = result["hits"]["hits"].as_array();
        let docs: Vec<MemoryDocument> = hits
            .map(|arr| {
                arr.iter()
                    .filter_map(|hit| serde_json::from_value(hit["_source"].clone()).ok())
                    .collect()
            })
            .unwrap_or_default();

        Ok(docs)
    }
}
