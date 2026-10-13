import { expect, test } from "@playwright/test"
import { stubWorkspace } from "./workspace-fixture"

test("the unified Contexts tree spans common, local, and CTX sources with read-only previews", async ({ page }) => {
  const fixture = await stubWorkspace(page, { language: "zh", theme: "light", ctxConnected: true })
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.goto("/#/contexts")
  await expect(page.locator(".markdown-editor")).toBeVisible()

  // unified tree: all three sources as top-level sections
  await expect(page.getByText("Cybion Common Context", { exact: true }).first()).toBeVisible()
  await expect(page.getByText("你的上下文", { exact: true })).toBeVisible()
  await expect(page.getByText("CTX 来源（可选）", { exact: true }).first()).toBeVisible()
  await expect(page.getByText("CTX project reference", { exact: true })).toBeVisible()
  await page.screenshot({ path: "test-results/layout-default.png" })

  // common context selected -> read-only preview
  await page.getByRole("button", { name: /Cybion Common Context/ }).first().click()
  await expect(page.getByText("只读", { exact: true }).first()).toBeVisible()
  await expect(page.getByText("随 Cybion 版本编译发布", { exact: false })).toBeVisible()
  expect(await page.locator(".markdown-editor[aria-readonly=true]").count()).toBe(1)
  expect(await page.locator(".markdown-editor__toolbar").count()).toBe(0)
  await page.screenshot({ path: "test-results/layout-common.png" })

  // CTX document selected -> read-only pane with CTX badge and deep link
  await page.getByRole("button", { name: /CTX project reference/ }).first().click()
  await expect(page.getByText("内容存放在 CTX", { exact: false })).toBeVisible()
  await expect(page.getByRole("link", { name: /在 CTX 打开/ })).toHaveAttribute("href", "https://ctx.ntnl.io/#/documents/ctx-reference")
  await page.screenshot({ path: "test-results/layout-ctx.png" })

  // create a local context and edit Markdown through the editor
  await page.getByRole("button", { name: "添加上下文引用", exact: true }).click()
  await page.getByLabel("上下文名称", { exact: true }).fill("项目手册")
  const editor = page.locator(".markdown-editor")
  await editor.getByRole("button", { name: "源码", exact: true }).click()
  await editor.locator("textarea").fill("# 手册\n\n- 第一条\n- 第二条")
  await editor.getByRole("button", { name: "编辑", exact: true }).click()
  await expect(editor.locator(".markdown-editor__canvas h1")).toHaveText("手册")
  await page.getByRole("button", { name: "创建上下文", exact: true }).click()
  await expect(page.getByText("项目手册", { exact: true }).first()).toBeVisible()
  expect(fixture.references).toHaveLength(1)
  expect(fixture.references[0].content).toContain("- 第一条")
  expect(await page.locator('input[type="file"]').count()).toBe(0)
  await page.screenshot({ path: "test-results/layout-editor.png" })

  // two-pane geometry at desktop: tree left, editor right, editor pane wider
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.waitForTimeout(200)
  const treeBox = await page.getByRole("tree", { name: "你的上下文" }).boundingBox()
  const editorBox = await page.locator(".markdown-editor").boundingBox()
  expect(treeBox && editorBox).toBeTruthy()
  expect(editorBox!.x).toBeGreaterThan(treeBox!.x + treeBox!.width)
  expect(editorBox!.width).toBeGreaterThan(treeBox!.width)
  const stacked = await page.evaluate(() => {
    const editors = document.querySelectorAll(".markdown-editor")
    const last = editors[editors.length - 1]
    return last ? getComputedStyle(last).width : ""
  })
  expect(stacked).not.toBe("")

  // mobile: no horizontal overflow
  await page.setViewportSize({ width: 390, height: 844 })
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: "test-results/layout-mobile.png" })

  expect(fixture.unexpected).toEqual([])
})
