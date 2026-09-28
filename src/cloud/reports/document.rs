use super::*;

pub(super) const THREAD_SECTIONS: [&str; 4] = ["goal", "progress", "decisions", "next_steps"];
pub(super) const DAY_SECTIONS: [&str; 4] = ["completed", "decisions", "in_progress", "blocked"];
const MAX_DOCUMENT_BYTES: usize = 16 * 1024;

pub(super) fn validate(
    text: &str,
    keys: &[&str; 4],
    allowed: &HashSet<i64>,
) -> Result<Document, ApiError> {
    if text.len() > MAX_DOCUMENT_BYTES {
        return Err(ApiError::unavailable(
            "summary exceeds the 16 KiB output budget",
        ));
    }
    let document: Document = serde_json::from_str(text).map_err(|_| {
        ApiError::unavailable("summary did not return the required JSON structure; retry")
    })?;
    if document
        .sections
        .iter()
        .map(|s| s.key.as_str())
        .ne(keys.iter().copied())
    {
        return Err(ApiError::unavailable("summary returned incorrect sections"));
    }
    for section in &document.sections {
        if section.items.len() > 8 {
            return Err(ApiError::unavailable(
                "summary contains too many statements",
            ));
        }
        for item in &section.items {
            if item.text.trim().is_empty()
                || item.text.chars().count() > 500
                || item.evidence.is_empty()
                || item.evidence.len() > 8
                || item.evidence.iter().any(|id| !allowed.contains(id))
            {
                return Err(ApiError::unavailable(
                    "summary has an invalid statement or cites evidence outside its source snapshot",
                ));
            }
        }
    }
    Ok(document)
}
