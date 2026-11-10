// 在 cybion.ntnl.io 上跑：把 GUI 已经持有的 Auth Mini 登录态递给插件。
// 插件不自己登录、不存第二次密码，它只是同一个人的第二个入口。
(() => {
  const KEY = "auth-mini.sdk:https://auth.ntnl.io/";

  function read() {
    try {
      const value = JSON.parse(localStorage.getItem(KEY) ?? "null");
      return value?.accessToken ? value : null;
    } catch {
      return null;
    }
  }

  const first = read();
  if (first) {
    try {
      void chrome.runtime.sendMessage({ type: "cybion:session", session: first })?.catch?.(() => {});
    } catch {}
  }

  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message?.type !== "cybion:read-session") return;
    respond({ session: read() ?? first });
    return true;
  });
})();
