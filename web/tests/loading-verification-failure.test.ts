import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const main = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8")

test("the loading screen forwards the provider's verification failure", () => {
  assert.match(main, /const \{ isReady, isAuthenticated, sdk, session, signOut, verificationFailure \} = useAuthMini\(\)/)
  assert.equal(main.match(/<LoadingScreen verificationFailure=\{verificationFailure\} \/>/g)?.length, 1)
})

test("audience-stale sessions sign out immediately so login re-mints them", () => {
  assert.match(main, /const AUDIENCE_RELOGIN_KEY = "cybion\.audience-relogin"/)
  assert.match(main, /missingAudiences\(accessToken, AUTH_AUDIENCES\)\.length === 0/)
  assert.match(main, /window\.sessionStorage\.getItem\(AUDIENCE_RELOGIN_KEY\)/)
  assert.match(main, /window\.sessionStorage\.setItem\(AUDIENCE_RELOGIN_KEY, "1"\)/)
  assert.match(main, /void signOut\(\)/)
})

test("the verification failure card shows the reason, diagnostics and a copy action", () => {
  const card = main.slice(main.indexOf("function SessionVerificationFailureCard"), main.indexOf("type WorkspaceNavItem ="))
  for (const fragment of [
    "{failure.reason}",
    "failure.code",
    "failure.clockOffsetMs",
    "failure.localTime",
    "failure.adjustedTime",
    "failure.failedAt",
    "navigator.userAgent",
    "navigator.clipboard.writeText",
    "void clearLocalAppData()",
    "localStorage.clear()",
    "sessionStorage.clear()",
    "caches.keys()",
    "navigator.serviceWorker.getRegistrations()",
    "window.location.reload()",
    "browserSupportsEd25519()",
    "importKey",
    "{browserUnsupported && <Alert>",
    "labels.loadingFailureUpgradeBrowser",
  ]) assert.ok(card.includes(fragment), fragment)
})

test("both language maps define every loading failure copy key", () => {
  for (const key of [
    "loadingFailureTitle",
    "loadingFailureCode",
    "loadingFailureClockOffset",
    "loadingFailureDeviceTime",
    "loadingFailureAdjustedTime",
    "loadingFailureFailedAt",
    "loadingFailureBrowser",
    "loadingFailureCopy",
    "loadingFailureClearData",
    "loadingFailureUpgradeBrowser",
  ]) assert.equal(main.match(new RegExp(`${key}:`, "g"))?.length, 2, key)
})
