use super::super::tests::{create_test_thread, insert_upstream, test_state};
use super::*;

#[derive(Default)]
struct Fake {
    bodies: Vec<Value>,
    fail_title: Option<String>,
    invalid_citation: bool,
    tools: bool,
    stream: bool,
    incomplete: bool,
    gate: Option<Arc<tokio::sync::Semaphore>>,
}
fn collect_evidence(value: &Value, ids: &mut Vec<i64>) {
    match value {
        Value::Object(object) => {
            if let Some(id) = object.get("record_id").and_then(Value::as_i64) {
                ids.push(id);
            }
            if let Some(citations) = object.get("evidence").and_then(Value::as_array) {
                ids.extend(citations.iter().filter_map(Value::as_i64));
            }
            for child in object.values() {
                collect_evidence(child, ids);
            }
        }
        Value::Array(values) => {
            for child in values {
                collect_evidence(child, ids);
            }
        }
        _ => {}
    }
}
async fn fake_response(
    State(fake): State<Arc<Mutex<Fake>>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    assert_eq!(body["tool_choice"], "none");
    assert!(body.get("tools").is_none());
    assert!(headers.get(THREAD_ID_HEADER).is_none());
    assert!(headers.get(CODEX_TURN_STATE_HEADER).is_none());
    assert_eq!(body["input"][0]["role"], "developer");
    let text = body["input"][1]["content"].as_str().unwrap();
    let prompt = body["input"][0]["content"].as_str().unwrap();
    assert!(prompt.contains("untrusted historical evidence"));
    let (failure, invalid, tools, stream, incomplete, gate) = {
        let mut fake = fake.lock().await;
        fake.bodies.push(body.clone());
        (
            fake.fail_title
                .as_ref()
                .is_some_and(|t| text.starts_with(&format!("Thread/topic: {t}"))),
            fake.invalid_citation,
            fake.tools,
            fake.stream,
            fake.incomplete,
            fake.gate.clone(),
        )
    };
    if let Some(gate) = gate {
        let _permit = gate.acquire().await.unwrap();
    }
    if failure {
        return (
            StatusCode::BAD_GATEWAY,
            Json(json!({"error":{"message":"fixture upstream unavailable"}})),
        )
            .into_response();
    }
    if tools {
        return Json(json!({"id":"report-tools","status":"completed","output":[{"type":"function_call","name":"bash","call_id":"unsafe","arguments":"{\"command\":\"touch /tmp/forbidden\"}"}]})).into_response();
    }
    let mut ids = Vec::new();
    for line in text.split("SOURCE EVIDENCE:\n").nth(1).unwrap().lines() {
        collect_evidence(&serde_json::from_str::<Value>(line).unwrap(), &mut ids);
    }
    ids.sort();
    ids.dedup();
    ids.truncate(8);
    if invalid {
        ids = vec![999_999_999];
    }
    let keys = if prompt.contains("Thread daily summary") {
        ["goal", "progress", "decisions", "next_steps"]
    } else {
        ["completed", "decisions", "in_progress", "blocked"]
    };
    let document = json!({"sections":keys.iter().enumerate().map(|(i,key)|json!({"key":key,"items":if i==1 && !ids.is_empty(){vec![json!({"text":"Verified fixture result; plans remain plans.","evidence":ids})]}else{vec![]}})).collect::<Vec<_>>()});
    let value = json!({"id":"report-fixture","status":if incomplete {"incomplete"} else {"completed"},"output":[{"type":"message","id":"msg","role":"assistant","content":[{"type":"output_text","text":document.to_string()}]}],"usage":{"input_tokens":100,"output_tokens":30,"input_tokens_details":{"cached_tokens":20}},"incomplete_details":if incomplete {json!({"reason":"max_output_tokens"})} else {Value::Null}});
    if !stream {
        return Json(value).into_response();
    }
    let events = [
        json!({"type":"response.created","response":{"id":"report-fixture","status":"in_progress"}}),
        json!({"type":"response.output_item.added","output_index":0,"item":{"id":"msg","type":"message","role":"assistant","content":[]}}),
        json!({"type":"response.output_text.delta","item_id":"msg","output_index":0,"content_index":0,"delta":document.to_string()}),
        json!({"type":"response.output_item.done","output_index":0,"item":value["output"][0]}),
        json!({"type":if incomplete {"response.incomplete"} else {"response.completed"},"response":value}),
    ];
    let body = events
        .iter()
        .map(|event| format!("data: {event}\n\n"))
        .collect::<String>();
    let fragments = body
        .as_bytes()
        .chunks(7)
        .map(|part| Ok::<_, Infallible>(part.to_vec()))
        .collect::<Vec<_>>();
    (
        [(header::CONTENT_TYPE, "text/event-stream")],
        Body::from_stream(futures_util::stream::iter(fragments)),
    )
        .into_response()
}
async fn fixture() -> (
    tempfile::TempDir,
    AppState,
    User,
    Arc<Mutex<Fake>>,
    tokio::task::JoinHandle<()>,
) {
    let (root, state) = test_state();
    let user = user_for_subject(&state, "report-owner").unwrap();
    let fake = Arc::new(Mutex::new(Fake::default()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let router = Router::new()
        .route("/responses", post(fake_response))
        .with_state(fake.clone());
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let upstream = insert_upstream(&state, &user, "report-model", &url).await;
    user_db(&state,&user,true,move|c|{
        c.execute("INSERT INTO thread_defaults(id,model,upstream_id,reasoning_effort,service_tier_fast) VALUES(1,'fixture-model',?,'medium',0)",[upstream.id])?;Ok(())
    }).await.unwrap();
    (root, state, user, fake, server)
}
fn date() -> NaiveDate {
    report_date(Some("2026-09-26")).unwrap()
}
async fn evidence(state: &AppState, user: &User, title: &str) -> (String, i64) {
    let thread = create_test_thread(state, user).await;
    let id = thread.id.clone();
    let title = title.to_owned();
    let record=user_db(state,user,false,move|c|{
        c.execute("UPDATE threads SET title=? WHERE id=?",params![title,id])?;
        let (start,_)=utc_day_bounds(date());
        persist_history_record(c,HistoryRecordInsert{thread_id:&id,kind:"input",payload:&json!({"role":"user","content":"Deploy the feature; do not claim success until verified."}),created_at:start+1})
    }).await.unwrap();
    (thread.id, record)
}
fn identity(user: &User) -> axum::Extension<BrowserIdentity> {
    axum::Extension(BrowserIdentity {
        user: user.clone(),
        bearer: String::new(),
    })
}
async fn begin(state: &AppState, user: &User, thread: Option<String>) -> Job {
    begin_language(state, user, thread, "zh").await
}
async fn begin_language(
    state: &AppState,
    user: &User,
    thread: Option<String>,
    language: &str,
) -> Job {
    generate(
        State(state.clone()),
        identity(user),
        AxumPath(date().to_string()),
        Json(GenerateInput {
            thread_id: thread,
            language: language.to_owned(),
        }),
    )
    .await
    .unwrap()
    .1
    .0
}
async fn wait(state: &AppState, user: &User, id: i64) -> Job {
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let item = user_db(state, user, false, move |c| job(c, id))
                .await
                .unwrap();
            if item.status != "running" {
                return item;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap()
}
async fn read(state: &AppState, user: &User) -> DailyReport {
    daily_report(
        State(state.clone()),
        identity(user),
        Query(DailyReportQuery {
            date: Some(date().to_string()),
        }),
    )
    .await
    .unwrap()
    .0
}

#[tokio::test]
async fn generates_persists_reuses_and_invalidates_thread_and_daily_summaries_without_thread_side_effects()
 {
    let (_root, state, user, fake, server) = fixture().await;
    let (first, record) = evidence(&state, &user, "First").await;
    let _ = evidence(&state, &user, "Second").await;
    let before = read(&state, &user).await;
    assert!(fake.lock().await.bodies.is_empty(), "GET must never infer");
    assert!(before.summary.saved.is_none());
    let initial = begin(&state, &user, None).await;
    assert_eq!(wait(&state, &user, initial.id).await.status, "completed");
    let report = read(&state, &user).await;
    assert_eq!(fake.lock().await.bodies.len(), 3);
    assert!(!report.summary.stale);
    let daily_id = report.summary.saved.as_ref().unwrap().id;
    for t in &report.threads {
        let saved = t.daily_summary.as_ref().unwrap().saved.as_ref().unwrap();
        assert_eq!(saved.input_tokens, 100);
        assert_eq!(saved.output_tokens, 30);
        assert_eq!(saved.model, "fixture-model");
        assert_eq!(saved.prompt_version, 1);
    }
    assert_eq!(report.activity_records, before.activity_records);
    assert_eq!(report.total_tokens, before.total_tokens);
    let counts=user_db(&state,&user,false,|c|Ok(c.query_row("SELECT (SELECT COUNT(*) FROM worker_calls),(SELECT COUNT(*) FROM reasoning_audits),(SELECT COUNT(*) FROM response_states),(SELECT COUNT(*) FROM threads WHERE status<>'idle')",[],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,i64>(1)?,r.get::<_,i64>(2)?,r.get::<_,i64>(3)?)))?)).await.unwrap();
    assert_eq!(counts, (0, 0, 0, 0));
    let reused = begin(&state, &user, None).await;
    assert_eq!(wait(&state, &user, reused.id).await.status, "completed");
    assert_eq!(fake.lock().await.bodies.len(), 3);
    assert_eq!(
        read(&state, &user).await.summary.saved.unwrap().id,
        daily_id
    );
    let changed = first.clone();
    user_db(&state,&user,false,move|c|{
        let (start,_)=utc_day_bounds(date());
        persist_history_record(c,HistoryRecordInsert{thread_id:&changed,kind:"response_output",payload:&json!({"type":"message","content":[{"type":"output_text","text":"Deployment health check passed."}]}),created_at:start+9})?;Ok(())
    }).await.unwrap();
    let stale = read(&state, &user).await;
    assert!(stale.summary.stale);
    assert!(
        stale
            .threads
            .iter()
            .find(|t| t.id == first)
            .unwrap()
            .daily_summary
            .as_ref()
            .unwrap()
            .stale
    );
    let thread_job = begin(&state, &user, Some(first.clone())).await;
    assert_eq!(wait(&state, &user, thread_job.id).await.status, "completed");
    assert_eq!(fake.lock().await.bodies.len(), 4);
    assert!(read(&state, &user).await.summary.stale);
    let updated = begin(&state, &user, None).await;
    assert_eq!(wait(&state, &user, updated.id).await.status, "completed");
    assert_eq!(fake.lock().await.bodies.len(), 5);
    let fresh = read(&state, &user).await;
    assert!(!fresh.summary.stale);
    assert_ne!(fresh.summary.saved.unwrap().id, daily_id);
    let old = read_summary(State(state.clone()), identity(&user), AxumPath(daily_id))
        .await
        .unwrap()
        .0;
    assert!(old.content.is_some());
    assert!(
        old.source_manifest["records"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["id"] == record)
    );
    user_db(&state, &user, false, move |c| {
        c.execute("DELETE FROM threads WHERE id=?", [first])?;
        Ok(())
    })
    .await
    .unwrap();
    assert_eq!(
        read_summary(State(state.clone()), identity(&user), AxumPath(daily_id))
            .await
            .err()
            .unwrap()
            .status,
        StatusCode::NOT_FOUND
    );
    server.abort();
}

#[tokio::test]
async fn failures_are_independent_retry_reuses_successes_and_bad_citations_do_not_become_saved_summaries()
 {
    let (_root, state, user, fake, server) = fixture().await;
    let (first, _) = evidence(&state, &user, "Fails").await;
    evidence(&state, &user, "Succeeds").await;
    fake.lock().await.fail_title = Some("Fails".to_owned());
    let initial = begin(&state, &user, None).await;
    assert_eq!(wait(&state, &user, initial.id).await.status, "failed");
    let report = read(&state, &user).await;
    assert!(report.summary.saved.is_none());
    assert_eq!(
        report
            .threads
            .iter()
            .filter(|t| t.daily_summary.as_ref().unwrap().saved.is_some())
            .count(),
        1
    );
    fake.lock().await.fail_title = None;
    fake.lock().await.invalid_citation = true;
    let bad = begin(&state, &user, Some(first.clone())).await;
    assert_eq!(wait(&state, &user, bad.id).await.status, "failed");
    let report = read(&state, &user).await;
    let bad = report
        .threads
        .iter()
        .find(|t| t.id == first)
        .unwrap()
        .daily_summary
        .as_ref()
        .unwrap();
    assert!(bad.saved.is_none());
    let attempt = bad.latest.as_ref().unwrap();
    assert_eq!(attempt.status, "failed");
    assert_eq!(attempt.input_tokens, 100);
    assert!(attempt.error.as_ref().unwrap().contains("outside"));
    fake.lock().await.invalid_citation = false;
    let retry = begin(&state, &user, None).await;
    assert_eq!(wait(&state, &user, retry.id).await.status, "completed");
    assert_eq!(
        fake.lock().await.bodies.len(),
        5,
        "one failure, one success, invalid output, then failed Thread + daily only"
    );
    server.abort();
}

#[tokio::test]
async fn duplicate_posts_share_a_job_reload_is_read_only_and_midflight_activity_marks_saved_result_stale()
 {
    let (_root, state, user, fake, server) = fixture().await;
    let (thread, _) = evidence(&state, &user, "Live").await;
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    fake.lock().await.gate = Some(gate.clone());
    let first = begin(&state, &user, Some(thread.clone())).await;
    let again = begin(&state, &user, Some(thread.clone())).await;
    assert_eq!(first.id, again.id);
    let conflict = generate(
        State(state.clone()),
        identity(&user),
        AxumPath("2026-09-25".to_owned()),
        Json(GenerateInput {
            thread_id: None,
            language: "zh".to_owned(),
        }),
    )
    .await;
    assert_eq!(conflict.err().unwrap().status, StatusCode::CONFLICT);
    assert_eq!(
        read(&state, &user).await.generation.running_job.unwrap().id,
        first.id
    );
    user_db(&state, &user, false, move |c| {
        let (start, _) = utc_day_bounds(date());
        persist_history_record(
            c,
            HistoryRecordInsert {
                thread_id: &thread,
                kind: "activity",
                payload: &json!({"content":"a new event"}),
                created_at: start + 99,
            },
        )?;
        Ok(())
    })
    .await
    .unwrap();
    gate.add_permits(1);
    assert_eq!(wait(&state, &user, first.id).await.status, "completed");
    assert!(
        read(&state, &user).await.threads[0]
            .daily_summary
            .as_ref()
            .unwrap()
            .stale
    );
    server.abort();
}

#[tokio::test]
async fn tool_outputs_are_never_executed_and_restart_unlocks_manual_retry() {
    let (_root, state, user, fake, server) = fixture().await;
    let (thread, _) = evidence(&state, &user, "Tools").await;
    fake.lock().await.tools = true;
    let attempt = begin(&state, &user, Some(thread.clone())).await;
    assert_eq!(wait(&state, &user, attempt.id).await.status, "failed");
    let report = read(&state, &user).await;
    assert!(
        report.threads[0]
            .daily_summary
            .as_ref()
            .unwrap()
            .latest
            .as_ref()
            .unwrap()
            .error
            .as_ref()
            .unwrap()
            .contains("no tool was executed")
    );
    user_db(&state, &user, false, move |c| {
        c.execute(
            "UPDATE report_jobs SET status='running',finished_at=NULL WHERE id=?",
            [attempt.id],
        )?;
        c.execute(
            "UPDATE report_summaries SET status='running' WHERE job_id=?",
            [attempt.id],
        )?;
        c.execute("UPDATE report_requests SET status='running'", [])?;
        recover(c)?;
        assert!(running_job(c)?.is_none());
        assert_eq!(
            c.query_row(
                "SELECT COUNT(*) FROM report_requests WHERE status='running'",
                [],
                |r| r.get::<_, i64>(0)
            )?,
            0
        );
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM worker_calls", [], |r| r
                .get::<_, i64>(0))?,
            0
        );
        Ok(())
    })
    .await
    .unwrap();
    fake.lock().await.tools = false;
    let retried = begin(&state, &user, Some(thread)).await;
    assert_eq!(wait(&state, &user, retried.id).await.status, "completed");
    server.abort();
}

#[tokio::test]
async fn auth_ownership_empty_days_strict_dates_and_full_calendar_boundaries() {
    let (_root, state, user, fake, server) = fixture().await;
    let (thread, _) = evidence(&state, &user, "Private").await;
    let other = user_for_subject(&state, "report-other").unwrap();
    let empty = read(&state, &other).await;
    assert_eq!(empty.active_thread_count, 0);
    assert!(begin_empty(&state, &other, None).await.status == StatusCode::BAD_REQUEST);
    assert_eq!(
        begin_empty(&state, &other, Some(thread)).await.status,
        StatusCode::NOT_FOUND
    );
    let job = begin(&state, &user, None).await;
    wait(&state, &user, job.id).await;
    let id = read(&state, &user).await.summary.saved.unwrap().id;
    assert_eq!(
        read_summary(State(state.clone()), identity(&other), AxumPath(id))
            .await
            .err()
            .unwrap()
            .status,
        StatusCode::NOT_FOUND
    );
    for invalid in [
        "",
        "2026-02-30",
        "2026-9-26",
        "2026-09-26x",
        "+262142-12-31",
        " 2026-09-26",
    ] {
        assert!(report_date(Some(invalid)).is_err(), "{invalid}");
    }
    user_db(&state, &user, false, |c| {
        let (start, end) = utc_day_bounds(date());
        let activity = load_insight_activity(c, Some(start + 3600), end - 1)?;
        let detail = load_daily_report(c, date())?;
        assert_eq!(activity.days[0].active_threads, detail.active_thread_count);
        assert_eq!(activity.days[0].activity_records, detail.activity_records);
        Ok(())
    })
    .await
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let router = app(state.clone());
    let auth_server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    for path in [
        "/api/reports/daily?date=2026-09-26",
        "/api/reports/summaries/1",
    ] {
        assert_eq!(
            reqwest::get(format!("{base}{path}"))
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
    }
    assert_eq!(
        reqwest::Client::new()
            .post(format!("{base}/api/reports/daily/2026-09-26/generate"))
            .json(&json!({"language":"zh"}))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(fake.lock().await.bodies.len(), 2);
    auth_server.abort();
    server.abort();
}
async fn begin_empty(state: &AppState, user: &User, thread: Option<String>) -> ApiError {
    generate(
        State(state.clone()),
        identity(user),
        AxumPath(date().to_string()),
        Json(GenerateInput {
            thread_id: thread,
            language: "zh".to_owned(),
        }),
    )
    .await
    .err()
    .unwrap()
}

#[tokio::test]
async fn large_thread_day_summarizes_all_fragments_before_reducing_and_keeps_prior_input_as_background()
 {
    let (_root, state, user, fake, server) = fixture().await;
    let (thread, _) = evidence(&state, &user, "Large").await;
    let copy = thread.clone();
    let (background,large)=user_db(&state,&user,false,move|c|{
        let(start,_)=utc_day_bounds(date());
        let before=persist_history_record(c,HistoryRecordInsert{thread_id:&copy,kind:"input",payload:&json!({"role":"user","content":"Yesterday's result must not be reported as today's achievement."}),created_at:start-1})?;
        let large=persist_history_record(c,HistoryRecordInsert{thread_id:&copy,kind:"tool_output",payload:&json!({"output":"部署结果".repeat(90000)}),created_at:start+2})?;
        Ok((before,large))
    }).await.unwrap();
    let initial = begin(&state, &user, Some(thread)).await;
    assert_eq!(wait(&state, &user, initial.id).await.status, "completed");
    let bodies = &fake.lock().await.bodies;
    assert!(bodies.len() > 2);
    for body in bodies {
        assert!(body["input"][1]["content"].as_str().unwrap().len() < 208 * 1024);
    }
    let report = read(&state, &user).await;
    let saved = report.threads[0]
        .daily_summary
        .as_ref()
        .unwrap()
        .saved
        .as_ref()
        .unwrap();
    assert_eq!(saved.source_manifest["background_input_id"], background);
    assert!(source::citations(saved.content.as_ref().unwrap()).contains(&large));
    assert!(!source::citations(saved.content.as_ref().unwrap()).contains(&background));
    server.abort();
}

#[tokio::test]
async fn streaming_completion_is_required_and_report_traffic_is_attributed_without_thread_audits() {
    let (_root, state, user, fake, server) = fixture().await;
    let (thread, _) = evidence(&state, &user, "SSE").await;
    fake.lock().await.stream = true;
    let first = begin(&state, &user, Some(thread.clone())).await;
    assert_eq!(wait(&state, &user, first.id).await.status, "completed");
    let initial = read(&state, &user)
        .await
        .threads
        .remove(0)
        .daily_summary
        .unwrap()
        .saved
        .unwrap();
    assert_eq!(initial.input_tokens, 100);
    let traffic = state.traffic.snapshot(&user.id).unwrap();
    assert!(traffic.upstream_received_bytes > 0);
    assert!(traffic.upstream_sent_bytes > 0);
    assert_eq!(traffic.worker_received_bytes, 0);
    assert_eq!(traffic.worker_sent_bytes, 0);
    fake.lock().await.incomplete = true;
    let failed = begin_language(&state, &user, Some(thread), "en").await;
    assert_eq!(wait(&state, &user, failed.id).await.status, "failed");
    let current = read(&state, &user)
        .await
        .threads
        .remove(0)
        .daily_summary
        .unwrap();
    assert_eq!(current.saved.unwrap().id, initial.id);
    assert_eq!(current.latest.unwrap().status, "failed");
    user_db(&state, &user, false, |c| {
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM reasoning_audits", [], |r| r
                .get::<_, i64>(0))?,
            0
        );
        assert_eq!(
            c.query_row(
                "SELECT COUNT(*) FROM report_requests WHERE status='failed'",
                [],
                |r| r.get::<_, i64>(0)
            )?,
            1
        );
        Ok(())
    })
    .await
    .unwrap();
    server.abort();
}

#[tokio::test]
async fn cache_keys_include_language_model_upstream_id_and_url_and_failed_updates_keep_success() {
    let (_root, state, user, fake, server) = fixture().await;
    let (thread, _) = evidence(&state, &user, "Cache").await;
    for language in ["zh", "en", "zh"] {
        let job = begin_language(&state, &user, Some(thread.clone()), language).await;
        assert_eq!(wait(&state, &user, job.id).await.status, "completed");
    }
    assert_eq!(fake.lock().await.bodies.len(), 3);
    user_db(&state, &user, false, |c| {
        c.execute("UPDATE thread_defaults SET model='another-model'", [])?;
        Ok(())
    })
    .await
    .unwrap();
    let job = begin(&state, &user, Some(thread.clone())).await;
    assert_eq!(wait(&state, &user, job.id).await.status, "completed");
    assert_eq!(fake.lock().await.bodies.len(), 4);
    user_db(&state,&user,false,|c| {
        c.execute("INSERT INTO upstreams(id,name,base_url,api_key,created_at,updated_at) SELECT 'new-upstream','new name',base_url,api_key,created_at,updated_at FROM upstreams LIMIT 1",[])?;
        c.execute("UPDATE thread_defaults SET upstream_id='new-upstream'",[])?; Ok(())
    }).await.unwrap();
    let job = begin(&state, &user, Some(thread.clone())).await;
    assert_eq!(wait(&state, &user, job.id).await.status, "completed");
    assert_eq!(fake.lock().await.bodies.len(), 5);
    user_db(&state, &user, false, |c| {
        c.execute(
            "UPDATE upstreams SET base_url=base_url||'/' WHERE id='new-upstream'",
            [],
        )?;
        Ok(())
    })
    .await
    .unwrap();
    let job = begin(&state, &user, Some(thread.clone())).await;
    assert_eq!(wait(&state, &user, job.id).await.status, "completed");
    assert_eq!(fake.lock().await.bodies.len(), 6);
    let previous = read(&state, &user)
        .await
        .threads
        .remove(0)
        .daily_summary
        .unwrap()
        .saved
        .unwrap();
    let copy = thread.clone();
    user_db(&state, &user, false, move |c| {
        c.execute(
            "UPDATE threads SET title='Changed title' WHERE id=?",
            [copy],
        )?;
        Ok(())
    })
    .await
    .unwrap();
    fake.lock().await.invalid_citation = true;
    let job = begin(&state, &user, Some(thread.clone())).await;
    assert_eq!(wait(&state, &user, job.id).await.status, "failed");
    let current = read(&state, &user)
        .await
        .threads
        .remove(0)
        .daily_summary
        .unwrap();
    assert!(current.stale);
    assert_eq!(current.saved.unwrap().id, previous.id);
    let failure = current.latest.unwrap();
    assert_eq!(failure.status, "failed");
    assert_eq!(failure.input_tokens, 100);
    fake.lock().await.invalid_citation = false;
    let retry = begin(&state, &user, Some(thread)).await;
    assert_eq!(wait(&state, &user, retry.id).await.status, "completed");
    assert_eq!(fake.lock().await.bodies.len(), 8);
    server.abort();
}

#[tokio::test]
async fn schema_17_upgrade_preserves_history_settings_and_foreign_keys() {
    let (_root, state, user, _fake, server) = fixture().await;
    let (thread, record) = evidence(&state, &user, "Preserved").await;
    let mut c = Connection::open(&user.path).unwrap();
    c.execute_batch("DROP TRIGGER reports_delete_derived_day; DROP TABLE report_requests; DROP TABLE report_summaries; DROP TABLE report_jobs; PRAGMA user_version=17;").unwrap();
    let before = c
        .query_row(
            "SELECT payload FROM history_records WHERE id=?",
            [record],
            |r| r.get::<_, String>(0),
        )
        .unwrap();
    ensure_user_schema(&mut c).unwrap();
    ensure_user_schema(&mut c).unwrap();
    assert_eq!(
        c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        18
    );
    assert_eq!(
        c.query_row(
            "SELECT payload FROM history_records WHERE id=?",
            [record],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        before
    );
    assert_eq!(
        c.query_row("SELECT title FROM threads WHERE id=?", [thread], |r| r
            .get::<_, String>(
            0
        ))
        .unwrap(),
        "Preserved"
    );
    assert_eq!(load_thread_defaults(&c).unwrap().model, "fixture-model");
    check_user_foreign_keys(&c).unwrap();
    for table in ["report_jobs", "report_summaries", "report_requests"] {
        assert_eq!(
            c.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    server.abort();
}

#[tokio::test]
async fn binary_projection_and_evidence_limits_are_explicit_and_deleted_snapshots_fail() {
    let (_root, state, user, _fake, server) = fixture().await;
    let (thread, record) = evidence(&state, &user, "Projection").await;
    user_db(&state,&user,false,move|c| {
        let(start,_)=utc_day_bounds(date());
        let media=persist_history_record(c,HistoryRecordInsert{thread_id:&thread,kind:"response_output",created_at:start+2,payload:&json!({"type":"image_generation_call","result":"SECRET_BINARY","encrypted_content":"SECRET_ENCRYPTED","file_data":"SECRET_FILE","input":{"image_url":"data:image/png;base64,SECRET_IMAGE"},"text":"Readable outcome"})})?;
        let screenshot = persist_history_record(c,HistoryRecordInsert{thread_id:&thread,kind:"tool_output",created_at:start+3,payload:&json!({"type":"function_call_output","call_id":"screenshot-call","output":json!({"data":"SECRET_SCREENSHOT".repeat(10000),"width":390}).to_string()})})?;
        c.execute("INSERT INTO workers(id,label,token_hash,created_at) VALUES('report-test-worker','fixture','fixture-hash',?)",[start])?;
        c.execute("INSERT INTO worker_calls(id,worker_id,thread_id,name,arguments_json,status,created_at,output_record_id) VALUES('screenshot-call','report-test-worker',?,'browser_control',?, 'completed',?,?)",params![thread,json!({"action":"screenshot"}).to_string(),start,screenshot])?;
        let source=thread_source(c,date(),&thread)?;
        let (units,_) = source::units(c,&source)?;
        let text=units.iter().map(|u|u.text.as_str()).collect::<String>();
        assert!(!text.contains("SECRET_"));
        assert!(text.contains("omitted"));
        assert!(text.contains("Readable outcome"));
        assert!(units.iter().any(|u|u.evidence.contains(&media)));
        assert!(units.iter().any(|u|u.evidence.contains(&screenshot) && u.text.contains("binary screenshot omitted") && u.text.contains("390")));
        c.execute("DELETE FROM history_records WHERE id=?",[record])?;
        assert_eq!(source::units(c,&source).err().unwrap().status,StatusCode::CONFLICT);
        // Oversized retained evidence must fail before sending any model call.
        c.execute("INSERT INTO history_records(thread_id,kind,payload,created_at) VALUES(?,'tool_output',?,?)",params![thread,"x".repeat(16*1024*1024+1),start+3])?;
        let source=thread_source(c,date(),&thread)?;
        assert!(source::units(c,&source).err().unwrap().message.contains("16 MiB"));
        Ok(())
    }).await.unwrap();
    server.abort();
}

#[test]
#[ignore = "bounded manual retained-history performance probe"]
fn daily_report_retained_history_probe() {
    let root = tempfile::tempdir().unwrap();
    let mut c = open_user(&root.path().join("probe.sqlite3"), true).unwrap();
    let (start, _) = utc_day_bounds(date());
    let tx = c.transaction().unwrap();
    for index in 0..100 {
        tx.execute("INSERT INTO threads(id,title,model,status,created_at,updated_at) VALUES(?,?,'probe','idle',?,?)",params![format!("t{index}"),format!("Thread {index}"),start,start]).unwrap();
    }
    tx.commit().unwrap();
    let mut previous = 0;
    for total in [10_000, 20_000, 40_000, 80_000] {
        let tx = c.transaction().unwrap();
        {
            let mut insert=tx.prepare("INSERT INTO history_records(thread_id,kind,payload,created_at) VALUES(?,'input',?,?)").unwrap();
            for index in previous..total {
                let created = start + if index % 5 == 0 { 1 } else { -86400 };
                insert
                    .execute(params![
                        format!("t{}", index % 100),
                        json!({"role":"user","content":format!("Record {index}")}).to_string(),
                        created
                    ])
                    .unwrap();
            }
        }
        tx.commit().unwrap();
        let tx = c.transaction().unwrap();
        tx.execute("INSERT INTO report_jobs(date,language,status,total_threads,started_at,finished_at) VALUES(?,'zh','completed',20,?,?)",params![date().to_string(),start,start]).unwrap();
        let job_id = tx.last_insert_rowid();
        let save = |source: Source| {
            let keys = if source.thread_id.is_some() {
                vec!["goal", "progress", "decisions", "next_steps"]
            } else {
                vec!["completed", "decisions", "in_progress", "blocked"]
            };
            let document = json!({"sections":keys.into_iter().map(|key|json!({"key":key,"items":[]})).collect::<Vec<_>>()});
            tx.execute("INSERT INTO report_summaries(job_id,date,thread_id,source_fingerprint,source_manifest,prompt_version,model,upstream_id,upstream_name,upstream_url,language,status,content_json,started_at,finished_at) VALUES(?,?,?,?,?,1,'probe','probe','probe','https://example.test','zh','completed',?,?,?)",params![job_id,source.date,source.thread_id,source.fingerprint,serde_json::to_string(&source.manifest).unwrap(),document.to_string(),start,start]).unwrap();
        };
        for thread in source::active_threads(&tx, date()).unwrap() {
            save(thread_source(&tx, date(), &thread).unwrap());
        }
        save(daily_source(&tx, date()).unwrap());
        tx.commit().unwrap();
        let began = std::time::Instant::now();
        let tx = c.transaction().unwrap();
        let report = load_daily_report(&tx, date()).unwrap();
        let output = serde_json::to_vec(&report).unwrap();
        assert_eq!(report.activity_records, total / 5);
        println!(
            "REPORT_PERF retained_records={total} day_records={} elapsed_ms={} response_bytes={}",
            total / 5,
            began.elapsed().as_millis(),
            output.len()
        );
        assert!(began.elapsed() < Duration::from_secs(3));
        previous = total;
    }
}

#[tokio::test]
async fn multi_megabyte_text_day_fits_bounded_chunks_without_dropping_the_tail() {
    let (_root, state, user, fake, server) = fixture().await;
    let (thread, _) = evidence(&state, &user, "Retained-scale").await;
    let copy = thread.clone();
    let last=user_db(&state,&user,false,move|c| {
        let (start,_) = utc_day_bounds(date());
        persist_history_record(c,HistoryRecordInsert{thread_id:&copy,kind:"tool_output",created_at:start+2,payload:&json!({"output":format!("{}TAIL_EVIDENCE_RETAINED", "build log abc def ".repeat(370000))})})
    }).await.unwrap();
    let job = begin(&state, &user, Some(thread)).await;
    assert_eq!(wait(&state, &user, job.id).await.status, "completed");
    let bodies = &fake.lock().await.bodies;
    assert!(bodies.len() > 32 && bodies.len() <= 128);
    assert!(bodies.iter().any(|body| {
        body["input"][1]["content"]
            .as_str()
            .unwrap()
            .contains("TAIL_EVIDENCE_RETAINED")
    }));
    for body in bodies {
        assert!(body["input"][1]["content"].as_str().unwrap().len() < 208 * 1024);
    }
    let saved = read(&state, &user)
        .await
        .threads
        .remove(0)
        .daily_summary
        .unwrap()
        .saved
        .unwrap();
    assert!(source::citations(saved.content.as_ref().unwrap()).contains(&last));
    server.abort();
}
