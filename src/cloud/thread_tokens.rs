//! Thread identity tokens.
//!
//! A Thread can prove which Thread it is. `create_thread_token` signs a
//! short-lived EdDSA JWT whose subject is the calling Thread, and the public
//! half is published at `/.well-known/jwks.json`. An integrating service then
//! verifies the token itself and never holds a Cybion secret: it recorded the
//! Thread id when it asked Cybion to create that Thread, so `sub` is the whole
//! of the answer it needs.
//!
//! Two rules keep the token narrow. `sub` is *always* the Thread that called the
//! tool — there is no argument for it — and it expires in a minute. The token
//! grants nothing by itself: permission stays with the verifier, which decides
//! what its own record of that Thread id may do.
//!
//! The scheme is Auth Mini's, one layer down: two Ed25519 keys in a `current`
//! and a `standby` slot inside the operator database, an `EdDSA` JWT carrying a
//! `kid`, and a JWKS document that publishes *both* slots so a verifier already
//! holds the next key before it starts signing. What it is *not* is an account: a
//! Thread has no session, so a verifier checks `iss`/`exp`/signature here rather
//! than handing the token to `auth-mini-axum`.

use super::*;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{Signer, SigningKey};
use rand::RngCore;
use rand::rngs::OsRng;

/// What a verifier compares `iss` against: the origin this deployment answers
/// on, and the same one pairing hands a Worker as its Controller.
pub(super) const ISSUER: &str = "https://cybion.ntnl.io";
/// One minute: long enough for the request the model mints it for, short enough
/// that a copy left in a Thread's archive is worthless before anyone reads it —
/// which is what makes it safe to show in the conversation or hand to a command.
const TTL_SECONDS: i64 = 60;

/// One signing key. The private half never leaves the operator database, and the
/// `kid` is derived from the public half so a verifier never sees a silent swap.
struct Key {
    signing: SigningKey,
    kid: String,
    public: String,
}

impl Key {
    fn generate() -> Self {
        let mut seed = [0u8; 32];
        OsRng.fill_bytes(&mut seed);
        Self::from_seed(seed)
    }

    fn from_seed(seed: [u8; 32]) -> Self {
        let signing = SigningKey::from_bytes(&seed);
        let public = signing.verifying_key().to_bytes();
        Self {
            signing,
            kid: hex::encode(&Sha256::digest(public)[..8]),
            public: URL_SAFE_NO_PAD.encode(public),
        }
    }

    fn jwk(&self) -> Value {
        json!({
            "kid": self.kid,
            "kty": "OKP",
            "crv": "Ed25519",
            "alg": "EdDSA",
            "use": "sig",
            "x": self.public,
        })
    }
}

/// The signing keys, read from the operator database at startup and replaced in
/// place when an administrator rotates them.
///
/// They live beside the user databases rather than in a file of their own: the
/// operator database is already the one table every deployment backs up, and the
/// keys belong to the deployment, not to any user. Keeping them there adds no
/// exposure *inside* the host — whoever reads that directory already reads every
/// Thread — and what it does extend is the blast radius *outside* the host, which
/// is why both slots are 0600 by way of the database file and never enter the
/// repository.
pub(super) struct Issuer {
    current: Key,
    /// Published, trusted, and not signing — so a rollover invalidates nothing
    /// that a verifier has cached.
    standby: Key,
}

impl Issuer {
    /// Reads both slots from `<admin_db>`, creating whichever is missing. This is
    /// the only place a key is ever generated implicitly; everything after it is
    /// explicit rotation.
    pub(super) fn load_or_create(path: &Path) -> Result<Self> {
        let connection = open_admin_db(path)?;
        let current = insert_key_if_missing(&connection, "current")?;
        let standby = insert_key_if_missing(&connection, "standby")?;
        Ok(Self { current, standby })
    }

    /// Promotes `standby` to `current` and generates a fresh `standby`, which is
    /// exactly what Auth Mini does: a verifier that cached the document already
    /// holds the key that will sign next.
    ///
    /// The key that signed until now is dropped, so a token minted in the minute
    /// before a rollover may reach a verifier that has already refreshed. That is
    /// the deliberate cost of never keeping retired material around.
    pub(super) fn rotate(path: &Path) -> Result<Self> {
        let mut connection = open_admin_db(path)?;
        insert_key_if_missing(&connection, "current")?;
        let promoted = insert_key_if_missing(&connection, "standby")?;
        let replacement = Key::generate();
        let transaction = connection.transaction()?;
        transaction.execute("DELETE FROM thread_token_keys WHERE slot='current'", [])?;
        transaction.execute(
            "UPDATE thread_token_keys SET slot='current' WHERE slot='standby'",
            [],
        )?;
        transaction.execute(
            "INSERT INTO thread_token_keys(slot,kid,seed,created_at) VALUES('standby',?,?,?)",
            params![replacement.kid, replacement.seed_hex(), now()],
        )?;
        transaction.commit()?;
        Ok(Self {
            current: promoted,
            standby: replacement,
        })
    }

    /// Signs one token for one Thread with the current key.
    pub(super) fn issue(&self, thread_id: &str) -> (String, i64) {
        let issued_at = now();
        let expires_at = issued_at + TTL_SECONDS;
        let header = json!({"alg":"EdDSA","kid":self.current.kid,"typ":"JWT"}).to_string();
        let claims = json!({
            "iss": ISSUER,
            "sub": thread_id,
            "iat": issued_at,
            "exp": expires_at,
        })
        .to_string();
        let signing_input = format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(header),
            URL_SAFE_NO_PAD.encode(claims)
        );
        let signature = self.current.signing.sign(signing_input.as_bytes());
        let token = format!(
            "{signing_input}.{}",
            URL_SAFE_NO_PAD.encode(signature.to_bytes())
        );
        (token, expires_at)
    }

    /// The published half: both slots, current first. `kty`/`crv`/`alg`/`use` are
    /// spelled the way every Ed25519 JWKS spells them, which is also what
    /// `auth-mini-axum` accepts.
    pub(super) fn jwks(&self) -> Value {
        json!({"keys": [self.current.jwk(), self.standby.jwk()]})
    }
}

impl Key {
    fn seed_hex(&self) -> String {
        hex::encode(self.signing.to_bytes())
    }
}

fn open_admin_db(path: &Path) -> Result<Connection> {
    let connection = Connection::open(path)?;
    connection.busy_timeout(Duration::from_secs(5))?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    Ok(connection)
}

fn insert_key_if_missing(connection: &Connection, slot: &str) -> Result<Key> {
    let exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM thread_token_keys WHERE slot=?)",
        [slot],
        |row| row.get(0),
    )?;
    if !exists {
        let key = Key::generate();
        connection.execute(
            "INSERT OR IGNORE INTO thread_token_keys(slot,kid,seed,created_at) VALUES(?,?,?,?)",
            params![slot, key.kid, key.seed_hex(), now()],
        )?;
        return stored_key(connection, slot);
    }
    stored_key(connection, slot)
}

fn stored_key(connection: &Connection, slot: &str) -> Result<Key> {
    let seed: String = connection.query_row(
        "SELECT seed FROM thread_token_keys WHERE slot=?",
        [slot],
        |row| row.get(0),
    )?;
    let bytes = hex::decode(&seed).context("thread token key is not hex")?;
    let len = bytes.len();
    let seed: [u8; 32] = bytes
        .try_into()
        .map_err(|_| anyhow::anyhow!("thread token key is {len} bytes, not 32"))?;
    Ok(Key::from_seed(seed))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TokenArguments {}

/// The model-facing tool. It takes no arguments: the subject is the Thread that
/// is running, never something the model can name.
pub(super) async fn tool_output(
    state: &AppState,
    thread_id: &str,
    input: &str,
) -> Result<Value, ApiError> {
    let arguments = input.trim();
    if !arguments.is_empty() {
        serde_json::from_str::<TokenArguments>(arguments).map_err(|error| {
            ApiError::bad_request(format!("create_thread_token takes no arguments: {error}"))
        })?;
    }
    let (token, expires_at) = state.thread_tokens.lock().await.issue(thread_id);
    Ok(json!({
        "token": token,
        "expires_at": expires_at,
        "issuer": ISSUER,
        "note": "Proof of which Thread this is, valid for 60 seconds. Send it as `Authorization: Bearer` to the service that created this Thread. It grants nothing on its own, and it is short enough to show or hand off safely: it expires before anyone could reuse it.",
    }))
}

pub(super) async fn jwks_document(State(state): State<AppState>) -> Json<Value> {
    Json(state.thread_tokens.lock().await.jwks())
}

/// Administrator-only. Promotes the standby key and publishes a new one, so the
/// next mint signs with material verifiers already trust.
pub(super) async fn rotate(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
) -> Result<Json<Value>, ApiError> {
    if !is_admin(&state, &identity.user.id, false).await? {
        return Err(ApiError::forbidden("administrator access is required"));
    }
    let path = state.admin_db_path.as_path().to_path_buf();
    let rotated = tokio::task::spawn_blocking(move || Issuer::rotate(&path))
        .await
        .map_err(ApiError::internal)?
        .map_err(ApiError::internal)?;
    let jwks = rotated.jwks();
    *state.thread_tokens.lock().await = rotated;
    Ok(Json(jwks))
}
