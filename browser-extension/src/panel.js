// 答案就浮在你看的那个页面上：一个 Shadow DOM 宿主，不碰站点样式，也不被站点样式碰到。
(() => {
  if (window.__cybionPanelReady) return;
  window.__cybionPanelReady = true;

  let host = null;
  let root = null;

  const style = `
    :host { all: initial; }
    .card {
      width: 380px; max-height: 62vh; display: flex; flex-direction: column;
      background: #ffffff; color: #111111; border: 1px solid #d8d8d8; border-radius: 12px;
      box-shadow: 0 12px 32px rgba(0, 0, 0, .18);
      font: 13px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
      overflow: hidden;
    }
    .head { display: flex; align-items: center; justify-content: space-between; padding: 8px 10px 8px 14px; border-bottom: 1px solid #ededed; }
    .brand { font-weight: 600; letter-spacing: .02em; }
    .close { border: 0; background: transparent; color: #888888; font-size: 18px; line-height: 1; cursor: pointer; padding: 2px 6px; border-radius: 6px; }
    .close:hover { background: #f2f2f2; color: #111111; }
    .body { padding: 12px 14px; overflow: auto; white-space: pre-wrap; word-break: break-word; }
    .body.loading { color: #666666; }
    .body.error { color: #b3261e; }
    .foot { padding: 0 14px 12px; }
    .foot a { color: #111111; text-underline-offset: 2px; font-size: 12px; }
    @media (prefers-color-scheme: dark) {
      .card { background: #17171a; color: #f4f4f5; border-color: #303034; }
      .head { border-bottom-color: #2a2a2e; }
      .body.loading { color: #a1a1aa; }
      .body.error { color: #f87171; }
      .close { color: #a1a1aa; }
      .close:hover { background: #26262a; color: #ffffff; }
      .foot a { color: #f4f4f5; }
    }
  `;

  function ensure() {
    if (host?.isConnected) return;
    host = document.createElement("div");
    host.style.cssText = "all:initial;position:fixed;top:16px;right:16px;z-index:2147483647;";
    root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>${style}</style>
      <div class="card">
        <div class="head"><span class="brand">Cybion</span><button class="close" title="关闭（Esc）">×</button></div>
        <div class="body loading">正在准备…</div>
        <div class="foot"></div>
      </div>`;
    root.querySelector(".close").addEventListener("click", close);
    document.addEventListener("keydown", onKey, true);
    (document.body ?? document.documentElement).appendChild(host);
  }

  function onKey(event) {
    if (event.key === "Escape") close();
  }

  function close() {
    document.removeEventListener("keydown", onKey, true);
    host?.remove();
    host = null;
    root = null;
  }

  function render(message) {
    ensure();
    const body = root.querySelector(".body");
    const foot = root.querySelector(".foot");
    body.className = "body";
    if (message.state === "loading") body.classList.add("loading");
    if (message.state === "error") body.classList.add("error");
    body.textContent = message.text ?? "";
    foot.textContent = "";
    if (message.link) {
      const link = document.createElement("a");
      link.href = message.link;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = "在 Cybion 里打开这个 Thread →";
      foot.appendChild(link);
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "cybion:panel") render(message);
  });
})();
