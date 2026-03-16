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
  ({ agentDir } = await seedRes.json() as { agentDir: string });
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
});
