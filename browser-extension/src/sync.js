// 在 cybion.ntnl.io 上跑（包括侧边栏里那个 iframe）：替站点把一份"过期但可续"的会话收拾好。
//
// 站点的 AuthMiniProvider 启动时会本地校验 JWT 的 exp，过期就直接出
// "Cybion could not verify this session"，不会替你续。这份代码跑在站点自己的 origin 里，
// 所以它能就地续期、或者就地清掉，让应用回到登录页而不是停在死卡片上。
(() => {
  const KEY = "auth-mini.sdk:https://auth.ntnl.io/";
  const REFRESH_URL = "https://auth.ntnl.io/session/refresh";
  const REPAIR_GUARD = "cybion.sessionRepairAt";
  const GUARD_MS = 60_000;
  const isFrame = window.top !== window.self;

  function read() {
    try {
      const value = JSON.parse(localStorage.getItem(KEY) ?? "null");
      return value?.accessToken ? value : null;
    } catch {
      return null;
    }
  }

  function expiresAt(token) {
    try {
      const payload = String(token).split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      const decoded = JSON.parse(atob(payload + "=".repeat((4 - (payload.length % 4)) % 4)));
      return (decoded.exp ?? 0) * 1000;
    } catch {
      return 0;
    }
  }

  async function refresh(session) {
    if (!session?.refreshToken || !session?.sessionId) return null;
    try {
      const response = await fetch(REFRESH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: session.sessionId, refresh_token: session.refreshToken }),
      });
      if (!response.ok) return null;
      const body = await response.json();
      if (typeof body?.access_token !== "string") return null;
      return {
        sessionId: body.session_id ?? session.sessionId,
        accessToken: body.access_token,
        refreshToken: body.refresh_token ?? session.refreshToken,
        receivedAt: new Date().toISOString(),
        expiresAt: typeof body.expires_in === "number"
          ? new Date(Date.now() + body.expires_in * 1000).toISOString()
          : new Date(expiresAt(body.access_token)).toISOString(),
      };
    } catch {
      return null;
    }
  }

  function reloadOnce() {
    try {
      const last = Number(sessionStorage.getItem(REPAIR_GUARD) ?? 0);
      if (Date.now() - last < GUARD_MS) return false;
      sessionStorage.setItem(REPAIR_GUARD, String(Date.now()));
      location.reload();
      return true;
    } catch {
      return false;
    }
  }

  const session = read();
  if (!session) return;
  if (expiresAt(session.accessToken) > Date.now() + 60_000) return;

  void (async () => {
    const repaired = await refresh(session);
    if (repaired) {
      localStorage.setItem(KEY, JSON.stringify(repaired));
      reloadOnce();
      return;
    }
    // 续不上就清掉：停在"过期"卡片上什么也做不了，回登录页至少能自己救。
    // 只对 iframe 动手——顶层标签页是你的场面，不替你做主。
    if (isFrame) {
      localStorage.removeItem(KEY);
      reloadOnce();
    }
  })();
})();
