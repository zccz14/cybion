import { readFileSync } from "node:fs"

/**
 * The thread view lives in the embeddable package, so its source is the one
 * implementation these tests guard; `path` is relative to the package's `src`.
 */
export function readPackageSource(path: string): string {
  return readFileSync(new URL(`../../packages/cybion-components/src/${path}`, import.meta.url), "utf8")
}
