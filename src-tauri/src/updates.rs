use serde::{Deserialize, Serialize};

const RELEASE_API: &str = "https://api.github.com/repos/4cyberlord/code-auditor/releases/latest";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    pub current_version: String,
    pub latest_version: Option<String>,
    pub update_available: bool,
    pub release_url: Option<String>,
    pub download_url: Option<String>,
    pub published_at: Option<String>,
    pub notes: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    html_url: String,
    body: Option<String>,
    published_at: Option<String>,
    assets: Vec<GithubAsset>,
}

#[derive(Debug, Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
}

#[tauri::command]
pub async fn update_check() -> Result<UpdateCheck, String> {
    let current = env!("CARGO_PKG_VERSION").to_string();
    let release = reqwest::Client::builder()
        .user_agent(crate::deployment::USER_AGENT)
        .build()
        .map_err(|e| e.to_string())?
        .get(RELEASE_API)
        .header("accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("Could not reach GitHub Releases: {e}"))?;

    if release.status() == reqwest::StatusCode::NOT_FOUND {
        return Err("No published GitHub release was found for this app yet.".into());
    }
    if release.status() == reqwest::StatusCode::FORBIDDEN {
        return Err(
            "GitHub refused the update check, likely because the rate limit was reached.".into(),
        );
    }
    if !release.status().is_success() {
        return Err(format!(
            "GitHub Releases answered with {}.",
            release.status()
        ));
    }

    let latest: GithubRelease = release
        .json()
        .await
        .map_err(|e| format!("GitHub returned a release this app could not read: {e}"))?;
    let latest_version = normalize_version(&latest.tag_name);
    let update_available = version_gt(&latest_version, &current);

    Ok(UpdateCheck {
        current_version: current,
        latest_version: Some(latest_version),
        update_available,
        release_url: Some(latest.html_url),
        download_url: best_macos_asset(&latest.assets),
        published_at: latest.published_at,
        notes: latest.body,
    })
}

fn best_macos_asset(assets: &[GithubAsset]) -> Option<String> {
    // Never recommend an ARM build to an Intel Mac (or vice versa).
    let arch = std::env::consts::ARCH;
    let matching_arch = |name: &str| {
        let arm = name.contains("arm64") || name.contains("aarch64") || name.contains("apple_silicon");
        let intel = name.contains("x86_64") || name.contains("x64") || name.contains("intel");
        match arch {
            "aarch64" => !intel,
            "x86_64" => !arm,
            _ => !arm && !intel,
        }
    };
    assets.iter()
        .filter(|asset| {
            let name = asset.name.to_ascii_lowercase();
            (name.ends_with(".dmg") || name.ends_with(".pkg"))
                && matching_arch(&name)
        })
        .max_by_key(|asset| {
            let name = asset.name.to_ascii_lowercase();
            let explicit_mac = name.contains("mac") || name.contains("darwin");
            let explicit_arch = match arch {
                "aarch64" => name.contains("arm64") || name.contains("aarch64") || name.contains("apple_silicon"),
                "x86_64" => name.contains("x86_64") || name.contains("x64") || name.contains("intel"),
                _ => false,
            };
            (explicit_mac, explicit_arch, name.ends_with(".pkg"))
        })
        .map(|asset| asset.browser_download_url.clone())
}

fn normalize_version(raw: &str) -> String {
    raw.trim()
        .trim_start_matches('v')
        .trim_start_matches('V')
        .to_string()
}

fn version_gt(candidate: &str, current: &str) -> bool {
    let candidate_parts = version_parts(candidate);
    let current_parts = version_parts(current);
    candidate_parts > current_parts
}

fn version_parts(version: &str) -> Vec<u64> {
    version
        .split(['.', '-'])
        .take(3)
        .map(|part| {
            part.chars()
                .take_while(|ch| ch.is_ascii_digit())
                .collect::<String>()
                .parse::<u64>()
                .unwrap_or(0)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{best_macos_asset, normalize_version, version_gt, GithubAsset};

    #[test]
    fn strips_a_leading_v() {
        assert_eq!(normalize_version("v0.2.1"), "0.2.1");
    }

    #[test]
    fn compares_release_versions() {
        assert!(version_gt("0.2.1", "0.2.0"));
        assert!(!version_gt("0.2.0", "0.2.0"));
        assert!(!version_gt("0.1.9", "0.2.0"));
    }

    #[test]
    fn does_not_offer_incompatible_architecture() {
        let assets = vec![GithubAsset {
            name: if cfg!(target_arch = "aarch64") {
                "Council-Editor-macos-x86_64.dmg".into()
            } else {
                "Council-Editor-macos-arm64.dmg".into()
            },
            browser_download_url: "wrong-architecture".into(),
        }];
        assert!(best_macos_asset(&assets).is_none());
    }

    #[test]
    fn prefers_macos_installer_assets() {
        let assets = vec![
            GithubAsset {
                name: "source.zip".into(),
                browser_download_url: "source".into(),
            },
            GithubAsset {
                name: "Council-Editor-0.2.1-macos-arm64.dmg".into(),
                browser_download_url: "dmg".into(),
            },
            GithubAsset {
                name: "Council-Editor-0.2.1-macos-arm64.pkg".into(),
                browser_download_url: "pkg".into(),
            },
        ];
        assert_eq!(best_macos_asset(&assets).as_deref(), if cfg!(target_arch = "aarch64") { Some("pkg") } else { None });
    }
}
