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
