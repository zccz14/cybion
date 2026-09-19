use super::tests::{create_test_thread, test_state};
use super::*;

fn audit(
    connection: &Connection,
    thread: &str,
    kind: &str,
    status: &str,
    usage: (Option<i64>, Option<i64>, Option<i64>),
) -> i64 {
    connection.execute(
        "INSERT INTO reasoning_audits(thread_id,request_kind,model,status,started_at,input_tokens,output_tokens,cached_tokens) VALUES(?,?,'fixture',?,1,?,?,?)",
        params![thread,kind,status,usage.0,usage.1,usage.2],
    ).unwrap();
    connection.last_insert_rowid()
}

#[tokio::test]
async fn empty_threads_return_zero_usage_and_no_cache_rate_everywhere() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "usage-empty").unwrap();
    let created = create_test_thread(&state, &user).await;
    assert_eq!(created.usage, ThreadUsage::default());
    let read = read_thread_for(&state, &user, created.id.clone())
        .await
        .unwrap();
    let list = list_threads_for(&state, &user).await.unwrap();
    assert_eq!(read.usage, created.usage);
    assert_eq!(list[0].usage, created.usage);
    let json = serde_json::to_value(read).unwrap();
    assert_eq!(json["usage"]["total_tokens"], 0);
    assert!(json["usage"]["cache_hit_rate"].is_null());
}

#[tokio::test]
async fn thread_usage_adds_all_reported_requests_and_weights_cache_by_input() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "usage-owner").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let other_thread = create_test_thread(&state, &user).await;
    let id = thread.id.clone();
    let other_id = other_thread.id.clone();
    user_db(&state, &user, false, move |connection| {
        for (kind, status, input, output, cached) in [
            ("inference", "completed", 1000, 100, 900),
            ("inference", "completed", 100, 50, 0),
            ("checkpoint", "completed", 20, 10, 0),
            ("title", "completed", 30, 5, 15),
            ("inference", "cancelled", 200, 20, 150),
            ("inference", "failed", 40, 4, 20),
        ] {
            audit(
                connection,
                &id,
                kind,
                status,
                (Some(input), Some(output), Some(cached)),
            );
        }
        audit(
            connection,
            &id,
            "inference",
            "in_flight",
            (None, None, None),
        );
        audit(connection, &id, "inference", "failed", (None, None, None));
        audit(
            connection,
            &other_id,
            "inference",
            "completed",
            (Some(100000), Some(3000), Some(99000)),
        );
        Ok(())
    })
    .await
    .unwrap();
    let usage = read_thread_for(&state, &user, thread.id.clone())
        .await
        .unwrap()
        .usage;
    assert_eq!(usage.input_tokens, 1390);
    assert_eq!(usage.output_tokens, 189);
    assert_eq!(
        usage.total_tokens, 1579,
        "cached input must not be added twice"
    );
    assert_eq!(usage.cached_tokens, 1085);
    assert_eq!(usage.cache_hit_rate, Some(1085.0 / 1390.0));
    assert_eq!(usage.unreported_requests, 2);
    let list = list_threads_for(&state, &user).await.unwrap();
    assert_eq!(
        list.iter().find(|item| item.id == thread.id).unwrap().usage,
        usage
    );
    assert_eq!(
        list.iter()
            .find(|item| item.id == other_thread.id)
            .unwrap()
            .usage
            .total_tokens,
        103000
    );
    let other_user = user_for_subject(&state, "usage-other-owner").unwrap();
    assert!(
        read_thread_for(&state, &other_user, thread.id)
            .await
            .is_err()
    );
    assert!(
        list_threads_for(&state, &other_user)
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn unknown_cache_is_not_zero_and_partial_token_reports_are_explicit() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "usage-partial").unwrap();
    for (values, expected) in [
        (
            (Some(100), Some(50), None),
            ThreadUsage {
                input_tokens: 100,
                output_tokens: 50,
                total_tokens: 150,
                cached_tokens: 0,
                cache_hit_rate: None,
                unreported_requests: 0,
            },
        ),
        (
            (Some(0), Some(50), None),
            ThreadUsage {
                input_tokens: 0,
                output_tokens: 50,
                total_tokens: 50,
                cached_tokens: 0,
                cache_hit_rate: None,
                unreported_requests: 0,
            },
        ),
        (
            (Some(100), None, Some(50)),
            ThreadUsage {
                input_tokens: 100,
                output_tokens: 0,
                total_tokens: 100,
                cached_tokens: 50,
                cache_hit_rate: Some(0.5),
                unreported_requests: 1,
            },
        ),
        (
            (None, Some(10), Some(5)),
            ThreadUsage {
                input_tokens: 0,
                output_tokens: 10,
                total_tokens: 10,
                cached_tokens: 5,
                cache_hit_rate: None,
                unreported_requests: 1,
            },
        ),
        (
            (None, None, None),
            ThreadUsage {
                unreported_requests: 1,
                ..ThreadUsage::default()
            },
        ),
        ((Some(0), Some(0), Some(0)), ThreadUsage::default()),
    ] {
        let thread = create_test_thread(&state, &user).await;
        let id = thread.id.clone();
        user_db(&state, &user, false, move |connection| {
            audit(connection, &id, "inference", "completed", values);
            Ok(())
        })
        .await
        .unwrap();
        assert_eq!(
            read_thread_for(&state, &user, thread.id)
                .await
                .unwrap()
                .usage,
            expected
        );
    }
    let mixed = create_test_thread(&state, &user).await;
    let id = mixed.id.clone();
    user_db(&state, &user, false, move |connection| {
        audit(
            connection,
            &id,
            "inference",
            "completed",
            (Some(100), Some(5), Some(80)),
        );
        audit(
            connection,
            &id,
            "title",
            "completed",
            (Some(20), Some(5), None),
        );
        Ok(())
    })
    .await
    .unwrap();
    assert_eq!(
        read_thread_for(&state, &user, mixed.id)
            .await
            .unwrap()
            .usage
            .cache_hit_rate,
        None
    );
}

#[tokio::test]
async fn audit_updates_do_not_double_count_and_renames_or_thread_status_do_not_reset_usage() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "usage-updates").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let id = thread.id.clone();
    let audit_id = user_db(&state, &user, false, move |connection| {
        Ok(audit(
            connection,
            &id,
            "inference",
            "in_flight",
            (None, None, None),
        ))
    })
    .await
    .unwrap();
    assert_eq!(
        read_thread_for(&state, &user, thread.id.clone())
            .await
            .unwrap()
            .usage
            .unreported_requests,
        1
    );
    for _ in 0..2 {
        user_db(&state,&user,false,move |connection| {
            connection.execute("UPDATE reasoning_audits SET status='completed',input_tokens=4000000000,output_tokens=30,cached_tokens=3000000000 WHERE id=?",[audit_id])?;
            Ok(())
        }).await.unwrap();
        assert_eq!(
            read_thread_for(&state, &user, thread.id.clone())
                .await
                .unwrap()
                .usage
                .total_tokens,
            4000000030
        );
    }
    let id = thread.id.clone();
    user_db(&state, &user, false, move |connection| {
        connection.execute(
            "UPDATE threads SET title='Renamed',status='failed',updated_at=updated_at+1 WHERE id=?",
            [&id],
        )?;
        audit(
            connection,
            &id,
            "inference",
            "cancelled",
            (Some(10), Some(2), Some(0)),
        );
        Ok(())
    })
    .await
    .unwrap();
    let loaded = read_thread_for(&state, &user, thread.id.clone())
        .await
        .unwrap();
    assert_eq!(loaded.usage.total_tokens, 4000000042);
    assert_eq!(loaded.usage.unreported_requests, 0);
    assert_eq!(loaded.display_status, "failed");
    let id = thread.id;
    user_db(&state, &user, false, move |connection| {
        connection.execute("DELETE FROM threads WHERE id=?", [&id])?;
        let count: i64 = connection.query_row(
            "SELECT COUNT(*) FROM reasoning_audits WHERE thread_id=?",
            [id],
            |row| row.get(0),
        )?;
        assert_eq!(count, 0);
        Ok(())
    })
    .await
    .unwrap();
    assert!(list_threads_for(&state, &user).await.unwrap().is_empty());
}
