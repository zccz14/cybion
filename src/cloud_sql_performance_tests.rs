use super::sql_performance::{self, Counter};
use super::tests::test_state;
use super::*;

/// These tests all read one process-wide recorder, and the switch test turns
/// recording off for everyone. They take this lock so a sample cannot be taken,
/// dropped or consumed by a test running beside them. Plain `#[test]` on
/// purpose: nothing here needs a runtime, and a synchronous body can hold the
/// guard across the whole test.
static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn exclusive() -> std::sync::MutexGuard<'static, ()> {
    SERIAL.lock().unwrap_or_else(|poison| poison.into_inner())
}

/// A statement that walks a table must report the rows it walked, not only the
/// time it took: the settlement scan this module exists for finished in 18 ms
/// while reading 141,568 rows, which is invisible in a latency ranking.
#[test]
fn a_statement_is_counted_with_the_rows_it_scanned() {
    let _serial = exclusive();
    let connection = Connection::open_in_memory().unwrap();
    sql_performance::install(&connection).unwrap();
    connection
        .execute_batch("CREATE TABLE scan (id INTEGER PRIMARY KEY, x TEXT)")
        .unwrap();
    for id in 0..400 {
        connection
            .execute("INSERT INTO scan(id,x) VALUES(?1,'x')", [id])
            .unwrap();
    }
    {
        // COUNT(*) alone would answer from the b-tree header and scan nothing,
        // which is the point of counting full-scan steps rather than rows read:
        // the filter forces SQLite to walk the table.
        let _label = sql_performance::enter_named("test::fullscan");
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM scan WHERE x='x'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 400);
    }
    {
        let _label = sql_performance::enter_named("test::pointlookup");
        let _: String = connection
            .query_row("SELECT x FROM scan WHERE id=7", [], |row| row.get(0))
            .unwrap();
    }

    let full = recorded("test::fullscan");
    assert_eq!(full.statements, 1);
    // SQLite counts one step per b-tree advance, which lands one short of the
    // row count; anything near 400 is a scan, and that is the signal.
    assert!(
        full.fullscan_steps >= 399,
        "a filtered COUNT(*) over 400 rows must report what it walked, got {full:?}"
    );

    let point = recorded("test::pointlookup");
    assert_eq!(point.statements, 1);
    assert_eq!(
        point.fullscan_steps, 0,
        "a rowid lookup walks no table and must not look like a scan, got {point:?}"
    );
}

/// Counters are monotonic and the reading side owns the difference, so a sample
/// is never drained out from under a statement that is landing in it. Taking a
/// difference twice must therefore report nothing the second time.
#[test]
fn a_difference_is_taken_exactly_once() {
    let _serial = exclusive();
    let connection = Connection::open_in_memory().unwrap();
    sql_performance::install(&connection).unwrap();
    {
        let _label = sql_performance::enter_named("test::once");
        for _ in 0..5 {
            let _: i64 = connection
                .query_row("SELECT 1", [], |row| row.get(0))
                .unwrap();
        }
    }
    let key = sql_performance::key_named("test::once").unwrap_or_else(|| {
        panic!(
            "test::once was not recorded; {} statements found no free slot",
            sql_performance::unattributed()
        )
    });

    let first = taken(key);
    assert_eq!(first.statements, 5, "every execution is one sample");
    let second = taken(key);
    assert_eq!(
        second.statements, 0,
        "a consumed difference is not reported again"
    );
}

/// Reads one named statement, failing with the reason rather than a bare
/// `Option` when the fixed table had no room for it: a full table is the one
/// way this recorder silently loses a measurement, so the test says so.
fn recorded(name: &str) -> Counter {
    sql_performance::measured_named(name).unwrap_or_else(|| {
        panic!(
            "{name} was not recorded; {} statements found no free slot",
            sql_performance::unattributed()
        )
    })
}

fn taken(key: u64) -> Counter {
    sql_performance::differences(true)
        .into_iter()
        .find(|(candidate, _)| *candidate == key)
        .map(|(_, counter)| counter)
        .unwrap_or_default()
}

/// The page must answer from the buckets the flusher wrote and name the
/// statement and the handler it came from.
#[test]
fn the_page_names_the_statement_and_the_handler_that_ran_it() {
    let _serial = exclusive();
    let (_root, state) = test_state();
    let monitor = sql_performance::Monitor::open(&state.admin_db_path).unwrap();
    let connection = Connection::open_in_memory().unwrap();
    sql_performance::install(&connection).unwrap();
    {
        let _label = sql_performance::enter_named("test::page");
        let _: i64 = connection
            .query_row("SELECT 42", [], |row| row.get(0))
            .unwrap();
    }
    monitor.persist_at(now() / 60).unwrap();
    let page = monitor
        .load(sql_performance::window(Some("1h")).unwrap())
        .unwrap();

    let row = page
        .statements
        .iter()
        .find(|statement| statement.caller == "test::page")
        .expect("the flushed statement appears in the page");
    assert!(row.statements >= 1);
    assert!(
        row.sql.contains("SELECT 42"),
        "the row carries the statement text, got {:?}",
        row.sql
    );
    assert!(page.totals.statements >= 1);
    assert!(
        page.enabled,
        "the profiler is on unless it was switched off"
    );
}

/// The switch is what makes this safe to leave installed: turning it off stops
/// recording without a release, and turning it back on resumes.
#[test]
fn the_switch_stops_and_resumes_recording() {
    let _serial = exclusive();
    assert!(sql_performance::is_enabled());
    sql_performance::set_enabled(false);
    assert!(!sql_performance::is_enabled());
    sql_performance::set_enabled(true);
    assert!(sql_performance::is_enabled());
}
