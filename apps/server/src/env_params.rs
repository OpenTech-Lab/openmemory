//! Shared environment-parameter operations used by the HTTP and stdio servers.

use anyhow::{Context, Result};
use sqlx::PgPool;

use crate::crypto::{decrypt_value, encrypt_value};

/// Rename an environment parameter, optionally replacing its value or
/// metadata. When those optional updates are omitted, the encrypted value and
/// metadata are preserved. References held by the resource catalog are updated
/// as part of the same transaction so a rename cannot leave a resource
/// pointing at a stale key name.
pub async fn rename_env_param(
    db: &PgPool,
    encryption_key: &[u8; 32],
    old_key: &str,
    new_key: &str,
    value: Option<&str>,
    is_secret: Option<bool>,
    description: Option<Option<&str>>,
) -> Result<()> {
    let old_key = old_key.trim();
    let new_key = new_key.trim();

    if let Some(error) = rename_validation_error(
        old_key,
        new_key,
        value.is_some() || is_secret.is_some() || description.is_some(),
    ) {
        anyhow::bail!("{error}");
    }

    let mut tx = db.begin().await.context("failed to begin env rename")?;

    let old_exists: Option<(String,)> =
        sqlx::query_as("SELECT key FROM env_params WHERE key = $1 FOR UPDATE")
            .bind(old_key)
            .fetch_optional(&mut *tx)
            .await
            .context("failed to find environment parameter")?;

    if old_exists.is_none() {
        anyhow::bail!("environment parameter '{}' not found", old_key);
    }

    if old_key != new_key {
        let new_exists: Option<(String,)> =
            sqlx::query_as("SELECT key FROM env_params WHERE key = $1")
                .bind(new_key)
                .fetch_optional(&mut *tx)
                .await
                .context("failed to check environment parameter name")?;

        if new_exists.is_some() {
            anyhow::bail!("environment parameter '{}' already exists", new_key);
        }
    }

    let encrypted_value = value.map(|value| encrypt_value(encryption_key, value));
    let description_provided = description.is_some();
    let description_value = description.flatten();

    sqlx::query(
        "UPDATE env_params SET
            key = $2,
            value_encrypted = COALESCE($3, value_encrypted),
            is_secret = COALESCE($4, is_secret),
            description = CASE WHEN $5 THEN $6 ELSE description END,
            updated_at = NOW()
         WHERE key = $1",
    )
    .bind(old_key)
    .bind(new_key)
    .bind(encrypted_value)
    .bind(is_secret)
    .bind(description_provided)
    .bind(description_value)
    .execute(&mut *tx)
    .await
    .context("failed to rename environment parameter")?;

    if old_key != new_key {
        // Manual resources keep their credential/config links as an array of
        // key names. Keep those links valid after the parameter is renamed.
        sqlx::query(
            "UPDATE resources \
             SET env_param_keys = array_replace(env_param_keys, $1, $2), updated_at = NOW() \
             WHERE $1 = ANY(env_param_keys)",
        )
        .bind(old_key)
        .bind(new_key)
        .execute(&mut *tx)
        .await
        .context("failed to update resource parameter references")?;

        // RESOURCE_AUTH.<slug> stores the name of the credential parameter it
        // links to. These values are encrypted, so rewrite only the structured
        // references that actually point at the renamed key.
        let auth_rows: Vec<(String, Vec<u8>)> = sqlx::query_as(
            "SELECT key, value_encrypted FROM env_params WHERE key LIKE 'RESOURCE_AUTH.%' FOR UPDATE",
        )
        .fetch_all(&mut *tx)
        .await
        .context("failed to inspect resource auth references")?;

        for (auth_key, encrypted) in auth_rows {
            let value = decrypt_value(encryption_key, &encrypted).with_context(|| {
                format!("failed to decrypt resource auth parameter '{}'", auth_key)
            })?;
            if value == old_key {
                let replacement = encrypt_value(encryption_key, new_key);
                sqlx::query(
                    "UPDATE env_params SET value_encrypted = $2, updated_at = NOW() WHERE key = $1",
                )
                .bind(&auth_key)
                .bind(replacement)
                .execute(&mut *tx)
                .await
                .context("failed to update resource auth reference")?;
            }
        }
    }

    tx.commit().await.context("failed to commit env rename")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn rename_validation_rejects_empty_or_unchanged_keys() {
        assert!(super::rename_validation_error("", "NEW", false).is_some());
        assert!(super::rename_validation_error("OLD", "", false).is_some());
        assert!(super::rename_validation_error("SAME", "SAME", false).is_some());
        assert!(super::rename_validation_error("SAME", "SAME", true).is_none());
        assert!(super::rename_validation_error("OLD", "NEW", false).is_none());
    }
}

fn rename_validation_error(
    old_key: &str,
    new_key: &str,
    has_updates: bool,
) -> Option<&'static str> {
    let old_key = old_key.trim();
    let new_key = new_key.trim();
    if old_key.is_empty() {
        Some("old key must not be empty")
    } else if new_key.is_empty() {
        Some("new key must not be empty")
    } else if old_key == new_key && !has_updates {
        Some("new key must be different from the current key")
    } else {
        None
    }
}
