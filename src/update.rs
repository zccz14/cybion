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
    match download_latest_inner(client, database_path).await {
        Ok((status, candidate)) => {
            persist_status(database_path, &status, candidate.as_deref())?;
            Ok(status)
        }
        Err(cause) => {
            let status = status_after_failed_check(database_path, cause.to_string())?;
            let candidate = if status.state == "ready" {
                candidate_path(database_path)?
            } else {
                None
            };
            persist_status(database_path, &status, candidate.as_deref())?;
            Ok(status)
        }
    }
}

pub fn status(database_path: &Path) -> Result<UpdateStatus> {
    let connection = Connection::open(database_path)?;
    let value = |key: &str| -> Result<Option<String>> {
        Ok(connection
            .query_row("SELECT value FROM app_meta WHERE key = ?1", [key], |row| {
                row.get(0)
            })
            .optional()?)
    };
    let current_version = current_version();
    let latest_version = value("update_latest_version")?.filter(|value| !value.is_empty());
    let state = value("update_state")?.unwrap_or_else(|| "checking".to_owned());
    let detail =
        value("update_detail")?.unwrap_or_else(|| "Checking for the latest release.".to_owned());
    if state == "ready"
        && latest_version
            .as_deref()
            .is_none_or(|version| !is_newer(version, &current_version))
    {
        return Ok(UpdateStatus {
            current_version,
            latest_version,
            state: "current".to_owned(),
            detail: "The verified release is installed. Checking for newer releases.".to_owned(),
        });
    }
    Ok(UpdateStatus {
        current_version,
        latest_version,
        state,
        detail,
    })
}

async fn download_latest_inner(
    client: &Client,
    database_path: &Path,
) -> Result<(UpdateStatus, Option<PathBuf>)> {
    let current = current_version();
    let release = client
        .get(RELEASE_URL)
        .send()
        .await?
        .error_for_status()?
        .json::<Release>()
        .await?;
    if !is_newer(&release.tag_name, &current) {
        return Ok((
            UpdateStatus {
                current_version: current,
                latest_version: Some(release.tag_name),
                state: "current".to_owned(),
                detail: "This machine is already on the latest release.".to_owned(),
            },
            None,
        ));
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
    Ok((
        UpdateStatus {
            current_version: current,
            latest_version: Some(release.tag_name),
            state: "ready".to_owned(),
            detail: "The verified release is downloaded. Restart to install it.".to_owned(),
        },
        Some(candidate),
    ))
}

pub fn restart(database_path: &Path) -> Result<()> {
    let candidate =
        candidate_path(database_path)?.ok_or_else(|| anyhow!("no downloaded update is ready"))?;
    if !candidate.is_file() {
        return Err(anyhow!("downloaded update is missing"));
    }
    let candidate_version = candidate_version(database_path)?
        .ok_or_else(|| anyhow!("downloaded update has no version"))?;
    if !is_newer(&candidate_version, &current_version()) {
        return Err(anyhow!(
            "downloaded update is not newer than this Mobius version"
        ));
    }
    let current =
        std::env::current_exe().context("cannot resolve the current Mobius executable")?;
    Command::new("sh")
        .args(["-c", update_helper_script(), "mobius-update"])
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

fn current_version() -> String {
    env!("CARGO_PKG_VERSION").to_owned()
}

fn update_helper_script() -> &'static str {
    r#"set -eu
sleep 1
candidate="$1"
current="$2"
staging="${current}.new"
backup="${current}.previous"
rm -f "$staging"
cp "$candidate" "$staging"
chmod +x "$staging"
mv -f "$current" "$backup"
mv -f "$staging" "$current"
"$current" &
new_pid=$!
attempt=0
while [ "$attempt" -lt 10 ]; do
  if curl -fsS http://127.0.0.1:1858/health >/dev/null; then
    wait "$new_pid"
    exit $?
  fi
  kill -0 "$new_pid" 2>/dev/null || break
  attempt=$((attempt + 1))
  sleep 1
done
kill "$new_pid" 2>/dev/null || true
mv -f "$backup" "$current"
exec "$current""#
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

fn persist_status(
    database_path: &Path,
    status: &UpdateStatus,
    candidate: Option<&Path>,
) -> Result<()> {
    let connection = Connection::open(database_path)?;
    for (key, value) in [
        (
            "update_latest_version",
            status.latest_version.as_deref().unwrap_or(""),
        ),
        ("update_state", status.state.as_str()),
        ("update_detail", status.detail.as_str()),
    ] {
        connection.execute("INSERT INTO app_meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value", params![key, value])?;
    }
    if let Some(candidate) = candidate {
        let version = status
            .latest_version
            .as_deref()
            .ok_or_else(|| anyhow!("update candidate has no version"))?;
        let path = candidate
            .to_str()
            .ok_or_else(|| anyhow!("update path is not UTF-8"))?;
        for (key, value) in [("update_version", version), ("update_path", path)] {
            connection.execute("INSERT INTO app_meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value", params![key, value])?;
        }
    } else {
        connection.execute(
            "DELETE FROM app_meta WHERE key IN ('update_version', 'update_path')",
            [],
        )?;
    }
    Ok(())
}

fn status_after_failed_check(database_path: &Path, detail: String) -> Result<UpdateStatus> {
    if let (Some(candidate), Some(version)) = (
        candidate_path(database_path)?,
        candidate_version(database_path)?,
    ) && candidate.is_file()
        && is_newer(&version, &current_version())
    {
        return Ok(UpdateStatus {
            current_version: current_version(),
            latest_version: Some(version),
            state: "ready".to_owned(),
            detail: format!(
                "A verified release is ready to install. The latest update check failed: {detail}"
            ),
        });
    }
    Ok(UpdateStatus {
        current_version: current_version(),
        latest_version: None,
        state: "failed".to_owned(),
        detail,
    })
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

fn candidate_version(database_path: &Path) -> Result<Option<String>> {
    let connection = Connection::open(database_path)?;
    Ok(connection
        .query_row(
            "SELECT value FROM app_meta WHERE key = 'update_version'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?)
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

    #[test]
    fn helper_keeps_a_backup_until_the_replacement_starts() {
        let script = update_helper_script();
        assert!(script.contains("cp \"$candidate\" \"$staging\""));
        assert!(script.contains("mv -f \"$current\" \"$backup\""));
        assert!(script.contains("curl -fsS http://127.0.0.1:1858/health"));
        assert!(script.contains("mv -f \"$backup\" \"$current\""));
    }

    #[test]
    fn failed_check_clears_a_stale_candidate() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("mobius.sqlite3");
        let connection = Connection::open(&database).unwrap();
        connection
            .execute_batch("CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            .unwrap();
        connection
            .execute(
                "INSERT INTO app_meta (key, value) VALUES ('update_path', '/missing')",
                [],
            )
            .unwrap();
        let status = UpdateStatus {
            current_version: current_version(),
            latest_version: None,
            state: "failed".to_owned(),
            detail: "network unavailable".to_owned(),
        };
        persist_status(&database, &status, None).unwrap();
        assert!(candidate_path(&database).unwrap().is_none());
    }

    #[test]
    fn installed_candidate_is_not_shown_as_ready() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("mobius.sqlite3");
        let connection = Connection::open(&database).unwrap();
        connection
            .execute_batch("CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            .unwrap();
        persist_status(
            &database,
            &UpdateStatus {
                current_version: current_version(),
                latest_version: Some(current_version()),
                state: "ready".to_owned(),
                detail: "ready".to_owned(),
            },
            None,
        )
        .unwrap();
        assert_eq!(status(&database).unwrap().state, "current");
    }
}
