//! Azure Blob access for private Council screenshots.
//!
//! The account connection string stays in the signed-in user's server-side
//! secret store. Only short-lived, blob-scoped SAS URLs leave this module.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::{Duration, Utc};
use hmac::{Hmac, Mac};
use reqwest::Url;
use sha2::Sha256;
use std::time::Duration as StdDuration;

pub const SECRET: &str = "azure_storage_connection_string";
pub const BUCKET: &str = "azure:council-images";
const CONTAINER: &str = "council-images";
const VERSION: &str = "2023-11-03";

struct Credentials {
    account: String,
    key: Vec<u8>,
}

fn credentials() -> Result<Credentials, String> {
    let value = crate::secrets::read_api_key(SECRET)?;
    let field = |name: &str| {
        value.split(';').find_map(|part| part.trim().split_once('=').and_then(|(key, value)|
            (key.eq_ignore_ascii_case(name)).then(|| value.trim().to_string())))
    };
    let account = field("AccountName").ok_or("Azure connection string has no AccountName.")?;
    if account != "councilimages" {
        return Err("Azure connection string must belong to the councilimages account.".into());
    }
    let key = STANDARD.decode(field("AccountKey").ok_or("Azure connection string has no AccountKey.")?)
        .map_err(|_| "Azure connection string has an invalid AccountKey.")?;
    Ok(Credentials { account, key })
}

fn blob_url(account: &str, path: &str) -> Result<Url, String> {
    if path.is_empty() || path.split('/').any(|part| part.is_empty() || part == "." || part == "..") {
        return Err("Invalid Azure blob path.".into());
    }
    let mut url = Url::parse(&format!("https://{account}.blob.core.windows.net/"))
        .map_err(|_| "Invalid Azure account name.")?;
    {
        let mut segments = url.path_segments_mut().map_err(|_| "Invalid Azure blob URL.")?;
        segments.push(CONTAINER);
        for segment in path.split('/') { segments.push(segment); }
    }
    Ok(url)
}

fn signed_url_with(credentials: &Credentials, path: &str, permissions: &str, seconds: u32) -> Result<Url, String> {
    let mut url = blob_url(&credentials.account, path)?;
    let expiry = (Utc::now() + Duration::seconds(seconds.clamp(60, 7200) as i64))
        .format("%Y-%m-%dT%H:%M:%SZ").to_string();
    let resource = format!("/blob/{}/{CONTAINER}/{path}", credentials.account);
    // Azure Blob service SAS, version 2020-12-06+; empty optional fields are
    // significant and must stay in this exact order.
    let to_sign = [permissions, "", &expiry, &resource, "", "", "https", VERSION,
        "b", "", "", "", "", "", "", ""].join("\n");
    let mut mac = Hmac::<Sha256>::new_from_slice(&credentials.key)
        .map_err(|_| "Invalid Azure account key.")?;
    mac.update(to_sign.as_bytes());
    let signature = STANDARD.encode(mac.finalize().into_bytes());
    url.query_pairs_mut()
        .append_pair("sp", permissions).append_pair("se", &expiry)
        .append_pair("spr", "https").append_pair("sv", VERSION)
        .append_pair("sr", "b").append_pair("sig", &signature);
    Ok(url)
}

pub fn signed_read_url(path: &str, seconds: u32) -> Result<String, String> {
    Ok(signed_url_with(&credentials()?, path, "r", seconds)?.to_string())
}

pub async fn upload(path: &str, mime: &str, bytes: Vec<u8>) -> Result<(), String> {
    let url = signed_url_with(&credentials()?, path, "cw", 600)?;
    // Bound DNS/TLS/transport waits. A failed Azure route must report an error,
    // never leave the capture submission appearing idle for minutes.
    let client = reqwest::Client::builder()
        .connect_timeout(StdDuration::from_secs(5))
        .timeout(StdDuration::from_secs(20))
        .build()
        .map_err(|e| format!("Could not create Azure client: {e}"))?;
    let response = client.put(url)
        .header("x-ms-blob-type", "BlockBlob")
        .header("x-ms-version", VERSION)
        .header("Content-Type", mime)
        .body(bytes).send().await.map_err(|e| format!("Azure upload failed: {e}"))?;
    if response.status().is_success() { return Ok(()); }
    Err(format!("Azure upload failed ({}): {}", response.status(),
        response.text().await.unwrap_or_default().chars().take(300).collect::<String>()))
}

pub async fn remove(path: &str) -> Result<(), String> {
    let url = signed_url_with(&credentials()?, path, "d", 600)?;
    let response = reqwest::Client::new().delete(url)
        .header("x-ms-version", VERSION).send().await
        .map_err(|e| format!("Azure delete failed: {e}"))?;
    if response.status().is_success() || response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(());
    }
    Err(format!("Azure delete failed ({}).", response.status()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn signed_url_is_blob_scoped_and_read_only() {
        let creds = Credentials { account: "councilimages".into(), key: vec![7; 32] };
        let url = signed_url_with(&creds, "owner/job/0-shot.png", "r", 600).unwrap();
        assert_eq!(url.scheme(), "https");
        assert_eq!(url.path(), "/council-images/owner/job/0-shot.png");
        assert_eq!(url.query_pairs().find(|(key, _)| key == "sp").unwrap().1, "r");
        assert!(url.query_pairs().any(|(key, _)| key == "sig"));
    }
    #[test]
    fn rejects_path_traversal() {
        assert!(blob_url("councilimages", "owner/../other").is_err());
    }
}
