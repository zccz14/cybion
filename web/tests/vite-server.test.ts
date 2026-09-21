import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import test from "node:test"

test("unit test Vite servers keep their dependency cache out of the dev server cache", () => {
  const directory = new URL(".", import.meta.url)
  const offenders = readdirSync(directory)
    .filter((name) => name.endsWith(".test.ts") && name !== "vite-server.test.ts")
    .filter((name) => readFileSync(new URL(name, directory), "utf8").includes("createServer("))
  assert.deepEqual(offenders, [], "Unit tests must create Vite servers with createTestServer from ./vite-server.ts")
})
