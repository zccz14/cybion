use super::tests::test_state;
use super::*;

fn identity(user: &User) -> axum::Extension<BrowserIdentity> {
    axum::Extension(BrowserIdentity {
        user: user.clone(),
        bearer: String::new(),
    })
}

async fn create_context_view(
    state: &AppState,
    user: &User,
    name: &str,
    parent_id: Option<String>,
) -> ContextView {
    let Json(view) = create_context(
        State(state.clone()),
        identity(user),
        Json(CreateContextInput {
            name: name.to_owned(),
            description: format!("Metadata for {name}"),
            content: format!("{name} content"),
            parent_id,
        }),
    )
    .await
    .unwrap();
    view
}

/// The sibling sequence the server would render for `parent_id`, keys included.
async fn sibling_sequence(
    state: &AppState,
    user: &User,
    parent_id: Option<&str>,
) -> Vec<(String, String)> {
    let parent_id = parent_id.map(str::to_owned);
    user_db(state, user, false, move |connection| {
        let mut statement = connection.prepare(
            "SELECT name,sort_key FROM contexts WHERE parent_id IS ?1 ORDER BY sort_key,name,id",
        )?;
        let rows = statement.query_map([parent_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    })
    .await
    .unwrap()
}

async fn move_context_view(
    state: &AppState,
    user: &User,
    id: &str,
    parent_id: Option<String>,
    after_id: Option<String>,
) -> Result<ContextView, ApiError> {
    let Json(view) = move_context(
        State(state.clone()),
        identity(user),
        AxumPath(id.to_owned()),
        Json(MoveContextInput {
            parent_id,
            after_id,
        }),
    )
    .await?;
    Ok(view)
}

fn names(sequence: &[(String, String)]) -> Vec<&str> {
    sequence.iter().map(|(name, _)| name.as_str()).collect()
}

#[tokio::test]
async fn context_moves_reorder_siblings_and_reparent_with_fractional_keys() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "context-sort-user").unwrap();
    let alpha = create_context_view(&state, &user, "Alpha", None).await;
    let beta = create_context_view(&state, &user, "Beta", None).await;
    let gamma = create_context_view(&state, &user, "Gamma", None).await;

    // Creation appends, so keys ascend in creation order even though the names
    // are not sorted.
    let roots = sibling_sequence(&state, &user, None).await;
    assert_eq!(names(&roots), ["Alpha", "Beta", "Gamma"]);
    assert!(roots.iter().all(|(_, key)| !key.is_empty()));
    assert!(roots.windows(2).all(|pair| pair[0].1 < pair[1].1));

    // Moving to the front places a key before every sibling.
    let moved = move_context_view(&state, &user, &gamma.id, None, None)
        .await
        .unwrap();
    assert_eq!(moved.parent_id, None);
    assert!(moved.sort_key < roots[0].1);
    assert_eq!(
        names(&sibling_sequence(&state, &user, None).await),
        ["Gamma", "Alpha", "Beta"]
    );

    // Moving between siblings lands strictly between their keys.
    let moved = move_context_view(&state, &user, &gamma.id, None, Some(alpha.id.clone()))
        .await
        .unwrap();
    let roots = sibling_sequence(&state, &user, None).await;
    assert_eq!(names(&roots), ["Alpha", "Gamma", "Beta"]);
    assert!(roots[0].1 < moved.sort_key && moved.sort_key < roots[2].1);

    // Children append under their parent and reorder within it.
    let child_one = create_context_view(&state, &user, "Child one", Some(alpha.id.clone())).await;
    let child_two = create_context_view(&state, &user, "Child two", Some(alpha.id.clone())).await;
    assert_eq!(
        names(&sibling_sequence(&state, &user, Some(&alpha.id)).await),
        ["Child one", "Child two"]
    );
    move_context_view(&state, &user, &child_two.id, Some(alpha.id.clone()), None)
        .await
        .unwrap();
    assert_eq!(
        names(&sibling_sequence(&state, &user, Some(&alpha.id)).await),
        ["Child two", "Child one"]
    );

    // Reparenting appends under the new parent and leaves the old parent alone.
    let moved = move_context_view(&state, &user, &child_one.id, Some(beta.id.clone()), None)
        .await
        .unwrap();
    assert_eq!(moved.parent_id, Some(beta.id.clone()));
    assert_eq!(
        names(&sibling_sequence(&state, &user, Some(&beta.id)).await),
        ["Child one"]
    );
    assert_eq!(
        names(&sibling_sequence(&state, &user, Some(&alpha.id)).await),
        ["Child two"]
    );
    // The returned view carries the new key, and the read path serves it too.
    let Json(read) = read_context_api(
        State(state.clone()),
        identity(&user),
        AxumPath(moved.id.clone()),
    )
    .await
    .unwrap();
    assert_eq!(read.context.sort_key, moved.sort_key);
}

#[tokio::test]
async fn context_moves_reject_invalid_targets() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "context-move-guard-user").unwrap();
    let root = create_context_view(&state, &user, "Root", None).await;
    let child = create_context_view(&state, &user, "Child", Some(root.id.clone())).await;
    let grandchild = create_context_view(&state, &user, "Grandchild", Some(child.id.clone())).await;

    let error = move_context_view(&state, &user, &root.id, None, Some(root.id.clone()))
        .await
        .unwrap_err();
    assert_eq!(error.status, StatusCode::BAD_REQUEST);

    let error = move_context_view(&state, &user, &root.id, None, Some(grandchild.id.clone()))
        .await
        .unwrap_err();
    assert_eq!(error.status, StatusCode::BAD_REQUEST);

    let error = move_context_view(&state, &user, &root.id, Some(root.id.clone()), None)
        .await
        .unwrap_err();
    assert_eq!(error.status, StatusCode::CONFLICT);

    let error = move_context_view(&state, &user, &root.id, Some(grandchild.id.clone()), None)
        .await
        .unwrap_err();
    assert_eq!(error.status, StatusCode::CONFLICT);

    let error = move_context_view(
        &state,
        &user,
        &child.id,
        Some(Uuid::new_v4().to_string()),
        None,
    )
    .await
    .unwrap_err();
    assert_eq!(error.status, StatusCode::NOT_FOUND);

    let error = move_context_view(&state, &user, &Uuid::new_v4().to_string(), None, None)
        .await
        .unwrap_err();
    assert_eq!(error.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn patch_reparent_appends_under_the_new_parent_and_keeps_keys_otherwise() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "context-patch-user").unwrap();
    let first = create_context_view(&state, &user, "First", None).await;
    let second = create_context_view(&state, &user, "Second", None).await;
    let mover = create_context_view(&state, &user, "Mover", Some(first.id.clone())).await;
    let resident = create_context_view(&state, &user, "Resident", Some(second.id.clone())).await;

    let Json(updated) = update_context(
        State(state.clone()),
        identity(&user),
        AxumPath(mover.id.clone()),
        Json(UpdateContextInput {
            name: None,
            description: None,
            content: None,
            parent_id: Some(Some(second.id.clone())),
        }),
    )
    .await
    .unwrap();
    assert_eq!(updated.parent_id, Some(second.id.clone()));
    let sequence = sibling_sequence(&state, &user, Some(&second.id)).await;
    assert_eq!(names(&sequence), ["Resident", "Mover"]);
    assert!(updated.sort_key > resident.sort_key);

    // Updating without touching the parent keeps the key stable.
    let Json(kept) = update_context(
        State(state.clone()),
        identity(&user),
        AxumPath(mover.id.clone()),
        Json(UpdateContextInput {
            name: Some("Mover renamed".to_owned()),
            description: None,
            content: None,
            parent_id: Some(Some(second.id.clone())),
        }),
    )
    .await
    .unwrap();
    assert_eq!(kept.sort_key, updated.sort_key);
}

#[test]
fn context_sort_keys_backfill_preserves_the_old_tree_order_on_upgrade() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("v36.sqlite3");
    let connection = Connection::open(&path).unwrap();
    connection
        .execute_batch(
            "CREATE TABLE contexts (
               id TEXT PRIMARY KEY,
               name TEXT NOT NULL,
               description TEXT NOT NULL,
               content TEXT NOT NULL,
               parent_id TEXT REFERENCES contexts(id) ON DELETE SET NULL
             );
             CREATE INDEX contexts_parent_name ON contexts(parent_id,name,id);
             INSERT INTO contexts(id,name,description,content,parent_id) VALUES
               ('11111111-1111-4111-8111-111111111111','Zulu','','',NULL),
               ('22222222-2222-4222-8222-222222222222','Alpha','','',NULL),
               ('33333333-3333-4333-8333-333333333333','Zulu child','','','11111111-1111-4111-8111-111111111111'),
               ('44444444-4444-4444-8444-444444444444','Alpha child','','','11111111-1111-4111-8111-111111111111');
             PRAGMA user_version = 36;",
        )
        .unwrap();
    drop(connection);

    let connection = open_user(&path, true).unwrap();
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, USER_SCHEMA_VERSION);
    let ordered = |parent: Option<&str>| {
        connection
            .prepare("SELECT name FROM contexts WHERE parent_id IS ?1 ORDER BY sort_key,name,id")
            .unwrap()
            .query_map([parent], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<std::result::Result<Vec<_>, _>>()
            .unwrap()
    };
    assert_eq!(ordered(None), ["Alpha", "Zulu"]);
    assert_eq!(
        ordered(Some("11111111-1111-4111-8111-111111111111")),
        ["Alpha child", "Zulu child"]
    );
    let missing: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM contexts WHERE sort_key = ''",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(missing, 0);
    let indexes = connection
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='contexts'")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<std::result::Result<Vec<_>, _>>()
        .unwrap();
    assert!(indexes.iter().any(|name| name == "contexts_parent_sort"));
    assert!(!indexes.iter().any(|name| name == "contexts_parent_name"));
}
