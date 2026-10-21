import { expect, test } from "@playwright/test"

test("each loaded Manual shows its name, never the id", async ({ page }) => {
  await page.goto("/e2e/thread-manual-loads.html")
  const loaded = page.locator("#loaded")
  await expect(loaded).toContainText("已加载手册 2 / 12")
  await expect(loaded).toContainText("#10–#32")
  const manual = loaded.getByRole("link", { name: /必读手册/ })
  await expect(manual).toHaveText("必读手册已加载")
  await expect(manual).toHaveAttribute("href", "#/manuals?manual=8f1d2e3a-4b5c-6d7e-8f90-1a2b3c4d5e6f")
  await expect(manual).toHaveAttribute("title", "8f1d2e3a-4b5c-6d7e-8f90-1a2b3c4d5e6f\n控制器会持续把它的最新副本送进请求，不需要模型重新读取。")
  await expect(loaded.getByRole("link", { name: /LOL-MODEL/ })).toHaveText("LOL-MODEL已加载")
  // The chip carries no id: a UUID means nothing to a reader.
  await expect(loaded).not.toContainText("8f1d2e3a")
})

test("a Manual the lookup cannot name keeps a readable stand-in", async ({ page }) => {
  await page.goto("/e2e/thread-manual-loads.html")
  const unknown = page.locator("#unknown")
  await expect(unknown).toContainText("已加载手册 2")
  await expect(unknown.getByRole("link", { name: /未知手册/ })).toHaveText("未知手册已加载")
})

test("a Thread with nothing loaded says so", async ({ page }) => {
  await page.goto("/e2e/thread-manual-loads.html")
  const empty = page.locator("#empty")
  await expect(empty).toContainText("已加载手册 0 / 2")
  await expect(empty).toContainText("本线程没有加载手册")
  await expect(empty.getByRole("link")).toHaveCount(0)
})

test("the transcript shows a Manual being kept loaded and released", async ({ page }) => {
  await page.goto("/e2e/thread-manual-loads.html")
  const load = page.locator("#load-notice")
  await expect(load).toContainText("已加载手册，完整 JSON 已注入请求")
  await expect(load).toContainText("控制器会自己再补一份最新副本")
  await expect(load.getByRole("link", { name: "必读手册" })).toHaveAttribute("href", "#/manuals?manual=8f1d2e3a-4b5c-6d7e-8f90-1a2b3c4d5e6f")
  await expect(load).toContainText("#43")
  const unload = page.locator("#unload-notice")
  await expect(unload).toContainText("已卸载手册")
  await expect(unload).toContainText("此后不再刷新")
  await expect(unload).toContainText("#44")
})

test("the row speaks both languages and keeps its layout in either theme", async ({ page }) => {
  await page.goto("/e2e/thread-manual-loads.html")
  await page.getByRole("button", { name: "Theme", exact: true }).click()
  await page.getByRole("button", { name: "Language", exact: true }).click()
  const loaded = page.locator("#loaded")
  await expect(loaded).toContainText("Loaded manuals 2 / 12")
  await expect(loaded).toContainText("#10–#32")
  await expect(loaded.getByRole("link", { name: /必读手册/ })).toHaveText("必读手册loaded")
  await expect(loaded.getByRole("link", { name: /必读手册/ })).toHaveAttribute("title", /keeps delivering its current copy/)
  await expect(page.locator("#unknown").getByRole("link", { name: /Unknown manual/ })).toHaveText("Unknown manualloaded")
  await expect(page.locator("#empty")).toContainText("no manual loaded in this thread")
  await expect(page.locator("#load-notice")).toContainText("Manual loaded — its JSON is in the request")
  await expect(page.locator("#unload-notice")).toContainText("Manual unloaded")
})
