use super::*;

fn minute_now() -> i64 {
    now() / 60
}

fn window(name: &str) -> route_performance::Window {
    route_performance::window(Some(name)).unwrap()
}

/// What the buckets hold, without the minute still in memory.
fn stored(path: &Path, name: &str) -> route_performance::RoutePerformance {
    route_performance::load(path, window(name), Vec::new(), Vec::new()).unwrap()
}

/// What the page shows: the buckets plus the minutes memory still holds.
fn merged(
    path: &Path,
    name: &str,
    monitor: &route_performance::Monitor,
) -> route_performance::RoutePerformance {
    route_performance::load(path, window(name), monitor.live(), monitor.live_slow()).unwrap()
}

fn record(
    monitor: &route_performance::Monitor,
    minute: i64,
    route: &str,
    method: &'static str,
    status: u16,
    millis: u64,
) {
    monitor.record_in(
        minute,
        Arc::from(route),
        method,
        status,
        Duration::from_millis(millis),
    );
}

fn statuses(route: &route_performance::PerformanceRoute) -> Vec<(i64, i64)> {
    route
        .statuses
        .iter()
        .map(|status| (status.status, status.requests))
        .collect()
}

fn admin_database() -> (tempfile::TempDir, PathBuf) {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("default.sqlite3");
    prepare_admin_db(&path).unwrap();
    (root, path)
}

// A request costs the request path an atomic add; the flush folds its minute
// into the buckets both the short and the long windows read.
#[test]
fn a_closed_minute_folds_into_the_minute_and_hour_buckets() {
    let (_root, path) = admin_database();
    let monitor = route_performance::Monitor::open(&path).unwrap();
    let closed = minute_now() - 2;
    record(&monitor, closed, "/api/threads", "GET", 200, 12);
    record(&monitor, closed, "/api/threads", "GET", 200, 7);
    record(&monitor, closed, "/api/threads", "POST", 500, 3_000);
    record(&monitor, closed, "/api/threads", "POST", 404, 4);
    monitor.persist().unwrap();

    let minute = stored(&path, "1h");
    assert_eq!(minute.resolution, "minute");
    assert_eq!(minute.bucket_seconds, 60);
    assert_eq!(minute.totals.requests, 4);
    assert_eq!(minute.totals.server_errors, 1);
    assert_eq!(
        minute.totals.client_errors, 1,
        "a 5xx is not a client error"
    );
    assert_eq!(minute.totals.slow_requests, 1);
    assert_eq!(minute.totals.max_us, Some(3_000_000));
    let get = minute
        .routes
        .iter()
        .find(|route| route.method == "GET")
        .unwrap();
    assert_eq!(get.route, "/api/threads");
    assert_eq!(get.requests, 2);
    // 7 ms and 12 ms land in the 10 ms and 25 ms bands: a percentile reports
    // that band's upper bound, so it is never optimistic.
    assert_eq!(get.p50_us, Some(10_000));
    assert_eq!(get.p95_us, Some(25_000));
    assert_eq!(get.max_us, Some(12_000));
    assert_eq!(statuses(get), vec![(200, 2)]);
    let post = minute
        .routes
        .iter()
        .find(|route| route.method == "POST")
        .unwrap();
    // Equal counts break the tie by status, so the order is stable.
    assert_eq!(statuses(post), vec![(404, 1), (500, 1)]);
    assert_eq!(post.slow_requests, 1);
    // A slow request is kept whole, so the page can show what went slow.
    assert_eq!(minute.slow.len(), 1);
    assert_eq!(minute.slow[0].route, "/api/threads");
    assert_eq!(minute.slow[0].status, 500);
    assert_eq!(minute.slow[0].latency_us, 3_000_000);
    // One bucket, holding the whole minute.
    assert_eq!(minute.series.len(), 1);
    assert_eq!(minute.series[0].bucket_start, closed * 60);
    assert_eq!(minute.series[0].requests, 4);
    assert_eq!(minute.series[0].p95_us, Some(5_000_000));
    assert_eq!(minute.latest_bucket_start, Some(closed * 60));

    // The same samples reach the hour buckets the long windows read.
    let hour = stored(&path, "24h");
    assert_eq!(hour.resolution, "hour");
    assert_eq!(hour.totals.requests, 4);
    assert_eq!(hour.series.len(), 1);
    assert_eq!(hour.series[0].bucket_start, closed * 60 / 3600 * 3600);
}

// Freshness, and the one hazard this design has: a minute written twice would
// count its requests twice.
#[test]
fn a_running_minute_is_flushed_once_and_only_after_it_closes() {
    let (_root, path) = admin_database();
    let monitor = route_performance::Monitor::open(&path).unwrap();
    let running = minute_now();
    record(&monitor, running, "/api/me", "GET", 200, 3);
    monitor.persist_at(running).unwrap();
    assert_eq!(
        stored(&path, "1h").totals.requests,
        0,
        "an open minute is not written yet"
    );
    assert_eq!(
        merged(&path, "1h", &monitor).totals.requests,
        1,
        "the page reads it from memory instead of waiting for the flush"
    );

    monitor.persist_at(running + 1).unwrap();
    assert_eq!(stored(&path, "1h").totals.requests, 1);
    assert_eq!(
        merged(&path, "1h", &monitor).totals.requests,
        1,
        "a drained minute is not counted twice by the merged read"
    );

    monitor.persist_at(running + 2).unwrap();
    assert_eq!(
        stored(&path, "1h").totals.requests,
        1,
        "a later pass adds nothing to a minute it already wrote"
    );
}

// The page reads the minute in memory, and a slow sample in that minute is not
// lost between the flush and the request that produced it.
#[test]
fn the_minute_in_memory_answers_the_page_before_the_next_flush() {
    let (_root, path) = admin_database();
    let monitor = route_performance::Monitor::open(&path).unwrap();
    let running = minute_now();
    record(
        &monitor,
        running,
        "/api/threads/{id}/inputs",
        "POST",
        200,
        20,
    );
    record(
        &monitor,
        running,
        "/api/threads/{id}/inputs",
        "POST",
        502,
        4_000,
    );

    let live = merged(&path, "1h", &monitor);
    assert_eq!(live.totals.requests, 2);
    assert_eq!(live.totals.server_errors, 1);
    assert_eq!(live.totals.slow_requests, 1);
    assert_eq!(live.series.len(), 1);
    assert_eq!(live.series[0].bucket_start, running * 60);
    assert_eq!(live.series[0].requests, 2);
    assert_eq!(live.latest_bucket_start, Some(running * 60));
    assert_eq!(live.slow.len(), 1);
    assert_eq!(live.slow[0].latency_us, 4_000_000);
    assert_eq!(live.routes.len(), 1);
    assert_eq!(statuses(&live.routes[0]), vec![(200, 1), (502, 1)]);

    // Once the flush has the minute, the merged read still reports it once.
    monitor.persist_at(running + 1).unwrap();
    let after = merged(&path, "1h", &monitor);
    assert_eq!(after.totals.requests, 2);
    assert_eq!(after.slow.len(), 1);
}

// Freshness is bounded on purpose: minute detail is short-lived, the hour
// buckets carry a month.
#[test]
fn retention_keeps_minute_detail_for_hours_and_hour_detail_for_a_month() {
    let (_root, path) = admin_database();
    let monitor = route_performance::Monitor::open(&path).unwrap();
    record(
        &monitor,
        minute_now() - 8 * 60,
        "/api/threads",
        "GET",
        200,
        5,
    );
    monitor.persist().unwrap();
    assert_eq!(
        stored(&path, "1h").totals.requests,
        0,
        "the minute table ages out after six hours"
    );
    assert_eq!(
        stored(&path, "24h").totals.requests,
        1,
        "the hour table still holds it"
    );

    record(
        &monitor,
        minute_now() - 35 * 24 * 60,
        "/api/archived",
        "GET",
        200,
        5,
    );
    monitor.persist().unwrap();
    let week = stored(&path, "7d");
    assert_eq!(
        week.routes
            .iter()
            .map(|route| route.route.as_str())
            .collect::<Vec<_>>(),
        vec!["/api/threads"],
        "hour buckets stop at thirty days"
    );
}

#[test]
fn a_percentile_reports_the_band_its_sample_lands_in() {
    let mut bands = [0i64; route_performance::BANDS_US.len()];
    // 99 requests at 1 ms, one at 12 s.
    bands[0] = 99;
    bands[10] = 1;
    let max_us = 12_000_000;
    assert_eq!(
        route_performance::percentile(&bands, 100, 0.50, max_us),
        Some(5_000)
    );
    assert_eq!(
        route_performance::percentile(&bands, 100, 0.95, max_us),
        Some(5_000)
    );
    // A 12 s request sits in the 30 s band, so even the hundredth percentile
    // reports a band bound rather than the sample itself.
    assert_eq!(
        route_performance::percentile(&bands, 100, 1.0, max_us),
        Some(30_000_000)
    );
    // The open-ended band has no bound to report, so it falls back to the
    // slowest request actually seen.
    let mut slowest = [0i64; route_performance::BANDS_US.len()];
    slowest[route_performance::BANDS_US.len() - 1] = 1;
    assert_eq!(
        route_performance::percentile(&slowest, 1, 0.95, max_us),
        Some(12_000_000)
    );
    assert_eq!(route_performance::percentile(&bands, 0, 0.95, max_us), None);
    assert_eq!(route_performance::slow_count(&bands), 1);
}

#[test]
fn the_page_windows_are_the_four_it_shows_and_nothing_else() {
    assert_eq!(window("1h").name, "1h");
    assert_eq!(window("7d").name, "7d");
    assert_eq!(route_performance::window(None).unwrap().name, "24h");
    assert!(route_performance::window(Some("30d")).is_err());
    assert!(route_performance::window(Some("")).is_err());
}

#[test]
fn every_method_is_recorded_under_a_fixed_name() {
    use axum::http::Method;
    assert_eq!(route_performance::method_name(&Method::GET), "GET");
    assert_eq!(route_performance::method_name(&Method::DELETE), "DELETE");
    assert_eq!(route_performance::method_name(&Method::OPTIONS), "OPTIONS");
    assert_eq!(
        route_performance::method_name(&Method::from_bytes(b"PROPFIND").unwrap()),
        "OTHER"
    );
}
