//! One live connection per user database, handed out through a per-database
//! queue instead of SQLite's own writer lock.
//!
//! A user's requests, its Worker polls and every background patrol read and
//! write the same file. Opening a connection per operation let those writers
//! race: the loser waited out `busy_timeout` and then failed the whole turn with
//! `database is locked`. One connection per file, admitted one operation at a
//! time through a FIFO mutex, removes the race — an operation queues and then
//! runs, it never times out — and no operation pays for a schema check, a WAL
//! setup or a close-time checkpoint ever again.

use super::*;
use std::panic::AssertUnwindSafe;
use std::sync::Mutex as BlockingMutex;

/// One operation holding its database's queue longer than this is worth a log
/// line: everything else queued for that user waited for it.
const SLOW_OPERATION: Duration = Duration::from_secs(3);

struct Slot {
    /// FIFO admission: the holder is the only operation touching the file.
    queue: Arc<tokio::sync::Mutex<()>>,
    /// Opened on first use and kept for the life of the process. A blocking
    /// mutex carries it, because `Connection` is `Send` but not `Sync`.
    connection: Arc<BlockingMutex<Option<Connection>>>,
}

/// The process-wide registry of user databases and their queues.
pub(super) struct UserDatabases {
    slots: BlockingMutex<HashMap<PathBuf, Arc<Slot>>>,
}

impl UserDatabases {
    pub(super) fn new() -> Self {
        Self {
            slots: BlockingMutex::new(HashMap::new()),
        }
    }

    fn slot(&self, path: &Path) -> Arc<Slot> {
        let mut slots = self
            .slots
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        slots
            .entry(path.to_path_buf())
            .or_insert_with(|| {
                Arc::new(Slot {
                    queue: Arc::new(tokio::sync::Mutex::new(())),
                    connection: Arc::new(BlockingMutex::new(None)),
                })
            })
            .clone()
    }

    /// Runs one operation against a user database, queued behind whatever was
    /// already admitted for that file.
    pub(super) async fn run<T, F>(
        &self,
        path: &Path,
        create: bool,
        operation: F,
    ) -> Result<T, ApiError>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> Result<T, ApiError> + Send + 'static,
    {
        let slot = self.slot(path);
        let path = path.to_path_buf();
        // The admission moves into the blocking task, so the queue reopens only
        // once the operation has committed or rolled back.
        let admission = slot.queue.clone().lock_owned().await;
        tokio::task::spawn_blocking(move || {
            let _admission = admission;
            let mut connection = slot
                .connection
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            // A cached connection is only trusted while the file still reports
            // the schema this process serves; an administrator reset or a tool
            // that recreated the file makes the next operation reopen instead of
            // writing through a stale handle.
            if connection
                .as_ref()
                .is_some_and(|existing| !connection_is_current(existing))
            {
                *connection = None;
            }
            if connection.is_none() {
                *connection = Some(open_user(&path, create)?);
            }
            let started = std::time::Instant::now();
            let outcome = {
                let connection = connection.as_mut().expect("connection opened above");
                std::panic::catch_unwind(AssertUnwindSafe(|| operation(connection)))
            };
            // The queue is per file, so a slow operation delays this user's other
            // work. Surface it instead of leaving the stall unexplained.
            if started.elapsed() > SLOW_OPERATION {
                tracing::warn!(
                    elapsed_ms = started.elapsed().as_millis() as u64,
                    "slow user database operation"
                );
            }
            match outcome {
                Ok(result) => result,
                Err(_) => {
                    // The interrupted transaction rolled back while unwinding, so
                    // reopening leaves the next operation a clean connection
                    // instead of one wedged mid-transaction.
                    *connection = None;
                    Err(ApiError::internal("user database operation panicked"))
                }
            }
        })
        .await
        .map_err(ApiError::internal)?
    }
}

fn connection_is_current(connection: &Connection) -> bool {
    matches!(
        connection.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0)),
        Ok(version) if version == USER_SCHEMA_VERSION
    )
}

#[cfg(test)]
mod tests;
