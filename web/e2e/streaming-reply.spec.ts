import { expect, test } from "@playwright/test"

const content = '[data-slot="assistant-content"]'

test("a polled reply types itself out and settles on the last snapshot", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message))
  await page.goto("/e2e/streaming-reply.html")

  const lengths: number[] = []
  const samples: string[] = []
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const text = await page.locator(content).evaluate((node) => node.textContent ?? "")
    samples.push(text)
    lengths.push(text.length)
    if (process.env.CAPTURE_REVEAL && attempt === 12) await page.screenshot({ path: "/tmp/reveal-mid.png" })
    if ((await page.locator('[data-stream="done"]').count()) > 0) break
    await page.waitForTimeout(100)
  }

  // 它是一段一段长出来的，不是一次到位；而且从不倒退。
  expect(new Set(lengths).size).toBeGreaterThan(4)
  expect(lengths).toEqual([...lengths].sort((a, b) => a - b))
  // Markdown 语法从不外泄：切在构造中间时，半截的 ** 不会出现。
  expect(samples.every((sample) => !sample.includes("**"))).toBe(true)

  await expect(page.locator(`${content} h2`)).toHaveText("部署状态")
  await expect(page.locator(`${content} code`).first()).toHaveText("git status")
  await expect(page.locator(`${content} pre code`)).toContainText("git status --short")
  await expect(page.locator(`${content} table td`).last()).toHaveText("通过")

  // 记录落地后不再直播：光标消失，内容与最后一份快照一致。
  await expect(page.locator('[data-stream="done"]')).toHaveCount(1)
  await expect(page.locator(".ux-markdown[data-revealing]")).toHaveCount(0)
  const final = await page.evaluate(() => window.__stream.final)
  expect(final).toContain("| 部署 | 通过 |")
  if (process.env.CAPTURE_REVEAL) await page.screenshot({ path: "/tmp/reveal-done.png" })
  expect(errors).toEqual([])
})

test("the reveal respects reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto("/e2e/streaming-reply.html")
  // 第二份快照在 600ms 到达：收手的话它整段立刻出现，而不是还在逐字播放。
  await page.waitForTimeout(800)
  const text = await page.locator(content).evaluate((node) => node.textContent ?? "")
  expect(text).toContain("检查通过")
  expect(text).toContain("服务健康")
})
