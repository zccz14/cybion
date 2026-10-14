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
