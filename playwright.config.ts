import { defineConfig } from "@playwright/test";

// e2e against the static export (the public sandbox). Real Chrome with SwiftShader so WebGL renders headless.
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 120_000,
  expect: { timeout: 20_000, toHaveScreenshot: { maxDiffPixelRatio: 0.03 } },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:8449",
    channel: "chrome",
    viewport: { width: 1400, height: 860 },
    launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] },
  },
  webServer: { command: "node scripts/serve.ts", url: "http://127.0.0.1:8449/", reuseExistingServer: true },
  snapshotPathTemplate: "tests/e2e/__screenshots__/{arg}{ext}",
});
