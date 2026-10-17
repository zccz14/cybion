import { expect, test, type Page } from "@playwright/test"

type Machine = {
  id: string
  name: string
  worker_id: string
  worker_label: string
  command: string
  intent: string
  interval_seconds: number
  thread_id: string
  thread_title: string
  enabled: boolean
  last_run_at: number
  last_exit: number
  created_at: number
}

const machine: Machine = {
  id: "m1",
  name: "磁盘检查",
  worker_id: "w1",
  worker_label: "Linux US",
  command: "test $(df -Pk / | awk 'NR==2 {print $5}' | tr -d %) -lt 90",
  intent: "确保根分区低于 90%",
  interval_seconds: 600,
  thread_id: "t1",
  thread_title: "终极机器 · 磁盘检查",
  enabled: true,
  last_run_at: 1,
  last_exit: 1,
  created_at: 0,
}

async function stubMachines(page: Page) {
  let machines: Machine[] = [machine]
  const deleted: string[] = []
  await page.route("**/api/machines**", (route) => {
    const request = route.request()
    if (request.method() === "DELETE") {
      deleted.push(request.url())
      machines = []
      return route.fulfill({ status: 204, body: "" })
    }
    if (request.method() === "GET") return route.fulfill({ json: machines })
    return route.fulfill({ status: 405, json: { error: "unexpected method" } })
  })
  await page.route("**/api/workers", (route) =>
    route.fulfill({ json: [{ id: "w1", label: "Linux US", created_at: 1, status: "online", access: "owner" }] }),
  )
  return { deleted }
}

test("a short window scrolls the tall edit dialog instead of cutting it off", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 420 })
  await stubMachines(page)
  await page.goto("/e2e/ultimate-machines.html")

  await page.getByRole("button", { name: "编辑" }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()

  const box = await dialog.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.y).toBeGreaterThanOrEqual(0)
  expect(box!.y + box!.height).toBeLessThanOrEqual(421)
  const metrics = await dialog.evaluate((element) => ({ scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }))
  expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight)

  // The footer lives at the end of the dialog's own scroll, not off-screen.
  const cancel = dialog.getByRole("button", { name: "取消" })
  await cancel.scrollIntoViewIfNeeded()
  await expect(cancel).toBeVisible()
  const cancelBox = await cancel.boundingBox()
  expect(cancelBox!.y + cancelBox!.height).toBeLessThanOrEqual(421)
  await cancel.click()
  await expect(dialog).toBeHidden()
})

test("deleting a machine asks first, keeps its repair Thread, and clears the row", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 800 })
  const { deleted } = await stubMachines(page)
  await page.goto("/e2e/ultimate-machines.html")
  await expect(page.getByRole("link", { name: "终极机器 · 磁盘检查" })).toBeVisible()

  await page.getByRole("button", { name: "删除", exact: true }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog).toContainText("删除机器")
  await expect(dialog).toContainText("绑定的修复 Thread 及其历史会保留。")
  await expect(dialog).toContainText("磁盘检查")

  await dialog.getByRole("button", { name: "删除", exact: true }).click()
  await expect.poll(() => deleted.length).toBe(1)
  await expect(page.getByText("还没有终极机器。")).toBeVisible()
  await expect(dialog).toBeHidden()
})
