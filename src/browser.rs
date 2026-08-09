use std::{collections::HashMap, path::PathBuf, process::Stdio, sync::Arc, time::Duration};

use anyhow::{Context, Result, anyhow};
use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::{Value, json};
use tokio::{
    process::{Child, Command},
    sync::{Mutex, oneshot, watch},
    task::JoinHandle,
};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async, tungstenite::Message as WebSocketMessage,
};
use url::Url;
use uuid::Uuid;

pub type BrowserSessions = Arc<Mutex<BrowserManager>>;
pub type BrowserFrameStream = watch::Receiver<Option<Vec<u8>>>;
type CdpSocket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

const VIEWPORT_WIDTH: u32 = 1280;
const VIEWPORT_HEIGHT: u32 = 800;
const BROWSER_START_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Serialize)]
pub struct BrowserSessionSummary {
    pub id: String,
    pub computer_use_enabled: bool,
    pub created_at: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_approval: Option<BrowserApproval>,
}

#[derive(Clone, Serialize)]
pub struct BrowserApproval {
    pub id: String,
    pub description: String,
}

#[derive(Clone)]
pub struct BrowserRunScope {
    pub id: String,
    pub computer_use_enabled: bool,
}

#[derive(Default)]
pub struct BrowserManager {
    sessions: HashMap<String, BrowserSession>,
}

struct BrowserSession {
    id: String,
    computer_use_enabled: bool,
    created_at: String,
    url: String,
    refs: HashMap<String, String>,
    next_ref: u64,
    pending_approval: Option<PendingApproval>,
    runner: BrowserRunner,
}

struct PendingApproval {
    id: String,
    description: String,
    sender: oneshot::Sender<bool>,
}

struct BrowserRunner {
    child: Child,
    profile_dir: PathBuf,
    browser: CdpClient,
    page: CdpClient,
    page_url: String,
    browser_context_id: String,
    frames: watch::Sender<Option<Vec<u8>>>,
    screencast: Option<JoinHandle<()>>,
}

struct CdpClient {
    socket: CdpSocket,
    next_id: u64,
}

pub fn sessions() -> BrowserSessions {
    Arc::new(Mutex::new(BrowserManager::default()))
}

pub async fn create(
    sessions: &BrowserSessions,
    client: &reqwest::Client,
    computer_use_enabled: bool,
) -> Result<BrowserSessionSummary> {
    let id = Uuid::new_v4().to_string();
    let runner = BrowserRunner::launch(client, &id).await?;
    let session = BrowserSession {
        id: id.clone(),
        computer_use_enabled,
        created_at: chrono::Utc::now().to_rfc3339(),
        url: "about:blank".to_owned(),
        refs: HashMap::new(),
        next_ref: 0,
        pending_approval: None,
        runner,
    };
    let summary = session.summary();
    sessions.lock().await.sessions.insert(id, session);
    Ok(summary)
}

pub async fn list(sessions: &BrowserSessions) -> Vec<BrowserSessionSummary> {
    sessions
        .lock()
        .await
        .sessions
        .values()
        .map(BrowserSession::summary)
        .collect()
}

pub async fn scope(sessions: &BrowserSessions, id: &str) -> Result<BrowserRunScope> {
    let sessions = sessions.lock().await;
    let session = sessions
        .sessions
        .get(id)
        .ok_or_else(|| anyhow!("browser session does not exist or has expired"))?;
    Ok(BrowserRunScope {
        id: session.id.clone(),
        computer_use_enabled: session.computer_use_enabled,
    })
}

pub async fn close(sessions: &BrowserSessions, id: &str) -> Result<()> {
    let mut session = sessions
        .lock()
        .await
        .sessions
        .remove(id)
        .ok_or_else(|| anyhow!("browser session does not exist"))?;
    if let Some(pending) = session.pending_approval.take() {
        let _ = pending.sender.send(false);
    }
    session.runner.close().await;
    Ok(())
}

pub async fn approve(sessions: &BrowserSessions, id: &str) -> Result<()> {
    let pending = sessions
        .lock()
        .await
        .sessions
        .get_mut(id)
        .ok_or_else(|| anyhow!("browser session does not exist"))?
        .pending_approval
        .take()
        .ok_or_else(|| anyhow!("browser session has no action awaiting approval"))?;
    pending
        .sender
        .send(true)
        .map_err(|_| anyhow!("the pending browser action is no longer waiting"))
}

pub async fn screenshot(sessions: &BrowserSessions, id: &str) -> Result<String> {
    let mut sessions = sessions.lock().await;
    let session = sessions
        .sessions
        .get_mut(id)
        .ok_or_else(|| anyhow!("browser session does not exist"))?;
    let image = session.runner.screenshot().await?;
    session.url = session.runner.url().await?;
    Ok(image)
}

pub async fn preview_stream(sessions: &BrowserSessions, id: &str) -> Result<BrowserFrameStream> {
    sessions
        .lock()
        .await
        .sessions
        .get_mut(id)
        .ok_or_else(|| anyhow!("browser session does not exist"))?
        .runner
        .preview_stream()
        .await
}

pub async fn user_input(sessions: &BrowserSessions, id: &str, input: BrowserInput) -> Result<()> {
    let mut sessions = sessions.lock().await;
    let session = sessions
        .sessions
        .get_mut(id)
        .ok_or_else(|| anyhow!("browser session does not exist"))?;
    match input {
        BrowserInput::Click { x, y } => session.runner.click_at(x, y).await,
        BrowserInput::Type { text } => session.runner.type_text(&text).await,
        BrowserInput::Keypress { key } => session.runner.keypress(&key).await,
        BrowserInput::Scroll { delta_y } => session.runner.scroll(delta_y).await,
    }?;
    session.url = session.runner.url().await?;
    Ok(())
}

#[derive(serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum BrowserInput {
    Click { x: f64, y: f64 },
    Type { text: String },
    Keypress { key: String },
    Scroll { delta_y: f64 },
}

pub async fn execute_tool(
    sessions: &BrowserSessions,
    name: &str,
    arguments: Value,
    cancellation: watch::Receiver<bool>,
) -> Result<String> {
    let id = required_string(&arguments, "session_id")?.to_owned();
    match name {
        "browser_snapshot" => snapshot(sessions, &id).await,
        "browser_screenshot" => screenshot(sessions, &id)
            .await
            .map(|image| json!({"image":format!("data:image/png;base64,{image}")}).to_string()),
        "browser_navigate" => {
            let url = required_string(&arguments, "url")?;
            navigate(sessions, &id, url).await
        }
        "browser_click" => {
            let reference = required_string(&arguments, "ref")?;
            click(sessions, &id, reference, cancellation).await
        }
        "browser_type" => {
            let reference = required_string(&arguments, "ref")?;
            let text = required_string(&arguments, "text")?;
            type_into(sessions, &id, reference, text, cancellation).await
        }
        "browser_keypress" => {
            let key = required_string(&arguments, "key")?;
            keypress(sessions, &id, key, cancellation).await
        }
        "browser_scroll" => {
            let delta_y = arguments
                .get("delta_y")
                .and_then(Value::as_f64)
                .ok_or_else(|| anyhow!("browser_scroll requires a numeric delta_y"))?;
            sessions
                .lock()
                .await
                .sessions
                .get_mut(&id)
                .ok_or_else(|| anyhow!("browser session does not exist"))?
                .runner
                .scroll(delta_y)
                .await?;
            Ok("scrolled browser".to_owned())
        }
        _ => Err(anyhow!("unknown browser tool")),
    }
}

pub async fn execute_computer_call(
    sessions: &BrowserSessions,
    scope: &BrowserRunScope,
    actions: &[Value],
    cancellation: watch::Receiver<bool>,
) -> Result<String> {
    if !scope.computer_use_enabled {
        return Err(anyhow!("Computer Use is disabled for this browser session"));
    }
    if actions_require_approval(actions) {
        wait_for_approval(
            sessions,
            &scope.id,
            format!("Allow the computer to execute: {}", action_summary(actions)),
            cancellation,
        )
        .await?;
    }
    let mut sessions = sessions.lock().await;
    let session = sessions
        .sessions
        .get_mut(&scope.id)
        .ok_or_else(|| anyhow!("browser session does not exist"))?;
    for action in actions {
        session.runner.computer_action(action).await?;
    }
    session.runner.screenshot().await
}

async fn snapshot(sessions: &BrowserSessions, id: &str) -> Result<String> {
    let mut sessions = sessions.lock().await;
    let session = sessions
        .sessions
        .get_mut(id)
        .ok_or_else(|| anyhow!("browser session does not exist"))?;
    let elements = session.runner.snapshot().await?;
    let rows = elements
        .into_iter()
        .map(|mut item| {
            session.next_ref += 1;
            let reference = format!("r{}", session.next_ref);
            let token = item
                .get("token")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow!("browser returned an invalid element snapshot"))?
                .to_owned();
            session.refs.insert(reference.clone(), token);
            item.as_object_mut()
                .expect("snapshot item is an object")
                .remove("token");
            item["ref"] = Value::String(reference);
            Ok(item)
        })
        .collect::<Result<Vec<_>>>()?;
    session.url = session.runner.url().await?;
    Ok(json!({"url":session.url,"elements":rows}).to_string())
}

async fn navigate(sessions: &BrowserSessions, id: &str, url: &str) -> Result<String> {
    if !is_web_url(url) {
        return Err(anyhow!("browser navigation requires an HTTP(S) URL"));
    }
    let mut sessions = sessions.lock().await;
    let session = sessions
        .sessions
        .get_mut(id)
        .ok_or_else(|| anyhow!("browser session does not exist"))?;
    session.runner.navigate(url).await?;
    session.url = session.runner.url().await?;
    Ok(json!({"url":session.url}).to_string())
}

async fn click(
    sessions: &BrowserSessions,
    id: &str,
    reference: &str,
    cancellation: watch::Receiver<bool>,
) -> Result<String> {
    let needs_approval = {
        let mut sessions = sessions.lock().await;
        let session = sessions
            .sessions
            .get_mut(id)
            .ok_or_else(|| anyhow!("browser session does not exist"))?;
        let token = session
            .refs
            .get(reference)
            .ok_or_else(|| anyhow!("unknown browser element reference; take a fresh snapshot"))?;
        session.runner.click_requires_approval(token).await?
    };
    if needs_approval {
        wait_for_approval(
            sessions,
            id,
            format!("Allow the agent to activate browser element {reference}"),
            cancellation,
        )
        .await?;
    }
    let mut sessions = sessions.lock().await;
    let session = sessions
        .sessions
        .get_mut(id)
        .ok_or_else(|| anyhow!("browser session does not exist"))?;
    let token = session
        .refs
        .get(reference)
        .ok_or_else(|| anyhow!("unknown browser element reference; take a fresh snapshot"))?;
    session.runner.click(token).await?;
    Ok(format!("clicked {reference}"))
}

async fn type_into(
    sessions: &BrowserSessions,
    id: &str,
    reference: &str,
    text: &str,
    cancellation: watch::Receiver<bool>,
) -> Result<String> {
    let sensitive = {
        let mut sessions = sessions.lock().await;
        let session = sessions
            .sessions
            .get_mut(id)
            .ok_or_else(|| anyhow!("browser session does not exist"))?;
        let token = session
            .refs
            .get(reference)
            .ok_or_else(|| anyhow!("unknown browser element reference; take a fresh snapshot"))?;
        session.runner.element_is_sensitive(token).await?
    };
    if sensitive {
        wait_for_approval(
            sessions,
            id,
            format!("Allow the agent to enter sensitive data into browser element {reference}"),
            cancellation,
        )
        .await?;
    }
    let mut sessions = sessions.lock().await;
    let session = sessions
        .sessions
        .get_mut(id)
        .ok_or_else(|| anyhow!("browser session does not exist"))?;
    let token = session
        .refs
        .get(reference)
        .ok_or_else(|| anyhow!("unknown browser element reference; take a fresh snapshot"))?;
    session.runner.focus(token).await?;
    session.runner.type_text(text).await?;
    Ok(format!("typed into {reference}"))
}

async fn keypress(
    sessions: &BrowserSessions,
    id: &str,
    key: &str,
    cancellation: watch::Receiver<bool>,
) -> Result<String> {
    if key.eq_ignore_ascii_case("ENTER") || key.eq_ignore_ascii_case("RETURN") {
        wait_for_approval(
            sessions,
            id,
            "Allow the agent to press Enter in the browser".to_owned(),
            cancellation,
        )
        .await?;
    }
    sessions
        .lock()
        .await
        .sessions
        .get_mut(id)
        .ok_or_else(|| anyhow!("browser session does not exist"))?
        .runner
        .keypress(key)
        .await?;
    Ok(format!("pressed {key}"))
}

async fn wait_for_approval(
    sessions: &BrowserSessions,
    id: &str,
    description: String,
    mut cancellation: watch::Receiver<bool>,
) -> Result<()> {
    let receiver = {
        let mut sessions = sessions.lock().await;
        let session = sessions
            .sessions
            .get_mut(id)
            .ok_or_else(|| anyhow!("browser session does not exist"))?;
        if session.pending_approval.is_some() {
            return Err(anyhow!("browser session is already waiting for approval"));
        }
        let (sender, receiver) = oneshot::channel();
        session.pending_approval = Some(PendingApproval {
            id: Uuid::new_v4().to_string(),
            description,
            sender,
        });
        receiver
    };
    tokio::select! {
        approved = receiver => match approved {
            Ok(true) => Ok(()),
            Ok(false) => Err(anyhow!("browser action was declined")),
            Err(_) => Err(anyhow!("browser action approval expired")),
        },
        _ = cancellation.changed() => Err(anyhow!("agent stopped")),
    }
}

impl BrowserSession {
    fn summary(&self) -> BrowserSessionSummary {
        BrowserSessionSummary {
            id: self.id.clone(),
            computer_use_enabled: self.computer_use_enabled,
            created_at: self.created_at.clone(),
            url: self.url.clone(),
            pending_approval: self
                .pending_approval
                .as_ref()
                .map(|pending| BrowserApproval {
                    id: pending.id.clone(),
                    description: pending.description.clone(),
                }),
        }
    }
}

impl BrowserRunner {
    async fn launch(client: &reqwest::Client, id: &str) -> Result<Self> {
        let executable = browser_executable()?;
        let profile_dir = std::env::temp_dir().join(format!("mobius-browser-{id}"));
        std::fs::create_dir_all(&profile_dir)?;
        let port = available_port()?;
        let mut child = Command::new(executable)
            .arg("--headless=new")
            .arg("--no-first-run")
            .arg("--no-default-browser-check")
            .arg("--disable-extensions")
            .arg("--disable-component-extensions-with-background-pages")
            .arg("--disable-sync")
            .arg("--disable-background-networking")
            .arg("--disable-default-apps")
            .arg("--disable-breakpad")
            .arg("--disable-features=Translate,OptimizationHints,MediaRouter")
            .arg("--remote-debugging-address=127.0.0.1")
            .arg(format!("--remote-debugging-port={port}"))
            .arg(format!("--user-data-dir={}", profile_dir.display()))
            .arg("about:blank")
            .env_clear()
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .context("cannot launch isolated Chromium browser")?;
        let version_url = format!("http://127.0.0.1:{port}/json/version");
        let deadline = tokio::time::Instant::now() + BROWSER_START_TIMEOUT;
        let version = loop {
            if let Ok(response) = client.get(&version_url).send().await
                && let Ok(version) = response.error_for_status()?.json::<Value>().await
            {
                break version;
            }
            if tokio::time::Instant::now() >= deadline {
                let _ = child.start_kill();
                let _ = std::fs::remove_dir_all(&profile_dir);
                return Err(anyhow!("isolated browser did not start within 10 seconds"));
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        };
        let browser_url = version
            .get("webSocketDebuggerUrl")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("browser did not expose a debugging socket"))?;
        let mut browser = CdpClient::connect(browser_url).await?;
        let browser_context_id = browser
            .command("Target.createBrowserContext", json!({}))
            .await?
            .get("browserContextId")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("browser did not create an isolated context"))?
            .to_owned();
        browser
            .command(
                "Browser.setDownloadBehavior",
                json!({"behavior":"deny","browserContextId":browser_context_id}),
            )
            .await?;
        let target_id = browser
            .command(
                "Target.createTarget",
                json!({"url":"about:blank","browserContextId":browser_context_id}),
            )
            .await?
            .get("targetId")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("browser did not create a page target"))?
            .to_owned();
        browser
            .command("Target.activateTarget", json!({"targetId":target_id}))
            .await?;
        let page_url = target_websocket_url(client, port, &target_id).await?;
        let mut page = CdpClient::connect(&page_url).await?;
        page.command("Page.enable", json!({})).await?;
        page.command(
            "Emulation.setDeviceMetricsOverride",
            json!({"width":VIEWPORT_WIDTH,"height":VIEWPORT_HEIGHT,"deviceScaleFactor":1,"mobile":false}),
        )
        .await?;
        let (frames, _) = watch::channel(None);
        Ok(Self {
            child,
            profile_dir,
            browser,
            page,
            page_url,
            browser_context_id,
            frames,
            screencast: None,
        })
    }

    async fn close(&mut self) {
        if let Some(screencast) = self.screencast.take() {
            screencast.abort();
        }
        let _ = self
            .browser
            .command(
                "Target.disposeBrowserContext",
                json!({"browserContextId":self.browser_context_id}),
            )
            .await;
        let _ = self.child.start_kill();
        let _ = self.child.wait().await;
        let _ = std::fs::remove_dir_all(&self.profile_dir);
    }

    async fn preview_stream(&mut self) -> Result<BrowserFrameStream> {
        if self.screencast.is_none() {
            let mut preview = CdpClient::connect(&self.page_url).await?;
            preview.command("Page.enable", json!({})).await?;
            preview
                .command(
                    "Page.startScreencast",
                    json!({"format":"jpeg","quality":70,"maxWidth":VIEWPORT_WIDTH,"maxHeight":VIEWPORT_HEIGHT,"everyNthFrame":1}),
                )
                .await?;
            let frames = self.frames.clone();
            self.screencast = Some(tokio::spawn(async move {
                while let Ok(event) = preview.event().await {
                    if event.get("method").and_then(Value::as_str) != Some("Page.screencastFrame") {
                        continue;
                    }
                    let session_id = event.pointer("/params/sessionId").and_then(Value::as_u64);
                    if let Some(session_id) = session_id {
                        let _ = preview
                            .notify("Page.screencastFrameAck", json!({"sessionId":session_id}))
                            .await;
                    }
                    let Some(data) = event.pointer("/params/data").and_then(Value::as_str) else {
                        continue;
                    };
                    let Ok(frame) = BASE64.decode(data) else {
                        continue;
                    };
                    frames.send_replace(Some(frame));
                }
            }));
            let frame = self.preview_frame().await?;
            self.frames.send_replace(Some(frame));
        }
        Ok(self.frames.subscribe())
    }

    async fn preview_frame(&mut self) -> Result<Vec<u8>> {
        let response = self
            .page
            .command(
                "Page.captureScreenshot",
                json!({"format":"jpeg","quality":70,"captureBeyondViewport":false}),
            )
            .await?;
        let data = response
            .get("data")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("browser did not return a preview frame"))?;
        BASE64
            .decode(data)
            .context("browser returned an invalid preview frame")
    }

    async fn url(&mut self) -> Result<String> {
        let value = self
            .page
            .command(
                "Runtime.evaluate",
                json!({"expression":"location.href","returnByValue":true}),
            )
            .await?;
        value
            .pointer("/result/value")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| anyhow!("browser did not return a page URL"))
    }

    async fn navigate(&mut self, url: &str) -> Result<()> {
        self.page
            .command("Page.navigate", json!({"url":url}))
            .await?;
        tokio::time::sleep(Duration::from_millis(150)).await;
        Ok(())
    }

    async fn screenshot(&mut self) -> Result<String> {
        self.page
            .command(
                "Page.captureScreenshot",
                json!({"format":"png","captureBeyondViewport":false}),
            )
            .await?
            .get("data")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| anyhow!("browser did not return a screenshot"))
    }

    async fn snapshot(&mut self) -> Result<Vec<Value>> {
        let expression = r#"(() => Array.from(document.querySelectorAll('a,button,input,textarea,select,[role="button"],[role="link"]')).slice(0, 200).map((element, index) => { const token = `mobius-${Date.now()}-${index}-${Math.random().toString(36).slice(2)}`; element.setAttribute('data-mobius-ref', token); return { token, tag: element.tagName.toLowerCase(), text: (element.innerText || element.value || element.getAttribute('aria-label') || element.getAttribute('placeholder') || '').trim().slice(0, 240), type: element.getAttribute('type') || '', href: element.getAttribute('href') || '' }; }))()"#;
        self.evaluate(expression)
            .await?
            .as_array()
            .cloned()
            .ok_or_else(|| anyhow!("browser did not return an element snapshot"))
    }

    async fn click_requires_approval(&mut self, token: &str) -> Result<bool> {
        self.evaluate(&format!(
            r#"(() => {{ const element = document.querySelector({}); if (!element) throw new Error('element disappeared'); return element.matches('button[type="submit"], input[type="submit"], input[type="image"], a[href^="mailto:"], a[href^="tel:"]'); }})()"#,
            serde_json::to_string(&format!("[data-mobius-ref=\"{token}\"]"))?
        ))
        .await?
        .as_bool()
        .ok_or_else(|| anyhow!("browser returned an invalid approval check"))
    }

    async fn element_is_sensitive(&mut self, token: &str) -> Result<bool> {
        self.evaluate(&format!(
            r#"(() => {{ const element = document.querySelector({}); if (!element) throw new Error('element disappeared'); const type = (element.getAttribute('type') || '').toLowerCase(); return ['password','file','hidden'].includes(type) || element.autocomplete.includes('cc-') || element.autocomplete.includes('one-time-code'); }})()"#,
            serde_json::to_string(&format!("[data-mobius-ref=\"{token}\"]"))?
        ))
        .await?
        .as_bool()
        .ok_or_else(|| anyhow!("browser returned an invalid sensitivity check"))
    }

    async fn focus(&mut self, token: &str) -> Result<()> {
        self.evaluate(&format!(
            r#"(() => {{ const element = document.querySelector({}); if (!element) throw new Error('element disappeared'); element.focus(); return true; }})()"#,
            serde_json::to_string(&format!("[data-mobius-ref=\"{token}\"]"))?
        ))
        .await?;
        Ok(())
    }

    async fn click(&mut self, token: &str) -> Result<()> {
        self.evaluate(&format!(
            r#"(() => {{ const element = document.querySelector({}); if (!element) throw new Error('element disappeared'); element.click(); return true; }})()"#,
            serde_json::to_string(&format!("[data-mobius-ref=\"{token}\"]"))?
        ))
        .await?;
        Ok(())
    }

    async fn type_text(&mut self, text: &str) -> Result<()> {
        self.page
            .command("Input.insertText", json!({"text":text}))
            .await?;
        Ok(())
    }

    async fn keypress(&mut self, key: &str) -> Result<()> {
        let key = normalize_key(key)?;
        self.page
            .command(
                "Input.dispatchKeyEvent",
                json!({"type":"keyDown","key":key,"code":key,"windowsVirtualKeyCode":key_code(&key)}),
            )
            .await?;
        self.page
            .command(
                "Input.dispatchKeyEvent",
                json!({"type":"keyUp","key":key,"code":key,"windowsVirtualKeyCode":key_code(&key)}),
            )
            .await?;
        Ok(())
    }

    async fn scroll(&mut self, delta_y: f64) -> Result<()> {
        self.page
            .command(
                "Input.synthesizeScrollGesture",
                json!({"x":VIEWPORT_WIDTH / 2,"y":VIEWPORT_HEIGHT / 2,"yDistance":-delta_y,"preventFling":true,"gestureSourceType":"mouse"}),
            )
            .await?;
        Ok(())
    }

    async fn click_at(&mut self, x: f64, y: f64) -> Result<()> {
        self.mouse_event("mousePressed", x, y, 1).await?;
        self.mouse_event("mouseReleased", x, y, 1).await
    }

    async fn mouse_event(&mut self, kind: &str, x: f64, y: f64, click_count: u8) -> Result<()> {
        self.page
            .command(
                "Input.dispatchMouseEvent",
                json!({"type":kind,"x":x,"y":y,"button":"left","clickCount":click_count}),
            )
            .await?;
        Ok(())
    }

    async fn computer_action(&mut self, action: &Value) -> Result<()> {
        match action.get("type").and_then(Value::as_str) {
            Some("screenshot") | Some("wait") => Ok(()),
            Some("click") => self.click_at(required_number(action, "x")?, required_number(action, "y")?).await,
            Some("double_click") => {
                let x = required_number(action, "x")?;
                let y = required_number(action, "y")?;
                self.mouse_event("mousePressed", x, y, 2).await?;
                self.mouse_event("mouseReleased", x, y, 2).await
            }
            Some("type") => self.type_text(required_string(action, "text")?).await,
            Some("keypress") => {
                let keys = action
                    .get("keys")
                    .and_then(Value::as_array)
                    .ok_or_else(|| anyhow!("keypress action requires keys"))?;
                for key in keys {
                    self.keypress(
                        key.as_str()
                            .ok_or_else(|| anyhow!("keypress key must be text"))?,
                    )
                    .await?;
                }
                Ok(())
            }
            Some("scroll") => self.scroll(
                action
                    .get("scroll_y")
                    .or_else(|| action.get("delta_y"))
                    .and_then(Value::as_f64)
                    .ok_or_else(|| anyhow!("scroll action requires scroll_y"))?,
            ).await,
            Some("move") => self
                .page
                .command(
                    "Input.dispatchMouseEvent",
                    json!({"type":"mouseMoved","x":required_number(action, "x")?,"y":required_number(action, "y")?}),
                )
                .await
                .map(|_| ()),
            Some("drag") => self.drag(
                action
                    .get("path")
                    .and_then(Value::as_array)
                    .ok_or_else(|| anyhow!("drag action requires path"))?,
            ).await,
            Some(action) => Err(anyhow!("unsupported computer action: {action}")),
            None => Err(anyhow!("computer action has no type")),
        }
    }

    async fn drag(&mut self, path: &[Value]) -> Result<()> {
        let first = path.first().ok_or_else(|| anyhow!("drag path is empty"))?;
        let x = required_number(first, "x")?;
        let y = required_number(first, "y")?;
        self.mouse_event("mousePressed", x, y, 1).await?;
        for point in path.iter().skip(1) {
            self.page
                .command(
                    "Input.dispatchMouseEvent",
                    json!({"type":"mouseMoved","x":required_number(point, "x")?,"y":required_number(point, "y")?,"button":"left"}),
                )
                .await?;
        }
        let last = path.last().expect("drag path is not empty");
        self.mouse_event(
            "mouseReleased",
            required_number(last, "x")?,
            required_number(last, "y")?,
            1,
        )
        .await
    }

    async fn evaluate(&mut self, expression: &str) -> Result<Value> {
        self.page
            .command(
                "Runtime.evaluate",
                json!({"expression":expression,"returnByValue":true,"awaitPromise":true}),
            )
            .await?
            .pointer("/result/value")
            .cloned()
            .ok_or_else(|| anyhow!("browser evaluation returned no value"))
    }
}

impl CdpClient {
    async fn connect(url: &str) -> Result<Self> {
        let (socket, _) = connect_async(url).await?;
        Ok(Self { socket, next_id: 1 })
    }

    async fn command(&mut self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id;
        self.next_id += 1;
        self.socket
            .send(WebSocketMessage::Text(
                json!({"id":id,"method":method,"params":params})
                    .to_string()
                    .into(),
            ))
            .await?;
        loop {
            let message = self
                .socket
                .next()
                .await
                .ok_or_else(|| anyhow!("browser debugging socket closed"))??;
            match message {
                WebSocketMessage::Text(text) => {
                    let value: Value = serde_json::from_str(&text)?;
                    if value.get("id").and_then(Value::as_u64) == Some(id) {
                        if let Some(error) = value.get("error") {
                            return Err(anyhow!("browser command {method} failed: {error}"));
                        }
                        return Ok(value.get("result").cloned().unwrap_or(Value::Null));
                    }
                }
                WebSocketMessage::Ping(payload) => {
                    self.socket.send(WebSocketMessage::Pong(payload)).await?
                }
                WebSocketMessage::Close(_) => {
                    return Err(anyhow!("browser debugging socket closed"));
                }
                _ => {}
            }
        }
    }

    async fn notify(&mut self, method: &str, params: Value) -> Result<()> {
        let id = self.next_id;
        self.next_id += 1;
        self.socket
            .send(WebSocketMessage::Text(
                json!({"id":id,"method":method,"params":params})
                    .to_string()
                    .into(),
            ))
            .await?;
        Ok(())
    }

    async fn event(&mut self) -> Result<Value> {
        loop {
            let message = self
                .socket
                .next()
                .await
                .ok_or_else(|| anyhow!("browser debugging socket closed"))??;
            match message {
                WebSocketMessage::Text(text) => {
                    let value: Value = serde_json::from_str(&text)?;
                    if value.get("method").is_some() {
                        return Ok(value);
                    }
                }
                WebSocketMessage::Ping(payload) => {
                    self.socket.send(WebSocketMessage::Pong(payload)).await?
                }
                WebSocketMessage::Close(_) => {
                    return Err(anyhow!("browser debugging socket closed"));
                }
                _ => {}
            }
        }
    }
}

fn browser_executable() -> Result<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        for path in [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ] {
            let path = PathBuf::from(path);
            if path.is_file() {
                return Ok(path);
            }
        }
    }
    #[cfg(target_os = "windows")]
    {
        for root in [
            std::env::var_os("PROGRAMFILES"),
            std::env::var_os("LOCALAPPDATA"),
        ]
        .into_iter()
        .flatten()
        {
            let path = PathBuf::from(root).join("Google/Chrome/Application/chrome.exe");
            if path.is_file() {
                return Ok(path);
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        for executable in ["google-chrome", "chromium", "chromium-browser"] {
            if let Some(path) = executable_in_path(executable) {
                return Ok(path);
            }
        }
    }
    Err(anyhow!(
        "Chrome or Chromium is required for Browser Control"
    ))
}

#[cfg(not(target_os = "macos"))]
fn executable_in_path(name: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|directory| directory.join(name))
            .find(|path| path.is_file())
    })
}

fn available_port() -> Result<u16> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    Ok(listener.local_addr()?.port())
}

async fn target_websocket_url(
    client: &reqwest::Client,
    port: u16,
    target_id: &str,
) -> Result<String> {
    let response = client
        .get(format!("http://127.0.0.1:{port}/json/list"))
        .send()
        .await?
        .error_for_status()?
        .json::<Vec<Value>>()
        .await?;
    response
        .into_iter()
        .find(|target| target.get("id").and_then(Value::as_str) == Some(target_id))
        .and_then(|target| {
            target
                .get("webSocketDebuggerUrl")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .ok_or_else(|| anyhow!("browser page target did not expose a debugging socket"))
}

fn is_web_url(value: &str) -> bool {
    Url::parse(value)
        .is_ok_and(|url| matches!(url.scheme(), "http" | "https") && url.host_str().is_some())
}

fn required_string<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("browser action requires {key}"))
}

fn required_number(value: &Value, key: &str) -> Result<f64> {
    value
        .get(key)
        .and_then(Value::as_f64)
        .ok_or_else(|| anyhow!("browser action requires numeric {key}"))
}

fn normalize_key(key: &str) -> Result<String> {
    let uppercase = key.to_ascii_uppercase();
    let key = match uppercase.as_str() {
        "ENTER" | "RETURN" => "Enter",
        "ESC" | "ESCAPE" => "Escape",
        "TAB" => "Tab",
        "SPACE" => " ",
        "BACKSPACE" => "Backspace",
        "DELETE" | "DEL" => "Delete",
        "ARROWUP" | "UP" => "ArrowUp",
        "ARROWDOWN" | "DOWN" => "ArrowDown",
        "ARROWLEFT" | "LEFT" => "ArrowLeft",
        "ARROWRIGHT" | "RIGHT" => "ArrowRight",
        key if key.len() == 1 => key,
        _ => return Err(anyhow!("unsupported browser key")),
    };
    Ok(key.to_owned())
}

fn key_code(key: &str) -> u16 {
    match key {
        "Enter" => 13,
        "Escape" => 27,
        "Tab" => 9,
        "Backspace" => 8,
        "Delete" => 46,
        "ArrowUp" => 38,
        "ArrowDown" => 40,
        "ArrowLeft" => 37,
        "ArrowRight" => 39,
        key => key.chars().next().unwrap_or_default() as u16,
    }
}

fn actions_require_approval(actions: &[Value]) -> bool {
    actions.iter().any(|action| {
        !matches!(
            action.get("type").and_then(Value::as_str),
            Some("screenshot" | "scroll" | "move" | "wait")
        )
    })
}

fn action_summary(actions: &[Value]) -> String {
    actions
        .iter()
        .filter_map(|action| action.get("type").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn next_preview_frame(frames: &mut BrowserFrameStream) -> Vec<u8> {
        loop {
            if let Some(frame) = frames.borrow_and_update().clone() {
                return frame;
            }
            frames.changed().await.expect("screencast ended");
        }
    }

    #[test]
    fn computer_clicks_and_typing_need_approval() {
        assert!(!actions_require_approval(&[json!({"type":"screenshot"})]));
        assert!(!actions_require_approval(&[
            json!({"type":"scroll","scroll_y":400})
        ]));
        assert!(actions_require_approval(&[
            json!({"type":"click","x":3,"y":4})
        ]));
        assert!(actions_require_approval(&[
            json!({"type":"type","text":"secret"})
        ]));
    }

    #[test]
    fn key_normalization_is_explicit() {
        assert_eq!(normalize_key("enter").unwrap(), "Enter");
        assert_eq!(normalize_key("x").unwrap(), "X");
        assert!(normalize_key("CTRL").is_err());
    }

    #[test]
    fn browser_navigation_accepts_any_web_host() {
        assert!(is_web_url("https://example.com/path"));
        assert!(is_web_url("https://another.example/path"));
        assert!(is_web_url("http://127.0.0.1:1858/health"));
        assert!(!is_web_url("file:///tmp/private"));
        assert!(!is_web_url("about:blank"));
    }

    #[tokio::test]
    #[ignore = "requires a working local Chrome or Chromium runtime"]
    async fn manager_keeps_independent_browser_sessions_when_chromium_is_available() {
        if browser_executable().is_err() {
            return;
        }
        let sessions = sessions();
        let first = create(&sessions, &reqwest::Client::new(), false)
            .await
            .unwrap();
        let second = create(&sessions, &reqwest::Client::new(), true)
            .await
            .unwrap();
        assert_ne!(first.id, second.id);
        assert_eq!(list(&sessions).await.len(), 2);
        assert!(
            scope(&sessions, &second.id)
                .await
                .unwrap()
                .computer_use_enabled
        );
        close(&sessions, &first.id).await.unwrap();
        close(&sessions, &second.id).await.unwrap();
        assert!(list(&sessions).await.is_empty());
    }

    #[tokio::test]
    #[ignore = "requires a working local Chrome or Chromium runtime"]
    async fn isolated_runner_captures_a_local_page_when_chromium_is_available() {
        if browser_executable().is_err() {
            return;
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 4096];
            let _ = stream.read(&mut request).await.unwrap();
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 71\r\nConnection: close\r\n\r\n<!doctype html><title>Mobius browser test</title><button>Ready</button>")
                .await
                .unwrap();
        });
        let mut runner = tokio::time::timeout(
            Duration::from_secs(15),
            BrowserRunner::launch(&reqwest::Client::new(), "test"),
        )
        .await
        .unwrap()
        .unwrap();
        let mut frames = runner.preview_stream().await.unwrap();
        let initial = tokio::time::timeout(Duration::from_secs(5), next_preview_frame(&mut frames))
            .await
            .unwrap();
        assert!(initial.starts_with(&[0xff, 0xd8, 0xff]));
        runner.navigate(&format!("http://{address}")).await.unwrap();
        let mut loaded = false;
        for _ in 0..50 {
            let screenshot = runner.screenshot().await.unwrap();
            assert!(!screenshot.is_empty());
            if runner
                .snapshot()
                .await
                .unwrap()
                .iter()
                .any(|item| item["tag"] == "button")
            {
                loaded = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(loaded, "the local page did not load");
        runner.close().await;
        server.await.unwrap();
    }

    #[tokio::test]
    #[ignore = "requires a working local Chrome or Chromium runtime"]
    async fn browser_preview_input_scrolls_and_follows_links_when_chromium_is_available() {
        if browser_executable().is_err() {
            return;
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = [0_u8; 4096];
                let size = stream.read(&mut request).await.unwrap();
                let next = std::str::from_utf8(&request[..size])
                    .unwrap()
                    .starts_with("GET /next ");
                let page = if next {
                    "<!doctype html><title>Next</title><p>Arrived</p>"
                } else {
                    "<!doctype html><title>Input</title><style>body{height:2400px}a{position:fixed;left:40px;top:40px}</style><a href=\"/next\">Next</a>"
                };
                stream
                    .write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{page}",
                            page.len()
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
                if next {
                    return;
                }
            }
        });
        let mut runner = BrowserRunner::launch(&reqwest::Client::new(), "input-test")
            .await
            .unwrap();
        let mut frames = runner.preview_stream().await.unwrap();
        runner.navigate(&format!("http://{address}")).await.unwrap();
        for _ in 0..50 {
            if runner
                .snapshot()
                .await
                .unwrap()
                .iter()
                .any(|item| item["tag"] == "a")
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let _ = frames.borrow_and_update();
        let started = Instant::now();
        let next_frame = tokio::time::timeout(Duration::from_secs(5), async {
            frames.changed().await.expect("screencast ended");
            (
                frames
                    .borrow_and_update()
                    .clone()
                    .expect("screencast frame"),
                started.elapsed(),
            )
        });
        let (next_frame, scroll) = tokio::join!(next_frame, runner.scroll(400.0));
        scroll.unwrap();
        let (frame, screencast_latency) = next_frame.unwrap();
        let started = Instant::now();
        let png = runner.screenshot().await.unwrap();
        let screenshot_latency = started.elapsed();
        let png = BASE64.decode(png).unwrap();
        println!(
            "PERF_BROWSER_PREVIEW screencast_latency_ms={} screencast_jpeg_bytes={} screenshot_latency_ms={} screenshot_png_bytes={}",
            screencast_latency.as_millis(),
            frame.len(),
            screenshot_latency.as_millis(),
            png.len()
        );
        assert!(frame.starts_with(&[0xff, 0xd8, 0xff]));
        assert!(
            runner
                .evaluate("window.scrollY")
                .await
                .unwrap()
                .as_f64()
                .is_some_and(|scroll_y| scroll_y > 0.0)
        );
        runner.click_at(50.0, 50.0).await.unwrap();
        for _ in 0..50 {
            if runner.url().await.unwrap().ends_with("/next") {
                runner.close().await;
                server.await.unwrap();
                return;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        runner.close().await;
        panic!("the preview click did not navigate to the linked page");
    }
}
