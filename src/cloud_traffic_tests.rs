use super::*;

// Frozen fixture of the administrator schema that still carried the per-user
// traffic start date. Opening it must drop the column without losing counters.
#[test]
fn opening_a_legacy_traffic_table_drops_the_since_column_and_preserves_counters() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("default.sqlite3");
    prepare_admin_db(&path).unwrap();
    Connection::open(&path)
        .unwrap()
        .execute_batch(
            "CREATE TABLE user_traffic (
            user_id TEXT PRIMARY KEY,
            worker_received_bytes INTEGER NOT NULL,
            worker_sent_bytes INTEGER NOT NULL,
            upstream_received_bytes INTEGER NOT NULL,
            upstream_sent_bytes INTEGER NOT NULL,
            since INTEGER NOT NULL
        );
        INSERT INTO user_traffic VALUES('legacy-user',1,2,3,4,5);",
        )
        .unwrap();
    let monitor = traffic::Monitor::open(&path).unwrap();
    monitor.for_user("fresh-user");
    monitor.persist().unwrap();
    let monitor = traffic::Monitor::open(&path).unwrap();
    let legacy = monitor.snapshot("legacy-user").unwrap();
    assert_eq!(legacy.worker_received_bytes, 1);
    assert_eq!(legacy.worker_sent_bytes, 2);
    assert_eq!(legacy.upstream_received_bytes, 3);
    assert_eq!(legacy.upstream_sent_bytes, 4);
    assert!(monitor.snapshot("fresh-user").is_some());
    let since_columns: i64 = Connection::open(&path)
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('user_traffic') WHERE name='since'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(since_columns, 0);
}
