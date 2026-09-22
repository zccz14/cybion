use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn decode(value: Value) -> Vec<ResponseEvent> {
    let (events, error) = EventDecoder::default().decode(&value.to_string()).unwrap();
    assert!(error.is_none(), "{error:?}");
    events
}

fn item(value: Value) -> ResponseItem {
    ResponseItem::from_value(value).unwrap()
}

#[test]
fn every_codex_sse_handler_emits_its_semantic_event() {
    // One fixture for every non-error arm of Codex process_responses_event.
    let fixtures = [
        (
            json!({"type":"response.created","response":{"id":"r"}}),
            "created",
        ),
        (
            json!({"type":"response.output_item.added","item":{"type":"message","role":"assistant","content":[]}}),
            "output_item_added",
        ),
        (
            json!({"type":"response.output_item.done","item":{"type":"reasoning","summary":[],"encrypted_content":"encrypted"}}),
            "output_item_done",
        ),
        (
            json!({"type":"response.output_text.delta","delta":"text"}),
            "output_text_delta",
        ),
        (
            json!({"type":"response.custom_tool_call_input.delta","call_id":"c","delta":"patch"}),
            "tool_call_input_delta",
        ),
        (
            json!({"type":"response.reasoning_summary_text.delta","summary_index":0,"delta":"summary"}),
            "reasoning_summary_delta",
        ),
        (
            json!({"type":"response.reasoning_summary_text.done","item_id":"rs","summary_index":0,"text":"summary"}),
            "reasoning_summary_done",
        ),
        (
            json!({"type":"response.reasoning_text.delta","content_index":0,"delta":"reasoning"}),
            "reasoning_content_delta",
        ),
        (
            json!({"type":"response.reasoning_summary_part.added","summary_index":0}),
            "reasoning_summary_part_added",
        ),
        (
            json!({"type":"response.completed","response":{"id":"r","end_turn":false,"usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5}}}),
            "completed",
        ),
    ];
    for (wire, expected) in fixtures {
        let events = decode(wire.clone());
        assert_eq!(events.len(), 1, "{wire}");
        assert_eq!(json!(events[0])["type"], expected, "{wire}");
    }
    let events = decode(
        json!({"type":"response.custom_tool_call_input.delta","call_id":"c","delta":"patch"}),
    );
    assert!(
        matches!(&events[0], ResponseEvent::ToolCallInputDelta { item_id, call_id: Some(call_id), .. } if item_id == "c" && call_id == "c")
    );
}

#[test]
fn every_codex_response_item_has_typed_fields_and_survives_replay() {
    let fixtures = [
        json!({"type":"additional_tools","role":"developer","tools":[]}),
        json!({"type":"message","role":"assistant","phase":"commentary","content":[{"type":"output_text","text":"x","annotations":[{"type":"url_citation","url":"https://example.com"}]}]}),
        json!({"type":"agent_message","author":"a","recipient":"b","content":[{"type":"encrypted_content","encrypted_content":"secret"}]}),
        json!({"type":"reasoning","summary":[{"type":"summary_text","text":"s"}],"content":[{"type":"text","text":"r"}],"encrypted_content":"cipher"}),
        json!({"type":"local_shell_call","status":"completed","action":{"type":"exec","command":["pwd"]}}),
        json!({"type":"function_call","name":"bash","namespace":"functions","call_id":"c","arguments":"{}","encrypted_function_args":["cipher"]}),
        json!({"type":"tool_search_call","execution":"client","arguments":{"query":"bash"}}),
        json!({"type":"function_call_output","call_id":"c","output":[{"type":"input_text","text":"ok"},{"type":"input_image","image_url":"data:image/png;base64,AA","detail":"original"},{"type":"input_audio","audio_url":"data:audio/wav;base64,AA"},{"type":"encrypted_content","encrypted_content":"cipher"}]}),
        json!({"type":"custom_tool_call","name":"apply_patch","call_id":"c","input":"patch"}),
        json!({"type":"custom_tool_call_output","call_id":"c","output":"ok"}),
        json!({"type":"tool_search_output","execution":"client","status":"completed","tools":[]}),
        json!({"type":"web_search_call","action":{"type":"search","queries":["a","b"]}}),
        json!({"type":"image_generation_call","status":"completed","result":"base64"}),
        json!({"type":"compaction","encrypted_content":"cipher"}),
        json!({"type":"configuration_update","reasoning":{"effort":"xhigh"}}),
        json!({"type":"compaction_trigger"}),
        json!({"type":"context_compaction","encrypted_content":"cipher"}),
        json!({"type":"future_item","future_field":{"keep":true}}),
    ];
    for mut wire in fixtures {
        wire["future_field"] = json!({"keep":true});
        let parsed = item(wire.clone());
        let restored = item(parsed.value());
        assert_eq!(restored, parsed);
        assert_eq!(restored.value()["future_field"], wire["future_field"]);
        assert_eq!(restored.kind(), wire["type"].as_str().unwrap());
    }
    for invalid in [
        json!({"type":"function_call","id":"not-a-call-id","name":"bash","arguments":"{}"}),
        json!({"type":"function_call","call_id":"c","name":"bash","arguments":{}}),
        json!({"type":"message","role":"assistant","content":"not-an-array"}),
        json!({"type":"reasoning","summary":"not-an-array"}),
        json!({"type":"custom_tool_call","call_id":123,"name":"tool","input":"x"}),
    ] {
        assert!(ResponseItem::from_value(invalid).is_err());
    }
}

#[test]
fn metadata_is_processed_even_on_otherwise_ignored_events() {
    let mut decoder = EventDecoder {
        faster_model: Some("fast".to_owned()),
        ..Default::default()
    };
    let wire = json!({"type":"response.metadata","headers":{"X-OpenAI-Model":["routed"],"X-Codex-Turn-State":"sticky"},"metadata":{"openai_verification_recommendation":["unknown","trusted_access_for_cyber","trusted_access_for_cyber"],"openai_chatgpt_moderation_metadata":{"flag":true}},"safety_buffering":{"use_cases":["code"],"reasons":["review"]}});
    let (events, error) = decoder.decode(&wire.to_string()).unwrap();
    assert!(error.is_none());
    let mut state = ResponseState::default();
    for event in &events {
        state.apply(event).unwrap();
    }
    assert_eq!(state.server_model.as_deref(), Some("routed"));
    assert_eq!(state.turn_state.as_deref(), Some("sticky"));
    assert_eq!(
        state.model_verifications,
        vec![ModelVerification::TrustedAccessForCyber]
    );
    assert_eq!(state.moderation_metadata.unwrap()["flag"], true);
    assert_eq!(
        state.safety_buffering.unwrap().faster_model.as_deref(),
        Some("fast")
    );
    let (events, _) = decoder.decode(&wire.to_string()).unwrap();
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, ResponseEvent::ServerModel(_)))
    );
    let events = decode(
        json!({"type":"response.created","headers":{"OpenAI-Model":"lower-priority"},"response":{"id":"r","headers":{"openai-model":["winner"]}}}),
    );
    assert_eq!(
        json!(events[0]),
        json!({"type":"server_model","data":"winner"})
    );
    for name in [
        "codex.response.metadata",
        "response.content_part.added",
        "response.content_part.done",
        "response.in_progress",
        "response.reasoning_summary_part.done",
        "responsesapi.websocket_timing",
        "response.new_tool_event",
        "response.refusal.delta",
        "response.mcp_call_arguments.delta",
        "unrecognized.event",
    ] {
        let events = decode(json!({"type":name,"headers":{"openai-model":"routed"}}));
        assert!(
            matches!(&events[0], ResponseEvent::ServerModel(model) if model == "routed"),
            "{name}"
        );
        assert!(decode(json!({"type":name})).is_empty());
    }
}

#[test]
fn safety_buffering_presence_and_fallback_match_codex() {
    let metadata = json!({"type":"safety_buffering","use_cases":[],"reasons":["check"]});
    let mut decoder = EventDecoder {
        faster_model: Some("fast".to_owned()),
        ..Default::default()
    };
    let (events, _) = decoder
        .decode(&json!({"type":"response.metadata","metadata":metadata}).to_string())
        .unwrap();
    assert!(
        matches!(&events[0], ResponseEvent::SafetyBuffering(value) if value.faster_model.as_deref() == Some("fast") && value.show_buffering_ui)
    );
    let (events, _) = decoder
        .decode(
            &json!({"type":"response.metadata","metadata":metadata,"safety_buffering":null})
                .to_string(),
        )
        .unwrap();
    assert!(events.is_empty(), "explicit null disables the fallback");
    let (events, _) = decoder.decode(&json!({"type":"response.created","safety_buffering":{"use_cases":[],"reasons":[],"retry_model":null}}).to_string()).unwrap();
    assert!(
        matches!(&events[0], ResponseEvent::SafetyBuffering(value) if value.faster_model.is_none())
    );
}

#[test]
fn all_header_notifications_reach_thread_state() {
    let mut headers = HeaderMap::new();
    for (name, value) in [
        ("openai-model", "routed"),
        ("x-models-etag", "etag"),
        ("x-request-id", "request"),
        ("x-codex-turn-state", "sticky"),
        ("x-reasoning-included", "true"),
        ("x-codex-primary-used-percent", "20"),
        ("x-codex-primary-window-minutes", "60"),
        ("x-codex-credits-has-credits", "true"),
        ("x-codex-credits-unlimited", "false"),
        ("x-codex-secondary-primary-used-percent", "80"),
    ] {
        headers.insert(name, value.parse().unwrap());
    }
    let mut state = ResponseState::default();
    for event in header_events(&headers) {
        state.apply(&event).unwrap();
    }
    assert_eq!(state.server_model.as_deref(), Some("routed"));
    assert_eq!(state.models_etag.as_deref(), Some("etag"));
    assert_eq!(state.request_id.as_deref(), Some("request"));
    assert!(state.reasoning_included);
    assert_eq!(state.rate_limits.len(), 2);
    assert_eq!(
        state.rate_limits[0].primary.as_ref().unwrap().used_percent,
        20.0
    );
    let events = decode(
        json!({"type":"codex.rate_limits","plan_type":"prolite","rate_limits":{"primary":{"used_percent":5,"reset_at":123}},"metered_limit_name":"codex-secondary"}),
    );
    state.apply(&events[0]).unwrap();
    assert_eq!(
        state.rate_limits[1].primary.as_ref().unwrap().resets_at,
        Some(123)
    );
    assert_eq!(state.rate_limits[1].plan_type, Some(PlanType::ProLite));
}

#[test]
fn summaries_and_tool_input_can_precede_item_added() {
    let mut state = ResponseState::default();
    for wire in [
        json!({"type":"response.reasoning_summary_part.added","summary_index":1}),
        json!({"type":"response.reasoning_summary_text.delta","summary_index":1,"delta":"second"}),
        json!({"type":"response.reasoning_summary_text.delta","item_id":"rs","summary_index":0,"delta":"first"}),
        json!({"type":"response.reasoning_text.delta","content_index":0,"delta":"content"}),
        json!({"type":"response.output_item.added","item":{"id":"rs","type":"reasoning","summary":[]}}),
        json!({"type":"response.custom_tool_call_input.delta","call_id":"c","delta":"patch"}),
        json!({"type":"response.output_item.added","item":{"id":"ct","type":"custom_tool_call","call_id":"c","name":"apply_patch","input":""}}),
        json!({"type":"response.reasoning_summary_text.done","item_id":"rs","summary_index":0,"text":"final first"}),
        json!({"type":"response.output_item.done","item":{"id":"rs","type":"reasoning","summary":[],"encrypted_content":"cipher"}}),
        json!({"type":"response.output_item.done","item":{"id":"ct","type":"custom_tool_call","call_id":"c","name":"apply_patch","input":""}}),
        json!({"type":"response.completed","response":{"id":"r","end_turn":true}}),
    ] {
        for event in decode(wire) {
            state.apply(&event).unwrap();
        }
    }
    let output = state.value()["output"].clone();
    assert_eq!(output[0]["summary"][0]["text"], "final first");
    assert_eq!(output[0]["summary"][1]["text"], "second");
    assert_eq!(output[0]["content"][0]["text"], "content");
    assert_eq!(output[0]["encrypted_content"], "cipher");
    assert_eq!(output[1]["input"], "patch");
}

#[test]
fn completion_preserves_usage_and_all_final_outputs_without_duplicates() {
    let first = json!({"id":"m1","type":"message","role":"assistant","phase":"commentary","content":[{"type":"output_text","text":"first"}]});
    let second = json!({"id":"m2","type":"message","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"second"}]});
    let mut state = ResponseState::default();
    state
        .apply(&ResponseEvent::OutputItemDone(item(first.clone())))
        .unwrap();
    state.output[0].record_id = Some(10);
    let events = decode(
        json!({"type":"response.completed","response":{"id":"r","output":[first,second],"end_turn":false,"usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15,"input_tokens_details":{"cached_tokens":4,"cache_write_tokens":2},"output_tokens_details":{"reasoning_tokens":3},"codex_rollout_budget_units":1.25},"usage_metadata":{"amount":"0.01"}}}),
    );
    assert_eq!(state.apply(&events[0]).unwrap(), vec![1]);
    assert_eq!(state.output.len(), 2);
    assert_eq!(state.output[0].record_id, Some(10));
    assert_eq!(state.end_turn, Some(false));
    assert_eq!(
        state
            .usage
            .as_ref()
            .unwrap()
            .input_tokens_details
            .as_ref()
            .unwrap()
            .cache_write_tokens,
        2
    );
    assert_eq!(
        state.usage_metadata.unwrap().amount.as_deref(),
        Some("0.01")
    );
}

#[test]
fn every_codex_failure_category_and_incomplete_reason_is_preserved() {
    for (code, expected) in [
        ("context_length_exceeded", "context_overflow"),
        ("insufficient_quota", "quota_exceeded"),
        ("usage_not_included", "usage_not_included"),
        ("cyber_policy", "cyber_policy"),
        ("misalignment_policy_violation", "misalignment_policy"),
        ("invalid_prompt", "invalid_request"),
        ("bio_policy", "invalid_request"),
        ("server_is_overloaded", "server_overloaded"),
        ("slow_down", "server_overloaded"),
        ("rate_limit_exceeded", "rate_limit_exceeded"),
        ("unknown", "retryable"),
    ] {
        let (_, error) = EventDecoder::default().decode(&json!({"type":"response.failed","response":{"error":{"code":code,"message":"Try again in 1.5 seconds","misalignment":{"reason":"test"}}}}).to_string()).unwrap();
        assert_eq!(json!(error.unwrap())["code"], expected, "{code}");
    }
    assert_eq!(retry_after_ms("Try again in 1.5 seconds."), Some(1500));
    assert_eq!(retry_after_ms("Try again in 25ms."), Some(25));
    let (_, error) = EventDecoder::default().decode(&json!({"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}).to_string()).unwrap();
    assert!(
        matches!(error, Some(ResponsesStreamError::OutputBudgetExhausted(message)) if message.contains("max_output_tokens"))
    );
    let (_, error) = EventDecoder::default().decode(&json!({"type":"response.incomplete","response":{"incomplete_details":{"reason":"content_filter"}}}).to_string()).unwrap();
    assert!(
        matches!(error, Some(ResponsesStreamError::Protocol(message)) if message.contains("content_filter"))
    );
}

async fn http_stream(
    body: &'static str,
    headers: &'static str,
    keep_open: bool,
) -> (Response, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = [0; 4096];
        let _ = socket.read(&mut request).await;
        socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n{headers}Connection: close\r\n\r\n").as_bytes()).await.unwrap();
        for byte in body.as_bytes() {
            socket.write_all(&[*byte]).await.unwrap();
        }
        if keep_open {
            let _ = socket.read(&mut request).await;
        }
    });
    (
        reqwest::get(format!("http://{address}")).await.unwrap(),
        server,
    )
}

#[tokio::test]
async fn transport_handles_utf8_crlf_comments_multiline_and_stops_at_completion() {
    let (response, server) = http_stream(": heartbeat\r\n\r\nevent: ignored-outer-event\r\ndata: {\"type\":\"response.output_text.delta\",\r\ndata: \"delta\":\"你好🌟\"}\r\n\r\ndata: invalid-json\r\n\r\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"r\"}}\r\n\r\n", "", true).await;
    let events = response_stream(response, None, Duration::from_secs(1))
        .collect::<Vec<_>>()
        .await;
    assert!(events.iter().any(
        |e| matches!(e, Ok(ResponseEvent::OutputTextDelta { delta, .. }) if delta == "你好🌟")
    ));
    assert!(matches!(
        events.last(),
        Some(Ok(ResponseEvent::Completed(_)))
    ));
    server.await.unwrap();
}

#[tokio::test]
async fn transport_keeps_semantic_errors_until_eof_and_requires_completed() {
    let (response, server) = http_stream("data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"code\":\"insufficient_quota\",\"message\":\"quota\"}}}\n\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"r\"}}\n\n", "", false).await;
    let events = response_stream(response, None, Duration::from_secs(1))
        .collect::<Vec<_>>()
        .await;
    assert!(
        events
            .iter()
            .any(|e| matches!(e, Ok(ResponseEvent::Created { .. })))
    );
    assert!(matches!(
        events.last(),
        Some(Err(ResponsesStreamError::QuotaExceeded(_)))
    ));
    server.await.unwrap();
    let (response, server) = http_stream("data: [DONE]\n\n", "", false).await;
    let events = response_stream(response, None, Duration::from_secs(1))
        .collect::<Vec<_>>()
        .await;
    assert!(matches!(
        events.last(),
        Some(Err(ResponsesStreamError::Closed))
    ));
    server.await.unwrap();
}

#[tokio::test]
async fn idle_timeout_and_cancellation_drop_the_network_stream() {
    let (response, server) = http_stream("", "", true).await;
    let events = response_stream(response, None, Duration::from_millis(20))
        .collect::<Vec<_>>()
        .await;
    assert!(matches!(
        events.last(),
        Some(Err(ResponsesStreamError::Timeout))
    ));
    server.await.unwrap();
    let (response, server) = http_stream("", "", true).await;
    let (tx, rx) = watch::channel(false);
    let mut stream = response_stream(response, Some(rx), Duration::from_secs(1));
    assert!(stream.next().await.is_some());
    tx.send(true).unwrap();
    assert!(matches!(
        stream.next().await,
        Some(Err(ResponsesStreamError::Cancelled))
    ));
    drop(stream);
    server.await.unwrap();
}

#[tokio::test]
async fn supplied_response_regression_replays_all_338_events() {
    let fixture = include_str!("../../tests/fixtures/responses-regression.sse");
    assert_eq!(fixture.matches("\nevent:").count() + 1, 338);
    let (response, server) = http_stream(fixture, "", false).await;
    let mut events = response_stream(response, None, Duration::from_secs(5));
    let mut state = ResponseState::default();
    while let Some(event) = events.next().await {
        state.apply(&event.unwrap()).unwrap();
    }
    server.await.unwrap();
    assert!(state.completed);
    assert_eq!(state.output.len(), 1);
    let ResponseItem::FunctionCall(call) = &state.output[0].item else {
        panic!("expected function call")
    };
    assert_eq!(call.call_id, "call_fixture");
    let arguments: Value = serde_json::from_str(&call.arguments).unwrap();
    assert_eq!(arguments["command"], "printf fixture");
    assert_eq!(arguments["padding"].as_str().unwrap().len(), 3200);
}
