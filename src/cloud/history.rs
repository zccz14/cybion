use super::{ApiError, AppState, BrowserIdentity, user_db};
use axum::{
    Extension, Json,
    extract::{Path, Query, State},
};
use rusqlite::{Connection, OptionalExtension, params_from_iter, types::Value};
use serde::{Deserialize, Serialize};

const COLUMNS: [&str; 9] = [
    "id",
    "thread_id",
    "request_input_id",
    "role",
    "content",
    "kind",
    "payload",
    "visible",
    "created_at",
];

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct HistoryQuery {
    page: Option<i64>,
    page_size: Option<i64>,
    sort: Option<String>,
    direction: Option<String>,
    id: Option<i64>,
    thread_id: Option<String>,
    request_input_id: Option<i64>,
    role: Option<String>,
    kind: Option<String>,
    visible: Option<i64>,
    created_from: Option<i64>,
    created_to: Option<i64>,
    q: Option<String>,
}

#[derive(Serialize)]
pub(super) struct RawHistoryRecord {
    id: i64,
    thread_id: String,
    request_input_id: Option<i64>,
    role: String,
    content: String,
    kind: String,
    payload: String,
    visible: i64,
    created_at: i64,
}

#[derive(Serialize)]
struct HistoryPreview {
    #[serde(flatten)]
    record: RawHistoryRecord,
    content_truncated: bool,
    payload_truncated: bool,
}

#[derive(Serialize)]
pub(super) struct HistoryPage {
    items: Vec<HistoryPreview>,
    total: i64,
    page: i64,
    page_size: i64,
    sort: String,
    direction: String,
}

pub(super) async fn list(
    State(state): State<AppState>,
    Extension(identity): Extension<BrowserIdentity>,
    Query(query): Query<HistoryQuery>,
) -> Result<Json<HistoryPage>, ApiError> {
    user_db(&state, &identity.user, true, move |connection| {
        load_page(connection, query)
    })
    .await
    .map(Json)
}

pub(super) async fn read(
    State(state): State<AppState>,
    Extension(identity): Extension<BrowserIdentity>,
    Path(id): Path<i64>,
) -> Result<Json<RawHistoryRecord>, ApiError> {
    user_db(&state, &identity.user, true, move |connection| {
        load_record(connection, id)
    })
    .await
    .map(Json)
}

fn raw_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawHistoryRecord> {
    Ok(RawHistoryRecord {
        id: row.get(0)?,
        thread_id: row.get(1)?,
        request_input_id: row.get(2)?,
        role: row.get(3)?,
        content: row.get(4)?,
        kind: row.get(5)?,
        payload: row.get(6)?,
        visible: row.get(7)?,
        created_at: row.get(8)?,
    })
}

fn load_record(connection: &Connection, id: i64) -> Result<RawHistoryRecord, ApiError> {
    connection
        .query_row(
            "SELECT id,thread_id,request_input_id,role,content,kind,payload,visible,created_at
         FROM history_records WHERE id=?",
            [id],
            raw_record,
        )
        .optional()?
        .ok_or_else(|| ApiError::not_found("history record not found"))
}

fn load_page(connection: &mut Connection, query: HistoryQuery) -> Result<HistoryPage, ApiError> {
    let page = query.page.unwrap_or(1);
    let page_size = query.page_size.unwrap_or(20);
    let sort = query.sort.unwrap_or_else(|| "id".to_owned());
    let direction = query.direction.unwrap_or_else(|| "desc".to_owned());
    if page < 1 || !(1..=100).contains(&page_size) {
        return Err(ApiError::bad_request(
            "page must be positive; page_size must be between 1 and 100",
        ));
    }
    if !COLUMNS.contains(&sort.as_str()) || !matches!(direction.as_str(), "asc" | "desc") {
        return Err(ApiError::bad_request(
            "invalid history sort column or direction",
        ));
    }
    if query.visible.is_some_and(|value| value != 0 && value != 1) {
        return Err(ApiError::bad_request("visible must be 0 or 1"));
    }
    if let (Some(from), Some(to)) = (query.created_from, query.created_to)
        && from > to
    {
        return Err(ApiError::bad_request(
            "created_from must not exceed created_to",
        ));
    }

    let mut filters = Vec::new();
    let mut values = Vec::<Value>::new();
    for (column, value) in [
        ("id", query.id),
        ("request_input_id", query.request_input_id),
        ("visible", query.visible),
    ] {
        if let Some(value) = value {
            filters.push(format!("{column} = ?"));
            values.push(value.into());
        }
    }
    for (column, value) in [
        ("thread_id", query.thread_id),
        ("role", query.role),
        ("kind", query.kind),
    ] {
        if let Some(value) = value {
            filters.push(format!("{column} = ?"));
            values.push(value.into());
        }
    }
    for (operator, value) in [(">=", query.created_from), ("<=", query.created_to)] {
        if let Some(value) = value {
            filters.push(format!("created_at {operator} ?"));
            values.push(value.into());
        }
    }
    if let Some(value) = query.q.filter(|value| !value.is_empty()) {
        filters.push("(instr(content, ?) > 0 OR instr(payload, ?) > 0)".to_owned());
        values.extend([Value::Text(value.clone()), Value::Text(value)]);
    }
    let predicate = if filters.is_empty() {
        "1".to_owned()
    } else {
        filters.join(" AND ")
    };
    // The count and page share one SQLite read snapshot while requests append history.
    let transaction = connection.transaction()?;
    let total: i64 = transaction.query_row(
        &format!("SELECT COUNT(*) FROM history_records WHERE {predicate}"),
        params_from_iter(&values),
        |row| row.get(0),
    )?;
    let page = page.min(((total - 1).max(0) / page_size) + 1);
    values.extend([
        Value::Integer(page_size),
        Value::Integer((page - 1) * page_size),
    ]);
    // Only allowlisted column/direction identifiers enter SQL; all filter values are bound.
    let mut statement = transaction.prepare(&format!(
        "SELECT id,thread_id,request_input_id,role,substr(content,1,240),kind,substr(payload,1,240),visible,created_at,
                length(CAST(content AS BLOB)),length(CAST(payload AS BLOB))
         FROM history_records WHERE {predicate} ORDER BY {sort} {direction},id {direction} LIMIT ? OFFSET ?"
    ))?;
    let items = statement
        .query_map(params_from_iter(&values), |row| {
            let record = raw_record(row)?;
            Ok(HistoryPreview {
                content_truncated: row.get::<_, usize>(9)? > record.content.len(),
                payload_truncated: row.get::<_, usize>(10)? > record.payload.len(),
                record,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(HistoryPage {
        items,
        total,
        page,
        page_size,
        sort,
        direction,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::{
        self,
        tests::{create_test_thread, test_state},
    };
    use axum::http::StatusCode;
    use rusqlite::params;
    use serde_json::json;

    fn database() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(cloud::THREAD_SCHEMA).unwrap();
        connection.execute_batch(cloud::USER_SCHEMA).unwrap();
        connection
            .execute_batch(cloud::USER_HISTORY_INDEXES)
            .unwrap();
        connection
            .execute_batch(
                "PRAGMA foreign_keys=ON;
             INSERT INTO threads(id,title,model,status,created_at,updated_at) VALUES
             ('a','Alpha','model','idle',0,0),('b','Beta','model','idle',0,0);",
            )
            .unwrap();
        for (id, thread, request, role, kind, visible, created, content, payload) in [
            (
                1,
                "a",
                None,
                "user",
                "input",
                1,
                300,
                "Hello",
                " {\n  \"a\":1, \"a\":2 } ".to_owned(),
            ),
            (
                2,
                "b",
                None,
                "assistant",
                "response_output",
                0,
                100,
                "100%_literal",
                "not JSON".to_owned(),
            ),
            (
                3,
                "a",
                Some(1),
                "tool",
                "tool_output",
                0,
                100,
                "工具",
                format!("{}needle", "数据🧪".repeat(400)),
            ),
            (
                4,
                "b",
                Some(2),
                "system",
                "checkpoint",
                0,
                200,
                "",
                "{}".to_owned(),
            ),
            (
                5,
                "a",
                Some(1),
                "system",
                "activity",
                1,
                200,
                "state",
                "{}".to_owned(),
            ),
            (
                6,
                "b",
                Some(2),
                "assistant",
                "response_output",
                1,
                300,
                "needle",
                "{}".to_owned(),
            ),
        ] {
            connection.execute(
                "INSERT INTO history_records(id,thread_id,request_input_id,role,content,kind,payload,visible,created_at)
                 VALUES(?,?,?,?,?,?,?,?,?)", params![id,thread,request,role,content,kind,payload,visible,created],
            ).unwrap();
        }
        connection
    }

    fn query(value: serde_json::Value) -> HistoryQuery {
        serde_json::from_value(value).unwrap()
    }

    fn ids(page: &HistoryPage) -> Vec<i64> {
        page.items.iter().map(|item| item.record.id).collect()
    }

    #[test]
    fn pagination_sorts_all_rows_with_stable_ties_and_clamps_deleted_pages() {
        let mut connection = database();
        let first = load_page(&mut connection, HistoryQuery::default()).unwrap();
        assert_eq!(first.total, 6);
        assert_eq!(ids(&first), [6, 5, 4, 3, 2, 1]);
        assert_eq!(first.items[2].record.visible, 0);
        assert_eq!(first.items[4].record.payload, "not JSON");
        let mut ordered = Vec::new();
        for page in 1..=3 {
            let result = load_page(
                &mut connection,
                query(json!({"sort":"created_at","direction":"asc","page_size":2,"page":page})),
            )
            .unwrap();
            assert_eq!(result.total, 6);
            ordered.extend(ids(&result));
        }
        assert_eq!(ordered, [2, 3, 4, 5, 1, 6]);
        let second = load_page(
            &mut connection,
            query(json!({"sort":"created_at","direction":"desc","page_size":2,"page":2})),
        )
        .unwrap();
        assert_eq!(ids(&second), [5, 4]);
        let last = load_page(
            &mut connection,
            query(json!({"page":i64::MAX,"page_size":2})),
        )
        .unwrap();
        assert_eq!(last.page, 3);
        assert_eq!(ids(&last), [2, 1]);
        let empty = load_page(&mut connection, query(json!({"id":999,"page":9}))).unwrap();
        assert_eq!(empty.page, 1);
        assert_eq!(empty.total, 0);
        assert!(empty.items.is_empty());
    }

    #[test]
    fn filters_use_full_stored_values_and_share_the_count_predicate() {
        let mut connection = database();
        for (input, expected) in [
            (json!({"q":"needle"}), vec![6, 3]),
            (json!({"q":"%_literal"}), vec![2]),
            (json!({"q":"hello"}), vec![]),
            (json!({"q":"' OR 1=1 --"}), vec![]),
            (
                json!({"thread_id":"a","request_input_id":1,"role":"tool","kind":"tool_output","visible":0,"created_from":100,"created_to":100,"q":"needle"}),
                vec![3],
            ),
            (json!({"id":4}), vec![4]),
            (json!({"visible":0}), vec![4, 3, 2]),
            (
                json!({"created_from":200,"created_to":300}),
                vec![6, 5, 4, 1],
            ),
            (json!({"thread_id":"a' OR 1=1 --"}), vec![]),
        ] {
            let page = load_page(&mut connection, query(input)).unwrap();
            assert_eq!(ids(&page), expected);
            assert_eq!(page.total as usize, expected.len());
        }
        let filtered = load_page(
            &mut connection,
            query(json!({"q":"needle","page_size":1,"page":2})),
        )
        .unwrap();
        assert_eq!(filtered.total, 2);
        assert_eq!(ids(&filtered), [3]);
    }

    #[test]
    fn previews_are_bounded_and_detail_preserves_raw_text_nulls_and_integers() {
        let mut connection = database();
        let page = load_page(&mut connection, query(json!({"id":3}))).unwrap();
        let preview = &page.items[0];
        assert_eq!(preview.record.payload.chars().count(), 240);
        assert!(preview.payload_truncated);
        assert!(!preview.content_truncated);
        let raw = load_record(&connection, 3).unwrap();
        assert_eq!(raw.payload, format!("{}needle", "数据🧪".repeat(400)));
        let raw = serde_json::to_value(load_record(&connection, 1).unwrap()).unwrap();
        assert_eq!(raw["payload"], " {\n  \"a\":1, \"a\":2 } ");
        assert_eq!(raw["visible"], 1);
        assert!(raw["request_input_id"].is_null());
        assert_eq!(raw.as_object().unwrap().len(), COLUMNS.len());
        assert_eq!(load_record(&connection, 4).unwrap().content, "");
        assert_eq!(load_record(&connection, 2).unwrap().payload, "not JSON");
        assert_eq!(
            load_record(&connection, 99).err().unwrap().status,
            StatusCode::NOT_FOUND
        );
    }

    #[test]
    fn every_column_sorts_and_invalid_queries_are_rejected() {
        let mut connection = database();
        for (column, ascending) in [
            ("id", vec![1, 2, 3, 4, 5, 6]),
            ("thread_id", vec![1, 3, 5, 2, 4, 6]),
            ("request_input_id", vec![1, 2, 3, 5, 4, 6]),
            ("role", vec![2, 6, 4, 5, 3, 1]),
            ("content", vec![4, 2, 1, 6, 5, 3]),
            ("kind", vec![5, 4, 1, 2, 6, 3]),
            ("payload", vec![1, 2, 4, 5, 6, 3]),
            ("visible", vec![2, 3, 4, 1, 5, 6]),
            ("created_at", vec![2, 3, 4, 5, 1, 6]),
        ] {
            for (direction, expected) in [
                ("asc", ascending.clone()),
                ("desc", ascending.into_iter().rev().collect()),
            ] {
                let page = load_page(
                    &mut connection,
                    query(json!({"sort":column,"direction":direction})),
                )
                .unwrap();
                assert_eq!(ids(&page), expected);
            }
        }
        for value in [
            json!({"page":0}),
            json!({"page":-1}),
            json!({"page_size":0}),
            json!({"page_size":101}),
            json!({"sort":"id; DROP TABLE history_records"}),
            json!({"direction":"desc;--"}),
            json!({"visible":2}),
            json!({"created_from":200,"created_to":100}),
        ] {
            assert_eq!(
                load_page(&mut connection, query(value))
                    .err()
                    .unwrap()
                    .status,
                StatusCode::BAD_REQUEST
            );
        }
    }

    #[tokio::test]
    async fn history_routes_require_browser_authentication() {
        let (_root, state) = test_state();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server =
            tokio::spawn(async move { axum::serve(listener, cloud::app(state)).await.unwrap() });
        let client = reqwest::Client::new();
        for path in ["/api/history?page_size=1", "/api/history/1"] {
            assert_eq!(
                client
                    .get(format!("{base}{path}"))
                    .send()
                    .await
                    .unwrap()
                    .status(),
                StatusCode::UNAUTHORIZED
            );
        }
        server.abort();
    }

    #[tokio::test]
    async fn handlers_only_read_the_authenticated_users_database() {
        let (_root, state) = test_state();
        let owner = cloud::user_for_subject(&state, "history-owner").unwrap();
        let stranger = cloud::user_for_subject(&state, "history-stranger").unwrap();
        let thread = create_test_thread(&state, &owner).await;
        user_db(&state, &owner, false, move |connection| {
            connection.execute("INSERT INTO history_records(thread_id,role,content,kind,payload,visible,created_at) VALUES(?,'system','private','activity','raw',0,123)", [thread.id])?;
            Ok(())
        }).await.unwrap();
        let identity = |user| {
            Extension(BrowserIdentity {
                user,
                bearer: String::new(),
            })
        };
        let page = list(
            State(state.clone()),
            identity(owner.clone()),
            Query(HistoryQuery::default()),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(page.total, 1);
        let id = page.items[0].record.id;
        assert_eq!(
            read(State(state.clone()), identity(owner), Path(id))
                .await
                .unwrap()
                .0
                .payload,
            "raw"
        );
        let page = list(
            State(state.clone()),
            identity(stranger.clone()),
            Query(query(json!({"thread_id":page.items[0].record.thread_id}))),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(page.total, 0);
        let error = read(State(state), identity(stranger), Path(id))
            .await
            .err()
            .unwrap();
        assert_eq!(error.status, StatusCode::NOT_FOUND);
    }
}
