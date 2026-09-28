import { expect, test } from "@playwright/test"

async function pasteImage(page: import("@playwright/test").Page, options: { wide?: boolean; paddingBytes?: number } = {}) {
  await page.evaluate(async ({ wide, paddingBytes }) => {
    const canvas = document.createElement("canvas")
    canvas.width = wide ? 2600 : 8
    canvas.height = wide ? 1000 : 8
    const context = canvas.getContext("2d")!
    if (wide) {
      const gradient = context.createLinearGradient(0, 0, canvas.width, canvas.height)
      gradient.addColorStop(0, "#123456")
      gradient.addColorStop(1, "#fedcba")
      context.fillStyle = gradient
    } else {
      context.fillStyle = "#ff0000"
    }
    context.fillRect(0, 0, canvas.width, canvas.height)
    const png = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), "image/png"))
    // Padding past the copy-unchanged size exercises the downscale path while
    // the PNG header keeps the padded file decodable.
    const file = new File([png, new Uint8Array(paddingBytes)], "screenshot.png", { type: "image/png" })
    const transfer = new DataTransfer()
    transfer.items.add(file)
    document.getElementById("paste")!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }))
  }, { wide: options.wide ?? false, paddingBytes: options.paddingBytes ?? 0 })
}

test("a large pasted screenshot is downscaled, previewed, sent and cleared", async ({ page }) => {
  const posted: { input: string; images: string[] }[] = []
  await page.route("**/composer-images/send", async (route) => {
    posted.push(route.request().postDataJSON())
    await route.fulfill({ json: { status: "accepted" } })
  })
  await page.goto("/e2e/composer-images.html")
  const input = page.getByRole("textbox")
  const send = page.getByRole("button", { name: "Send", exact: true })
  await expect(send).toBeDisabled()
  await pasteImage(page, { wide: true, paddingBytes: 2_000_000 })
  const thumbnail = page.getByRole("img")
  await expect(thumbnail).toHaveAttribute("src", /^data:image\/jpeg;base64,/)
  await expect.poll(() => thumbnail.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(2048)
  await expect(send).toBeEnabled()
  await input.fill("看看这个报错")
  await send.click()
  await expect(input).toHaveValue("")
  await expect(page.getByRole("img")).toHaveCount(0)
  expect(posted).toHaveLength(1)
  expect(posted[0].input).toBe("看看这个报错")
  expect(posted[0].images).toHaveLength(1)
  expect(posted[0].images[0].startsWith("data:image/jpeg;base64,")).toBe(true)
  expect(posted[0].images[0].length).toBeLessThan(500_000)
})

test("a small image keeps its bytes and sends without typed text", async ({ page }) => {
  const posted: { input: string; images: string[] }[] = []
  await page.route("**/composer-images/send", async (route) => {
    posted.push(route.request().postDataJSON())
    await route.fulfill({ json: { status: "accepted" } })
  })
  await page.goto("/e2e/composer-images.html")
  const send = page.getByRole("button", { name: "Send", exact: true })
  await pasteImage(page)
  const thumbnail = page.getByRole("img")
  await expect(thumbnail).toHaveAttribute("src", /^data:image\/png;base64,/)
  await expect(thumbnail).toHaveAttribute("alt", "粘贴的图片")
  const src = await thumbnail.getAttribute("src")
  await send.click()
  expect(posted).toHaveLength(1)
  expect(posted[0].input).toBe("")
  expect(posted[0].images).toEqual([src])
})

test("attachments can be removed and text pastes are left alone", async ({ page }) => {
  await page.goto("/e2e/composer-images.html")
  const send = page.getByRole("button", { name: "Send", exact: true })
  await pasteImage(page)
  await expect(page.getByRole("img")).toHaveCount(1)
  await expect(send).toBeEnabled()
  await page.getByRole("button", { name: "移除图片" }).click()
  await expect(page.getByRole("img")).toHaveCount(0)
  await expect(send).toBeDisabled()
  await page.evaluate(() => {
    const transfer = new DataTransfer()
    transfer.setData("text/plain", "普通文本")
    document.getElementById("paste")!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }))
  })
  await expect(page.getByRole("img")).toHaveCount(0)
})
