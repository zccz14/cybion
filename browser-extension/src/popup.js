const CYBION_ORIGIN = "https://cybion.ntnl.io";
const dot = document.getElementById("dot");
const state = document.getElementById("state");

function describe(session) {
  if (!session?.accessToken) {
    dot.classList.remove("on");
    state.textContent = "未同步：登录 cybion.ntnl.io 后点下面的同步";
    return;
  }
  const at = Date.parse(session.expiresAt ?? "");
  dot.classList.add("on");
  state.textContent = Number.isFinite(at)
    ? `已同步，令牌 ${Math.max(0, Math.round((at - Date.now()) / 60000))} 分钟后到期`
    : "已同步";
}

async function refresh() {
  const reply = await chrome.runtime.sendMessage({ type: "cybion:session-state" });
  describe(reply?.session);
}

document.getElementById("ask").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "cybion:capture" });
  window.close();
});

document.getElementById("sync").addEventListener("click", async () => {
  state.textContent = "正在同步…";
  const reply = await chrome.runtime.sendMessage({ type: "cybion:sync-now" });
  if (reply?.ok) await refresh();
  else state.textContent = "没有找到已登录的 Cybion 页面，点下面打开";
});

document.getElementById("open").addEventListener("click", () => {
  void chrome.tabs.create({ url: CYBION_ORIGIN });
  window.close();
});

void refresh();
