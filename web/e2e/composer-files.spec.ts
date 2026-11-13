import { expect, test } from "@playwright/test"

/// 附件按钮不弹系统对话框，它点的是页面里那个隐藏的 file input，所以 e2e 直接把文件
/// 塞给那个 input，走的是和用户点选完全一样的事件路径。
async function attach(page: import("@playwright/test").Page, files: { name: string; mimeType: string; buffer: Buffer }[]) {
  await page.locator('#composer input[type=file]').setInputFiles(files)
}

test("[+] attaches a text file, sends its content inside the message and clears the chip", async ({ page }) => {
  const posted: { input: string }[] = []
  await page.route("**/composer-files/send", async (route) => {
    posted.push(route.request().postDataJSON())
    await route.fulfill({ json: { status: "accepted" } })
  })
  await page.goto("/e2e/composer-files.html")
  const send = page.getByRole("button", { name: "Send", exact: true })
  await expect(send).toBeDisabled()

  await attach(page, [{ name: "notes.md", mimeType: "text/markdown", buffer: Buffer.from("# 记录\n- 磁盘 88%") }])
  await expect(page.getByText("notes.md")).toBeVisible()
  // An attachment alone is enough to send.
  await expect(send).toBeEnabled()
  await page.getByRole("textbox").fill("帮我看看")
  await send.click()

  await expect(page.getByRole("textbox")).toHaveValue("")
  await expect(page.getByText("notes.md")).toHaveCount(0)
  expect(posted).toHaveLength(1)
  expect(posted[0].input).toBe("帮我看看\n\n附件：notes.md（21 B）\n```markdown\n# 记录\n- 磁盘 88%\n```")
})

test("a file the composer cannot send is named with the reason instead of vanishing", async ({ page }) => {
  await page.goto("/e2e/composer-files.html")
  await attach(page, [
    { name: "report.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7") },
    { name: "app.log", mimeType: "text/plain", buffer: Buffer.from("line one\nline two") },
  ])
  await expect(page.getByText("app.log")).toBeVisible()
  await expect(page.getByText("未添加： report.pdf（不是图片、音频或文本文件）")).toBeVisible()
})

test("chips can be removed and the composer falls back to its idle state", async ({ page }) => {
  await page.goto("/e2e/composer-files.html")
  const send = page.getByRole("button", { name: "Send", exact: true })
  await attach(page, [{ name: "main.rs", mimeType: "application/octet-stream", buffer: Buffer.from("fn main() {}") }])
  await expect(send).toBeEnabled()
  await page.getByRole("button", { name: "移除附件: main.rs" }).click()
  await expect(page.getByText("main.rs")).toHaveCount(0)
  await expect(send).toBeDisabled()
})
