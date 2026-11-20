import { expect, test } from "@playwright/test"

test.use({ permissions: ["clipboard-read", "clipboard-write"] })

test("user input renders its text, its pasted images and opens a preview", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message))
  await page.goto("/e2e/user-input-message.html")
  const groups = page.locator('[data-slot="message-group"]')
  await expect(groups).toHaveCount(5)
  await expect(page.getByText("看看这张图。", { exact: true })).toBeVisible()
  await expect(page.getByText("这个报错怎么回事？", { exact: true })).toBeVisible()
  await expect(page.getByRole("img")).toHaveCount(3)
  await expect(page.getByRole("img").first()).toHaveAttribute("alt", "粘贴的图片")
  await expect(groups.nth(2).locator(".bg-user-message")).toHaveCount(0)
  await page.getByRole("button", { name: "查看图片" }).first().click()
  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole("img")).toHaveCount(1)
  await page.keyboard.press("Escape")
  await expect(dialog).toBeHidden()
  await page.getByRole("button", { name: "Language", exact: true }).click()
  await expect(page.getByRole("img").first()).toHaveAttribute("alt", "Pasted image")
  await expect(page.getByRole("button", { name: "Open image" }).first()).toBeVisible()
  expect(errors).toEqual([])
})

test("user input exposes the shared copy control beneath its bubble", async ({ page }) => {
  await page.goto("/e2e/user-input-message.html")
  const groups = page.locator('[data-slot="message-group"]')
  const first = groups.first()
  const button = first.getByRole("button", { name: "复制", exact: true })
  await expect(button).toBeVisible()
  expect(await first.evaluate((node) => {
    const bubble = node.querySelector(".bg-user-message")
    const control = node.querySelector('button[aria-label="复制"]')
    return bubble !== null && control !== null && bubble.compareDocumentPosition(control) === Node.DOCUMENT_POSITION_FOLLOWING
  })).toBe(true)
  await button.click()
  await expect(first.getByRole("status")).toHaveText("已复制")
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("看看这张图。")
  await expect(groups.nth(2).getByRole("button", { name: "复制", exact: true })).toHaveCount(0)
})

test("the copy control and the record meta render on one footer row", async ({ page }) => {
  await page.goto("/e2e/user-input-message.html")
  const first = page.locator('[data-slot="message-group"]').first()
  await expect(first.locator('[data-slot="user-footer"]')).toBeVisible()
  await expect(first.locator('[data-slot="user-meta"]')).toHaveText("#12 · 2026-01-02 12:34:56")
  expect(await first.evaluate((node) => {
    const control = node.querySelector('button[aria-label="复制"]')
    const meta = node.querySelector('[data-slot="user-meta"]')
    if (control === null || meta === null) return false
    const a = control.getBoundingClientRect()
    const b = meta.getBoundingClientRect()
    return a.bottom > b.top && b.bottom > a.top && (a.left + a.right) / 2 < (b.left + b.right) / 2
  })).toBe(true)
})

test("image-only inputs keep the record meta row without a copy control", async ({ page }) => {
  await page.goto("/e2e/user-input-message.html")
  const imageOnly = page.locator('[data-slot="message-group"]').nth(2)
  await expect(imageOnly.locator('[data-slot="user-meta"]')).toHaveText("#14 · 2026-01-02 12:34:56")
  await expect(imageOnly.getByRole("button", { name: "复制", exact: true })).toHaveCount(0)
})

// 手机上一条很长的输入曾经把气泡撑到 595px：气泡在右对齐的列里收缩到 min-content，
// 超出对话栏的部分被滚动容器裁掉，看到的就是行首缺字。断行必须让气泡永远留在栏内，
// 并且栏内不再有水平溢出的文字。
test("a long input wraps inside the column instead of being clipped on the left", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/e2e/user-input-message.html")
  await expect(page.locator('[data-slot="audio-transcript"]')).toContainText("这段转写没有标点")
  const overflow = await page.evaluate(() => {
    const rounded = (value: number) => Math.round(value * 10) / 10
    return [...document.querySelectorAll<HTMLElement>(".bg-user-message, [data-slot=audio-transcript]")].flatMap((element) => {
      const column = element.closest<HTMLElement>("[data-slot=message-content]")
      if (!column) return []
      const box = element.getBoundingClientRect(), frame = column.getBoundingClientRect()
      const outside = box.left < frame.left - 0.5 || box.right > frame.right + 0.5
      const scrolls = element.scrollWidth > element.clientWidth + 1
      if (!outside && !scrolls) return []
      return [{ head: element.textContent?.slice(0, 20), left: rounded(box.left), right: rounded(box.right), columnLeft: rounded(frame.left), columnRight: rounded(frame.right), clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }]
    })
  })
  expect(overflow).toEqual([])
})
