import { test, expect } from '@playwright/test';
import { ChatPage } from '../pages/ChatPage.js';

/**
 * Browser simulation tests using TestModeRuntime.
 *
 * These tests run against a server started with DORKOS_TEST_RUNTIME=true.
 * No real Claude API calls are made — responses are controlled via
 * POST /api/test/scenario before each test.
 *
 * Scenario name constants match TestScenario from @dorkos/test-utils:
 *   'simple-text'  → session_status → text_delta("Echo: {content}") → done
 *   'tool-call'    → session_status → tool_call_start(Bash) → … → done
 *   'todo-write'   → session_status → task_update(3 tasks) → done
 *   'error'        → session_status → error → done
 */

// eslint-disable-next-line no-restricted-syntax -- E2E test config; no env.ts available
const MOCK_PORT = process.env.DORKOS_MOCK_PORT || '4243';
const API_URL = `http://localhost:${MOCK_PORT}`;

// The mock server is SHARED mutable state: POST /api/test/reset wipes the
// default scenario, tracked sessions, AND projectors globally. Under the
// project-wide fullyParallel setting these tests would race each other's
// beforeEach reset (observed: a tool-call test receiving the simple-text echo),
// so this file opts back into sequential same-worker execution.
test.describe.configure({ mode: 'default' });

// Seeded by POST /api/test/seed-agent in beforeEach.
let agentDir: string;

test.beforeEach(async ({ request }) => {
  // Reset to default scenario (simple-text) before each test
  await request.post(`${API_URL}/api/test/reset`);
  // Dismiss onboarding so the main app shell renders immediately.
  // Fresh DORK_HOME has no completed steps, which would show the onboarding wizard.
  await request.patch(`${API_URL}/api/config`, {
    data: { onboarding: { dismissedAt: new Date().toISOString() } },
  });
  // Seed a test agent so the chat UI has an agent to select and enables the send button.
  // The agent is created at ~/tmp/dorkos-e2e-agent, within the default home-directory boundary.
  const seedRes = await request.post(`${API_URL}/api/test/seed-agent`);
  ({ agentDir } = (await seedRes.json()) as { agentDir: string });
});

test.describe('TestModeRuntime — mock browser tests', () => {
  test('renders streamed text response from simple-text scenario', async ({ page, request }) => {
    await request.post(`${API_URL}/api/test/scenario`, {
      data: { name: 'simple-text' },
    });

    const chatPage = new ChatPage(page);
    await chatPage.goto(undefined, { dir: agentDir });
    await chatPage.sendMessage('Hello');

    // simple-text scenario echoes: "Echo: Hello"
    await expect(page.getByText(/Echo:/)).toBeVisible({ timeout: 10_000 });
  });

  test('renders tool call card for tool-call scenario', async ({ page, request }) => {
    await request.post(`${API_URL}/api/test/scenario`, {
      data: { name: 'tool-call' },
    });

    const chatPage = new ChatPage(page);
    await chatPage.goto(undefined, { dir: agentDir });
    await chatPage.sendMessage('Run bash');

    // tool-call scenario emits a Bash tool call
    await expect(chatPage.toolCallCards.first()).toBeVisible({ timeout: 10_000 });
  });

  test('scenario endpoint rejects unknown scenario names', async ({ request }) => {
    const res = await request.post(`${API_URL}/api/test/scenario`, {
      data: { name: 'nonexistent-scenario' },
    });
    expect(res.status()).toBe(400);
  });

  test('a session id reused across POST /api/test/reset gets a fresh session, not resurrected history', async ({
    request,
  }) => {
    // Pins the FULL-reset contract over the real HTTP stack: the test-mode
    // runtime's only persistence is the per-session projector (EventLog), so a
    // reset that cleared tracked metadata but left projectors alive would
    // resurrect pre-reset history the moment the same id is used again
    // (review finding, acceptance run 20260611-145454).
    const sessionId = crypto.randomUUID();
    const messagesUrl = `${API_URL}/api/sessions/${sessionId}/messages`;
    const historyUrl = `${messagesUrl}?cwd=${encodeURIComponent(agentDir)}`;

    const turnHistory = async () => {
      const res = await request.get(historyUrl);
      if (!res.ok()) return [];
      const { messages } = (await res.json()) as { messages: { content: string }[] };
      return messages;
    };

    // Turn 1 under the id (202 = trigger accepted; turn runs detached).
    const post1 = await request.post(messagesUrl, {
      data: { content: 'before reset', cwd: agentDir },
    });
    expect(post1.status()).toBe(202);
    await expect
      .poll(async () => (await turnHistory()).length, { timeout: 10_000 })
      .toBeGreaterThanOrEqual(2);
    expect((await turnHistory()).map((m) => m.content)).toContain('Echo: before reset');

    // Reset, then the SAME id must read as a fresh session — no resurrected log.
    const reset = await request.post(`${API_URL}/api/test/reset`);
    expect(reset.status()).toBe(200);
    // Assert the response itself here (not via turnHistory, whose non-OK → []
    // fallback would let a 404/500 masquerade as "fresh session reads empty").
    const postReset = await request.get(historyUrl);
    expect(postReset.ok()).toBe(true);
    expect(((await postReset.json()) as { messages: unknown[] }).messages).toEqual([]);

    // And a new turn under the reused id contains ONLY post-reset content.
    const post2 = await request.post(messagesUrl, {
      data: { content: 'after reset', cwd: agentDir },
    });
    expect(post2.status()).toBe(202);
    await expect
      .poll(async () => (await turnHistory()).length, { timeout: 10_000 })
      .toBeGreaterThanOrEqual(2);
    const contents = (await turnHistory()).map((m) => m.content);
    expect(contents).toContain('Echo: after reset');
    expect(contents.join('\n')).not.toContain('before reset');
  });
});
