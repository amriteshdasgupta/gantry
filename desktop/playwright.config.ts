import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

// End-to-end tests run fully offline: gh and claude are stand-ins from e2e/bin,
// and the repo under review is a local fixture built by e2e/setup.mjs.
const PORT = Number(process.env.GANTRY_E2E_PORT ?? 3457);
const runtimeUrl = `http://127.0.0.1:${process.env.GANTRY_E2E_RUNTIME_PORT ?? 3458}`;
const bin = path.resolve(__dirname, "e2e/bin");
const home = path.resolve(__dirname, "e2e/.tmp/home");

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
  },
  webServer: [{
    command: 'node e2e/gantry-server.mjs',
    url: `${runtimeUrl}/api/version`,
    reuseExistingServer: false,
  }, {
    // E2E_BUNDLE=1 tests the server the Mac app ships (run `npm run app:bundle` first).
    command: process.env.E2E_BUNDLE || process.env.E2E_APP
      ? `node e2e/setup.mjs && node .next/standalone/server.js`
      : `node e2e/setup.mjs && next dev -p ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      PR_LENS_CODEX: 'codex',
      PR_LENS_CLAUDE: 'claude',
      PR_LENS_OPENCODE: 'opencode',
      PR_LENS_HOME: home,
      // Chats open in the e2e herdr stand-in, never the real herdr or Ghostty on this machine.
      PR_LENS_HERDR: path.join(bin, "herdr"),
      PR_LENS_GHOSTTY: path.join(home, "no-ghostty"),
      CLAUDE_CONFIG_DIR: path.resolve(__dirname, "e2e/.tmp/claude-config"),
      PR_LENS_GANTRY_URL: runtimeUrl,
      PORT: String(PORT),
      HOSTNAME: "127.0.0.1",
    },
  }],
});
