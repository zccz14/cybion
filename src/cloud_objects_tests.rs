use super::tests::{create_test_thread, insert_record, test_state};
use super::*;

#[test]
fn objects_round_trip_by_content_hash() {
    let (root, _state) = test_state();
    let data_dir = root.path();
    let bytes = b"a tiny png".to_vec();
    let id = objects::put(data_dir, &bytes).unwrap();
    assert_eq!(id.len(), 64);
    assert_eq!(id, hex::encode(Sha256::digest(&bytes)));
    assert_eq!(objects::read(data_dir, &id).unwrap(), bytes);
    // Identical bytes share one object.
    assert_eq!(objects::put(data_dir, &bytes).unwrap(), id);
    let other = objects::put(data_dir, b"other bytes").unwrap();
    assert_ne!(other, id);
    assert_eq!(objects::read(data_dir, &other).unwrap(), b"other bytes");
}

#[test]
fn object_reads_reject_invalid_or_missing_references() {
    let (root, _state) = test_state();
    let data_dir = root.path();
    assert!(objects::read(data_dir, &"0".repeat(64)).is_err());
    assert!(objects::read(data_dir, &"g".repeat(64)).is_err());
    assert!(objects::read(data_dir, "../../etc/passwd").is_err());
}

#[test]
fn stored_references_materialize_into_inline_media() {
    let (root, _state) = test_state();
    let data_dir = root.path();
    let bytes = b"inline image bytes";
    let id = objects::put(data_dir, bytes).unwrap();
    let mut image = json!({
        "type": "image_generation_call",
        "status": "completed",
        "result_ref": id,
        "output_format": "png",
    });
    materialize_media(data_dir, &mut image).unwrap();
    assert_eq!(image["result"], encode_base64(bytes));
    assert!(image.get("result_ref").is_none());

    let mut message = json!({
        "role": "user",
        "content": [{"type": "input_image", "image_ref": id, "media_type": "image/png"}],
    });
    materialize_media(data_dir, &mut message).unwrap();
    assert_eq!(
        message["content"][0]["image_url"],
        format!("data:image/png;base64,{}", encode_base64(bytes))
    );
    assert!(message["content"][0].get("image_ref").is_none());
}

#[test]
fn inline_media_written_before_object_storage_passes_through() {
    let (root, _state) = test_state();
    let data_dir = root.path();
    let mut image = json!({
        "type": "image_generation_call",
        "status": "completed",
        "result": "AAAA",
        "output_format": "png",
    });
    materialize_media(data_dir, &mut image).unwrap();
    assert_eq!(image["result"], "AAAA");
    let mut message = json!({
        "role": "user",
        "content": [{"type": "input_image", "image_url": "data:image/png;base64,AAAA"}],
    });
    materialize_media(data_dir, &mut message).unwrap();
    assert_eq!(
        message["content"][0]["image_url"],
        "data:image/png;base64,AAAA"
    );
}

#[test]
fn materialization_fails_loudly_when_an_object_is_missing() {
    let (root, _state) = test_state();
    let data_dir = root.path();
    let mut image = json!({"type": "image_generation_call", "result_ref": "0".repeat(64)});
    assert!(materialize_media(data_dir, &mut image).is_err());
}

#[test]
fn object_references_price_at_the_bounded_media_cost() {
    let id = "a".repeat(64);
    let capped = CONTEXT_MEDIA_ESTIMATE_TOKENS * CONTEXT_ESTIMATE_BYTES_PER_TOKEN;
    let image = json!({
        "type": "image_generation_call",
        "status": "completed",
        "result_ref": id,
        "output_format": "png",
    })
    .to_string();
    assert_eq!(
        estimated_payload_bytes(&image),
        image.chars().count() as i64 + capped - 64
    );
    let input = json!({
        "role": "user",
        "content": [{"type": "input_image", "image_ref": id, "media_type": "image/png"}],
    })
    .to_string();
    assert_eq!(
        estimated_payload_bytes(&input),
        input.chars().count() as i64 + capped - 64
    );
}

#[tokio::test]
async fn stored_references_resolve_for_history_and_replay() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "object-media-user").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let bytes = b"reference bytes";
    let id = objects::put(&state.data_dir, bytes).unwrap();
    let thread_id = thread.id.clone();
    let (input_id, image_id) = user_db(&state, &user, false, {
        let id = id.clone();
        move |connection| {
            let input = insert_record(
                connection,
                &thread_id,
                "input",
                json!({
                    "role": "user",
                    "content": [{"type": "input_image", "image_ref": id, "media_type": "image/png"}],
                }),
            );
            let image = insert_record(
                connection,
                &thread_id,
                "tool_output",
                json!({
                    "type": "image_generation_call",
                    "status": "completed",
                    "result_ref": id,
                    "output_format": "png",
                }),
            );
            Ok((input, image))
        }
    })
    .await
    .unwrap();
    let history = history_for(&state, &user, thread.id.clone(), 0)
        .await
        .unwrap();
    let input = history.iter().find(|record| record.id == input_id).unwrap();
    assert_eq!(
        input.payload["content"][0]["image_url"],
        format!("data:image/png;base64,{}", encode_base64(bytes))
    );
    let image = history.iter().find(|record| record.id == image_id).unwrap();
    assert_eq!(image.payload["result"], encode_base64(bytes));
    assert!(image.payload.get("result_ref").is_none());

    let context = user_db(&state, &user, false, {
        let thread_id = thread.id.clone();
        let data_dir = state.data_dir.clone();
        move |connection| compile_thread_context(connection, &data_dir, &thread_id, image_id)
    })
    .await
    .unwrap();
    let replayed = context
        .items
        .iter()
        .find(|item| item["type"] == "image_generation_call")
        .unwrap();
    assert_eq!(replayed["result"], encode_base64(bytes));
    assert!(replayed.get("result_ref").is_none());
}

#[test]
fn view_image_results_store_bytes_and_materialize_into_inline_parts() {
    let (root, _state) = test_state();
    let data_dir = root.path();
    let bytes = b"a viewed png";
    let result = view_image_result(
        data_dir,
        &json!({"data": encode_base64(bytes), "media_type": "image/png"}),
    )
    .unwrap();
    let id = result[0]["image_ref"].as_str().unwrap().to_owned();
    assert_eq!(id.len(), 64);
    assert_eq!(result[0]["media_type"], "image/png");
    assert_eq!(
        fs::read(data_dir.join("objects").join(&id[..2]).join(&id)).unwrap(),
        bytes
    );
    let mut item = json!({"type":"function_call_output","call_id":"c1","output":result});
    materialize_media(data_dir, &mut item).unwrap();
    assert_eq!(item["output"][0]["type"], "input_image");
    assert_eq!(
        item["output"][0]["image_url"],
        json!(format!("data:image/png;base64,{}", encode_base64(bytes)))
    );
    assert!(item["output"][0].get("image_ref").is_none());

    for passthrough in [
        json!({"error":"view_image cannot read /tmp/missing.png"}),
        json!({"data":"eA=="}),
        json!({"data":"!!!","media_type":"image/png"}),
        json!("text"),
    ] {
        assert_eq!(
            view_image_result(data_dir, &passthrough).unwrap(),
            passthrough
        );
    }
}
