// Cybion 的第二个 UI：跟 GUI 走同一套 /api，用同一个 Auth Mini JWT。
// 它不是设备，所以没有配对、没有注册、没有长连接。

const CYBION_ORIGIN = "https://cybion.ntnl.io";
const AUTH_ORIGIN = "https://auth.ntnl.io";
const SESSION_KEY = `auth-mini.sdk:${AUTH_ORIGIN}/`;
const LOCAL_KEY = "cybion.session";
const DEFAULT_QUESTION = "这张截图是我正在看的页面。先说清这一块是干什么的，再说我看它时最该注意的三件事。";
const threadLink = (id) => `${CYBION_ORIGIN}/#/threads/${encodeURIComponent(id)}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class NeedsLogin extends Error {
  constructor() {
    super("还没有 Cybion 的登录态：打开 cybion.ntnl.io 登录一次，再按一次快捷键。");
  }
}

async function readSession() {
  const stored = await chrome.storage.local.get(LOCAL_KEY);
  return stored[LOCAL_KEY] ?? null;
}

async function writeSession(session) {
  if (session) await chrome.storage.local.set({ [LOCAL_KEY]: session });
}

/** 登录态由 GUI 持有，插件只是同一个人的第二个入口：从已登录的 Cybion 页面把它取过来。 */
async function syncSessionFromTab() {
  const tabs = await chrome.tabs.query({ url: [`${CYBION_ORIGIN}/*`] });
  for (const tab of tabs) {
    try {
      const reply = await chrome.tabs.sendMessage(tab.id, { type: "cybion:read-session" });
      if (reply?.session?.accessToken) {
        await writeSession(reply.session);
        return reply.session;
      }
    } catch {}
  }
  return null;
}

async function refreshSession(session) {
  if (!session?.refreshToken || !session?.sessionId) return null;
  try {
    const response = await fetch(`${AUTH_ORIGIN}/session/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: session.sessionId, refresh_token: session.refreshToken }),
    });
    if (!response.ok) return null;
    const body = await response.json();
    const accessToken = body.access_token ?? body.accessToken;
    if (!accessToken) return null;
    const next = {
      sessionId: body.session_id ?? body.sessionId ?? session.sessionId,
      accessToken,
      refreshToken: body.refresh_token ?? body.refreshToken ?? session.refreshToken,
      receivedAt: new Date().toISOString(),
      expiresAt: body.expires_at ?? body.expiresAt ?? session.expiresAt,
    };
    await writeSession(next);
    return next;
  } catch {
    return null;
  }
}

function expiringSoon(session) {
  const at = Date.parse(session?.expiresAt ?? "");
  return !Number.isFinite(at) || at <= Date.now() + 60_000;
}

async function accessToken(force = false) {
  let session = await readSession();
  if (!session || force || expiringSoon(session)) {
    session = (await refreshSession(session)) ?? (await syncSessionFromTab()) ?? session;
  }
  if (!session?.accessToken) throw new NeedsLogin();
  return session.accessToken;
}

async function callApi(path, init = {}) {
  const send = (bearer) =>
    fetch(CYBION_ORIGIN + path, {
      ...init,
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
  let response = await send(await accessToken());
  if (response.status === 401) response = await send(await accessToken(true));
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(detail?.error ?? `Cybion 返回 ${response.status}`);
  }
  return response.status === 204 ? null : response.json();
}

function answerText(view) {
  const parts = [];
  for (const output of view?.response?.output ?? []) {
    const item = output?.item ?? {};
    if (item.type !== "message") continue;
    for (const part of item.content ?? []) {
      if (typeof part?.text === "string") parts.push(part.text);
    }
  }
  return parts.join("\n\n").trim();
}

async function ask(image, question, page) {
  const title = (page.title || "浏览器截图").slice(0, 80);
  const thread = await callApi("/api/threads", { method: "POST", body: JSON.stringify({ title }) });
  await callApi(`/api/threads/${encodeURIComponent(thread.id)}/inputs`, {
    method: "POST",
    body: JSON.stringify({ input: `${question}\n\n页面：${page.url}`, images: [image], audios: [] }),
  });
  return thread.id;
}

async function waitForAnswer(threadId, onTick) {
  const deadline = Date.now() + 180_000;
  let ticks = 0;
  while (Date.now() < deadline) {
    const view = await callApi(`/api/threads/${encodeURIComponent(threadId)}/response`);
    if (view?.response?.completed) {
      const text = answerText(view);
      if (text) return text;
      throw new Error("这一轮没有产生可显示的回答，去 Cybion 里看看。");
    }
    if (view?.status === "failed") throw new Error("这一轮失败了，去 Cybion 里看看。");
    onTick?.(++ticks);
    await sleep(1200);
  }
  throw new Error("等了三分钟还没有答案，先去 Cybion 里看这个 Thread。");
}

async function showPanel(tabId, payload) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "cybion:panel", ...payload });
  } catch {}
}

async function run(tab, question) {
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["src/panel.js"] });
    await showPanel(tab.id, { state: "loading", text: "正在截这张图…" });
    const image = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    await showPanel(tab.id, { state: "loading", text: "Cybion 正在看这张图…" });
    const threadId = await ask(image, question, { url: tab.url ?? "", title: tab.title ?? "" });
    await showPanel(tab.id, { state: "loading", text: "Cybion 正在看这张图…", link: threadLink(threadId) });
    const text = await waitForAnswer(threadId);
    await showPanel(tab.id, { state: "answer", text, link: threadLink(threadId) });
  } catch (error) {
    await showPanel(tab.id, {
      state: "error",
      text: error?.message ?? String(error),
      link: null,
    });
  }
}

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.type === "cybion:session" && message.session?.accessToken) {
    void writeSession(message.session);
    return;
  }
  if (message?.type === "cybion:sync-now") {
    void (async () => {
      const session = await syncSessionFromTab();
      respond({ ok: Boolean(session?.accessToken), expiresAt: session?.expiresAt ?? null });
    })();
    return true;
  }
  if (message?.type === "cybion:session-state") {
    void (async () => respond({ session: await readSession() }))();
    return true;
  }
  if (message?.type === "cybion:forget") {
    void chrome.storage.local.remove(LOCAL_KEY).then(() => respond({ ok: true }));
    return true;
  }
  if (message?.type === "cybion:capture") {
    void (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) await run(tab, DEFAULT_QUESTION);
      respond({ ok: true });
    })();
    return true;
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "capture-and-ask") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id !== undefined) await run(tab, DEFAULT_QUESTION);
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "cybion-ask",
    title: "问 Cybion：这是干什么的？",
    contexts: ["page", "selection", "image"],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "cybion-ask" || tab?.id === undefined) return;
  const question = info.selectionText
    ? `这张截图是我正在看的页面，我选中了这段文字：「${info.selectionText.slice(0, 500)}」。它是什么意思？`
    : DEFAULT_QUESTION;
  await run(tab, question);
});
