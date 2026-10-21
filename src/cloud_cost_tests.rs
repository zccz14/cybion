use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use axum::{Json, Router, extract::State as Parts, routing::post};

use super::cost::{MAX_ATTEMPTS, run_pass};
use super::tests::{create_test_thread, insert_upstream, test_state};
use super::*;

/// What the mock gateway holds: request ID → settled amount, where `None`
/// means it has the record but has not priced it yet. IDs absent from the map
/// answer as `missing`, like a call it never saw.
type Ledger = Arc<Mutex<HashMap<String, Option<i64>>>>;

struct Gateway {
    ledger: Ledger,
    queries: Arc<AtomicUsize>,
    authorization: Arc<Mutex<Option<String>>>,
}

async fn answer(
    Parts(gateway): Parts<Arc<Gateway>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Json<Value> {
    gateway.queries.fetch_add(1, Ordering::SeqCst);
    *gateway.authorization.lock().unwrap() = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let ledger = gateway.ledger.lock().unwrap();
    let mut requests = Vec::new();
    let mut missing = Vec::new();
    for id in body["ids"].as_array().into_iter().flatten() {
        let Some(id) = id.as_str() else { continue };
        match ledger.get(id) {
            Some(cost) => requests.push(json!({
                "request_id": id,
                "cost_usd_nanos": cost,
                "settlement_pending": cost.is_none(),
            })),
            None => missing.push(json!(id)),
        }
    }
    Json(json!({"requests": requests, "missing": missing}))
}

/// Spawns a gateway that serves the request-cost contract and returns its
/// `/v1` base URL, the way Cybion stores an upstream.
async fn spawn_gateway(ledger: Ledger) -> (String, Arc<Gateway>) {
    let gateway = Arc::new(Gateway {
        ledger,
        queries: Arc::new(AtomicUsize::new(0)),
        authorization: Arc::new(Mutex::new(None)),
    });
    let app = Router::new()
        .route("/v1/requests/query", post(answer))
        .with_state(gateway.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{address}/v1"), gateway)
}

/// Spawns a host that answers nothing: an upstream with no request-cost
/// interface at all.
async fn spawn_silent_host() -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, Router::new()).await.unwrap();
    });
    format!("http://{address}/v1")
}

fn ledger(entries: &[(&str, Option<i64>)]) -> Ledger {
    Arc::new(Mutex::new(
        entries
            .iter()
            .map(|(id, cost)| ((*id).to_owned(), *cost))
            .collect(),
    ))
}

async fn seed_audit(
    state: &AppState,
    user: &User,
    thread: &str,
    upstream_id: &str,
    request_id: &str,
) {
    let thread = thread.to_owned();
    let upstream_id = upstream_id.to_owned();
    let request_id = request_id.to_owned();
    user_db(state, user, false, move |connection| {
        connection
            .execute(
                "INSERT INTO reasoning_audits(thread_id,request_kind,model,status,started_at,finished_at,upstream_id,openai_lb_request_id)
                 VALUES(?,'inference','fixture','completed',?,?,?,?)",
                params![thread, now(), now(), upstream_id, request_id],
            )
            .map_err(ApiError::internal)?;
        Ok(())
    })
    .await
    .unwrap();
}

async fn read_cost(state: &AppState, user: &User, request_id: &str) -> (Option<i64>, i64) {
    let request_id = request_id.to_owned();
    user_db(state, user, false, move |connection| {
        connection
            .query_row(
                "SELECT cost_usd_nanos,cost_attempts FROM reasoning_audits WHERE openai_lb_request_id=?",
                [request_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(ApiError::internal)
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn a_pass_books_the_answered_amount_and_stops_asking() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "cost-settled").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let (base_url, gateway) =
        spawn_gateway(ledger(&[("req-1", Some(4321)), ("req-2", Some(7))])).await;
    let upstream = insert_upstream(&state, &user, "gateway", &base_url).await;
    seed_audit(&state, &user, &thread.id, &upstream.id, "req-1").await;
    seed_audit(&state, &user, &thread.id, &upstream.id, "req-2").await;

    run_pass(&state).await.unwrap();

    assert_eq!(read_cost(&state, &user, "req-1").await, (Some(4321), 0));
    assert_eq!(read_cost(&state, &user, "req-2").await, (Some(7), 0));
    assert_eq!(gateway.queries.load(Ordering::SeqCst), 1);
    assert_eq!(
        gateway.authorization.lock().unwrap().as_deref(),
        Some("Bearer sk-fixture"),
        "the cost query carries the upstream credential"
    );
    assert_eq!(
        read_thread_for(&state, &user, thread.id.clone())
            .await
            .unwrap()
            .usage
            .cost_usd_nanos,
        4328,
        "the Thread panel reads the settled amount off its own audit rows"
    );

    run_pass(&state).await.unwrap();
    assert_eq!(
        gateway.queries.load(Ordering::SeqCst),
        1,
        "an answered amount is never asked for twice"
    );
}

#[tokio::test]
async fn an_unpriced_or_unrecorded_id_stays_unknown_until_the_budget_runs_out() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "cost-pending").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let (base_url, gateway) = spawn_gateway(ledger(&[("req-pending", None)])).await;
    let upstream = insert_upstream(&state, &user, "gateway", &base_url).await;
    seed_audit(&state, &user, &thread.id, &upstream.id, "req-pending").await;
    seed_audit(&state, &user, &thread.id, &upstream.id, "req-unknown").await;

    run_pass(&state).await.unwrap();
    assert_eq!(read_cost(&state, &user, "req-pending").await, (None, 1));
    assert_eq!(read_cost(&state, &user, "req-unknown").await, (None, 1));
    assert_eq!(gateway.queries.load(Ordering::SeqCst), 1);

    for _ in 0..MAX_ATTEMPTS {
        run_pass(&state).await.unwrap();
    }
    assert_eq!(
        read_cost(&state, &user, "req-pending").await,
        (None, MAX_ATTEMPTS)
    );
    assert_eq!(
        read_cost(&state, &user, "req-unknown").await,
        (None, MAX_ATTEMPTS)
    );
    let queries = gateway.queries.load(Ordering::SeqCst);
    run_pass(&state).await.unwrap();
    assert_eq!(
        gateway.queries.load(Ordering::SeqCst),
        queries,
        "a row that used its attempts is no longer asked about"
    );
}

#[tokio::test]
async fn an_upstream_without_the_contract_never_records_a_cost() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "cost-silent").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let base_url = spawn_silent_host().await;
    let upstream = insert_upstream(&state, &user, "own-endpoint", &base_url).await;
    seed_audit(&state, &user, &thread.id, &upstream.id, "req-1").await;

    run_pass(&state).await.unwrap();

    assert_eq!(read_cost(&state, &user, "req-1").await, (None, 1));
    assert_eq!(
        read_thread_for(&state, &user, thread.id.clone())
            .await
            .unwrap()
            .usage
            .cost_settled_requests,
        0,
        "a Thread on an upstream that never answers shows no amount"
    );
}

#[tokio::test]
async fn a_deleted_upstream_spends_an_attempt_without_asking() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "cost-orphan").unwrap();
    let thread = create_test_thread(&state, &user).await;
    seed_audit(&state, &user, &thread.id, "upstream-deleted", "req-1").await;

    run_pass(&state).await.unwrap();

    assert_eq!(read_cost(&state, &user, "req-1").await, (None, 1));
}
