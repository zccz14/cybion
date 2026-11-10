// Cybion 的第二个宿主：侧边栏里嵌的是站点本身，插件只补"截图"这一件事。
// 热键和右键菜单都不替你提问，只把这一屏截下来放进草稿页——问什么由你写。

const CYBION_ORIGIN = "https://cybion.ntnl.io";
const IMAGE_KEY = "cybion.pendingImage";
const ERROR_KEY = "cybion.lastError";

/** 侧边栏要开，就必须在用户手势还在的时候调用，所以先开面板，再慢慢截图。 */
async function openPanel(tab) {
  try {
    if (tab?.id !== undefined) await chrome.sidePanel.open({ tabId: tab.id });
    else if (tab?.windowId !== undefined) await chrome.sidePanel.open({ windowId: tab.windowId });
  } catch {}
}

async function captureDraft(tab) {
  try {
    const image = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    await chrome.storage.local.set({ [IMAGE_KEY]: { dataUrl: image, at: Date.now() } });
    await chrome.storage.local.remove(ERROR_KEY);
    try {
      await chrome.action.setBadgeText({ text: "" });
    } catch {}
  } catch (error) {
    await chrome.storage.local.set({ [ERROR_KEY]: error?.message ?? String(error) });
    try {
      await chrome.action.setBadgeText({ text: "!" });
      await chrome.action.setBadgeBackgroundColor({ color: "#b91c1c" });
    } catch {}
  }
}

async function run(tab) {
  await openPanel(tab);
  await captureDraft(tab);
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "capture-and-ask") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) await run(tab);
});

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true });
  chrome.contextMenus.create({
    id: "cybion-ask",
    title: "用这张截图问 Cybion",
    contexts: ["page", "selection", "image"],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "cybion-ask" || !tab) return;
  await run(tab);
});
