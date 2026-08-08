use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    process::Stdio,
    sync::Arc,
    time::Duration,
};

use anyhow::{Context, Result, anyhow};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::{Value, json};
use tokio::{
    process::{Child, Command},
    sync::{Mutex, oneshot, watch},
};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async, tungstenite::Message as WebSocketMessage,
};
use url::Url;
use uuid::Uuid;

pub type BrowserSessions = Arc<Mutex<BrowserManager>>;
type CdpSocket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

const VIEWPORT_WIDTH: u32 = 1280;
const VIEWPORT_HEIGHT: u32 = 800;
const BROWSER_START_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Serialize)]
pub struct BrowserSessionSummary {
    pub id: String,
    pub allowed_domains: Vec<String>,
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
    allowed_domains: HashSet<String>,
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
    allowed_domains: HashSet<String>,
    browser: CdpClient,
    page: CdpClient,
    browser_context_id: String,
}

struct CdpClient {
    socket: CdpSocket,
    next_id: u64,
}

pub fn sessions() -> BrowserSessions {
    Arc::new(Mutex::new(BrowserManager::default()))
}

pub fn parse_allowed_domains(domains: &[String]) -> Result<HashSet<String>> {
    let domains = domains
        .iter()
        .map(|domain| domain.trim().to_ascii_lowercase())
        .filter(|domain| !domain.is_empty())
        .map(|domain| {
            if domain
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
                && !domain.starts_with('.')
                && !domain.ends_with('.')
            {
                Ok(domain)
            } else {
                Err(anyhow!("invalid allowed domain"))
            }
        })
        .collect::<Result<HashSet<_>>>()?;
    if domains.is_empty() {
        return Err(anyhow!("at least one allowed domain is required"));
    }
    Ok(domains)
}

pub async fn create(
    sessions: &BrowserSessions,
    client: &reqwest::Client,
    allowed_domains: HashSet<String>,
    computer_use_enabled: bool,
) -> Result<BrowserSessionSummary> {
    let id = Uuid::new_v4().to_string();
    let runner = BrowserRunner::launch(client, &id, &allowed_domains).await?;
    let session = BrowserSession {
        id: id.clone(),
        allowed_domains,
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
    scope: &BrowserRunScope,
    name: &str,
    arguments: Value,
    cancellation: watch::Receiver<bool>,
) -> Result<String> {
    match name {
        "browser_snapshot" => snapshot(sessions, &scope.id).await,
        "browser_screenshot" => screenshot(sessions, &scope.id)
            .await
            .map(|image| json!({"image":format!("data:image/png;base64,{image}")}).to_string()),
        "browser_navigate" => {
            let url = required_string(&arguments, "url")?;
            navigate(sessions, &scope.id, url).await
        }
        "browser_click" => {
            let reference = required_string(&arguments, "ref")?;
            click(sessions, &scope.id, reference, cancellation).await
        }
        "browser_type" => {
            let reference = required_string(&arguments, "ref")?;
            let text = required_string(&arguments, "text")?;
            type_into(sessions, &scope.id, reference, text, cancellation).await
        }
        "browser_keypress" => {
            let key = required_string(&arguments, "key")?;
            keypress(sessions, &scope.id, key, cancellation).await
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
                .get_mut(&scope.id)
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
    let mut sessions = sessions.lock().await;
    let session = sessions
        .sessions
        .get_mut(id)
        .ok_or_else(|| anyhow!("browser session does not exist"))?;
    if !allowed_url(url, &session.allowed_domains) {
        return Err(anyhow!("URL is outside this session's allowed domains"));
    }
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
            allowed_domains: self.allowed_domains.iter().cloned().collect(),
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
    async fn launch(client: &reqwest::Client, id: &str, domains: &HashSet<String>) -> Result<Self> {
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
            .command("Target.createBrowserContext", json!({}), domains)
            .await?
            .get("browserContextId")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("browser did not create an isolated context"))?
            .to_owned();
        browser
            .command(
                "Browser.setDownloadBehavior",
                json!({"behavior":"deny","browserContextId":browser_context_id}),
                domains,
            )
            .await?;
        let target_id = browser
            .command(
                "Target.createTarget",
                json!({"url":"about:blank","browserContextId":browser_context_id}),
                domains,
            )
            .await?
            .get("targetId")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("browser did not create a page target"))?
            .to_owned();
        browser
            .command(
                "Target.activateTarget",
                json!({"targetId":target_id}),
                domains,
            )
            .await?;
        let page_url = target_websocket_url(client, port, &target_id).await?;
        let mut page = CdpClient::connect(&page_url).await?;
        page.command("Page.enable", json!({}), domains).await?;
        page.command(
            "Emulation.setDeviceMetricsOverride",
            json!({"width":VIEWPORT_WIDTH,"height":VIEWPORT_HEIGHT,"deviceScaleFactor":1,"mobile":false}),
            domains,
        )
        .await?;
        page.command(
            "Fetch.enable",
            json!({"patterns":[{"urlPattern":"*","requestStage":"Request"}]}),
            domains,
        )
        .await?;
        Ok(Self {
            child,
            profile_dir,
            allowed_domains: domains.clone(),
            browser,
            page,
            browser_context_id,
        })
    }

    async fn close(&mut self) {
        let _ = self
            .browser
            .command(
                "Target.disposeBrowserContext",
                json!({"browserContextId":self.browser_context_id}),
                &self.allowed_domains,
            )
            .await;
        let _ = self.child.start_kill();
        let _ = self.child.wait().await;
        let _ = std::fs::remove_dir_all(&self.profile_dir);
    }

    async fn url(&mut self) -> Result<String> {
        let value = self
            .page
            .command(
                "Runtime.evaluate",
                json!({"expression":"location.href","returnByValue":true}),
                &self.allowed_domains,
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
            .command("Page.navigate", json!({"url":url}), &self.allowed_domains)
            .await?;
        tokio::time::sleep(Duration::from_millis(150)).await;
        Ok(())
    }

    async fn screenshot(&mut self) -> Result<String> {
        self.page
            .command(
                "Page.captureScreenshot",
                json!({"format":"png","captureBeyondViewport":false}),
                &self.allowed_domains,
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
            .command(
                "Input.insertText",
                json!({"text":text}),
                &self.allowed_domains,
            )
            .await?;
        Ok(())
    }

    async fn keypress(&mut self, key: &str) -> Result<()> {
        let key = normalize_key(key)?;
        self.page
            .command(
                "Input.dispatchKeyEvent",
                json!({"type":"keyDown","key":key,"code":key,"windowsVirtualKeyCode":key_code(&key)}),
                &self.allowed_domains,
            )
            .await?;
        self.page
            .command(
                "Input.dispatchKeyEvent",
                json!({"type":"keyUp","key":key,"code":key,"windowsVirtualKeyCode":key_code(&key)}),
                &self.allowed_domains,
            )
            .await?;
        Ok(())
    }

    async fn scroll(&mut self, delta_y: f64) -> Result<()> {
        self.page
            .command(
                "Input.dispatchMouseEvent",
                json!({"type":"mouseWheel","x":VIEWPORT_WIDTH / 2,"y":VIEWPORT_HEIGHT / 2,"deltaX":0,"deltaY":delta_y}),
                &self.allowed_domains,
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
                &self.allowed_domains,
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
                    &self.allowed_domains,
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
                    &self.allowed_domains,
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
                &self.allowed_domains,
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

    async fn command(
        &mut self,
        method: &str,
        params: Value,
        domains: &HashSet<String>,
    ) -> Result<Value> {
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
                    if value.get("method").and_then(Value::as_str) == Some("Fetch.requestPaused") {
                        self.handle_paused_request(&value, domains).await?;
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

    async fn handle_paused_request(
        &mut self,
        event: &Value,
        domains: &HashSet<String>,
    ) -> Result<()> {
        let request_id = event
            .pointer("/params/requestId")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("browser paused request has no ID"))?;
        let url = event
            .pointer("/params/request/url")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("browser paused request has no URL"))?;
        let method = if allowed_url(url, domains) {
            "Fetch.continueRequest"
        } else {
            "Fetch.failRequest"
        };
        let params = if method == "Fetch.continueRequest" {
            json!({"requestId":request_id})
        } else {
            json!({"requestId":request_id,"errorReason":"BlockedByClient"})
        };
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

fn allowed_url(value: &str, domains: &HashSet<String>) -> bool {
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    matches!(url.scheme(), "http" | "https")
        && url
            .host_str()
            .is_some_and(|host| domains.contains(&host.to_ascii_lowercase()))
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
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn allowed_domains_are_exact_hosts() {
        let domains = parse_allowed_domains(&["example.com".to_owned()]).unwrap();
        assert!(allowed_url("https://example.com/path", &domains));
        assert!(!allowed_url("https://evil-example.com", &domains));
        assert!(!allowed_url("https://sub.example.com", &domains));
        assert!(!allowed_url("file:///tmp/private", &domains));
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

    #[tokio::test]
    #[ignore = "requires a working local Chrome or Chromium runtime"]
    async fn isolated_runner_captures_an_allowed_local_page_when_chromium_is_available() {
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
        let domains = parse_allowed_domains(&["127.0.0.1".to_owned()]).unwrap();
        let mut runner = tokio::time::timeout(
            Duration::from_secs(15),
            BrowserRunner::launch(&reqwest::Client::new(), "test", &domains),
        )
        .await
        .unwrap()
        .unwrap();
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
        assert!(loaded, "the allowed local page did not load");
        runner.close().await;
        server.await.unwrap();
    }
}
