import { test } from '@playwright/test';

/**
 * The shared setup of the `chromium-mock` spec files (`chat-mock*.spec.ts`).
 *
 * Those files run against one test-mode server started with
 * DORKOS_TEST_RUNTIME=true, which is SHARED mutable state: POST /api/test/reset
 * wipes the default scenario, tracked sessions, AND projectors globally. Two
 * things keep its tests from racing each other's resets:
 *
 * - inside a file, {@link useMockServer} opts the file into sequential
 *   same-worker execution;
 * - across files, the `chromium-mock` project runs one worker
 *   (`playwright.config.ts`), so one file finishes before the next starts.
 *
 * The suite is several files rather than one so the browser shards can share
 * it out: as one file it was a single ~9-minute unit the balancer could never
 * split (`reporters/balanced-shard.ts`).
 */

// eslint-disable-next-line no-restricted-syntax -- E2E test config; no env.ts available
const MOCK_PORT = process.env.DORKOS_MOCK_PORT || '4243';

/** The test-mode server's base URL. */
export const MOCK_API_URL = `http://localhost:${MOCK_PORT}`;

/**
 * Registers the reset-and-seed hooks every `chromium-mock` spec file needs and
 * returns the seeded agent's directory, read at test time.
 *
 * Call it once, at the top level of the spec file.
 */
export function useMockServer(): () => string {
  test.describe.configure({ mode: 'default' });

  // Seeded by POST /api/test/seed-agent in beforeEach.
  let agentDir = '';

  // And after each: the reset below only protects THIS file's tests, and the
  // scenario a test selected would otherwise still be the default for whatever
  // runs next on this shared server.
  test.afterEach(async ({ request }) => {
    await request.post(`${MOCK_API_URL}/api/test/reset`);
  });

  test.beforeEach(async ({ request }) => {
    // Reset to default scenario (simple-text) before each test
    await request.post(`${MOCK_API_URL}/api/test/reset`);
    // Dismiss onboarding so the main app shell renders immediately.
    // Fresh DORK_HOME has no completed steps, which would show the onboarding wizard.
    await request.patch(`${MOCK_API_URL}/api/config`, {
      data: { onboarding: { dismissedAt: new Date().toISOString() } },
    });
    // Seed a test agent so the chat UI has an agent to select and enables the send button.
    // The agent is created at <boundary>/tmp/dorkos-e2e-agent — the server derives it from the
    // resolved directory boundary, so it is in-bounds whatever DORKOS_BOUNDARY is set to.
    const seedRes = await request.post(`${MOCK_API_URL}/api/test/seed-agent`);
    // The seed route refuses when the runtime its manifest declares is registered
    // here — that would bind every seeded session to it instead of the server
    // default (DOR-991). Read the refusal out loud; without this the suite fails
    // later with an undefined agentDir and no hint why.
    if (!seedRes.ok()) {
      throw new Error(`seed-agent failed (${seedRes.status()}): ${await seedRes.text()}`);
    }
    ({ agentDir } = (await seedRes.json()) as { agentDir: string });
  });

  return () => agentDir;
}
