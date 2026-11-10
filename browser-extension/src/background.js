// Cybion 的第二个 UI：侧边栏就是它的容器，跟 GUI 走同一套 /api、同一个 Auth Mini JWT。
// 它不是设备，所以没有配对、没有注册、没有长连接，也没有无人值守的调用。

const CYBION_ORIGIN = "https://cybion.ntnl.io";
const AUTH_ORIGIN = "https://auth.ntnl.io";
const SESSION_KEY = `auth-mini.sdk:${AUTH_ORIGIN}/`;
const LOCAL_KEY = "cybion.session";
const PENDING_KEY = "cybion.pendingThread";
const ERROR_KEY = "cybion.lastError";
const DEFAULT_QUESTION = "这张截图是我正在看的页面。先说清这一块是干什么的，再说我看它时最该注意的三件事。";

class NeedsLogin extends Error {
  constructor() {
    super("还没有 Cybion 的登录态：打开 cybion.ntnl.io 登录一次（插件会自己取）。");
  }
}

async function readSession() {
  const stored = await chrome.storage.local.get(LOCAL_KEY);
  return stored[LOCAL_KEY] ?? null;
}

async function writeSession(session) {
  if (session) await chrome.storage.local.set({ [LOCAL_KEY]: session });
}

/** 登录态由 GUI 持有，插件只是同一个人的第二个入口，从已登录的 Cybion 页面把它取过来。 */
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
    // auth-mini 的刷新响应是 { access_token, session_id, refresh_token, expires_in }：
    // 到期时间是相对秒数，不是时间戳；写错的话 expiresAt 永远停在过去。
    const expiresAt =
      typeof body.expires_in === "number"
        ? new Date(Date.now() + body.expires_in * 1000).toISOString()
        : body.expires_at ?? body.expiresAt ?? session.expiresAt;
    const next = {
      sessionId: body.session_id ?? body.sessionId ?? session.sessionId,
      accessToken,
      refreshToken: body.refresh_token ?? body.refreshToken ?? session.refreshToken,
      receivedAt: new Date().toISOString(),
      expiresAt,
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

/** 侧边栏要开，就必须在用户手势还在的时候调用，所以先开面板，再慢慢截图建线程。 */
async function openPanel(tab) {
  try {
    if (tab?.id !== undefined) await chrome.sidePanel.open({ tabId: tab.id });
    else if (tab?.windowId !== undefined) await chrome.sidePanel.open({ windowId: tab.windowId });
  } catch {}
}

async function askWithScreenshot(tab, question) {
  try {
    const image = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    const title = (tab.title || "浏览器截图").slice(0, 80);
    const thread = await callApi("/api/threads", { method: "POST", body: JSON.stringify({ title }) });
    await callApi(`/api/threads/${encodeURIComponent(thread.id)}/inputs`, {
      method: "POST",
      body: JSON.stringify({
        input: `${question}\n\n页面：${tab.url}`,
        images: [image],
        audios: [],
      }),
    });
    await chrome.storage.local.remove(ERROR_KEY);
    await chrome.storage.local.set({ [PENDING_KEY]: { id: thread.id, at: Date.now() } });
    try {
      await chrome.action.setBadgeText({ text: "" });
    } catch {}
  } catch (error) {
    const message = error?.message ?? String(error);
    await chrome.storage.local.set({ [ERROR_KEY]: message });
    try {
      await chrome.action.setBadgeText({ text: "!" });
      await chrome.action.setBadgeBackgroundColor({ color: "#b91c1c" });
    } catch {}
  }
}

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.type === "cybion:session" && message.session?.accessToken) {
    void writeSession(message.session);
    return;
  }
  if (message?.type === "cybion:token") {
    void (async () => {
      try {
        respond({ token: await accessToken(Boolean(message.force)) });
      } catch (error) {
        respond({ error: error?.message ?? String(error) });
      }
    })();
    return true;
  }
  // 侧边栏要的不只是一份缓存，而是一份"现在就能用"的会话：先刷新，再回落到已登录的页面。
  if (message?.type === "cybion:session-now") {
    void (async () => {
      let session = await readSession();
      if (!session?.accessToken || message.force || expiringSoon(session)) {
        session = (await refreshSession(session)) ?? (await syncSessionFromTab()) ?? session;
      }
      respond({ session });
    })();
    return true;
  }
  if (message?.type === "cybion:sync-now") {
    void (async () => {
      const session = await syncSessionFromTab();
      respond({ ok: Boolean(session?.accessToken), expiresAt: session?.expiresAt ?? null });
    })();
    return true;
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "capture-and-ask") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  await openPanel(tab);
  await askWithScreenshot(tab, DEFAULT_QUESTION);
});

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true });
  chrome.contextMenus.create({
    id: "cybion-ask",
    title: "问 Cybion：这是干什么的？",
    contexts: ["page", "selection", "image"],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "cybion-ask" || !tab) return;
  const question = info.selectionText
    ? `这张截图是我正在看的页面，我选中了这段文字：「${info.selectionText.slice(0, 500)}」。它是什么意思？`
    : DEFAULT_QUESTION;
  await openPanel(tab);
  await askWithScreenshot(tab, question);
});
