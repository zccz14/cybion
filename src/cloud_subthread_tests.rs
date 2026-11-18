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
