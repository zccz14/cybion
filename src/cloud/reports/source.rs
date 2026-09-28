use super::*;

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct RecordSource {
    pub id: i64,
    pub kind: String,
    pub created_at: i64,
}
#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Child {
    pub thread_id: String,
    pub source_fingerprint: String,
    pub summary_id: Option<i64>,
}
#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Manifest {
    pub records: Vec<RecordSource>,
    pub background_input_id: Option<i64>,
    pub children: Vec<Child>,
}
#[derive(Clone)]
pub(super) struct Source {
    pub date: String,
    pub thread_id: Option<String>,
    pub title: String,
    pub fingerprint: String,
    pub manifest: Manifest,
}

fn make_source(
    date: NaiveDate,
    thread_id: Option<String>,
    title: String,
    manifest: Manifest,
) -> Result<Source, ApiError> {
    // INVARIANT: history_records is an append-only log. Exact IDs, kinds and
    // timestamps identify the retained evidence; reading reports never edits it.
    let fingerprint=hash_secret(&serde_json::to_string(&json!({"date":date,"timezone":"UTC","thread_id":thread_id,"title":title,"manifest":manifest,"prompt_version":PROMPT_VERSION})).map_err(ApiError::internal)?);
    Ok(Source {
        date: date.to_string(),
        thread_id,
        title,
        fingerprint,
        manifest,
    })
}

pub(super) fn active_threads(c: &Connection, date: NaiveDate) -> Result<Vec<String>, ApiError> {
    let (start, end) = utc_day_bounds(date);
    Ok(c.prepare("SELECT DISTINCT thread_id FROM history_records WHERE kind<>'checkpoint' AND created_at>=? AND created_at<? ORDER BY thread_id")?
        .query_map(params![start,end],|r|r.get(0))?.collect::<rusqlite::Result<_>>()?)
}

pub(super) fn thread_source(c: &Connection, date: NaiveDate, id: &str) -> Result<Source, ApiError> {
    let title: String = c
        .query_row("SELECT title FROM threads WHERE id=?", [id], |r| r.get(0))
        .optional()?
        .ok_or_else(|| ApiError::not_found("thread not found"))?;
    let (start, end) = utc_day_bounds(date);
    let records=c.prepare("SELECT id,kind,created_at FROM history_records WHERE thread_id=? AND kind<>'checkpoint' AND created_at>=? AND created_at<? ORDER BY id")?
        .query_map(params![id,start,end],|r|Ok(RecordSource{id:r.get(0)?,kind:r.get(1)?,created_at:r.get(2)?}))?.collect::<rusqlite::Result<Vec<_>>>()?;
    let background=c.query_row("SELECT id FROM history_records WHERE thread_id=? AND kind='input' AND created_at<? ORDER BY created_at DESC,id DESC LIMIT 1",params![id,start],|r|r.get(0)).optional()?;
    make_source(
        date,
        Some(id.to_owned()),
        title,
        Manifest {
            records,
            background_input_id: background,
            children: Vec::new(),
        },
    )
}

pub(super) fn daily_source(c: &Connection, date: NaiveDate) -> Result<Source, ApiError> {
    let mut children = Vec::new();
    let mut records = Vec::new();
    for id in active_threads(c, date)? {
        let source = thread_source(c, date, &id)?;
        let saved = latest_completed(c, &date.to_string(), Some(&id))?;
        children.push(Child {
            thread_id: id,
            source_fingerprint: source.fingerprint,
            summary_id: saved.map(|s| s.id),
        });
        records.extend(source.manifest.records);
    }
    records.sort_by_key(|record| record.id);
    make_source(
        date,
        None,
        "Daily report".to_owned(),
        Manifest {
            records,
            background_input_id: None,
            children,
        },
    )
}

pub(super) fn require_current_children(c: &Connection, source: &Source) -> Result<(), ApiError> {
    if source.manifest.children.is_empty() {
        return Err(ApiError::bad_request("no active Threads to summarize"));
    }
    for child in &source.manifest.children {
        let id = child.summary_id.ok_or_else(|| {
            ApiError::conflict("generate all Thread summaries before the daily report")
        })?;
        let saved = summary(c, id)?;
        if saved.source_fingerprint != child.source_fingerprint
            || saved.prompt_version != PROMPT_VERSION
        {
            return Err(ApiError::conflict(
                "activity changed while generating; update Thread summaries before the daily report",
            ));
        }
    }
    Ok(())
}

pub(super) struct Unit {
    pub text: String,
    pub evidence: HashSet<i64>,
}

// Textual evidence is fragmented, never silently truncated. Binary images and
// encrypted reasoning cannot be summarized as text and have explicit markers.
fn text_projection(value: &mut Value) {
    match value {
        Value::Object(object) => {
            let image = object.get("type").and_then(Value::as_str) == Some("image_generation_call");
            for (key, child) in object {
                if matches!(key.as_str(), "encrypted_content" | "b64_json" | "file_data")
                    || (image && key == "result")
                {
                    *child = json!("[binary/encrypted content omitted; inspect original record]");
                } else {
                    text_projection(child);
                }
            }
        }
        Value::Array(values) => {
            for value in values {
                text_projection(value);
            }
        }
        Value::String(text) if text.starts_with("data:") => {
            *text = "[binary media omitted; inspect original record]".to_owned();
        }
        _ => {}
    }
}

pub(super) fn units(c: &Connection, source: &Source) -> Result<(Vec<Unit>, String), ApiError> {
    if source.thread_id.is_none() {
        require_current_children(c, source)?;
        let mut units = Vec::new();
        for child in &source.manifest.children {
            let saved = summary(c, child.summary_id.expect("validated child"))?;
            let document = saved
                .content
                .ok_or_else(|| ApiError::internal("completed summary has no content"))?;
            let evidence = citations(&document);
            units.push(Unit{text:json!({"thread_id":child.thread_id,"summary_version":saved.id,"summary":document}).to_string(),evidence});
        }
        return Ok((units, String::new()));
    }
    let thread = source.thread_id.as_deref().expect("Thread source");
    let last = source.manifest.records.last().map(|r| r.id).unwrap_or(0);
    let (start, end) = utc_day_bounds(report_date(Some(&source.date))?);
    let bytes:i64=c.query_row("SELECT COALESCE(SUM(length(CAST(payload AS BLOB))),0) FROM history_records WHERE thread_id=? AND kind<>'checkpoint' AND created_at>=? AND created_at<? AND id<=?",params![thread,start,end,last],|r|r.get(0))?;
    if bytes > 16 * 1024 * 1024 {
        return Err(ApiError::bad_request(
            "Thread day exceeds the 16 MiB evidence budget; no source was silently dropped",
        ));
    }
    let records=c.prepare("SELECT id,kind,created_at,payload FROM history_records WHERE thread_id=? AND kind<>'checkpoint' AND created_at>=? AND created_at<? AND id<=? ORDER BY id")?
        .query_map(params![thread,start,end,last],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,i64>(2)?,r.get::<_,String>(3)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
    if records
        .iter()
        .map(|r| r.0)
        .ne(source.manifest.records.iter().map(|r| r.id))
    {
        return Err(ApiError::conflict("source records changed or were deleted"));
    }
    let mut units = Vec::new();
    for (id, kind, created_at, payload) in records {
        let mut value: Value = serde_json::from_str(&payload).map_err(ApiError::internal)?;
        text_projection(&mut value);
        let text = value.to_string();
        let fragments = split_utf8_by_bytes(&text, 16 * 1024);
        for (part, fragment) in fragments.iter().enumerate() {
            units.push(Unit{text:json!({"record_id":id,"thread_id":thread,"kind":kind,"created_at":created_at,"part":part+1,"parts":fragments.len(),"payload_fragment":fragment}).to_string(),evidence:HashSet::from([id])});
        }
    }
    let background = match source.manifest.background_input_id {
        Some(id) => {
            let payload: String = c.query_row(
                "SELECT substr(payload,1,4096) FROM history_records WHERE id=? AND thread_id=?",
                params![id, thread],
                |r| r.get(0),
            )?;
            format!(
                "Background only: previous user input #{id}, at most 4096 characters. Never cite as today's evidence or count its outcomes today.\n{payload}"
            )
        }
        None => String::new(),
    };
    Ok((units, background))
}

pub(super) fn citations(document: &Document) -> HashSet<i64> {
    document
        .sections
        .iter()
        .flat_map(|s| &s.items)
        .flat_map(|item| item.evidence.iter().copied())
        .collect()
}
