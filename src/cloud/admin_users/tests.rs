use super::*;
use crate::cloud::tests::test_state;

fn identity(user: &User) -> axum::Extension<BrowserIdentity> {
    axum::Extension(BrowserIdentity {
        user: user.clone(),
        bearer: String::new(),
    })
}

#[tokio::test]
async fn worker_metrics_count_owned_active_workers_only() {
    let (_root, state) = test_state();
    assert!(admin_user_sync(&state.admin_db_path, "root", true).unwrap());
    let root = user_for_subject(&state, "root").unwrap();
    user_db(
        &state,
        &user_for_subject(&state, "device-owner").unwrap(),
        true,
        |connection| {
            connection.execute_batch(
                "INSERT INTO workers(id,label,token_hash,created_at,status,deleted_at) VALUES
                   ('w-active','Active','hash-active',1,'offline',NULL),
                   ('w-deleted','Deleted','hash-deleted',1,'offline',1);
                 INSERT INTO shared_workers(owner_user_id,worker_id,label,grant_id,revision,created_at,updated_at)
                   VALUES('elsewhere','w-shared','Borrowed','grant',1,1,1);",
            )?;
            Ok(())
        },
    )
    .await
    .unwrap();
    let report = list(State(state.clone()), identity(&root)).await.unwrap().0;
    let owner = report
        .items
        .iter()
        .find(|summary| summary.user_id == "device-owner")
        .unwrap();
    assert_eq!(owner.metrics.as_ref().unwrap().workers, 1);
}

async fn running_thread(state: &AppState, user: &User, title: &str) -> String {
    let thread = Uuid::new_v4().to_string();
    let id = thread.clone();
    let title = title.to_owned();
    user_db(state, user, true, move |connection| {
        connection.execute(
            "INSERT INTO threads(id,title,model,status,created_at,updated_at)
             VALUES(?1,?2,'test-model','running',?3,?3)",
            params![thread, title, now()],
        )?;
        Ok(())
    })
    .await
    .unwrap();
    id
}

async fn thread_with_audit(state: &AppState, user: &User, title: &str, kind: &str) -> String {
    let thread = running_thread(state, user, title).await;
    let id = thread.clone();
    let kind = kind.to_owned();
    user_db(state, user, true, move |connection| {
        connection.execute(
            "INSERT INTO reasoning_audits(thread_id,request_kind,model,status,started_at)
             VALUES(?,?, 'test-model','in_flight',?)",
            params![thread, kind, now() - 30],
        )?;
        Ok(())
    })
    .await
    .unwrap();
    id
}

async fn phase_report(state: &AppState, root: &User, user: &User) -> (Running, Running) {
    let report = list(State(state.clone()), identity(root)).await.unwrap().0;
    let summary = report
        .items
        .iter()
        .find(|summary| summary.user_id == user.id)
        .unwrap();
    (
        summary.metrics.as_ref().unwrap().running.clone(),
        report.running,
    )
}

#[tokio::test]
async fn running_threads_split_into_kernel_inference_and_device() {
    let (_root, state) = test_state();
    assert!(admin_user_sync(&state.admin_db_path, "root", true).unwrap());
    let root = user_for_subject(&state, "root").unwrap();
    let owner = user_for_subject(&state, "phase-owner").unwrap();
    let _kernel = running_thread(&state, &owner, "Kernel").await;
    let _inference = thread_with_audit(&state, &owner, "Inference", "inference").await;
    let device = running_thread(&state, &owner, "Device").await;
    user_db(&state, &owner, true, move |connection| {
        connection.execute(
            "INSERT INTO workers(id,label,token_hash,created_at,status)
             VALUES('phase-worker','Phase','phase-hash',0,'online')",
            [],
        )?;
        connection.execute(
            "INSERT INTO worker_calls(id,responses_call_id,worker_id,thread_id,name,arguments_json,status,created_at,started_at)
             VALUES('phase-call','call','phase-worker',?, 'bash','{}','delivered',?,?)",
            params![device, now() - 20, now() - 15],
        )?;
        Ok(())
    })
    .await
    .unwrap();

    let (user_running, all_running) = phase_report(&state, &root, &owner).await;
    assert_eq!(
        (
            user_running.total,
            user_running.kernel,
            user_running.inference,
            user_running.device,
            user_running.unattended
        ),
        (3, 1, 1, 1, 0)
    );
    assert_eq!((all_running.total, all_running.inference), (3, 1));
    assert_eq!(
        all_running.kernel + all_running.inference + all_running.device,
        all_running.total
    );
    assert!(user_running.longest_seconds >= 30, "{user_running:?}");
}

#[tokio::test]
async fn running_threads_ignore_title_generation_and_machine_calls() {
    let (_root, state) = test_state();
    assert!(admin_user_sync(&state.admin_db_path, "root", true).unwrap());
    let root = user_for_subject(&state, "root").unwrap();
    let owner = user_for_subject(&state, "phase-noise").unwrap();
    let idle = thread_with_audit(&state, &owner, "Idle named", "title_generation").await;
    let running = thread_with_audit(&state, &owner, "Running named", "title_generation").await;
    user_db(&state, &owner, true, move |connection| {
        connection.execute("UPDATE threads SET status='idle' WHERE id=?", [&idle])?;
        connection.execute(
            "INSERT INTO workers(id,label,token_hash,created_at,status)
             VALUES('phase-worker2','Phase','phase-hash-2',0,'online')",
            [],
        )?;
        connection.execute(
            "INSERT INTO worker_calls(id,responses_call_id,worker_id,thread_id,name,arguments_json,status,created_at,machine_id)
             VALUES('machine-call','call','phase-worker2',?, 'bash','{}','queued',?, 'machine-1')",
            params![running, now()],
        )?;
        Ok(())
    })
    .await
    .unwrap();

    let (user_running, _) = phase_report(&state, &root, &owner).await;
    assert_eq!(
        (
            user_running.total,
            user_running.kernel,
            user_running.inference,
            user_running.device
        ),
        (1, 1, 0, 0)
    );
}

#[tokio::test]
async fn shared_pending_calls_report_device() {
    let (_root, state) = test_state();
    assert!(admin_user_sync(&state.admin_db_path, "root", true).unwrap());
    let root = user_for_subject(&state, "root").unwrap();
    let owner = user_for_subject(&state, "phase-shared").unwrap();
    let thread = running_thread(&state, &owner, "Shared").await;
    user_db(&state, &owner, true, move |connection| {
        connection.execute(
            "INSERT INTO history_records(thread_id,kind,payload,created_at,worker_owner_user_id,worker_call_id)
             VALUES(?, 'response_output', '{}', ?, 'device-owner', 'shared-call')",
            params![thread, now() - 10],
        )?;
        Ok(())
    })
    .await
    .unwrap();

    let (user_running, _) = phase_report(&state, &root, &owner).await;
    assert_eq!(
        (
            user_running.total,
            user_running.device,
            user_running.inference
        ),
        (1, 1, 0)
    );
}

#[tokio::test]
async fn live_phases_win_and_missing_runners_are_unattended() {
    let (_root, state) = test_state();
    assert!(admin_user_sync(&state.admin_db_path, "root", true).unwrap());
    let root = user_for_subject(&state, "root").unwrap();
    let owner = user_for_subject(&state, "phase-live").unwrap();
    let live = thread_with_audit(&state, &owner, "Live", "inference").await;
    let orphan = running_thread(&state, &owner, "Orphan").await;
    user_db(&state, &owner, true, move |connection| {
        connection.execute(
            "UPDATE threads SET updated_at=? WHERE id=?",
            params![now() - 600, orphan],
        )?;
        Ok(())
    })
    .await
    .unwrap();
    let record = 7;
    let (cancellation, _receiver) = watch::channel(false);
    state.active_requests.lock().await.insert(
        request_key(&owner, &live),
        ActiveRequest {
            record_idx: record,
            cancellation,
            phase: Arc::new(run_phase::PhaseCell::new()),
        },
    );
    state
        .set_phase(&owner, &live, record, run_phase::Phase::Device)
        .await;
    // A write fenced by another request record must not move the phase.
    state
        .set_phase(&owner, &live, record + 1, run_phase::Phase::Kernel)
        .await;

    let (user_running, _) = phase_report(&state, &root, &owner).await;
    assert_eq!(
        (
            user_running.total,
            user_running.kernel,
            user_running.inference,
            user_running.device,
            user_running.unattended
        ),
        (2, 1, 0, 1, 1)
    );
}

#[tokio::test]
async fn rollup_matches_the_raw_counts_through_settlement_and_cascade() {
    // The rollup is what the page reads; `counted` is the pre-rollup answer and
    // the semantic oracle. They must agree on every column after inserts,
    // token settlement, a soft-deleted Worker and a Thread cascade delete.
    let (_root, state) = test_state();
    assert!(admin_user_sync(&state.admin_db_path, "root", true).unwrap());
    let user = user_for_subject(&state, "rollup-owner").unwrap();
    user_db(&state, &user, true, |connection| {
        connection.execute_batch(
            "INSERT INTO threads(id,title,model,status,created_at,updated_at) VALUES
               ('t1','One','test-model','running',1,1),
               ('t2','Two','test-model','idle',1,1);
             INSERT INTO workers(id,label,token_hash,created_at,status,deleted_at) VALUES
               ('w-active','Active','hash-active',1,'offline',NULL),
               ('w-gone','Gone','hash-gone',1,'offline',5);
             INSERT INTO history_records(thread_id,kind,payload,created_at) VALUES
               ('t1','input','{}',1),
               ('t1','response_output','{}',2),
               ('t2','input','{}',3);
             INSERT INTO reasoning_audits(thread_id,request_kind,model,status,started_at) VALUES
               ('t1','inference','test-model','in_flight',1),
               ('t1','compaction','test-model','completed',2),
               ('t2','inference','test-model','failed',3);
             UPDATE reasoning_audits SET status='completed',finished_at=9,
               input_tokens=100,output_tokens=40,cached_tokens=60 WHERE thread_id='t1';
             UPDATE reasoning_audits SET input_tokens=5,output_tokens=7,cached_tokens=3
               WHERE thread_id='t2';
             UPDATE workers SET deleted_at=7 WHERE id='w-active';
             DELETE FROM threads WHERE id='t1';",
        )?;
        Ok(())
    })
    .await
    .unwrap();

    let (rolled, counted) = user_db(&state, &user, false, |connection| {
        let rolled: Counts = connection.query_row(
            "SELECT requests,input_tokens,output_tokens,cached_tokens,history_records,threads,workers
               FROM user_rollup WHERE id=1",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            },
        )?;
        let counted: Counts = connection.query_row(
            "SELECT COUNT(*),
               COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0), COALESCE(SUM(cached_tokens),0),
               (SELECT COUNT(*) FROM history_records), (SELECT COUNT(*) FROM threads),
               (SELECT COUNT(*) FROM workers WHERE deleted_at IS NULL)
               FROM reasoning_audits",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            },
        )?;
        Ok((rolled, counted))
    })
    .await
    .unwrap();

    // The surviving Thread owns one audit, one history row and the tokens the
    // settled audit reported; both Workers are deleted and t1's rows are gone.
    assert_eq!(rolled, (1, 5, 7, 3, 1, 1, 0));
    assert_eq!(rolled, counted);
}

#[tokio::test]
async fn rollup_backfill_seeds_a_database_that_predates_it() {
    // A database written before schema 46 has rows but no rollup: the migration
    // must seed it from those rows, and the migration's own answer must match
    // the raw counts.
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "legacy-owner").unwrap();
    user_db(&state, &user, true, |connection| {
        connection.execute_batch(
            "INSERT INTO threads(id,title,model,status,created_at,updated_at) VALUES
               ('t1','One','test-model','idle',1,1);
             INSERT INTO history_records(thread_id,kind,payload,created_at) VALUES
               ('t1','input','{}',1),('t1','response_output','{}',2);
             INSERT INTO reasoning_audits(thread_id,request_kind,model,status,started_at,input_tokens,output_tokens,cached_tokens) VALUES
               ('t1','inference','test-model','completed',1,20,8,4);",
        )?;
        // Simulate the pre-46 database: drop the rollup and forget the schema.
        connection.execute_batch(
            "DROP TRIGGER IF EXISTS user_rollup_audit_insert;
             DROP TRIGGER IF EXISTS user_rollup_audit_tokens;
             DROP TRIGGER IF EXISTS user_rollup_audit_delete;
             DROP TRIGGER IF EXISTS user_rollup_history_insert;
             DROP TRIGGER IF EXISTS user_rollup_history_delete;
             DROP TRIGGER IF EXISTS user_rollup_thread_insert;
             DROP TRIGGER IF EXISTS user_rollup_thread_delete;
             DROP TRIGGER IF EXISTS user_rollup_worker_insert;
             DROP TRIGGER IF EXISTS user_rollup_worker_delete;
             DROP TRIGGER IF EXISTS user_rollup_worker_update;
             DROP TABLE user_rollup;
             PRAGMA user_version = 45;",
        )?;
        Ok(())
    })
    .await
    .unwrap();

    // Reopening runs the migration, which recreates and seeds the rollup.
    let (rolled, counted) = user_db(&state, &user, false, |connection| {
        let rolled: Counts = connection.query_row(
            "SELECT requests,input_tokens,output_tokens,cached_tokens,history_records,threads,workers
               FROM user_rollup WHERE id=1",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            },
        )?;
        let raw = counted(connection).map_err(ApiError::internal)?;
        let counted: Counts = (
            raw.requests,
            raw.input_tokens,
            raw.output_tokens,
            raw.cached_tokens,
            raw.history_records,
            raw.threads,
            raw.workers,
        );
        Ok((rolled, counted))
    })
    .await
    .unwrap();

    assert_eq!(rolled, (1, 20, 8, 4, 2, 1, 0));
    assert_eq!(rolled, counted);
}
