use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Key, Nonce,
};
use chrono::{DateTime, Utc};
use hkdf::Hkdf;
use rand::{rngs::OsRng, RngCore};
use serde::Serialize;
use sha2::Sha256;
use sqlx::FromRow;
use uuid::Uuid;

/// Metadata-only row returned by env.list (never includes the encrypted value).
#[derive(Debug, Serialize, FromRow)]
pub struct EnvParamRow {
    pub id: Uuid,
    pub key: String,
    pub is_secret: bool,
    pub description: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Derive a 32-byte AES key from the application secret using HKDF-SHA256.
/// The fixed info string provides domain separation between uses of the same secret.
pub fn derive_key(secret: &str) -> [u8; 32] {
    let hk = Hkdf::<Sha256>::new(None, secret.as_bytes());
    let mut key = [0u8; 32];
    hk.expand(b"openmemory-env-params-v1", &mut key)
        .expect("32 bytes is a valid HKDF output length");
    key
}

/// Encrypt plaintext with AES-256-GCM. Returns `nonce (12 bytes) || ciphertext`.
pub fn encrypt_value(key: &[u8; 32], plaintext: &str) -> Vec<u8> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let mut nonce_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .expect("aes-gcm encryption failure");
    let mut out = nonce_bytes.to_vec();
    out.extend(ciphertext);
    out
}

/// Decrypt a blob produced by `encrypt_value`. Expects `nonce (12 bytes) || ciphertext`.
pub fn decrypt_value(key: &[u8; 32], data: &[u8]) -> anyhow::Result<String> {
    if data.len() < 12 {
        anyhow::bail!("encrypted data too short");
    }
    let (nonce_bytes, ciphertext) = data.split_at(12);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let nonce = Nonce::from_slice(nonce_bytes);
    let plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|_| anyhow::anyhow!("decryption failed"))?;
    String::from_utf8(plaintext)
        .map_err(|e| anyhow::anyhow!("invalid UTF-8 in decrypted value: {e}"))
}

/// Compute a short, non-reversible fingerprint of a plaintext value, salted with a
/// per-run random value so digests are not brute-forceable offline and are only
/// comparable within a single run (used by `rotate-secret-key` to prove a rewrap
/// preserved the plaintext without ever printing it).
pub fn fingerprint(run_salt: &[u8; 32], plaintext: &str) -> String {
    use sha2::Digest;
    let mut hasher = Sha256::new();
    hasher.update(run_salt);
    hasher.update(plaintext.as_bytes());
    let digest = hasher.finalize();
    digest.iter().take(6).map(|b| format!("{b:02x}")).collect()
}
