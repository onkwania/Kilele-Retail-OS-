import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  // A browser suite on shared CI runners is timing-sensitive, and one flake must not fail a build
  // that the same commit just passed elsewhere. A real regression still fails on the retry, and
  // the trace/screenshot artifacts are kept for both attempts. Locally this stays at zero so a
  // flake is visible immediately while it is being diagnosed.
  retries: process.env.CI ? 1 : 0,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 1050 },
    launchOptions: { args: ['--no-sandbox'] },
  },
  webServer: {
    command: 'npx tsx e2e/server.ts',
    url: 'http://127.0.0.1:4173/api/health',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
