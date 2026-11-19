//! Child Threads: the slice a parent grants, the ceilings that bound a branch,
//! and the tree both the model and the console read.

use super::tests::{insert_upstream, test_state};
use super::*;

fn connection() -> Connection {
    let mut connection = Connection::open_in_memory().unwrap();
    ensure_user_schema(&mut connection).unwrap();
    connection
}

fn thread(connection: &Connection, id: &str, parent: Option<&str>, budget: Option<i64>) {
    connection
        .execute(
            "INSERT INTO threads(id,title,model,status,parent_thread_id,budget_usd_nanos,created_at,updated_at)
             VALUES(?,?,?,'idle',?,?,?,?)",
            params![id, id, "model", parent, budget, now(), now()],
        )
        .unwrap();
}

fn spend(connection: &Connection, id: &str, nanos: i64) {
    connection
        .execute(
            "INSERT INTO reasoning_audits(thread_id,model,status,started_at,finished_at,cost_usd_nanos)
             VALUES(?,?,'completed',?,?,?)",
            params![id, "model", now(), now(), nanos],
        )
        .unwrap();
}

fn view(connection: &Connection, id: &str) -> ThreadView {
    load_thread(connection, id).unwrap()
}

#[test]
fn a_child_is_stopped_by_the_slice_its_parent_granted() {
    let connection = connection();
    thread(&connection, "root", None, Some(10_000_000_000));
    thread(&connection, "child", Some("root"), Some(2_000_000_000));
    spend(&connection, "child", 2_500_000_000);
    let exceeded = subthreads::exhausted(&connection, "child", 0)
        .unwrap()
        .unwrap();
    assert!(exceeded.own);
    assert_eq!(exceeded.budget_usd_nanos, 2_000_000_000);
    assert_eq!(exceeded.spent_usd_nanos, 2_500_000_000);
}

#[test]
fn a_child_that_outspent_the_root_with_its_siblings_is_stopped_by_the_root() {
    let connection = connection();
    thread(&connection, "root", None, Some(3_000_000_000));
    thread(&connection, "child", Some("root"), None);
    spend(&connection, "root", 1_000_000_000);
    spend(&connection, "child", 2_500_000_000);
    let exceeded = subthreads::exhausted(&connection, "child", 0)
        .unwrap()
        .unwrap();
    assert!(
        !exceeded.own,
        "the ceiling that ran out belongs to the root"
    );
    assert_eq!(exceeded.spent_usd_nanos, 3_500_000_000);
}

#[test]
fn a_child_never_falls_back_to_the_account_budget() {
    let connection = connection();
    thread(&connection, "root", None, Some(10_000_000_000));
    thread(&connection, "child", Some("root"), None);
    spend(&connection, "child", 9_000_000_000);
    // The account default would have stopped it; a child reads its own column
    // only, and it has none.
    assert!(
        subthreads::exhausted(&connection, "child", 1_000_000_000)
            .unwrap()
            .is_none()
    );
    // The root still bounds the branch, which is what the child's spend hits.
    spend(&connection, "child", 2_000_000_000);
    let root_ceiling = subthreads::exhausted(&connection, "child", 0)
        .unwrap()
        .unwrap();
    assert_eq!(root_ceiling.budget_usd_nanos, 10_000_000_000);
}

#[test]
fn a_slice_must_fit_what_the_parent_has_left() {
    let connection = connection();
    thread(&connection, "root", None, Some(2_000_000_000));
    let defaults = load_thread_defaults(&connection).unwrap();
    let root = view(&connection, "root");
    // Nothing spent or promised yet: the whole 2.00 is offerable.
    subthreads::check_child(&connection, &root, Some(2_000_000_000), &defaults).unwrap();
    assert!(subthreads::check_child(&connection, &root, Some(2_500_000_000), &defaults).is_err());

    spend(&connection, "root", 500_000_000);
    assert!(subthreads::check_child(&connection, &root, Some(1_600_000_000), &defaults).is_err());
    subthreads::check_child(&connection, &root, Some(1_500_000_000), &defaults).unwrap();
}

#[test]
fn two_children_cannot_be_promised_the_same_money() {
    let connection = connection();
    thread(&connection, "root", None, Some(2_000_000_000));
    thread(&connection, "first", Some("root"), Some(1_500_000_000));
    let defaults = load_thread_defaults(&connection).unwrap();
    let root = view(&connection, "root");
    // 1.50 is already promised, so only 0.50 can be offered to a second child.
    assert!(subthreads::check_child(&connection, &root, Some(1_000_000_000), &defaults).is_err());
    subthreads::check_child(&connection, &root, Some(500_000_000), &defaults).unwrap();
    // A child with no ceiling of its own promises nothing, so it always fits.
    subthreads::check_child(&connection, &root, None, &defaults).unwrap();
}

#[test]
fn a_branch_may_not_grow_past_three_levels() {
    let connection = connection();
    let defaults = load_thread_defaults(&connection).unwrap();
    thread(&connection, "root", None, None);
    thread(&connection, "one", Some("root"), None);
    thread(&connection, "two", Some("one"), None);
    let deep = view(&connection, "two");
    let error = subthreads::check_child(&connection, &deep, None, &defaults).unwrap_err();
    assert_eq!(error.status, StatusCode::CONFLICT);
    // The level above the deepest one still may.
    let middle = view(&connection, "one");
    subthreads::check_child(&connection, &middle, None, &defaults).unwrap();
}

#[test]
fn the_tree_reports_flat_nodes_with_depth_and_branch_spend() {
    let connection = connection();
    thread(&connection, "root", None, Some(5_000_000_000));
    thread(&connection, "first", Some("root"), Some(2_000_000_000));
    thread(&connection, "second", Some("root"), None);
    thread(&connection, "leaf", Some("first"), Some(1_000_000_000));
    spend(&connection, "root", 100_000_000);
    spend(&connection, "first", 200_000_000);
    spend(&connection, "leaf", 300_000_000);
    let tree = subthreads::tree(&connection, "root", 2).unwrap();
    assert_eq!(tree.pool.budget_usd, Some(5.0));
    assert_eq!(tree.pool.subtree_spent_usd, 0.6);
    // A grandchild's slice is drawn from its own parent's, so only the direct
    // children's promises occupy the root's pool.
    assert_eq!(tree.pool.allotted_usd, 2.0);
    assert_eq!(tree.pool.remaining_usd, Some(2.4));
    let ids = tree
        .nodes
        .iter()
        .map(|node| (node.thread_id.as_str(), node.depth))
        .collect::<Vec<_>>();
    assert_eq!(ids, [("first", 1), ("second", 1), ("leaf", 2)]);
    // A branch's spend is the Thread's own plus everything under it.
    let first = tree
        .nodes
        .iter()
        .find(|node| node.thread_id == "first")
        .unwrap();
    assert_eq!(first.subtree_spent_usd, 0.5);
    assert_eq!(first.children, 1);
    // Depth 1 stops at the direct children.
    let shallow = subthreads::tree(&connection, "root", 1).unwrap();
    assert_eq!(shallow.nodes.len(), 2);
}

#[test]
fn a_thread_steers_only_the_threads_below_it() {
    let connection = connection();
    thread(&connection, "root", None, None);
    thread(&connection, "child", Some("root"), None);
    thread(&connection, "grandchild", Some("child"), None);
    thread(&connection, "stranger", None, None);
    assert!(super::subthreads::is_below(&connection, "root", "grandchild").unwrap());
    assert!(!super::subthreads::is_below(&connection, "child", "root").unwrap());
    assert!(!super::subthreads::is_below(&connection, "root", "stranger").unwrap());
    assert!(super::subthreads::require_below(&connection, "child", "root").is_err());
}

#[tokio::test]
async fn a_subcontracted_thread_records_its_parent_and_the_slice_it_was_given() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "subcontract-owner").unwrap();
    let upstream = insert_upstream(&state, &user, "fixture", "http://127.0.0.1:1").await;
    let parent = create_thread_for(
        &state,
        &user,
        serde_json::from_value(json!({
            "upstream_id": upstream.id,
            "budget_usd_nanos": 2_000_000_000i64,
        }))
        .unwrap(),
        ThreadOrigin::Web,
    )
    .await
    .unwrap();
    let child = create_thread_for(
        &state,
        &user,
        serde_json::from_value(json!({
            "title": "Subcontract",
            "budget_usd_nanos": 500_000_000i64,
        }))
        .unwrap(),
        ThreadOrigin::Child {
            parent_thread_id: parent.id.clone(),
        },
    )
    .await
    .unwrap();
    assert_eq!(child.parent_thread_id.as_deref(), Some(parent.id.as_str()));
    assert_eq!(child.budget_usd_nanos, Some(500_000_000));
    // The child is a root's opposite: it carries a parent, and a person's own
    // Thread never does.
    assert_eq!(parent.parent_thread_id, None);
    // More than the parent was given is refused rather than silently capped.
    let error = create_thread_for(
        &state,
        &user,
        serde_json::from_value(json!({ "budget_usd_nanos": 9_000_000_000i64 })).unwrap(),
        ThreadOrigin::Child {
            parent_thread_id: parent.id.clone(),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(error.status, StatusCode::CONFLICT);
}

#[tokio::test]
async fn the_tools_grant_read_and_steer_within_the_branch() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "subthread-tools").unwrap();
    let upstream = insert_upstream(&state, &user, "fixture", "http://127.0.0.1:1").await;
    let parent = create_thread_for(
        &state,
        &user,
        serde_json::from_value(json!({
            "upstream_id": upstream.id,
            "budget_usd_nanos": 2_000_000_000i64,
        }))
        .unwrap(),
        ThreadOrigin::Web,
    )
    .await
    .unwrap();
    let created = subthreads::create_tool_output(
        &state,
        &user,
        &parent.id,
        &json!({"task": "read three filings", "budget_usd": 0.5}).to_string(),
    )
    .await
    .unwrap();
    let child_id = created["thread_id"].as_str().unwrap().to_owned();
    assert_eq!(created["budget_usd"], json!(0.5));
    assert_eq!(created["parent"]["remaining_usd"], json!(1.5));

    let tree = subthreads::list_tool_output(&state, &user, &parent.id, "{}")
        .await
        .unwrap();
    assert_eq!(tree["nodes"].as_array().unwrap().len(), 1);
    assert_eq!(tree["nodes"][0]["depth"], json!(1));
    assert_eq!(tree["nodes"][0]["budget_usd"], json!(0.5));

    // A child may not steer the Thread above it, and a slice may not outgrow
    // the pool it is drawn from.
    assert!(
        subthreads::control_tool_output(
            &state,
            &user,
            &child_id,
            &json!({"thread_id": parent.id, "action": "stop"}).to_string(),
        )
        .await
        .is_err()
    );
    assert!(
        subthreads::control_tool_output(
            &state,
            &user,
            &parent.id,
            &json!({"thread_id": child_id, "action": "top_up", "budget_usd": 9.0}).to_string(),
        )
        .await
        .is_err()
    );
    let raised = subthreads::control_tool_output(
        &state,
        &user,
        &parent.id,
        &json!({"thread_id": child_id, "action": "top_up", "budget_usd": 1.0}).to_string(),
    )
    .await
    .unwrap();
    assert_eq!(raised["budget_usd"], json!(1.0));
    assert_eq!(raised["parent"]["remaining_usd"], json!(1.0));
}

/// The Thread list is the top level, not the whole forest: a Thread a model
/// subcontracted stays in the branch that granted it, so one task never reads
/// as two conversations in the list.
#[tokio::test]
async fn the_thread_list_shows_only_root_threads() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "thread-list-roots").unwrap();
    let upstream = insert_upstream(&state, &user, "fixture", "http://127.0.0.1:1").await;
    let parent = create_thread_for(
        &state,
        &user,
        serde_json::from_value(json!({
            "title": "Parent",
            "upstream_id": upstream.id,
            "budget_usd_nanos": 1_000_000_000i64,
        }))
        .unwrap(),
        ThreadOrigin::Web,
    )
    .await
    .unwrap();
    let child = create_thread_for(
        &state,
        &user,
        serde_json::from_value(json!({
            "title": "Subcontract",
            "budget_usd_nanos": 200_000_000i64,
        }))
        .unwrap(),
        ThreadOrigin::Child {
            parent_thread_id: parent.id.clone(),
        },
    )
    .await
    .unwrap();

    let page = list_threads_for(
        &state,
        &user,
        ThreadListFilter::active(),
        DEFAULT_THREAD_LIST_LIMIT,
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        page.items.len(),
        1,
        "only the Thread a person started is listed"
    );
    assert_eq!(page.items[0].id, parent.id);
    assert_eq!(
        page.total, 1,
        "the count follows the same filter as the page"
    );
    // Hidden from the list is not gone: the parent still reports the branch,
    // and the child still opens from its own URL.
    assert_eq!(page.items[0].branches, 1);
    assert_eq!(
        read_thread_for(&state, &user, child.id.clone())
            .await
            .unwrap()
            .id,
        child.id
    );

    // Every view of the list is about the top level, search included: a
    // subcontract does not become a conversation because someone typed its
    // title into the search box.
    let searched = ThreadListFilter {
        q: Some("Subcontract".to_owned()),
        ..ThreadListFilter::active()
    };
    let page = list_threads_for(&state, &user, searched, DEFAULT_THREAD_LIST_LIMIT, None)
        .await
        .unwrap();
    assert!(page.items.is_empty());
    assert_eq!(page.total, 0);
}

/// A model is a choice; the endpoint is plumbing. Naming a model alone keeps the
/// endpoint the parent already runs on, so a caller never has to hand
/// `create_thread` an `upstream_id`.
#[tokio::test]
async fn a_child_naming_only_a_model_keeps_its_parents_endpoint() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "child-model-only").unwrap();
    let upstream = insert_upstream(&state, &user, "fixture", "http://127.0.0.1:1").await;
    let parent = create_thread_for(
        &state,
        &user,
        serde_json::from_value(json!({
            "upstream_id": upstream.id,
            "budget_usd_nanos": 1_000_000_000i64,
        }))
        .unwrap(),
        ThreadOrigin::Web,
    )
    .await
    .unwrap();
    let created = subthreads::create_tool_output(
        &state,
        &user,
        &parent.id,
        &json!({"task": "research", "settings": {"model": "gpt-6-astra"}}).to_string(),
    )
    .await
    .unwrap();
    let child = read_thread_for(
        &state,
        &user,
        created["thread_id"].as_str().unwrap().to_owned(),
    )
    .await
    .unwrap();
    assert_eq!(child.model, "gpt-6-astra");
    assert_eq!(child.upstream_id, Some(upstream.id));
    // Nothing surprising happened, so nothing is reported.
    assert!(created.get("upstream_notice").is_none());

    // Naming nothing inherits both halves of the pair the parent runs on.
    let bare = subthreads::create_tool_output(
        &state,
        &user,
        &parent.id,
        &json!({"task": "follow up"}).to_string(),
    )
    .await
    .unwrap();
    let bare = read_thread_for(
        &state,
        &user,
        bare["thread_id"].as_str().unwrap().to_owned(),
    )
    .await
    .unwrap();
    assert_eq!(bare.model, parent.model);
    assert_eq!(bare.upstream_id, parent.upstream_id);
}

/// An endpoint id this account does not have — deleted, or copied from another
/// install — is skipped rather than fatal: the child runs where its parent runs,
/// and the tool says where that is.
#[tokio::test]
async fn a_stale_upstream_id_falls_back_to_the_parents_endpoint() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "child-stale-upstream").unwrap();
    let upstream = insert_upstream(&state, &user, "fixture", "http://127.0.0.1:1").await;
    let parent = create_thread_for(
        &state,
        &user,
        serde_json::from_value(json!({
            "upstream_id": upstream.id,
            "budget_usd_nanos": 1_000_000_000i64,
        }))
        .unwrap(),
        ThreadOrigin::Web,
    )
    .await
    .unwrap();
    let stale = Uuid::now_v7().to_string();
    let created = subthreads::create_tool_output(
        &state,
        &user,
        &parent.id,
        &json!({"task": "research", "settings": {"upstream_id": stale}}).to_string(),
    )
    .await
    .unwrap();
    let child = read_thread_for(
        &state,
        &user,
        created["thread_id"].as_str().unwrap().to_owned(),
    )
    .await
    .unwrap();
    assert_eq!(child.upstream_id, Some(upstream.id));
    assert_eq!(child.model, parent.model);
    let notice = created["upstream_notice"].as_str().unwrap();
    assert!(notice.contains(&stale), "{notice}");
}

/// A Thread a person starts is not a subcontract: an endpoint they name has to
/// exist, because nothing above them can answer for it.
#[tokio::test]
async fn a_root_thread_still_refuses_an_unknown_upstream() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "root-stale-upstream").unwrap();
    let error = create_thread_for(
        &state,
        &user,
        serde_json::from_value(json!({ "upstream_id": Uuid::now_v7().to_string() })).unwrap(),
        ThreadOrigin::Web,
    )
    .await
    .unwrap_err();
    assert_eq!(error.status, StatusCode::NOT_FOUND);
}

fn wrote(connection: &Connection, thread_id: &str, kind: &str, payload: Value) {
    connection
        .execute(
            "INSERT INTO history_records(thread_id,kind,payload,created_at) VALUES(?,?,?,?)",
            params![thread_id, kind, payload.to_string(), now()],
        )
        .unwrap();
}

/// A snapshot is what one request returned; history is what the Thread said. A
/// turn that ends on a tool call leaves the snapshot without text, and the
/// parent must still get the conclusion the Thread already wrote.
#[test]
fn an_answer_falls_back_to_the_last_message_of_the_turn() {
    let connection = connection();
    thread(&connection, "child", None, None);
    wrote(
        &connection,
        "child",
        "input",
        json!({"content": "读这三份财报"}),
    );
    wrote(
        &connection,
        "child",
        "response_output",
        json!({"type":"message","content":[{"type":"output_text","text":"结论：三份财报都读完了。"}]}),
    );
    wrote(
        &connection,
        "child",
        "response_output",
        json!({"type":"function_call","name":"bash","arguments":"{}"}),
    );
    let (text, clipped) = subthreads::answer(&connection, "child").unwrap();
    assert_eq!(text, "结论：三份财报都读完了。");
    assert!(!clipped);
}

/// Some Responses-compatible gateways name a message part `text` instead of
/// `output_text`; a message is a message either way.
#[test]
fn an_answer_accepts_the_older_text_part() {
    let connection = connection();
    thread(&connection, "child", None, None);
    wrote(
        &connection,
        "child",
        "input",
        json!({"content": "读这三份财报"}),
    );
    wrote(
        &connection,
        "child",
        "response_output",
        json!({"type":"message","content":[{"type":"text","text":"结论：都读完了。"}]}),
    );
    let (text, _) = subthreads::answer(&connection, "child").unwrap();
    assert_eq!(text, "结论：都读完了。");
}

/// An empty answer is a fact about the turn: name the stop behind it, because
/// raising a slice, asking a person and retrying are different next steps.
#[test]
fn an_empty_answer_names_the_stop_that_left_it_empty() {
    let connection = connection();
    thread(&connection, "budget", None, None);
    wrote(
        &connection,
        "budget",
        "activity",
        json!({
            "role": "system",
            "content": "Budget exhausted: $0.20 settled of the $0.10 limit.",
            "budget_usd_nanos": 100_000_000i64,
            "spent_usd_nanos": 200_000_000i64,
        }),
    );
    let reason = subthreads::empty_answer(&connection, "budget", "idle", true).unwrap();
    assert_eq!(reason["kind"], "budget");
    assert!(
        reason["detail"]
            .as_str()
            .unwrap()
            .contains("Budget exhausted")
    );

    thread(&connection, "waiting", None, None);
    let reason = subthreads::empty_answer(&connection, "waiting", "idle", true).unwrap();
    assert_eq!(reason["kind"], "blocked");

    thread(&connection, "failed", None, None);
    let reason = subthreads::empty_answer(&connection, "failed", "failed", false).unwrap();
    assert_eq!(reason["kind"], "failed");

    thread(&connection, "quiet", None, None);
    let reason = subthreads::empty_answer(&connection, "quiet", "idle", false).unwrap();
    assert_eq!(reason["kind"], "no-message");
}

/// A branch row reads like the Thread list: the same status it would show, plus
/// the Thread's own tokens, cache rate and settled cost.
#[test]
fn a_branch_row_reports_the_status_and_usage_the_list_would() {
    let connection = connection();
    thread(&connection, "root", None, Some(10_000_000_000));
    thread(&connection, "child", Some("root"), Some(2_000_000_000));
    // The child answered, so it reads as completed rather than as an idle dot.
    connection
        .execute(
            "INSERT INTO history_records(thread_id,kind,payload,created_at) VALUES('child','input','{}',?)",
            [now()],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO history_records(thread_id,kind,payload,created_at) VALUES('child','response_output',?,?)",
            params![json!({"type":"message","content":[]}).to_string(), now()],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO reasoning_audits(thread_id,model,status,started_at,finished_at,input_tokens,output_tokens,cached_tokens,cost_usd_nanos)
             VALUES('child','model','completed',?,?,?,?,?,?)",
            params![now(), now(), 1_000i64, 200i64, 400i64, 5_000_000i64],
        )
        .unwrap();
    // A child that never ran has nothing to show, and says so.
    thread(&connection, "quiet", Some("root"), None);
    let tree = subthreads::tree(&connection, "root", 3).unwrap();
    let child = tree
        .nodes
        .iter()
        .find(|node| node.thread_id == "child")
        .unwrap();
    assert_eq!(child.display_status, "completed");
    assert_eq!(child.usage.total_tokens, 1_200);
    assert_eq!(child.usage.cache_hit_rate, Some(0.4));
    assert_eq!(child.usage.cost_usd_nanos, 5_000_000);
    let quiet = tree
        .nodes
        .iter()
        .find(|node| node.thread_id == "quiet")
        .unwrap();
    assert_eq!(quiet.display_status, "ready");
/// A child read back names the Thread that subcontracted it, so opening it from
/// its own URL still shows the way back.
#[tokio::test]
async fn a_child_reports_the_title_of_the_thread_above_it() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "child-parent-title").unwrap();
    let upstream = insert_upstream(&state, &user, "fixture", "http://127.0.0.1:1").await;
    let parent = create_thread_for(
        &state,
        &user,
        serde_json::from_value(json!({
            "title": "Parent task",
            "upstream_id": upstream.id,
        }))
        .unwrap(),
        ThreadOrigin::Web,
    )
    .await
    .unwrap();
    let child = create_thread_for(
        &state,
        &user,
        serde_json::from_value(json!({ "title": "Subcontract" })).unwrap(),
        ThreadOrigin::Child {
            parent_thread_id: parent.id.clone(),
        },
    )
    .await
    .unwrap();
    let read = read_thread_for(&state, &user, child.id.clone())
        .await
        .unwrap();
    assert_eq!(read.parent_thread_id.as_deref(), Some(parent.id.as_str()));
    assert_eq!(read.parent_title.as_deref(), Some("Parent task"));
    // A root has no parent to point at.
    let root = read_thread_for(&state, &user, parent.id.clone())
        .await
        .unwrap();
    assert_eq!(root.parent_title, None);
}
