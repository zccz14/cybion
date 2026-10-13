import { expect, test } from "@playwright/test"
import { stubWorkspace } from "./workspace-fixture"

test("the Contexts page keeps an edge-to-edge tree beside a full-width reading pane", async ({ page }) => {
  const fixture = await stubWorkspace(page, { language: "zh", theme: "light" })
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.goto("/#/contexts")
  await expect(page.locator(".markdown-editor")).toBeVisible()

  // the page title lives in the shared app header; the page itself owns no title block
  await expect(page.locator(".ux-app-header__title")).toHaveText("上下文")

  // unified tree: both sources as top-level sections
  await expect(page.getByText("Cybion Common Context", { exact: true }).first()).toBeVisible()
  await expect(page.getByText("你的上下文", { exact: true })).toBeVisible()

  // node labels stack the name over the purpose instead of squeezing both into one row
  const commonNode = page.getByRole("button", { name: /Cybion Common Context/ }).first()
  const nameSpan = commonNode.locator("span span").nth(0)
  const purposeSpan = commonNode.locator("span span").nth(1)
  await expect(nameSpan).toHaveText("Cybion Common Context")
  await expect(purposeSpan).toContainText("Compiled into Cybion")
  const nameBox = await nameSpan.boundingBox()
  const purposeBox = await purposeSpan.boundingBox()
  expect(nameBox && purposeBox).toBeTruthy()
  expect(purposeBox!.y).toBeGreaterThanOrEqual(nameBox!.y + nameBox!.height - 1)
  expect(await nameSpan.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)

  // edge-to-edge columns: the tree sits flush at the app sidebar and the two columns share one boundary
  const sidebar = await page.locator(".ux-sidebar").boundingBox()
  const aside = await page.locator("main > aside").boundingBox()
  const section = await page.locator("main > section").boundingBox()
  expect(sidebar && aside && section).toBeTruthy()
  expect(Math.abs(aside!.x - (sidebar!.x + sidebar!.width))).toBeLessThanOrEqual(1)
  expect(Math.abs(aside!.x + aside!.width - section!.x)).toBeLessThanOrEqual(1)
  expect(Math.round(aside!.width)).toBe(320)
  expect(section!.width).toBeGreaterThan(aside!.width)
  await page.screenshot({ path: "test-results/layout-default.png" })

  // common context selected -> read-only preview
  await page.getByRole("button", { name: /Cybion Common Context/ }).first().click()
  await expect(page.getByText("只读", { exact: true }).first()).toBeVisible()
  await expect(page.getByText("随 Cybion 版本编译发布", { exact: false })).toBeVisible()
  expect(await page.locator(".markdown-editor[aria-readonly=true]").count()).toBe(1)
  expect(await page.locator(".markdown-editor__toolbar").count()).toBe(0)
  await page.screenshot({ path: "test-results/layout-common.png" })

  // create a local context and edit Markdown through the editor
  await page.getByRole("button", { name: "新建上下文", exact: true }).click()
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

  // mobile: no horizontal overflow
  await page.setViewportSize({ width: 390, height: 844 })
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: "test-results/layout-mobile.png" })

  expect(fixture.unexpected).toEqual([])
})

test("nested context branches start folded and open manually", async ({ page }) => {
  const fixture = await stubWorkspace(page, { language: "zh", theme: "light" })
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.goto("/#/contexts")

  await page.getByRole("button", { name: "新建上下文", exact: true }).click()
  await page.getByLabel("上下文名称", { exact: true }).fill("父上下文")
  await page.getByRole("button", { name: "创建上下文", exact: true }).click()
  await page.getByRole("button", { name: "新建上下文", exact: true }).click()
  await page.getByLabel("上下文名称", { exact: true }).fill("子上下文")
  await page.locator("#context-parent").click()
  await page.getByRole("option", { name: "父上下文" }).click()
  await page.getByRole("button", { name: "创建上下文", exact: true }).click()

  // the nested node stays folded until the branch is opened by hand
  const tree = page.getByRole("tree", { name: "你的上下文" })
  await expect(tree.getByRole("button", { name: "子上下文", exact: true })).toHaveCount(0)
  await tree.getByRole("button", { name: "展开上下文" }).click()
  await expect(tree.getByRole("button", { name: "子上下文", exact: true })).toBeVisible()
  await expect(tree.getByRole("button", { name: "收起上下文" })).toBeVisible()

  expect(fixture.references).toHaveLength(2)
  expect(fixture.references[1].parent_id).toBe("saved-reference")
  expect(fixture.unexpected).toEqual([])
})

test("context branches drag to reorder and nest with sort keys", async ({ page }) => {
  const fixture = await stubWorkspace(page, { language: "zh", theme: "light" })
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.goto("/#/contexts")

  const create = async (name: string) => {
    await page.getByRole("button", { name: "新建上下文", exact: true }).click()
    await page.getByLabel("上下文名称", { exact: true }).fill(name)
    await page.getByRole("button", { name: "创建上下文", exact: true }).click()
    await expect(page.getByText(name, { exact: true }).first()).toBeVisible()
  }
  await create("甲")
  await create("乙")
  await create("丙")

  const tree = page.getByRole("tree", { name: "你的上下文" })
  const rowOrder = () => tree.locator("[data-context-id]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-context-id")))
  expect(await rowOrder()).toEqual(["saved-reference", "saved-reference-2", "saved-reference-3"])

  const drag = async (sourceId: string, targetId: string, zone: "before" | "inside") => {
    const sourceBox = await tree.locator(`[data-context-id="${sourceId}"]`).boundingBox()
    const targetBox = await tree.locator(`[data-context-id="${targetId}"]`).boundingBox()
    expect(sourceBox && targetBox).toBeTruthy()
    const startX = sourceBox!.x + sourceBox!.width / 2
    const startY = sourceBox!.y + sourceBox!.height / 2
    await page.mouse.move(startX, startY)
    await page.mouse.down()
    await page.mouse.move(startX, startY + 12, { steps: 4 })
    const targetX = targetBox!.x + targetBox!.width / 2
    const targetY = zone === "before" ? targetBox!.y + targetBox!.height * 0.15 : targetBox!.y + targetBox!.height * 0.5
    await page.mouse.move(targetX, targetY, { steps: 10 })
    await page.mouse.move(targetX, targetY, { steps: 2 })
    await page.mouse.up()
  }

  // 丙 drops above 甲: the move write anchors on the front of the root group
  await drag("saved-reference-3", "saved-reference", "before")
  await expect.poll(rowOrder).toEqual(["saved-reference-3", "saved-reference", "saved-reference-2"])
  expect(fixture.writes).toContainEqual({ path: "/api/contexts/saved-reference-3/move", body: { parent_id: null, after_id: null } })

  // dropping a node on its current position stays local and writes nothing
  await drag("saved-reference-3", "saved-reference", "before")
  await page.waitForTimeout(300)
  expect(fixture.writes.filter((write) => write.path.endsWith("/move"))).toHaveLength(1)
  expect(await rowOrder()).toEqual(["saved-reference-3", "saved-reference", "saved-reference-2"])

  // 乙 drops inside 甲 and nests under it
  await drag("saved-reference-2", "saved-reference", "inside")
  await expect.poll(rowOrder).toEqual(["saved-reference-3", "saved-reference"])
  expect(fixture.writes).toContainEqual({ path: "/api/contexts/saved-reference-2/move", body: { parent_id: "saved-reference", after_id: null } })
  expect(fixture.references.find((reference) => reference.id === "saved-reference-2")!.parent_id).toBe("saved-reference")
  await tree.locator('[data-context-id="saved-reference"]').getByRole("button", { name: "展开上下文" }).click()
  await expect.poll(rowOrder).toEqual(["saved-reference-3", "saved-reference", "saved-reference-2"])
  await page.screenshot({ path: "test-results/layout-drag.png" })

  expect(fixture.unexpected).toEqual([])
})
