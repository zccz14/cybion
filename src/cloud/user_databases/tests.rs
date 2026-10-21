use super::*;
use crate::cloud::tests::test_state;
use std::sync::atomic::{AtomicUsize, Ordering};

/// Writes into one user database are admitted one at a time: a second writer
/// waits for the first to commit instead of racing it into `SQLITE_BUSY`.
#[tokio::test]
async fn writes_on_one_database_never_overlap() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "queue-user").unwrap();
    user_db(&state, &user, true, |c| {
        c.execute_batch(
            "CREATE TABLE counter(value INTEGER NOT NULL); INSERT INTO counter VALUES(0);",
        )?;
        Ok(())
    })
    .await
    .unwrap();
    let inside = Arc::new(AtomicUsize::new(0));
    let overlaps = Arc::new(AtomicUsize::new(0));
    let mut tasks = Vec::new();
    for _ in 0..8 {
        let state = state.clone();
        let user = user.clone();
        let inside = inside.clone();
        let overlaps = overlaps.clone();
        tasks.push(tokio::spawn(async move {
            user_db(&state, &user, false, move |c| {
                if inside.fetch_add(1, Ordering::SeqCst) != 0 {
                    overlaps.fetch_add(1, Ordering::SeqCst);
                }
                std::thread::sleep(Duration::from_millis(25));
                let transaction = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
                transaction.execute("UPDATE counter SET value=value+1", [])?;
                transaction.commit()?;
                inside.fetch_sub(1, Ordering::SeqCst);
                Ok(())
            })
            .await
        }));
    }
    for task in tasks {
        task.await.unwrap().unwrap();
    }
    assert_eq!(
        overlaps.load(Ordering::SeqCst),
        0,
        "two operations held the same database at once"
    );
    let total: i64 = user_db(&state, &user, false, |c| {
        Ok(c.query_row("SELECT value FROM counter", [], |row| row.get(0))?)
    })
    .await
    .unwrap();
    assert_eq!(total, 8, "every queued write committed exactly once");
}

/// The connection survives between operations: reopening per operation was the
/// churn that made a busy file expensive in the first place.
#[tokio::test]
async fn consecutive_operations_share_one_connection() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "shared-connection-user").unwrap();
    user_db(&state, &user, true, |c| {
        c.execute_batch("CREATE TEMP TABLE probe(value INTEGER)")?;
        Ok(())
    })
    .await
    .unwrap();
    let temporary: i64 = user_db(&state, &user, false, |c| {
        Ok(c.query_row(
            "SELECT count(*) FROM temp.sqlite_master WHERE name='probe'",
            [],
            |row| row.get(0),
        )?)
    })
    .await
    .unwrap();
    assert_eq!(temporary, 1, "the next operation lost its connection");
}

/// A panicking operation answers with an internal error and leaves both the
/// queue and the file usable for whoever comes next.
#[tokio::test]
async fn a_panicking_operation_does_not_wedge_the_database() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "panicking-user").unwrap();
    let error = user_db(&state, &user, true, |_| -> Result<(), ApiError> {
        panic!("injected failure");
    })
    .await
    .unwrap_err();
    assert_eq!(error.status, StatusCode::INTERNAL_SERVER_ERROR);
    user_db(&state, &user, false, |c| {
        c.execute_batch("CREATE TABLE after_panic(value INTEGER)")?;
        Ok(())
    })
    .await
    .unwrap();
    let tables: i64 = user_db(&state, &user, false, |c| {
        Ok(c.query_row(
            "SELECT count(*) FROM sqlite_master WHERE name='after_panic'",
            [],
            |row| row.get(0),
        )?)
    })
    .await
    .unwrap();
    assert_eq!(tables, 1);
}
