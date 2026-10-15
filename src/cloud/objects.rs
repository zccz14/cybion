use super::*;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

/// The content-addressed media store: `<data_dir>/objects/<first two hex
/// characters>/<sha256>`. Media is written once - identical bytes share one
/// object - and never modified; records reference objects by hash.
pub(super) fn put(data_dir: &Path, bytes: &[u8]) -> Result<String, ApiError> {
    let id = hex::encode(Sha256::digest(bytes));
    let dir = data_dir.join("objects").join(&id[..2]);
    fs::create_dir_all(&dir).map_err(ApiError::internal)?;
    #[cfg(unix)]
    {
        fs::set_permissions(data_dir.join("objects"), fs::Permissions::from_mode(0o700))
            .map_err(ApiError::internal)?;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).map_err(ApiError::internal)?;
    }
    let path = dir.join(&id);
    // Objects are immutable: an existing id already holds these bytes.
    if !path.exists() {
        let temporary = dir.join(format!(".{id}.{}.tmp", Uuid::new_v4().simple()));
        fs::write(&temporary, bytes).map_err(ApiError::internal)?;
        #[cfg(unix)]
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))
            .map_err(ApiError::internal)?;
        fs::rename(&temporary, &path).map_err(ApiError::internal)?;
    }
    Ok(id)
}

pub(super) fn read(data_dir: &Path, id: &str) -> Result<Vec<u8>, ApiError> {
    if id.len() != 64 || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(ApiError::internal(format!(
            "invalid object reference: {id}"
        )));
    }
    fs::read(data_dir.join("objects").join(&id[..2]).join(id))
        .map_err(|error| ApiError::internal(format!("stored object {id} is unavailable: {error}")))
}
