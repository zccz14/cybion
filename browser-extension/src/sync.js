// 在 cybion.ntnl.io 上跑（包括侧边栏里那个 iframe）：把站点自己持有的 Auth Mini 登录态递给插件。
// 插件不自己登录、不存第二次密码——它只是同一个人的第二个入口，借一份现成的 JWT 去发截图。
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

  let last = null;

  function push(session) {
    if (!session?.accessToken || session.accessToken === last) return;
    last = session.accessToken;
    try {
      void chrome.runtime.sendMessage({ type: "cybion:session", session })?.catch?.(() => {});
    } catch {}
  }

  push(read());

  // 侧边栏里那个 iframe 也是这个站点，但它的存储是分区过的：你在框里登录之后，
  // 会话只落在它自己那一格。所以这里持续盯着，一有新的就递出去。
  setInterval(() => push(read()), 4000);

  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message?.type !== "cybion:read-session") return;
    respond({ session: read() });
    return true;
  });
})();
