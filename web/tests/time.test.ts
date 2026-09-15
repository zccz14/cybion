import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import test from "node:test"
import { formattedTime } from "../src/lib/time.ts"

for (const language of ["en", "zh"] as const) {
  test(`${language} timestamps always display two-digit seconds, including whole minutes`, () => {
    for (const second of [0, 1, 9, 48, 59]) {
      const timestamp = Date.UTC(2026, 8, 15, 12, 34, second) / 1000
      const formatted = formattedTime(language, timestamp)
      assert.match(formatted, new RegExp(`\\d{1,2}:\\d{2}:${String(second).padStart(2, "0")}(?!\\d)`))
      assert.match(formatted, /2026/)
      assert.notEqual(formatted, formattedTime(language, timestamp + 1))
    }
  })

  test(`${language} timestamps distinguish missing values from the Unix epoch`, () => {
    assert.equal(formattedTime(language, null), "—")
    assert.equal(formattedTime(language, undefined), "—")
    assert.match(formattedTime(language, 0), /\d{1,2}:\d{2}:00/)
  })
}

for (const [timeZone, en, zh] of [
  ["UTC", "Jan 1, 2026, 1:04:05 AM", "2026年1月1日 01:04:05"],
  ["America/New_York", "Dec 31, 2025, 8:04:05 PM", "2025年12月31日 20:04:05"],
  ["Asia/Shanghai", "Jan 1, 2026, 9:04:05 AM", "2026年1月1日 09:04:05"],
]) {
  test(`timestamps retain the local date, time zone and language in ${timeZone}`, () => {
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
      import { formattedTime } from ${JSON.stringify(new URL("../src/lib/time.ts", import.meta.url).href)}
      const timestamp = Date.UTC(2026, 0, 1, 1, 4, 5) / 1000
      console.log(JSON.stringify([formattedTime("en", timestamp), formattedTime("zh", timestamp)]))
    `], { env: { ...process.env, TZ: timeZone }, encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), [en, zh])
  })
}
