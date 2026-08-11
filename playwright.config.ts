import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:8791",
    serviceWorkers: "block",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm start",
    url: "http://127.0.0.1:8791/api/health",
    timeout: 60_000,
    reuseExistingServer: false,
    env: {
      DATA_DIR: "./.run-data",
      PORT: "8791",
      PUBLIC_BASE_URL: "http://127.0.0.1:8791",
      AI_PROVIDER: "none",
      ADMIN_TOKEN: "run-test-token",
    },
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
});
