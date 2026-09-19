import { defineConfig } from "@playwright/test"
export default defineConfig({
  testDir: "e2e", timeout: 30000, use: { baseURL: "http://127.0.0.1:4178", screenshot: "only-on-failure", trace: "retain-on-failure" },
  webServer: { command: "npm run dev -- --host 127.0.0.1 --port 4178 --strictPort", url: "http://127.0.0.1:4178/e2e/fixture.html", reuseExistingServer: !process.env.CI },
})
