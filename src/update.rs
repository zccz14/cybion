use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

use anyhow::{Context, Result, anyhow};
use flate2::read::GzDecoder;
use reqwest::Client;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tar::Archive;

const RELEASE_URL: &str = "https://api.github.com/repos/zccz14/mobius/releases/latest";

#[derive(Serialize)]
pub struct UpdateStatus {
    pub current_version: String,
    pub latest_version: Option<String>,
    pub state: String,
    pub detail: String,
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    assets: Vec<ReleaseAsset>,
}
#[derive(Deserialize)]
struct ReleaseAsset {
    name: String,
    browser_download_url: String,
}

pub async fn download_latest(client: &Client, database_path: &Path) -> Result<UpdateStatus> {
    let current = env!("CARGO_PKG_VERSION").to_owned();
    let release = client
        .get(RELEASE_URL)
        .send()
        .await?
        .error_for_status()?
        .json::<Release>()
        .await?;
    if !is_newer(&release.tag_name, &current) {
        return Ok(UpdateStatus {
            current_version: current,
            latest_version: Some(release.tag_name),
            state: "current".to_owned(),
            detail: "This machine is already on the latest release.".to_owned(),
        });
    }
    let asset_name = release_asset_name()?;
    let asset = release
        .assets
        .iter()
        .find(|asset| asset.name == asset_name)
        .ok_or_else(|| anyhow!("release {} has no {}", release.tag_name, asset_name))?;
    let checksum = release
        .assets
        .iter()
        .find(|asset| asset.name == format!("{asset_name}.sha256"))
        .ok_or_else(|| {
            anyhow!(
                "release {} has no checksum for {}",
                release.tag_name,
                asset_name
            )
        })?;
    let candidate = update_directory(database_path, &release.tag_name).join("mobius");
    if !candidate.is_file() {
        let archive = client
            .get(&asset.browser_download_url)
            .send()
            .await?
            .error_for_status()?
            .bytes()
            .await?;
        let expected = client
            .get(&checksum.browser_download_url)
            .send()
            .await?
            .error_for_status()?
            .text()
            .await?;
        verify_checksum(&archive, &expected)?;
        unpack_binary(
            &archive,
            &update_directory(database_path, &release.tag_name),
        )?;
    }
    persist_candidate(database_path, &release.tag_name, &candidate)?;
    Ok(UpdateStatus {
        current_version: current,
        latest_version: Some(release.tag_name),
        state: "ready".to_owned(),
        detail: "The verified release is downloaded. Restart to install it.".to_owned(),
    })
}

pub fn restart(database_path: &Path) -> Result<()> {
    let candidate =
        candidate_path(database_path)?.ok_or_else(|| anyhow!("no downloaded update is ready"))?;
    if !candidate.is_file() {
        return Err(anyhow!("downloaded update is missing"));
    }
    let current =
        std::env::current_exe().context("cannot resolve the current Mobius executable")?;
    Command::new("sh")
        .args([
            "-c",
            "sleep 1; mv -f \"$1\" \"$2\"; exec \"$2\"",
            "mobius-update",
        ])
        .arg(candidate)
        .arg(current)
        .spawn()
        .context("cannot start the update helper")?;
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_millis(250));
        std::process::exit(0);
    });
    Ok(())
}

fn release_asset_name() -> Result<&'static str> {
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        return Ok("mobius-linux-x86_64.tar.gz");
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        return Ok("mobius-linux-aarch64.tar.gz");
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        return Ok("mobius-macos-aarch64.tar.gz");
    }
    #[allow(unreachable_code)]
    Err(anyhow!(
        "automatic updates are unavailable for this platform"
    ))
}

fn is_newer(tag: &str, current: &str) -> bool {
    version_parts(tag) > version_parts(current)
}
fn version_parts(version: &str) -> Vec<u64> {
    version
        .trim_start_matches('v')
        .split('.')
        .map(|part| part.parse().unwrap_or_default())
        .collect()
}
fn update_directory(database_path: &Path, tag: &str) -> PathBuf {
    database_path
        .parent()
        .expect("Mobius database has a parent")
        .join("updates")
        .join(tag)
}

fn verify_checksum(bytes: &[u8], checksum: &str) -> Result<()> {
    let expected = checksum
        .split_whitespace()
        .next()
        .ok_or_else(|| anyhow!("checksum file is empty"))?;
    let actual = format!("{:x}", Sha256::digest(bytes));
    if actual != expected {
        return Err(anyhow!("release checksum does not match"));
    }
    Ok(())
}

fn unpack_binary(bytes: &[u8], directory: &Path) -> Result<()> {
    fs::create_dir_all(directory)?;
    let mut archive = Archive::new(GzDecoder::new(bytes));
    for entry in archive.entries()? {
        let mut entry = entry?;
        let path = entry.path()?;
        if path.file_name().and_then(|name| name.to_str()) == Some("mobius") {
            let candidate = directory.join("mobius");
            entry.unpack(&candidate)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&candidate, fs::Permissions::from_mode(0o755))?;
            }
            return Ok(());
        }
    }
    Err(anyhow!("release archive has no Mobius executable"))
}

fn persist_candidate(database_path: &Path, version: &str, candidate: &Path) -> Result<()> {
    let connection = Connection::open(database_path)?;
    for (key, value) in [
        ("update_version", version),
        (
            "update_path",
            candidate
                .to_str()
                .ok_or_else(|| anyhow!("update path is not UTF-8"))?,
        ),
    ] {
        connection.execute("INSERT INTO app_meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value", params![key, value])?;
    }
    Ok(())
}

fn candidate_path(database_path: &Path) -> Result<Option<PathBuf>> {
    let connection = Connection::open(database_path)?;
    Ok(connection
        .query_row(
            "SELECT value FROM app_meta WHERE key = 'update_path'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .map(PathBuf::from))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn compares_release_versions() {
        assert!(is_newer("v0.1.2", "0.1.1"));
        assert!(!is_newer("v0.1.1", "0.1.1"));
    }
    #[test]
    fn rejects_a_bad_checksum() {
        assert!(verify_checksum(b"mobius", "deadbeef mobius.tar.gz").is_err());
    }
}
