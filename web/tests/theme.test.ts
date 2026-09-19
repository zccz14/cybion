import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8")
const source = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8")
const design = readFileSync(new URL("../../DESIGN.md", import.meta.url), "utf8")
const lightBlock = css.match(/:root \{([\s\S]*?)\n\}/)![1]
const darkBlock = css.match(/\.dark \{([\s\S]*?)\n\}/)![1]
const tokens = (block: string): Record<string, string> => Object.fromEntries([...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(([, key, value]) => [key, value]))
const light = tokens(lightBlock)
const dark = tokens(darkBlock)
const baseDarkTokens = [
  "background", "foreground", "card", "card-foreground", "popover", "popover-foreground",
  "primary", "primary-foreground", "user-message", "user-message-foreground",
  "secondary", "secondary-foreground", "muted", "muted-foreground", "accent", "accent-foreground",
  "border", "input", "ring", "sidebar", "sidebar-foreground", "sidebar-primary",
  "sidebar-primary-foreground", "sidebar-accent", "sidebar-accent-foreground", "sidebar-border", "sidebar-ring",
]
function resolve(key: string): string {
  const value = dark[key]
  const alias = value.match(/^var\(--([\w-]+)\)$/)
  return alias ? resolve(alias[1]) : value
}
function rgb(value: string) {
  assert.match(value, /^#[\da-f]{6}$/i)
  return [1, 3, 5].map((start) => parseInt(value.slice(start, start + 2), 16))
}
function luminance(channels: number[]) {
  const [r, g, b] = channels.map((c) => c / 255).map((c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
function contrast(a: number[], b: number[]) {
  const x = luminance(a), y = luminance(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

test("existing light-mode palette is unchanged, including status colors", () => {
  const expected = JSON.parse(readFileSync(new URL("fixtures/light-theme-tokens.json", import.meta.url), "utf8")) as Record<string, string>
  for (const [key, value] of Object.entries(expected)) assert.equal(light[key], value, key)
  assert.equal(light["user-message"], "var(--primary)")
  assert.equal(light["user-message-foreground"], "var(--primary-foreground)")
})

test("every dark base token is neutral and the surface levels match DESIGN.md", () => {
  for (const key of baseDarkTokens) {
    const [r, g, b] = rgb(resolve(key))
    assert.equal(r, g, `${key} must be neutral`)
    assert.equal(g, b, `${key} must be neutral`)
    assert.ok(design.toLowerCase().includes(resolve(key)), `${key} is documented`)
  }
  assert.deepEqual(["background", "sidebar", "card", "popover", "muted", "accent"].map(resolve), ["#121212", "#161616", "#1c1c1c", "#242424", "#262626", "#303030"])
  assert.equal(dark["thread-active"], "#fcd34d")
  assert.equal(dark["thread-success"], "#6ee7b7")
  assert.equal(dark["thread-failure"], "#fca5a5")
  assert.equal(dark.destructive, "oklch(0.704 0.191 22.216)")
})

test("dark text, actions, status labels and translucent focus rings retain contrast", () => {
  for (const surface of ["background", "sidebar", "card", "popover", "muted", "accent"]) {
    const bg = rgb(resolve(surface))
    for (const foreground of ["foreground", "muted-foreground", "thread-active", "thread-success", "thread-failure"]) {
      assert.ok(contrast(rgb(resolve(foreground)), bg) >= 4.5, `${foreground} on ${surface}`)
    }
    const ring = rgb(resolve("ring")).map((channel, i) => (channel + bg[i]) / 2)
    assert.ok(contrast(ring, bg) >= 3, `50% focus ring on ${surface}`)
  }
  assert.ok(contrast(rgb(resolve("primary-foreground")), rgb(resolve("primary"))) >= 4.5)
  assert.ok(contrast(rgb(resolve("user-message-foreground")), rgb(resolve("user-message"))) >= 4.5)
})

test("message surfaces are separated from primary actions and Markdown is neutral only in dark mode", () => {
  assert.equal(resolve("user-message"), "#262626")
  assert.notEqual(resolve("user-message"), resolve("primary"))
  assert.match(css, /--color-user-message: var\(--user-message\)/)
  assert.match(source, /bg-user-message[^"\n]+text-user-message-foreground/)
  assert.match(source, /border-primary\/20 bg-primary\/5[^"\n]+dark:border-border dark:bg-card/)
  assert.equal(source.match(/dark:prose-neutral dark:prose-invert/g)?.length, 2)
  assert.doesNotMatch(source, /\sprose-neutral\s/)
  assert.match(lightBlock, /color-scheme: light;/)
  assert.match(darkBlock, /color-scheme: dark;/)
})
