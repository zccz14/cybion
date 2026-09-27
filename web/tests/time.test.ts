import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import test from "node:test"
import { formatStatsDuration, formattedTime } from "../src/lib/time.ts"

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

test("stats durations collapse to the largest useful unit in both languages", () => {
  for (const [seconds, en, zh] of [
    [0, "0s", "0 秒"],
    [2.34, "2.3s", "2.3 秒"],
    [14.46, "14s", "14 秒"],
    [60, "1m", "1 分钟"],
    [90, "1m 30s", "1 分钟 30 秒"],
    [3600, "1h", "1 小时"],
    [3900, "1h 5m", "1 小时 5 分钟"],
    [3 * 86400, "3d", "3 天"],
    [3 * 86400 + 10 * 3600, "3d 10h", "3 天 10 小时"],
    [296212, "3d 10h", "3 天 10 小时"],
    [-5, "0s", "0 秒"],
  ] as const) {
    assert.equal(formatStatsDuration(seconds, "en"), en)
    assert.equal(formatStatsDuration(seconds, "zh"), zh)
  }
})
