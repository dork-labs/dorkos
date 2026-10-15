import { defineConfig, devices } from '@playwright/test';

/**
 * The one-minute first run, proven against never-onboarded servers (spec
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
 * Each path gets its own server and home, so neither starts from what the
 * other left behind: a first run happens once per install.
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

/** One never-onboarded install: an API, the app in front of it, and a home. */
interface Leg {
  project: string;
  grep: RegExp;
  apiPort: string;
  vitePort: string;
}

const BASE = Number(port('DORKOS_FIRST_RUN_PORT', '4251'));
const LEGS: Leg[] = [
  {
    project: 'dorkos-path',
    grep: /Continue with DorkOS/,
    apiPort: `${BASE}`,
    vitePort: `${BASE + 1}`,
  },
  {
    project: 'own-ai-path',
    grep: /Use my own AI/,
    apiPort: `${BASE + 2}`,
    vitePort: `${BASE + 3}`,
  },
];

/**
 * Boot one API unwatched, from an empty `0700` home — the same shape as the
 * shared legs' `apiLegCommand` (see its note on why no e2e leg may watch).
 */
function apiCommand(leg: Leg): string {
  const home = `/tmp/dorkos-first-run-${leg.apiPort}`;
  return [
    `DORKOS_TEST_RUNTIME=true`,
    `DORKOS_TEST_RUNTIME_DOE=true`,
    // DorkBot answers on a claude-code-typed TestModeRuntime, so the "AI app
    // you sign in to" path has an app that is signed in and a reply that is free.
    `DORKOS_TEST_RUNTIME_CLAUDE_ALIAS=true`,
    `DORKOS_PORT=${leg.apiPort}`,
    `VITE_PORT=${leg.vitePort}`,
    `DORK_HOME=${home}`,
    `DORKOS_SEARCH_NO_EXTERNAL_HISTORY=true`,
    `dotenv -- sh -c 'rm -rf ${home} && mkdir -m 700 -p ${home} && turbo run build --filter=@dorkos/server --output-logs=new-only && pnpm --filter @dorkos/server exec tsx src/index.ts'`,
  ].join(' ');
}

export default defineConfig({
  testDir: './first-run',
  // Not `*.spec.ts` on purpose: the main suite's executed-tests gate
  // (scripts/assert-browser-tests-executed.sh) counts every `*.spec.ts` as a
  // main-suite file, and this one runs only here: by `pnpm e2e:first-run`, and
  // in CI by browser-test.yml's `first-run` job in the merge queue (DOR-2844).
  testMatch: 'first-run.journey.ts',
  reporter: [['list']],
  workers: 1,
  retries: 0,
  timeout: 120_000,
  use: { ...devices['Desktop Chrome'], trace: 'retain-on-failure' },
  projects: LEGS.map((leg) => ({
    name: leg.project,
    grep: leg.grep,
    use: { baseURL: `http://localhost:${leg.vitePort}` },
  })),
  webServer: LEGS.flatMap((leg) => [
    {
      command: apiCommand(leg),
      url: `http://localhost:${leg.apiPort}/api/health`,
      name: `API (${leg.project})`,
      timeout: 240_000,
      reuseExistingServer: false,
      stdout: 'pipe' as const,
      stderr: 'pipe' as const,
    },
    {
      // Vite itself rather than `turbo dev`: turbo's child outlives
      // Playwright's stop and holds the port for the next run.
      command: `DORKOS_PORT=${leg.apiPort} VITE_PORT=${leg.vitePort} DORKOS_E2E_NO_HMR=true dotenv -- pnpm --filter @dorkos/client exec vite --port ${leg.vitePort} --strictPort`,
      url: `http://localhost:${leg.vitePort}`,
      name: `Vite Client (${leg.project})`,
      timeout: 120_000,
      reuseExistingServer: false,
      stdout: 'pipe' as const,
    },
  ]),
});
