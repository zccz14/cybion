use std::{
    ffi::OsString,
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Child, Command},
    thread,
    time::Duration,
};

use anyhow::{Context, Result, anyhow};
use flate2::read::GzDecoder;
use reqwest::Client;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tar::Archive;

const RELEASE_URL: &str = "https://api.github.com/repos/zccz14/cybion/releases/latest";
const UPDATE_HELPER_FLAG: &str = "--apply-update";
const STARTUP_WAIT: Duration = Duration::from_secs(10);
const SUPERVISOR_STARTUP_WAIT: Duration = Duration::from_secs(2);

#[derive(Deserialize, Serialize)]
struct StartupMarker {
    pid: u32,
    version: String,
}

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
    let candidate = update_directory(database_path, &release.tag_name).join("cybion");
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
    restart_after(database_path, Duration::from_millis(250))
}

pub fn restart_after(database_path: &Path, exit_delay: Duration) -> Result<()> {
    let candidate =
        candidate_path(database_path)?.ok_or_else(|| anyhow!("no downloaded update is ready"))?;
    if !candidate.is_file() {
        return Err(anyhow!("downloaded update is missing"));
    }
    let candidate_version = candidate_version(database_path)?
        .ok_or_else(|| anyhow!("downloaded update has no version"))?;
    if !is_newer(&candidate_version, &current_version()) {
        return Err(anyhow!(
            "downloaded update is not newer than this Cybion version"
        ));
    }
    let current =
        std::env::current_exe().context("cannot resolve the current Cybion executable")?;
    let installed = installed_binary_path(database_path)?;
    seed_installation(&current, &installed)?;
    Command::new(&current)
        .arg(UPDATE_HELPER_FLAG)
        .arg(std::process::id().to_string())
        .arg(candidate)
        .arg(installed)
        .arg(database_path)
        .arg(candidate_version)
        .spawn()
        .context("cannot start the update helper")?;
    std::thread::spawn(move || {
        std::thread::sleep(exit_delay);
        std::process::exit(0);
    });
    Ok(())
}

/// Starts the binary from Cybion's fixed installation location. Release archives and
/// development builds are only migration sources; the long-running server always uses
/// `~/.cybion/bin/cybion`.
pub fn launch_installed_binary(database_path: &Path) -> Result<bool> {
    let current =
        std::env::current_exe().context("cannot resolve the current Cybion executable")?;
    let installed = installed_binary_path(database_path)?;
    if current == installed {
        return Ok(false);
    }
    seed_installation(&current, &installed)?;
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;

        let cause = Command::new(installed)
            .args(std::env::args_os().skip(1))
            .exec();
        return Err(cause).context("cannot start the installed Cybion binary");
    }
    #[allow(unreachable_code)]
    Err(anyhow!(
        "automatic updates are unavailable for this platform"
    ))
}

pub fn run_update_helper() -> Result<bool> {
    let mut arguments = std::env::args_os();
    let _program = arguments.next();
    let Some(flag) = arguments.next() else {
        return Ok(false);
    };
    if flag != UPDATE_HELPER_FLAG {
        return Ok(false);
    }
    let parent_pid = required_argument(&mut arguments, "parent PID")?
        .into_string()
        .map_err(|_| anyhow!("parent PID is not UTF-8"))?
        .parse()
        .context("parent PID is not a number")?;
    let candidate = PathBuf::from(required_argument(&mut arguments, "candidate path")?);
    let installed = PathBuf::from(required_argument(&mut arguments, "installation path")?);
    let database_path = PathBuf::from(required_argument(&mut arguments, "database path")?);
    let expected_version = required_argument(&mut arguments, "expected version")?
        .into_string()
        .map_err(|_| anyhow!("expected version is not UTF-8"))?;
    if arguments.next().is_some() {
        return Err(anyhow!("unexpected update helper arguments"));
    }
    if let Err(cause) = apply_update(
        parent_pid,
        &candidate,
        &installed,
        &database_path,
        &expected_version,
    ) {
        record_update_failure(&database_path, &cause.to_string())?;
        return Err(cause);
    }
    Ok(true)
}

pub fn record_startup(database_path: &Path) -> Result<()> {
    let marker_path = startup_marker_path(database_path)?;
    let directory = marker_path
        .parent()
        .expect("startup marker has a parent directory");
    fs::create_dir_all(directory)?;
    let marker = StartupMarker {
        pid: std::process::id(),
        version: current_version(),
    };
    let temporary = marker_path.with_extension("new");
    let mut file = fs::File::create(&temporary)?;
    file.write_all(serde_json::to_string(&marker)?.as_bytes())?;
    file.sync_all()?;
    fs::rename(temporary, marker_path)?;
    Ok(())
}

fn required_argument(
    arguments: &mut impl Iterator<Item = OsString>,
    name: &str,
) -> Result<OsString> {
    arguments
        .next()
        .ok_or_else(|| anyhow!("missing update helper {name}"))
}

fn apply_update(
    parent_pid: u32,
    candidate: &Path,
    installed: &Path,
    database_path: &Path,
    expected_version: &str,
) -> Result<()> {
    if !candidate.is_file() {
        return Err(anyhow!("downloaded update is missing"));
    }
    clear_startup_marker(database_path)?;
    let previous = replace_installed_binary(candidate, installed)?;
    if let Err(cause) = wait_for_process_exit(parent_pid) {
        restore_previous_binary(installed, &previous)?;
        return Err(cause);
    }
    if updated_binary_started(installed, database_path, expected_version).is_ok() {
        return Ok(());
    }
    restore_previous_binary(installed, &previous)?;
    Command::new(installed)
        .spawn()
        .context("cannot restart the previous Cybion version")?;
    Err(anyhow!("updated Cybion did not confirm startup"))
}

fn updated_binary_started(
    installed: &Path,
    database_path: &Path,
    expected_version: &str,
) -> Result<()> {
    if wait_for_supervisor_startup(database_path, expected_version)? {
        return Ok(());
    }
    let mut child = Command::new(installed)
        .spawn()
        .context("cannot start updated Cybion")?;
    match wait_for_startup(&mut child, database_path, expected_version) {
        Ok(true) => return Ok(()),
        Ok(false) => {}
        Err(cause) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(cause);
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    Err(anyhow!("updated Cybion did not confirm startup"))
}

fn wait_for_supervisor_startup(database_path: &Path, expected_version: &str) -> Result<bool> {
    let deadline = std::time::Instant::now() + SUPERVISOR_STARTUP_WAIT;
    while std::time::Instant::now() < deadline {
        if startup_marker_has_version(database_path, expected_version)? {
            return Ok(true);
        }
        thread::sleep(Duration::from_millis(100));
    }
    Ok(false)
}

fn wait_for_process_exit(parent_pid: u32) -> Result<()> {
    let deadline = std::time::Instant::now() + STARTUP_WAIT;
    while process_is_alive(parent_pid)? {
        if std::time::Instant::now() >= deadline {
            return Err(anyhow!("previous Cybion process did not exit"));
        }
        thread::sleep(Duration::from_millis(100));
    }
    Ok(())
}

fn process_is_alive(pid: u32) -> Result<bool> {
    Ok(Command::new("kill")
        .args(["-0", &pid.to_string()])
        .status()
        .context("cannot inspect the previous Cybion process")?
        .success())
}

fn wait_for_startup(
    child: &mut Child,
    database_path: &Path,
    expected_version: &str,
) -> Result<bool> {
    let deadline = std::time::Instant::now() + STARTUP_WAIT;
    while std::time::Instant::now() < deadline {
        if child.try_wait()?.is_some() {
            return Ok(false);
        }
        if startup_marker_matches(database_path, child.id(), expected_version)? {
            return Ok(true);
        }
        thread::sleep(Duration::from_millis(100));
    }
    Ok(false)
}

fn installed_binary_path(database_path: &Path) -> Result<PathBuf> {
    Ok(database_path
        .parent()
        .context("database path has no parent")?
        .join("bin/cybion"))
}

fn startup_marker_path(database_path: &Path) -> Result<PathBuf> {
    Ok(database_path
        .parent()
        .context("database path has no parent")?
        .join("run/started.json"))
}

fn seed_installation(current: &Path, installed: &Path) -> Result<()> {
    if current == installed || installed.is_file() {
        return Ok(());
    }
    copy_binary(current, installed)
}

fn replace_installed_binary(candidate: &Path, installed: &Path) -> Result<PathBuf> {
    let staging = installed.with_extension("new");
    let previous = installed.with_extension("previous");
    copy_binary(candidate, &staging)?;
    if previous.exists() {
        fs::remove_file(&previous).context("cannot clear the previous Cybion backup")?;
    }
    fs::rename(installed, &previous).context("cannot preserve the previous Cybion binary")?;
    if let Err(cause) = fs::rename(&staging, installed) {
        fs::rename(&previous, installed).context("cannot restore the previous Cybion binary")?;
        return Err(cause.into());
    }
    Ok(previous)
}

fn restore_previous_binary(installed: &Path, previous: &Path) -> Result<()> {
    let failed = installed.with_extension("failed");
    if failed.exists() {
        fs::remove_file(&failed).context("cannot clear the failed Cybion backup")?;
    }
    fs::rename(installed, failed).context("cannot preserve the failed Cybion binary")?;
    fs::rename(previous, installed).context("cannot restore the previous Cybion binary")?;
    Ok(())
}

fn copy_binary(source: &Path, destination: &Path) -> Result<()> {
    let directory = destination
        .parent()
        .expect("Cybion binary path has a parent directory");
    fs::create_dir_all(directory)?;
    fs::copy(source, destination)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(destination, fs::Permissions::from_mode(0o755))?;
    }
    Ok(())
}

fn clear_startup_marker(database_path: &Path) -> Result<()> {
    let marker = startup_marker_path(database_path)?;
    if marker.exists() {
        fs::remove_file(marker)?;
    }
    Ok(())
}

fn startup_marker_matches(database_path: &Path, pid: u32, version: &str) -> Result<bool> {
    let marker = startup_marker_path(database_path)?;
    let Ok(content) = fs::read_to_string(marker) else {
        return Ok(false);
    };
    let marker: StartupMarker = serde_json::from_str(&content)?;
    Ok(marker.pid == pid && marker.version == version.trim_start_matches('v'))
}

fn startup_marker_has_version(database_path: &Path, version: &str) -> Result<bool> {
    let marker = startup_marker_path(database_path)?;
    let Ok(content) = fs::read_to_string(marker) else {
        return Ok(false);
    };
    let marker: StartupMarker = serde_json::from_str(&content)?;
    Ok(marker.version == version.trim_start_matches('v'))
}

fn record_update_failure(database_path: &Path, cause: &str) -> Result<()> {
    let connection = Connection::open(database_path)?;
    connection.execute(
        "INSERT INTO app_meta (key, value) VALUES ('update_state', 'ready')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [],
    )?;
    connection.execute(
        "INSERT INTO app_meta (key, value) VALUES ('update_detail', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [format!(
            "Installation failed; the previous version was restored: {cause}"
        )],
    )?;
    Ok(())
}

fn current_version() -> String {
    env!("CARGO_PKG_VERSION").to_owned()
}

fn release_asset_name() -> Result<&'static str> {
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        return Ok("cybion-linux-x86_64.tar.gz");
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        return Ok("cybion-linux-aarch64.tar.gz");
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        return Ok("cybion-macos-aarch64.tar.gz");
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
        .expect("Cybion database has a parent")
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
        if path.file_name().and_then(|name| name.to_str()) == Some("cybion") {
            let candidate = directory.join("cybion");
            entry.unpack(&candidate)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&candidate, fs::Permissions::from_mode(0o755))?;
            }
            return Ok(());
        }
    }
    Err(anyhow!("release archive has no Cybion executable"))
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
        assert!(verify_checksum(b"cybion", "deadbeef cybion.tar.gz").is_err());
    }

    #[test]
    fn installation_path_is_separate_from_the_database_and_source_tree() {
        let database = Path::new("/tmp/cybion/default.sqlite3");
        assert_eq!(
            installed_binary_path(database).unwrap(),
            PathBuf::from("/tmp/cybion/bin/cybion")
        );
    }

    #[test]
    fn replacement_preserves_the_previous_binary() {
        let directory = tempfile::tempdir().unwrap();
        let installed = directory.path().join("bin/cybion");
        let candidate = directory.path().join("candidate");
        copy_binary_bytes(&installed, b"old");
        copy_binary_bytes(&candidate, b"new");
        let previous = replace_installed_binary(&candidate, &installed).unwrap();
        assert_eq!(fs::read(installed).unwrap(), b"new");
        assert_eq!(fs::read(previous).unwrap(), b"old");
    }

    #[test]
    fn replacement_replaces_an_old_backup_with_the_current_binary() {
        let directory = tempfile::tempdir().unwrap();
        let installed = directory.path().join("bin/cybion");
        let candidate = directory.path().join("candidate");
        copy_binary_bytes(&installed, b"current");
        copy_binary_bytes(&candidate, b"next");
        copy_binary_bytes(&installed.with_extension("previous"), b"stale backup");
        let previous = replace_installed_binary(&candidate, &installed).unwrap();
        assert_eq!(fs::read(installed).unwrap(), b"next");
        assert_eq!(fs::read(previous).unwrap(), b"current");
    }

    #[test]
    fn startup_marker_requires_the_expected_pid_and_version() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("default.sqlite3");
        record_startup(&database).unwrap();
        assert!(startup_marker_matches(&database, std::process::id(), &current_version()).unwrap());
        assert!(!startup_marker_matches(&database, 0, &current_version()).unwrap());
        assert!(
            startup_marker_matches(
                &database,
                std::process::id(),
                &format!("v{}", current_version())
            )
            .unwrap()
        );
        assert!(startup_marker_has_version(&database, &current_version()).unwrap());
        assert!(startup_marker_has_version(&database, &format!("v{}", current_version())).unwrap());
        assert!(!startup_marker_has_version(&database, "999.0.0").unwrap());
    }

    fn copy_binary_bytes(path: &Path, bytes: &[u8]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    #[test]
    fn failed_check_clears_a_stale_candidate() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("cybion.sqlite3");
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
        let database = directory.path().join("cybion.sqlite3");
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
