import { defineConfig, devices } from '@playwright/test';

/**
 * The one-minute first run, proven against a never-onboarded server (spec
 * `one-minute-onboarding` §8).
 *
 * Its own config, not a project of `playwright.config.ts`, for two reasons the
 * shared legs cannot meet:
 *
 * - **A fresh home.** The shared legs' `global-setup.ts` puts the first run
 *   away before any spec runs, because a never-onboarded home draws the wizard
 *   instead of the app. This spec needs exactly that wizard.
 * - **Its own flags.** `DORKOS_TEST_RUNTIME_DOE` adds the DorkOS runtime, and
 *   the DorkOS path links the server to the test-mode Cloud. Both change what
 *   every other spec on a shared leg would see.
 *
 * Nothing leaves the machine: the Cloud, its credits token and the model
 * behind it are the in-process fakes `DORKOS_TEST_RUNTIME` composes, so no
 * money path is involved. Run it with `pnpm --filter @dorkos/e2e e2e:first-run`.
 */
function port(name: string, fallback: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be digits only, got: ${JSON.stringify(value)}`);
  }
  return value;
}

const API_PORT = port('DORKOS_FIRST_RUN_PORT', '4251');
const VITE_PORT = port('DORKOS_FIRST_RUN_VITE_PORT', '4252');
const DORK_HOME = `/tmp/dorkos-first-run-${API_PORT}`;

/**
 * Boot the API unwatched, from an empty `0700` home — the same shape as the
 * shared legs' `apiLegCommand` (see its note on why no e2e leg may watch).
 */
const apiCommand = [
  `DORKOS_TEST_RUNTIME=true`,
  `DORKOS_TEST_RUNTIME_DOE=true`,
  // DorkBot answers on a claude-code-typed TestModeRuntime, so the "AI app you
  // sign in to" path has an app that is signed in and a reply that is free.
  `DORKOS_TEST_RUNTIME_CLAUDE_ALIAS=true`,
  `DORKOS_PORT=${API_PORT}`,
  `VITE_PORT=${VITE_PORT}`,
  `DORK_HOME=${DORK_HOME}`,
  `DORKOS_SEARCH_NO_EXTERNAL_HISTORY=true`,
  `dotenv -- sh -c 'rm -rf ${DORK_HOME} && mkdir -m 700 -p ${DORK_HOME} && turbo run build --filter=@dorkos/server --output-logs=new-only && pnpm --filter @dorkos/server exec tsx src/index.ts'`,
].join(' ');

export default defineConfig({
  testDir: './tests/onboarding',
  testMatch: 'first-run.spec.ts',
  reporter: [['list']],
  workers: 1,
  retries: 0,
  timeout: 120_000,
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://localhost:${VITE_PORT}`,
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: apiCommand,
      url: `http://localhost:${API_PORT}/api/health`,
      name: 'Express API (first run)',
      timeout: 240_000,
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: `DORKOS_PORT=${API_PORT} VITE_PORT=${VITE_PORT} DORKOS_E2E_NO_HMR=true dotenv -- turbo dev --filter=@dorkos/client --output-logs=new-only`,
      url: `http://localhost:${VITE_PORT}`,
      name: 'Vite Client (first run)',
      timeout: 120_000,
      reuseExistingServer: false,
      stdout: 'pipe',
    },
  ],
});
