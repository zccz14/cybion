use std::{
    io,
    path::{Path, PathBuf},
    time::Instant,
};

use anyhow::Result;
use rusqlite::Connection;
use serde::Serialize;
use sysinfo::{CpuRefreshKind, Disks, Networks, Pid, ProcessesToUpdate, System};

#[derive(Serialize)]
pub struct SystemResourcesSnapshot {
    pub sampled_at: i64,
    pub sample_interval_ms: u64,
    pub cpu: CpuSnapshot,
    pub memory: MemorySnapshot,
    pub network: NetworkSnapshot,
    pub disk: Option<DiskSnapshot>,
    pub sqlite: SqliteSnapshot,
}

#[derive(Serialize)]
pub struct CpuSnapshot {
    pub usage_percent: f32,
    pub load_1m: f64,
    pub logical_cpus: usize,
}
#[derive(Serialize)]
pub struct MemorySnapshot {
    pub used_bytes: u64,
    pub total_bytes: u64,
    pub available_bytes: u64,
    pub process_used_bytes: u64,
    pub other_used_bytes: u64,
    pub usage_percent: f64,
    pub swap_used_bytes: u64,
    pub swap_total_bytes: u64,
}
#[derive(Serialize)]
pub struct NetworkSnapshot {
    pub receive_bytes_per_second: u64,
    pub transmit_bytes_per_second: u64,
    pub interfaces: usize,
}
#[derive(Serialize)]
pub struct DiskSnapshot {
    pub mount_point: String,
    pub used_bytes: u64,
    pub total_bytes: u64,
    pub available_bytes: u64,
    pub usage_percent: f64,
}
#[derive(Serialize)]
pub struct SqliteSnapshot {
    pub main_bytes: u64,
    pub wal_bytes: u64,
    pub shm_bytes: u64,
    pub total_bytes: u64,
    pub freelist_bytes: u64,
    pub freelist_percent: f64,
}

pub struct ResourceMonitor {
    database_path: PathBuf,
    system: System,
    disks: Disks,
    networks: Networks,
    last_sample: Instant,
}

impl ResourceMonitor {
    pub fn new(database_path: PathBuf) -> Self {
        let mut system = System::new();
        system.refresh_memory();
        system.refresh_cpu_list(CpuRefreshKind::nothing().with_cpu_usage());
        Self {
            database_path,
            system,
            disks: Disks::new_with_refreshed_list(),
            networks: Networks::new_with_refreshed_list(),
            last_sample: Instant::now(),
        }
    }

    pub fn sample(&mut self) -> Result<SystemResourcesSnapshot> {
        self.system.refresh_cpu_usage();
        self.system.refresh_memory();
        let process_id = Pid::from_u32(std::process::id());
        self.system
            .refresh_processes(ProcessesToUpdate::Some(&[process_id]), true);
        self.disks.refresh(true);
        self.networks.refresh(true);
        let now = Instant::now();
        let elapsed = now.duration_since(self.last_sample);
        self.last_sample = now;
        let seconds = elapsed
            .max(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL)
            .as_secs_f64();
        let received = self
            .networks
            .values()
            .map(sysinfo::NetworkData::received)
            .sum::<u64>();
        let transmitted = self
            .networks
            .values()
            .map(sysinfo::NetworkData::transmitted)
            .sum::<u64>();
        let used = self.system.used_memory();
        let total = self.system.total_memory();
        let process_used = self
            .system
            .process(process_id)
            .map(sysinfo::Process::memory)
            .unwrap_or_default();
        Ok(SystemResourcesSnapshot {
            sampled_at: chrono::Utc::now().timestamp(),
            sample_interval_ms: u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX),
            cpu: CpuSnapshot {
                usage_percent: self.system.global_cpu_usage(),
                load_1m: System::load_average().one,
                logical_cpus: self.system.cpus().len(),
            },
            memory: MemorySnapshot {
                used_bytes: used,
                total_bytes: total,
                available_bytes: self.system.available_memory(),
                process_used_bytes: process_used,
                other_used_bytes: used.saturating_sub(process_used),
                usage_percent: percentage(used, total),
                swap_used_bytes: self.system.used_swap(),
                swap_total_bytes: self.system.total_swap(),
            },
            network: NetworkSnapshot {
                receive_bytes_per_second: rate(received, seconds),
                transmit_bytes_per_second: rate(transmitted, seconds),
                interfaces: self.networks.len(),
            },
            disk: disk_usage(&self.disks, &self.database_path),
            sqlite: sqlite_usage(&self.database_path)?,
        })
    }
}

fn disk_usage(disks: &Disks, database_path: &Path) -> Option<DiskSnapshot> {
    let disk = disks
        .list()
        .iter()
        .filter(|disk| database_path.starts_with(disk.mount_point()))
        .max_by_key(|disk| disk.mount_point().components().count())?;
    let total = disk.total_space();
    let available = disk.available_space();
    Some(DiskSnapshot {
        mount_point: disk.mount_point().to_string_lossy().into_owned(),
        used_bytes: total.saturating_sub(available),
        total_bytes: total,
        available_bytes: available,
        usage_percent: percentage(total.saturating_sub(available), total),
    })
}

fn sqlite_usage(database_path: &Path) -> Result<SqliteSnapshot> {
    let main_bytes = file_size(database_path)?;
    let wal_bytes = file_size(&with_suffix(database_path, "-wal"))?;
    let shm_bytes = file_size(&with_suffix(database_path, "-shm"))?;
    let connection = Connection::open(database_path)?;
    let (page_size, page_count, freelist_count): (u64, u64, u64) = connection.query_row("SELECT (SELECT * FROM pragma_page_size()), (SELECT * FROM pragma_page_count()), (SELECT * FROM pragma_freelist_count())", [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
    Ok(SqliteSnapshot {
        main_bytes,
        wal_bytes,
        shm_bytes,
        total_bytes: main_bytes
            .saturating_add(wal_bytes)
            .saturating_add(shm_bytes),
        freelist_bytes: page_size.saturating_mul(freelist_count),
        freelist_percent: percentage(freelist_count, page_count),
    })
}

fn file_size(path: &Path) -> io::Result<u64> {
    match std::fs::metadata(path) {
        Ok(metadata) => Ok(metadata.len()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(0),
        Err(error) => Err(error),
    }
}
fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_owned();
    value.push(suffix);
    value.into()
}
fn percentage(used: u64, total: u64) -> f64 {
    if total == 0 {
        0.0
    } else {
        used as f64 / total as f64 * 100.0
    }
}
fn rate(bytes: u64, seconds: f64) -> u64 {
    (bytes as f64 / seconds).round() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sqlite_usage_includes_wal_and_shared_memory() {
        let temp = tempfile::tempdir().unwrap();
        let db = temp.path().join("default.sqlite3");
        let connection = Connection::open(&db).unwrap();
        connection
            .execute_batch("CREATE TABLE data (value TEXT);")
            .unwrap();
        drop(connection);
        std::fs::write(with_suffix(&db, "-wal"), [0_u8; 5]).unwrap();
        std::fs::write(with_suffix(&db, "-shm"), [0_u8; 2]).unwrap();
        let snapshot = sqlite_usage(&db).unwrap();
        assert!(snapshot.total_bytes >= 7);
        assert_eq!(snapshot.wal_bytes, 5);
        assert_eq!(snapshot.shm_bytes, 2);
    }
}
