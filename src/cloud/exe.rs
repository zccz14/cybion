//! eXe devices: hands Cybion reaches through a relay that cannot read them.
//!
//! A Cybion Worker is a connection this Controller pushes work down, and the
//! record of what happened stays here. An eXe device is the opposite
//! arrangement: the relay only queues opaque envelopes, every command is signed
//! and sealed by the caller, and only the device can open it. So a Cybion
//! account holds one caller identity — an Ed25519 key pair whose secret never
//! leaves the Controller and whose address is the whole of what a user sees —
//! and each eXe device that trusts that address becomes one more device in the
//! same list a Worker lives in.
//!
//! Three rules keep the two kinds one device layer:
//!
//! - a `workers` row of kind `exe` is addressed by its `exe_address`; nothing
//!   pushes to it, because it has no connection to this Controller;
//! - `worker_calls` stays the single ledger. The driver below claims a queued
//!   call exactly like the Worker event stream claims one, and settles it
//!   through the same `settle_worker_call_result` the Worker result endpoint
//!   uses, so a Thread sees one kind of result either way;
//! - the Controller never depends on the relay understanding anything: it
//!   seals with the device's address, opens with its own key, and treats every
//!   byte the relay returns as untrusted until the device's signature verifies.

use super::*;
use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce as GcmNonce};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use crypto_box::aead::AeadInPlace;
use crypto_box::{
    Nonce as BoxNonce, PublicKey as BoxPublicKey, SalsaBox, SecretKey as BoxSecretKey,
};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use futures_util::future::join_all;
use rand::RngCore;
use rand::rngs::OsRng;
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::Sha512;
use std::time::Duration;

/// The relay a Cybion account talks to. Devices carry their own endpoint list;
/// the Controller only needs one reachable entry, and both entries name the
/// same relay.
pub(super) const API_URL: &str = "https://exe.ntnl.io";
/// eXe caps one call's lifetime at an hour, so Cybion never asks for longer.
const MAX_CALL_LIFETIME_SECONDS: i64 = 3600;
/// A device has no connection to push down, so the Controller looks instead.
/// This is how often one driver pass runs.
const DRIVE_TICK: Duration = Duration::from_secs(2);
/// One live call is read at most this often while it waits for the device.
const POLL_FLOOR: Duration = Duration::from_millis(500);
const POLL_CEILING: Duration = Duration::from_millis(2500);
/// Requests to the relay are small; a slow one must not hold the pass.
const HTTP_TIMEOUT: Duration = Duration::from_secs(10);
const PROBE_TIMEOUT: Duration = Duration::from_secs(4);
/// One pass drives at most this many pending calls per user.
const DRIVE_BATCH: usize = 16;
/// A call whose envelope never reached the relay is retried for this long
/// before it is settled as a failure the model can see and correct.
const SUBMIT_GRACE: Duration = Duration::from_secs(60);

fn unix() -> u64 {
    now().max(0) as u64
}

fn push_lp(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    out.extend_from_slice(bytes);
}

fn push_u64(out: &mut Vec<u8>, value: u64) {
    out.extend_from_slice(&value.to_be_bytes());
}

fn b58(bytes: &[u8]) -> String {
    bs58::encode(bytes).into_string()
}

fn unb58(text: &str) -> Vec<u8> {
    bs58::decode(text).into_vec().unwrap_or_default()
}

fn b64u(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

fn unb64u(text: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(text.trim_end_matches('=')).ok()
}

fn random<const N: usize>() -> [u8; N] {
    let mut out = [0u8; N];
    OsRng.fill_bytes(&mut out);
    out
}

/// `base58(pub32)`: the address an eXe device trusts and a Cybion user sees.
fn parse_address(text: &str) -> Result<[u8; 32], ApiError> {
    let raw = unb58(text);
    if raw.len() != 32 {
        return Err(ApiError::bad_request(
            "an eXe address is the base58 form of a 32-byte public key",
        ));
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&raw);
    VerifyingKey::from_bytes(&out)
        .map_err(|_| ApiError::bad_request("that string is not an Ed25519 address"))?;
    Ok(out)
}

/// edwardsToMontgomery(ed25519_pub): the key a `crypto_box` envelope is sealed to.
fn agreement_public_of(public: &[u8; 32]) -> Result<[u8; 32], ApiError> {
    let verifying = VerifyingKey::from_bytes(public)
        .map_err(|_| ApiError::bad_request("that string is not an Ed25519 address"))?;
    Ok(verifying.to_montgomery().to_bytes())
}

/// The one key pair a Cybion account holds on eXe. The secret is stored in the
/// user's own database and never leaves the Controller: a user sees the address
/// (the public half) because a device has to be told what to trust, and nothing
/// else.
#[derive(Clone)]
pub(super) struct Identity {
    seed: [u8; 32],
    public: [u8; 32],
}

impl Identity {
    fn generate() -> Self {
        Self::from_seed(random::<32>())
    }

    fn from_seed(seed: [u8; 32]) -> Self {
        let public = SigningKey::from_bytes(&seed).verifying_key().to_bytes();
        Self { seed, public }
    }

    /// `base58(seed32 || pub32)`, the same layout an eXe client writes, so the
    /// secret can be moved between a Cybion account and a hand-held device by
    /// hand if custody ever has to change.
    fn from_secret(secret: &str) -> Result<Self, ApiError> {
        let raw = unb58(secret);
        if raw.len() != 64 {
            return Err(ApiError::internal("stored eXe secret is malformed"));
        }
        let mut seed = [0u8; 32];
        seed.copy_from_slice(&raw[..32]);
        let identity = Self::from_seed(seed);
        if identity.public != raw[32..] {
            return Err(ApiError::internal(
                "stored eXe secret does not match its own public key",
            ));
        }
        Ok(identity)
    }

    fn secret(&self) -> String {
        let mut raw = [0u8; 64];
        raw[..32].copy_from_slice(&self.seed);
        raw[32..].copy_from_slice(&self.public);
        b58(&raw)
    }

    fn address(&self) -> String {
        b58(&self.public)
    }

    fn sign(&self, message: &[u8]) -> String {
        b58(&SigningKey::from_bytes(&self.seed).sign(message).to_bytes())
    }

    /// clamp(sha512(seed)[0..32]) — the X25519 half of the same key, which is
    /// how one key both signs and receives sealed bytes.
    fn agreement_secret(&self) -> [u8; 32] {
        let digest = Sha512::digest(self.seed);
        let mut scalar = [0u8; 32];
        scalar.copy_from_slice(&digest[..32]);
        scalar[0] &= 248;
        scalar[31] = (scalar[31] & 127) | 64;
        scalar
    }
}

fn verify(public: &[u8; 32], message: &[u8], signature: &str) -> bool {
    let raw = unb58(signature);
    let Ok(signature) = Signature::from_slice(&raw) else {
        return false;
    };
    let Ok(verifying) = VerifyingKey::from_bytes(public) else {
        return false;
    };
    verifying.verify_strict(message, &signature).is_ok()
}

/// aad = direction ‖ caller ‖ device ‖ call_id ‖ issued_at ‖ expires_at, each
/// field length-prefixed. Every field a call is bound to is in here, so the
/// relay cannot move a body from one call to another.
struct SealContext<'a> {
    direction: &'a str,
    caller: &'a str,
    device: &'a str,
    call_id: &'a str,
    issued_at: u64,
    expires_at: u64,
}

impl SealContext<'_> {
    fn aad(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(128);
        push_lp(&mut out, self.direction.as_bytes());
        push_lp(&mut out, self.caller.as_bytes());
        push_lp(&mut out, self.device.as_bytes());
        push_lp(&mut out, self.call_id.as_bytes());
        push_u64(&mut out, self.issued_at);
        push_u64(&mut out, self.expires_at);
        out
    }
}

/// sealed = base64url( nonce24 ‖ eph_pub32 ‖ tag16‖wrapped32 ‖ iv12 ‖ body ).
fn seal(context: &SealContext, recipient: &[u8; 32], plaintext: &[u8]) -> Result<String, ApiError> {
    let nonce = random::<24>();
    let content_key = random::<32>();
    let iv = random::<12>();
    let ephemeral = BoxSecretKey::from(random::<32>());
    let cipher = Aes256Gcm::new_from_slice(&content_key)
        .map_err(|_| ApiError::internal("eXe content key is unusable"))?;
    let body = cipher
        .encrypt(
            GcmNonce::from_slice(&iv),
            Payload {
                msg: plaintext,
                aad: &context.aad(),
            },
        )
        .map_err(|_| ApiError::internal("eXe sealing failed"))?;
    let salsa = SalsaBox::new(&BoxPublicKey::from(*recipient), &ephemeral);
    let mut wrapped = content_key.to_vec();
    let tag = salsa
        .encrypt_in_place_detached(BoxNonce::from_slice(&nonce), b"", &mut wrapped)
        .map_err(|_| ApiError::internal("eXe key wrapping failed"))?;
    let mut out = Vec::with_capacity(116 + body.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(ephemeral.public_key().as_bytes());
    out.extend_from_slice(&tag);
    out.extend_from_slice(&wrapped);
    out.extend_from_slice(&iv);
    out.extend_from_slice(&body);
    Ok(b64u(&out))
}

fn open_sealed(
    context: &SealContext,
    identity: &Identity,
    sealed: &str,
) -> Result<Vec<u8>, ApiError> {
    let raw = unb64u(sealed)
        .ok_or_else(|| ApiError::bad_request("an eXe sealed value is not base64url"))?;
    open_sealed_bytes(context, identity, &raw)
}

fn open_sealed_bytes(
    context: &SealContext,
    identity: &Identity,
    raw: &[u8],
) -> Result<Vec<u8>, ApiError> {
    if raw.len() < 116 + 16 {
        return Err(ApiError::bad_request("an eXe sealed value is too short"));
    }
    let nonce = &raw[..24];
    let mut ephemeral = [0u8; 32];
    ephemeral.copy_from_slice(&raw[24..56]);
    let mut wrapped = [0u8; 32];
    wrapped.copy_from_slice(&raw[72..104]);
    let mut tag = [0u8; 16];
    tag.copy_from_slice(&raw[56..72]);
    let mut content_key = wrapped;
    let salsa = SalsaBox::new(
        &BoxPublicKey::from(ephemeral),
        &BoxSecretKey::from(identity.agreement_secret()),
    );
    salsa
        .decrypt_in_place_detached(
            BoxNonce::from_slice(nonce),
            b"",
            &mut content_key,
            (&tag).into(),
        )
        .map_err(|_| ApiError::bad_request("an eXe sealed value does not open with this key"))?;
    let cipher = Aes256Gcm::new_from_slice(&content_key)
        .map_err(|_| ApiError::internal("eXe content key is unusable"))?;
    cipher
        .decrypt(
            GcmNonce::from_slice(&raw[104..116]),
            Payload {
                msg: &raw[116..],
                aad: &context.aad(),
            },
        )
        .map_err(|_| ApiError::bad_request("an eXe sealed body failed authentication"))
}

/// An opaque command on the wire. Everything readable here is routing metadata:
/// the relay knows who called whom, how long it may live, and how big it is.
#[derive(Serialize, Deserialize)]
struct CallEnvelope {
    call_id: String,
    caller: String,
    device: String,
    issued_at: u64,
    expires_at: u64,
    sealed: String,
    sig: String,
}

impl CallEnvelope {
    fn transcript(&self) -> Result<Vec<u8>, ApiError> {
        let mut out = Vec::with_capacity(256);
        out.extend_from_slice(b"eXe/call\0");
        push_lp(&mut out, self.call_id.as_bytes());
        push_lp(&mut out, self.caller.as_bytes());
        push_lp(&mut out, self.device.as_bytes());
        push_u64(&mut out, self.issued_at);
        push_u64(&mut out, self.expires_at);
        push_lp(
            &mut out,
            &unb64u(&self.sealed)
                .ok_or_else(|| ApiError::internal("eXe envelope sealed value is not base64url"))?,
        );
        Ok(out)
    }

    fn build(
        identity: &Identity,
        device: &str,
        call_id: &str,
        plaintext: &[u8],
        issued_at: u64,
        expires_at: u64,
    ) -> Result<Self, ApiError> {
        let caller = identity.address();
        let context = SealContext {
            direction: "call",
            caller: &caller,
            device,
            call_id,
            issued_at,
            expires_at,
        };
        let recipient = agreement_public_of(&parse_address(device)?)?;
        let sealed = seal(&context, &recipient, plaintext)?;
        let mut envelope = Self {
            call_id: call_id.to_owned(),
            caller,
            device: device.to_owned(),
            issued_at,
            expires_at,
            sealed,
            sig: String::new(),
        };
        envelope.sig = identity.sign(&envelope.transcript()?);
        Ok(envelope)
    }
}

/// The device's answer: the same key that signs also received the call.
#[derive(Serialize, Deserialize)]
struct ResultEnvelope {
    call_id: String,
    device: String,
    ok: bool,
    issued_at: u64,
    sealed: String,
    sig: String,
}

impl ResultEnvelope {
    fn transcript(&self) -> Result<Vec<u8>, ApiError> {
        let mut out = Vec::with_capacity(256);
        out.extend_from_slice(b"eXe/result\0");
        push_lp(&mut out, self.call_id.as_bytes());
        push_lp(&mut out, self.device.as_bytes());
        out.push(u8::from(self.ok));
        push_u64(&mut out, self.issued_at);
        push_lp(
            &mut out,
            &unb64u(&self.sealed)
                .ok_or_else(|| ApiError::bad_request("an eXe result is not base64url"))?,
        );
        Ok(out)
    }
}

fn request_headers(identity: &Identity, method: &str, path: &str) -> Vec<(String, String)> {
    let address = identity.address();
    let timestamp = unix();
    let mut transcript = Vec::with_capacity(160);
    transcript.extend_from_slice(b"eXe/request\0");
    push_lp(&mut transcript, method.to_uppercase().as_bytes());
    push_lp(&mut transcript, path.as_bytes());
    push_lp(&mut transcript, address.as_bytes());
    push_u64(&mut transcript, timestamp);
    vec![
        ("x-exe-address".to_owned(), address),
        ("x-exe-timestamp".to_owned(), timestamp.to_string()),
        ("x-exe-signature".to_owned(), identity.sign(&transcript)),
    ]
}

/// What the relay says about one device. The relay is the only party that can
/// answer "is it awake", because the device holds no connection to Cybion.
#[derive(Default)]
pub(super) struct DeviceStatus {
    pub(super) registered: bool,
    pub(super) online: bool,
    pub(super) platform: Option<String>,
    pub(super) version: Option<String>,
    pub(super) last_seen_at: Option<i64>,
}

struct Relay<'a> {
    http: &'a reqwest::Client,
    base: &'a str,
    identity: &'a Identity,
}

impl Relay<'_> {
    fn new<'a>(state: &'a AppState, identity: &'a Identity) -> Relay<'a> {
        Relay {
            http: &state.client,
            base: state.exe_api_url.trim_end_matches('/'),
            identity,
        }
    }

    async fn send(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<&Value>,
        timeout: Duration,
    ) -> Result<Value, ApiError> {
        let mut request = self
            .http
            .request(method.clone(), format!("{}{}", self.base, path))
            .timeout(timeout);
        for (name, value) in request_headers(self.identity, method.as_str(), path) {
            request = request.header(name, value);
        }
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = request.send().await.map_err(|error| {
            ApiError::transient(format!("the eXe relay could not be reached: {error}"), None)
        })?;
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        let value: Value = serde_json::from_str(&text).unwrap_or_else(|_| json!({ "error": text }));
        if status.is_success() {
            return Ok(value);
        }
        let detail = value
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("the eXe relay gave no reason")
            .to_owned();
        Err(match status.as_u16() {
            403 => ApiError::conflict(format!(
                "the eXe relay will not queue this call; the device does not trust this Cybion address, or the envelope signature did not verify ({detail})"
            )),
            404 => ApiError::conflict(format!("the eXe relay cannot find that device ({detail})")),
            400 | 401 => {
                ApiError::conflict(format!("the eXe relay refused the request ({detail})"))
            }
            409 => ApiError::conflict(format!("the eXe relay reports a conflict ({detail})")),
            _ => ApiError::transient(format!("the eXe relay answered {status} ({detail})"), None),
        })
    }

    async fn device(&self, address: &str) -> Result<DeviceStatus, ApiError> {
        let value = self
            .send(
                reqwest::Method::GET,
                &format!("/api/devices/{address}"),
                None,
                PROBE_TIMEOUT,
            )
            .await?;
        Ok(DeviceStatus {
            registered: value["registered"].as_bool().unwrap_or(false),
            online: value["online"].as_bool().unwrap_or(false),
            platform: value["platform"].as_str().map(str::to_owned),
            version: value["version"].as_str().map(str::to_owned),
            last_seen_at: value["last_seen_at"].as_i64(),
        })
    }

    async fn submit(&self, envelope: &CallEnvelope) -> Result<(), ApiError> {
        let body = serde_json::to_value(envelope).map_err(ApiError::internal)?;
        self.send(
            reqwest::Method::POST,
            &format!("/api/devices/{}/calls", envelope.device),
            Some(&body),
            HTTP_TIMEOUT,
        )
        .await?;
        Ok(())
    }

    async fn call(&self, call_id: &str) -> Result<Value, ApiError> {
        self.send(
            reqwest::Method::GET,
            &format!("/api/calls/{call_id}"),
            None,
            HTTP_TIMEOUT,
        )
        .await
    }

    async fn cancel(&self, call_id: &str) -> Result<(), ApiError> {
        let path = format!("/api/calls/{call_id}/cancel");
        self.send(reqwest::Method::POST, &path, None, HTTP_TIMEOUT)
            .await?;
        Ok(())
    }

    async fn ack(&self, call_id: &str) -> Result<(), ApiError> {
        let path = format!("/api/calls/{call_id}/ack");
        self.send(reqwest::Method::POST, &path, None, HTTP_TIMEOUT)
            .await?;
        Ok(())
    }

    async fn blob(&self, call_id: &str) -> Result<Vec<u8>, ApiError> {
        let path = format!("/api/calls/{call_id}/blob");
        let mut request = self
            .http
            .get(format!("{}{}", self.base, path))
            .timeout(HTTP_TIMEOUT);
        for (name, value) in request_headers(self.identity, reqwest::Method::GET.as_str(), &path) {
            request = request.header(name, value);
        }
        let response = request.send().await.map_err(|error| {
            ApiError::transient(format!("the eXe relay could not be reached: {error}"), None)
        })?;
        if !response.status().is_success() {
            return Err(ApiError::conflict(
                "the eXe attachment is no longer available",
            ));
        }
        Ok(response.bytes().await.map_err(ApiError::internal)?.to_vec())
    }
}

/// The caller identity a Cybion account owns, or `None` before its first use.
/// The secret never leaves this database and is never returned by an API.
pub(super) fn stored(c: &Connection) -> Result<Option<(Identity, i64)>, ApiError> {
    c.query_row(
        "SELECT secret,created_at FROM exe_identity WHERE id=1",
        [],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
    )
    .optional()?
    .map(|(secret, created_at)| Ok((Identity::from_secret(&secret)?, created_at)))
    .transpose()
}

/// The account's identity, generated on first use. A user never sees the
/// secret; what they see is the address, which is the public key.
fn ensure(c: &Connection) -> Result<(Identity, i64), ApiError> {
    if let Some(found) = stored(c)? {
        return Ok(found);
    }
    let identity = Identity::generate();
    let created_at = now();
    c.execute(
        "INSERT INTO exe_identity(id,secret,created_at) VALUES(1,?,?)",
        params![identity.secret(), created_at],
    )?;
    Ok((identity, created_at))
}

pub(super) async fn identity_for(state: &AppState, user: &User) -> Result<(String, i64), ApiError> {
    let (identity, created_at) = user_db(state, user, true, |c| ensure(c)).await?;
    Ok((identity.address(), created_at))
}

pub(super) struct ExeDevice {
    pub(super) id: String,
    pub(super) label: String,
    pub(super) address: String,
    pub(super) platform: Option<String>,
    pub(super) version: Option<String>,
    pub(super) last_seen_at: Option<i64>,
    pub(super) created_at: i64,
}

pub(super) fn devices(c: &Connection) -> Result<Vec<ExeDevice>, ApiError> {
    let mut statement = c.prepare(
        "SELECT id,label,exe_address,platform,version,last_seen_at,created_at FROM workers WHERE kind='exe' AND deleted_at IS NULL ORDER BY created_at,id",
    )?;
    let rows = statement.query_map([], |r| {
        Ok(ExeDevice {
            id: r.get(0)?,
            label: r.get(1)?,
            address: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
            platform: r.get(3)?,
            version: r.get(4)?,
            last_seen_at: r.get(5)?,
            created_at: r.get(6)?,
        })
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}

fn apply_status(c: &Connection, id: &str, status: &DeviceStatus) -> Result<(), ApiError> {
    c.execute(
        "UPDATE workers SET last_seen_at=?,status=?,platform=COALESCE(?,platform),version=COALESCE(?,version) WHERE id=? AND kind='exe'",
        params![
            status.last_seen_at,
            if status.online { "online" } else { "offline" },
            status.platform,
            status.version,
            id
        ],
    )?;
    Ok(())
}

fn insert_device(
    c: &Connection,
    id: &str,
    label: &str,
    address: &str,
    status: &DeviceStatus,
) -> Result<(), ApiError> {
    c.execute(
        "INSERT INTO workers(id,label,token_hash,created_at,last_seen_at,status,kind,exe_address,platform,version) VALUES(?,?,?,?,?,?,'exe',?,?,?)",
        params![
            id,
            label,
            format!("exe:{id}"),
            now(),
            status.last_seen_at,
            if status.online { "online" } else { "offline" },
            address,
            status.platform,
            status.version
        ],
    )?;
    Ok(())
}

/// Reads the relay's view of every eXe device this account owns and stores it.
/// Online state is not something Cybion can infer: no connection exists until
/// the relay is asked, so a stale answer is worse than none.
pub(super) async fn refresh(state: &AppState, user: &User) -> Result<(), ApiError> {
    let owned = user_db(state, user, false, |c| devices(c)).await?;
    if owned.is_empty() {
        return Ok(());
    }
    let Some((identity, _)) = user_db(state, user, false, |c| stored(c)).await? else {
        return Ok(());
    };
    let probes = join_all(owned.iter().map(|device| {
        let identity = identity.clone();
        async move {
            let status = Relay::new(state, &identity).device(&device.address).await;
            (device.id.clone(), status)
        }
    }))
    .await;
    let updates = probes
        .into_iter()
        .filter_map(|(id, status)| status.ok().map(|status| (id, status)))
        .collect::<Vec<_>>();
    if updates.is_empty() {
        return Ok(());
    }
    user_db(state, user, false, move |c| {
        for (id, status) in &updates {
            apply_status(c, id, status)?;
        }
        Ok(())
    })
    .await
}

/// `GET /api/exe`: the account's address — the only half of the key a user is
/// meant to see — plus the devices that address can reach.
pub(super) async fn read(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
) -> Result<Json<Value>, ApiError> {
    let user = identity.user;
    let (address, created_at) = identity_for(&state, &user).await?;
    if let Err(error) = refresh(&state, &user).await {
        tracing::warn!(error = %error.message, "eXe device status refresh deferred");
    }
    let owned = user_db(&state, &user, false, |c| devices(c)).await?;
    let online_since = now() - WORKER_ONLINE_SECONDS;
    Ok(Json(json!({
        "address": address,
        "created_at": created_at,
        "devices": owned
            .iter()
            .map(|device| json!({
                "worker_id": device.id,
                "label": device.label,
                "address": device.address,
                "status": if device.last_seen_at.is_some_and(|seen| seen >= online_since) { "online" } else { "offline" },
                "last_seen_at": device.last_seen_at,
                "platform": device.platform,
                "version": device.version,
                "created_at": device.created_at,
            }))
            .collect::<Vec<_>>(),
    })))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct AddDeviceInput {
    address: String,
    #[serde(default)]
    label: Option<String>,
}

/// `POST /api/exe/devices`: record a device address. Trust itself is configured
/// on the device (`exe trust <address>`) and is never something the Controller
/// can grant, so this only decides which addresses this account watches.
pub(super) async fn add_device(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
    Json(input): Json<AddDeviceInput>,
) -> Result<Json<Value>, ApiError> {
    let user = identity.user;
    let address = b58(&parse_address(input.address.trim())?);
    let label = input
        .label
        .as_deref()
        .map(str::trim)
        .filter(|label| !label.is_empty())
        .map(|label| label.chars().take(80).collect::<String>())
        .unwrap_or_else(|| format!("eXe {}", &address[..address.len().min(8)]));
    let (exe, _) = user_db(&state, &user, true, |c| ensure(c)).await?;
    let address_key = address.clone();
    let duplicate: Option<String> = user_db(&state, &user, false, move |c| {
        Ok(c.query_row(
            "SELECT id FROM workers WHERE exe_address=? AND deleted_at IS NULL",
            [address_key],
            |r| r.get(0),
        )
        .optional()?)
    })
    .await?;
    if duplicate.is_some() {
        return Err(ApiError::conflict(
            "this eXe device is already connected to the account",
        ));
    }
    let status = Relay::new(&state, &exe)
        .device(&address)
        .await
        .unwrap_or_default();
    let id = Uuid::new_v4().to_string();
    let insert_id = id.clone();
    let insert_label = label.clone();
    let insert_address = address.clone();
    let insert_status = DeviceStatus {
        registered: status.registered,
        online: status.online,
        platform: status.platform.clone(),
        version: status.version.clone(),
        last_seen_at: status.last_seen_at,
    };
    user_db(&state, &user, false, move |c| {
        insert_device(
            c,
            &insert_id,
            &insert_label,
            &insert_address,
            &insert_status,
        )
    })
    .await?;
    Ok(Json(json!({
        "worker_id": id,
        "label": label,
        "address": address,
        "registered": status.registered,
        "status": if status.online { "online" } else { "offline" },
        "last_seen_at": status.last_seen_at,
        "platform": status.platform,
        "version": status.version,
    })))
}

/// One queued or live call on an eXe device, as the driver reads it.
struct PendingCall {
    id: String,
    worker_id: String,
    address: String,
    name: String,
    arguments_json: String,
    status: String,
    exe_call_id: Option<String>,
    envelope: Option<String>,
    cancel_requested_at: Option<i64>,
    cancel_notified_at: Option<i64>,
}

fn pending_calls(c: &Connection) -> Result<Vec<PendingCall>, ApiError> {
    let mut statement = c.prepare(
        "SELECT c.id,c.worker_id,w.exe_address,c.name,c.arguments_json,c.status,c.exe_call_id,c.exe_envelope,c.cancel_requested_at,c.cancel_notified_at
         FROM worker_calls c JOIN workers w ON w.id=c.worker_id
         WHERE w.kind='exe' AND w.deleted_at IS NULL
           AND (c.status IN ('queued','delivered') OR (c.cancel_requested_at IS NOT NULL AND c.cancel_notified_at IS NULL))
         ORDER BY c.created_at,c.id LIMIT ?",
    )?;
    let rows = statement.query_map([DRIVE_BATCH as i64], |r| {
        Ok(PendingCall {
            id: r.get(0)?,
            worker_id: r.get(1)?,
            address: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
            name: r.get(3)?,
            arguments_json: r.get(4)?,
            status: r.get(5)?,
            exe_call_id: r.get(6)?,
            envelope: r.get(7)?,
            cancel_requested_at: r.get(8)?,
            cancel_notified_at: r.get(9)?,
        })
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}

/// The driver: the eXe half of what the Worker event stream does for a paired
/// Worker. It claims queued calls, seals and submits them, reads the relay
/// until a device answers, and settles the ledger through the same function the
/// Worker result endpoint uses — so a Thread cannot tell which kind of device
/// executed its tool call, except by the address it addressed.
#[derive(Default)]
pub(super) struct Driver {
    /// When each live call may be read from the relay again, and how long the
    /// wait that led there was, so the first answer is noticed quickly and a
    /// long command is not polled every second.
    polls: HashMap<String, (tokio::time::Instant, Duration)>,
    /// When submitting a call first failed, so an unreachable relay cannot hold
    /// a Thread open forever.
    failures: HashMap<String, tokio::time::Instant>,
}

pub(super) async fn supervise(state: AppState) {
    let mut driver = Driver::default();
    loop {
        if let Err(error) = driver.pass(&state).await {
            tracing::warn!(error = %error.message, "eXe driver pass deferred");
        }
        tokio::time::sleep(DRIVE_TICK).await;
    }
}

impl Driver {
    async fn pass(&mut self, state: &AppState) -> Result<(), ApiError> {
        for entry in fs::read_dir(state.data_dir.join("users")).map_err(ApiError::internal)? {
            let path = entry.map_err(ApiError::internal)?.path();
            if path.extension().and_then(|extension| extension.to_str()) != Some("sqlite3") {
                continue;
            }
            let Some(id) = path.file_stem().and_then(|stem| stem.to_str()) else {
                continue;
            };
            let user = user_from_id(state, id.to_owned())?;
            if let Err(error) = self.user(state, &user).await {
                tracing::warn!(user=%user.id,error=%error.message,"eXe driver deferred this account");
            }
        }
        Ok(())
    }

    async fn user(&mut self, state: &AppState, user: &User) -> Result<(), ApiError> {
        let pending = user_db(state, user, false, |c| pending_calls(c)).await?;
        if pending.is_empty() {
            return Ok(());
        }
        let Some((identity, _)) = user_db(state, user, false, |c| stored(c)).await? else {
            for call in pending {
                self.settle(
                    state,
                    user,
                    &call,
                    json!({"error":"this account has no eXe identity, so the call could not be sealed","code":"exe_no_identity"}),
                    "failed",
                    Some("this account has no eXe identity".to_owned()),
                )
                .await?;
            }
            return Ok(());
        };
        for call in pending {
            if let Err(error) = self.call(state, user, &identity, call).await {
                tracing::warn!(error=%error.message,"eXe call deferred to a later pass");
            }
        }
        Ok(())
    }

    async fn call(
        &mut self,
        state: &AppState,
        user: &User,
        identity: &Identity,
        call: PendingCall,
    ) -> Result<(), ApiError> {
        let relay = Relay::new(state, identity);
        if call.cancel_requested_at.is_some() && call.cancel_notified_at.is_none() {
            if let Some(exe_call) = call.exe_call_id.as_deref() {
                // A 409 here means the call already settled; either way the
                // device has nothing left to cancel.
                let _ = relay.cancel(exe_call).await;
            }
            let id = call.id.clone();
            user_db(state, user, false, move |c| {
                c.execute(
                    "UPDATE worker_calls SET cancel_notified_at=? WHERE id=? AND cancel_notified_at IS NULL",
                    params![now(), id],
                )?;
                Ok(())
            })
            .await?;
        }
        match call.status.as_str() {
            "queued" => {
                let id = call.id.clone();
                let claimed = user_db(state, user, false, move |c| {
                    Ok(c.execute(
                        "UPDATE worker_calls SET status='delivered',started_at=? WHERE id=? AND status='queued'",
                        params![now(), id],
                    )? > 0)
                })
                .await?;
                if !claimed {
                    return Ok(());
                }
                self.submit(state, user, &relay, &call, identity).await
            }
            "delivered" if call.exe_call_id.is_none() => {
                self.submit(state, user, &relay, &call, identity).await
            }
            "delivered" => self.poll(state, user, &relay, &call, identity).await,
            _ => Ok(()),
        }
    }

    async fn submit(
        &mut self,
        state: &AppState,
        user: &User,
        relay: &Relay<'_>,
        call: &PendingCall,
        identity: &Identity,
    ) -> Result<(), ApiError> {
        let Some(plaintext) = encode_call(call) else {
            self.failures.remove(&call.id);
            let message = format!(
                "{} is not available on an eXe device: it executes shell commands only, so use bash",
                call.name
            );
            return self
                .settle(
                    state,
                    user,
                    call,
                    json!({"error": message, "code": "exe_unsupported_tool"}),
                    "failed",
                    Some(message),
                )
                .await;
        };
        let exe_call = Uuid::new_v4().simple().to_string();
        let issued_at = unix();
        let timeout = call.timeout_seconds();
        let lifetime = (timeout + WORKER_CALL_TIMEOUT_GRACE_SECONDS)
            .clamp(1, MAX_CALL_LIFETIME_SECONDS) as u64;
        let expires_at = issued_at + lifetime;
        let envelope = CallEnvelope::build(
            identity,
            &call.address,
            &exe_call,
            plaintext.as_bytes(),
            issued_at,
            expires_at,
        )?;
        let plaintext_envelope = serde_json::to_string(&envelope).map_err(ApiError::internal)?;
        match relay.submit(&envelope).await {
            Ok(()) => {
                self.failures.remove(&call.id);
                let id = call.id.clone();
                user_db(state, user, false, move |c| {
                    c.execute(
                        "UPDATE worker_calls SET exe_call_id=?,exe_envelope=? WHERE id=? AND exe_call_id IS NULL",
                        params![exe_call, plaintext_envelope, id],
                    )?;
                    Ok(())
                })
                .await
            }
            Err(error) => {
                // An unreachable relay is not the device's answer: retry for a
                // bounded window, then tell the model the call never left.
                let first = *self
                    .failures
                    .entry(call.id.clone())
                    .or_insert_with(tokio::time::Instant::now);
                if error.status == StatusCode::SERVICE_UNAVAILABLE && first.elapsed() < SUBMIT_GRACE
                {
                    return Ok(());
                }
                self.failures.remove(&call.id);
                let message = error.message.clone();
                self.settle(
                    state,
                    user,
                    call,
                    json!({"error": message, "code": "exe_undelivered"}),
                    "failed",
                    Some(message),
                )
                .await
            }
        }
    }

    async fn poll(
        &mut self,
        state: &AppState,
        user: &User,
        relay: &Relay<'_>,
        call: &PendingCall,
        identity: &Identity,
    ) -> Result<(), ApiError> {
        let now_at = tokio::time::Instant::now();
        let previous = self.polls.get(&call.id).copied();
        if previous.is_some_and(|(at, _)| at > now_at) {
            return Ok(());
        }
        let wait = previous
            .map(|(_, wait)| (wait * 2).min(POLL_CEILING))
            .unwrap_or(POLL_FLOOR);
        self.polls.insert(call.id.clone(), (now_at + wait, wait));
        let Some(exe_call) = call.exe_call_id.as_deref() else {
            return Ok(());
        };
        let detail = match relay.call(exe_call).await {
            Ok(detail) => detail,
            Err(error) if error.status == StatusCode::CONFLICT => {
                self.polls.remove(&call.id);
                let message = format!("the eXe relay no longer knows this call: {}", error.message);
                return self
                    .settle(
                        state,
                        user,
                        call,
                        json!({"error": message, "code":"exe_lost", "execution_outcome":"unknown"}),
                        "failed",
                        Some(message),
                    )
                    .await;
            }
            // Transient: the call is still on the relay, and the Thread's own
            // timeout answers it if this never recovers.
            Err(_) => return Ok(()),
        };
        let status = detail["call"]["status"].as_str().unwrap_or("queued");
        match status {
            "queued" | "received" => Ok(()),
            "succeeded" | "failed" => {
                self.polls.remove(&call.id);
                let envelope: CallEnvelope = match call
                    .envelope
                    .as_deref()
                    .and_then(|raw| serde_json::from_str(raw).ok())
                {
                    Some(envelope) => envelope,
                    None => {
                        let message =
                            "the stored eXe envelope for this call is unreadable".to_owned();
                        return self
                            .settle(
                                state,
                                user,
                                call,
                                json!({"error": message, "code":"exe_envelope_lost"}),
                                "failed",
                                Some(message),
                            )
                            .await;
                    }
                };
                let opened = open_result(relay, identity, &envelope, &detail).await;
                let body = match opened {
                    Ok(body) => body,
                    Err(error) => {
                        let message = error.message.clone();
                        return self
                            .settle(
                                state,
                                user,
                                call,
                                json!({"error": message, "code":"exe_result_unreadable"}),
                                "failed",
                                Some(message),
                            )
                            .await;
                    }
                };
                let (result, status, error) = tool_result(status == "succeeded", body);
                self.settle(state, user, call, result, status, error).await
            }
            "cancelled" => {
                self.polls.remove(&call.id);
                let message = "the eXe device reported the call cancelled".to_owned();
                self.settle(
                    state,
                    user,
                    call,
                    json!({"error": message, "code":"exe_cancelled"}),
                    "failed",
                    Some(message),
                )
                .await
            }
            "expired" => {
                self.polls.remove(&call.id);
                let message =
                    "the eXe call expired before the device answered; the command may not have run"
                        .to_owned();
                self.settle(
                    state,
                    user,
                    call,
                    json!({"error": message, "code":"exe_expired", "execution_outcome":"unknown"}),
                    "failed",
                    Some(message),
                )
                .await
            }
            "lost" => {
                self.polls.remove(&call.id);
                let message = "the device process that took this call is gone and never answered; the command may have run. Do not retry blindly.".to_owned();
                self.settle(
                    state,
                    user,
                    call,
                    json!({"error": message, "code":"exe_lost", "execution_outcome":"unknown"}),
                    "failed",
                    Some(message),
                )
                .await
            }
            _ => Ok(()),
        }
    }

    /// Settles one eXe call in the same ledger a Worker result writes. A machine
    /// run settles through the machine scheduler first, exactly like the Worker
    /// result endpoint, and never enters a Thread's history.
    async fn settle(
        &mut self,
        state: &AppState,
        user: &User,
        call: &PendingCall,
        result: Value,
        status: &'static str,
        error: Option<String>,
    ) -> Result<(), ApiError> {
        self.polls.remove(&call.id);
        self.failures.remove(&call.id);
        let result_json = serde_json::to_string(&result).map_err(ApiError::internal)?;
        let worker_id = call.worker_id.clone();
        let call_id = call.id.clone();
        let effect = user_db(state, user, false, {
            let worker_id = worker_id.clone();
            let call_id = call_id.clone();
            let result_json = result_json.clone();
            let error = error.clone();
            move |c| {
                machines::settle_call_result(
                    c,
                    &worker_id,
                    &call_id,
                    &result_json,
                    status,
                    error.as_deref(),
                )
            }
        })
        .await?;
        if let Some(effect) = effect {
            machines::apply_effect(state, user, effect).await;
        } else {
            let data_dir = state.data_dir.clone();
            user_db(state, user, false, move |c| {
                settle_worker_call_result(&data_dir, c, &worker_id, &call_id, result, status, error)
            })
            .await?;
        }
        if let Some(exe_call) = call.exe_call_id.as_deref() {
            let identity = user_db(state, user, false, |c| stored(c)).await?;
            if let Some((identity, _)) = identity {
                let _ = Relay::new(state, &identity).ack(exe_call).await;
            }
        }
        Ok(())
    }
}

impl PendingCall {
    fn timeout_seconds(&self) -> i64 {
        serde_json::from_str::<Value>(&self.arguments_json)
            .ok()
            .and_then(|arguments| {
                arguments
                    .get("timeout_seconds")
                    .and_then(Value::as_i64)
                    .filter(|seconds| *seconds >= 1)
            })
            .unwrap_or(DEFAULT_WORKER_CALL_TIMEOUT_SECONDS)
    }
}

/// The one verb an eXe device implements: `shell`. Cybion's `bash` arguments are
/// mapped onto it explicitly — a device never sees the worker id, the summary,
/// or any field the device did not ask for.
fn encode_call(call: &PendingCall) -> Option<String> {
    if call.name != "bash" {
        return None;
    }
    let arguments: Value = serde_json::from_str(&call.arguments_json).ok()?;
    let command = arguments.get("command")?.as_str()?;
    let mut ask = json!({ "command": command });
    if let Some(cwd) = arguments.get("cwd").and_then(Value::as_str) {
        ask["cwd"] = json!(cwd);
    }
    let timeout = arguments
        .get("timeout_seconds")
        .and_then(Value::as_i64)
        .filter(|seconds| *seconds >= 1)
        .unwrap_or(DEFAULT_WORKER_CALL_TIMEOUT_SECONDS)
        .min(MAX_CALL_LIFETIME_SECONDS);
    ask["timeout_seconds"] = json!(timeout);
    Some(json!({ "name": "shell", "args": ask.to_string() }).to_string())
}

/// Verifies and opens one device answer. Nothing here trusts the relay: the
/// signature is checked against the address the call was sent to, and the seal
/// only opens with this account's own key.
async fn open_result(
    relay: &Relay<'_>,
    identity: &Identity,
    envelope: &CallEnvelope,
    detail: &Value,
) -> Result<Value, ApiError> {
    let result: ResultEnvelope = serde_json::from_value(detail["result"].clone())
        .map_err(|_| ApiError::bad_request("the eXe relay returned no readable result"))?;
    if result.call_id != envelope.call_id || result.device != envelope.device {
        return Err(ApiError::bad_request(
            "the eXe result names another call or device",
        ));
    }
    let device = parse_address(&envelope.device)?;
    if !verify(&device, &result.transcript()?, &result.sig) {
        return Err(ApiError::bad_request(
            "the eXe result does not verify against the device address",
        ));
    }
    let context = SealContext {
        direction: "result",
        caller: &envelope.caller,
        device: &envelope.device,
        call_id: &envelope.call_id,
        issued_at: result.issued_at,
        expires_at: envelope.expires_at,
    };
    let mut plaintext = open_sealed(&context, identity, &result.sealed)?;
    if detail["call"]["blob_bytes"].as_u64().unwrap_or(0) > 0 {
        // A result too big for one row arrives as an attachment; anything short
        // of opening it leaves the inline preview, which is still true.
        let raw = relay.blob(&envelope.call_id).await?;
        let blob = SealContext {
            direction: "blob",
            caller: &envelope.caller,
            device: &envelope.device,
            call_id: &envelope.call_id,
            issued_at: result.issued_at,
            expires_at: envelope.expires_at,
        };
        if let Ok(full) = open_sealed_bytes(&blob, identity, &raw) {
            plaintext = full;
        }
    }
    serde_json::from_slice(&plaintext)
        .map_err(|_| ApiError::bad_request("the eXe result body is not JSON"))
}

/// The device's answer, mapped onto the shape a Cybion Worker returns for
/// `bash`, so a Thread reads `exit_code`/`stdout`/`stderr` either way. eXe's
/// `ok` is about the tool, not the exit code: a command that ran and exited
/// non-zero still completed, which is why the machine scheduler can read this.
fn tool_result(ok: bool, body: Value) -> (Value, &'static str, Option<String>) {
    if ok {
        let output = body.get("output").cloned().unwrap_or(Value::Null);
        let result = json!({
            "exit_code": output.get("exit_code").cloned().unwrap_or(Value::Null),
            "stdout": output.get("stdout").cloned().unwrap_or_else(|| json!("")),
            "stderr": output.get("stderr").cloned().unwrap_or_else(|| json!("")),
        });
        (result, "completed", None)
    } else {
        let message = body
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("the eXe device could not run the command")
            .to_owned();
        (body, "failed", Some(message))
    }
}

/// One driver pass. The hosted Controller runs it on a timer; a test runs it
/// once and reads what changed.
#[cfg(test)]
pub(super) async fn drive_once(state: &AppState) -> Result<(), ApiError> {
    Driver::default().pass(state).await
}

#[cfg(test)]
mod tests;
