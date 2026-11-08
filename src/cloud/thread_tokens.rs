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
//! The scheme is Auth Mini's, one layer down: an Ed25519 key, an `EdDSA` JWT
//! carrying a `kid`, and a JWKS document a verifier caches and refreshes. What it
//! is *not* is an account: a Thread has no session, so a verifier checks
//! `iss`/`exp`/signature here rather than handing the token to `auth-mini-axum`.

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
const KEY_FILE_NAME: &str = "thread-token.key";

/// The one key that signs Thread tokens.
///
/// It lives beside the user databases, so it adds no exposure *inside* the host:
/// whoever reads that directory already reads every Thread. What it does extend
/// is the blast radius *outside* the host — a verifier trusts anything this key
/// signs about a Thread id — which is why the file is 0600, generated locally,
/// and never enters the repository.
pub(super) struct Issuer {
    signing: SigningKey,
    /// Derived from the public key, so a verifier never sees a silent key change.
    kid: String,
    public: String,
}

impl Issuer {
    /// Reads `<data_dir>/thread-token.key`, creating it on first boot. A file
    /// that exists but cannot be parsed is an error, not a rotation: minting a
    /// fresh key behind a verifier's back would invalidate tokens it still holds
    /// and publish a `kid` nobody asked for.
    pub(super) fn load_or_create(data_dir: &Path) -> Result<Self> {
        let path = data_dir.join(KEY_FILE_NAME);
        let seed = match fs::read_to_string(&path) {
            Ok(text) => parse_seed(text.trim())?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let mut seed = [0u8; 32];
                OsRng.fill_bytes(&mut seed);
                write_seed(&path, &seed)?;
                seed
            }
            Err(error) => return Err(error.into()),
        };
        Ok(Self::from_seed(seed))
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

    /// Signs one token for one Thread and reports when it dies.
    pub(super) fn issue(&self, thread_id: &str) -> (String, i64) {
        let issued_at = now();
        let expires_at = issued_at + TTL_SECONDS;
        let header = json!({"alg":"EdDSA","kid":self.kid,"typ":"JWT"}).to_string();
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
        let signature = self.signing.sign(signing_input.as_bytes());
        let token = format!(
            "{signing_input}.{}",
            URL_SAFE_NO_PAD.encode(signature.to_bytes())
        );
        (token, expires_at)
    }

    /// The published half. `kty`/`crv`/`alg`/`use` are spelled the way every
    /// Ed25519 JWKS spells them, which is also what `auth-mini-axum` accepts.
    pub(super) fn jwks(&self) -> Value {
        json!({"keys": [{
            "kid": self.kid,
            "kty": "OKP",
            "crv": "Ed25519",
            "alg": "EdDSA",
            "use": "sig",
            "x": self.public,
        }]})
    }
}

fn parse_seed(text: &str) -> Result<[u8; 32]> {
    let bytes = hex::decode(text).context("thread token key is not hex")?;
    let len = bytes.len();
    bytes
        .try_into()
        .map_err(|_| anyhow::anyhow!("thread token key is {len} bytes, not 32"))
}

fn write_seed(path: &Path, seed: &[u8; 32]) -> Result<()> {
    use std::io::Write;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    file.write_all(hex::encode(seed).as_bytes())?;
    file.sync_all()?;
    Ok(())
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
    let (token, expires_at) = state.thread_tokens.issue(thread_id);
    Ok(json!({
        "token": token,
        "expires_at": expires_at,
        "issuer": ISSUER,
        "note": "Proof of which Thread this is, valid for 60 seconds. Send it as `Authorization: Bearer` to the service that created this Thread. It grants nothing on its own, and it is short enough to show or hand off safely: it expires before anyone could reuse it.",
    }))
}

pub(super) async fn jwks_document(State(state): State<AppState>) -> Json<Value> {
    Json(state.thread_tokens.jwks())
}
