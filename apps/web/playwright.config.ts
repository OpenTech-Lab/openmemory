import { defineConfig, devices } from '@playwright/test';

/**
 * Drives the already-running stack rather than starting its own server.
 *
 * The app is served from a container (docker compose `web`), so there is no
 * `webServer` block here: Playwright cannot rebuild that image, and starting a
 * second dev server on another port would test different code than the one the
 * developer is looking at.
 */
export default defineConfig({
  testDir: './e2e',
  // These tests mutate shared server state (they create QA runs), so they run
  // one at a time. Parallel workers would race on the counts they assert.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [
    ['junit', { outputFile: process.env.PLAYWRIGHT_JUNIT_OUTPUT_NAME || '.junit-e2e.xml' }],
    ['list'],
  ],
  use: {
    baseURL: process.env.OPENMEMORY_WEB_URL || 'http://127.0.0.1:13000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
