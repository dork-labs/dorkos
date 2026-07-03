import { test, expect } from '@playwright/test';
import { BasePage } from '../pages/BasePage.js';
import { ChatPage } from '../pages/ChatPage.js';

/**
 * Browser simulation tests using TestModeRuntime.
 *
 * These tests run against a server started with DORKOS_TEST_RUNTIME=true.
 * No real Claude API calls are made — responses are controlled via
 * POST /api/test/scenario before each test. The server also sets
 * DORKOS_TEST_RUNTIME_SECONDARY=true, registering a SECOND TestModeRuntime
 * instance under the 'test-mode-b' type — so multi-runtime UI (the status-bar
 * runtime picker, `?runtime=` launch binding, session-list runtime marks) is
 * exercisable with zero real agent binaries.
 *
 * Scenario name constants match TestScenario from @dorkos/test-utils:
 *   'simple-text'  → session_status → text_delta("Echo: {content}") → done
 *   'tool-call'    → session_status → tool_call_start(Bash) → … → done
 *   'todo-write'   → session_status → task_update(3 tasks) → done
 *   'error'        → session_status → session_status{terminalReason:'error'}
 *                    → error → done (the turn closes in error — drives the
 *                    turn-failed notice)
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

// Runtime UX across the chat surface (spec additional-agent-runtimes, task
// 4.3). The mock server registers TWO runtimes ('test-mode' + 'test-mode-b',
// via DORKOS_TEST_RUNTIME_SECONDARY=true in playwright.config.ts), which makes
// the status-bar picker selectable pre-launch. Selectors prefer roles,
// aria-labels, and test-ids; the descriptor labels asserted here come from the
// client's runtime-descriptor registry ('Test Mode' for test-mode; unknown
// types like test-mode-b fall back to the raw type string).
test.describe('Runtime UX — multi-runtime test server', () => {
  test('picker renders both runtimes pre-launch, applies a selection, and opens runtime setup', async ({
    page,
  }) => {
    const chatPage = new ChatPage(page);
    await chatPage.goto(undefined, { dir: agentDir });

    const statusLine = page.getByTestId('status-line');
    // Pre-launch with >1 registered runtime the chip is a dropdown trigger
    // showing the server default.
    await statusLine.getByRole('button', { name: 'Test Mode' }).click();

    // Both registered runtimes are selectable radio entries.
    await expect(page.getByRole('menuitemradio', { name: 'Test Mode' })).toBeVisible();
    const secondary = page.getByRole('menuitemradio', { name: 'test-mode-b' });
    await expect(secondary).toBeVisible();

    // Selecting one applies it: the chip re-labels and the choice is written
    // to the URL, where the first send reads it as the runtime hint.
    await secondary.click();
    await expect(statusLine.getByRole('button', { name: 'test-mode-b' })).toBeVisible();
    await expect(page).toHaveURL(/runtime=test-mode-b/);

    // Known-but-unregistered runtimes (OpenCode, Codex) surface through the
    // picker's "Add a runtime" entry, which opens the setup panel with a
    // needs-setup section and copyable install command per runtime.
    await statusLine.getByRole('button', { name: 'test-mode-b' }).click();
    await page.getByRole('menuitem', { name: /add a runtime/i }).click();
    await expect(page.getByTestId('runtime-setup-panel')).toBeVisible();
    await expect(page.getByTestId('runtime-section-opencode')).toBeVisible();
    await expect(page.getByTestId('runtime-section-codex')).toBeVisible();
    await expect(page.getByRole('button', { name: /copy install command/i }).first()).toBeVisible();
  });

  test('?runtime= launch binds the session to that runtime; chip is read-only after start', async ({
    page,
    request,
  }) => {
    const chatPage = new ChatPage(page);
    await chatPage.goto(undefined, { dir: agentDir, runtime: 'test-mode-b' });

    // The launch param survives the loader's session-mint redirect.
    await expect(page).toHaveURL(/session=/);
    await expect(page).toHaveURL(/runtime=test-mode-b/);

    const statusLine = page.getByTestId('status-line');
    // Pre-launch the pending selection drives the chip (still a dropdown).
    await expect(statusLine.getByRole('button', { name: 'test-mode-b' })).toBeVisible();

    await chatPage.sendMessage('Hello');
    await expect(page.getByText('Echo: Hello')).toBeVisible({ timeout: 10_000 });

    // The first send carried the hint — the session is bound server-side.
    const sessionId = await chatPage.getSessionId();
    expect(sessionId).toBeTruthy();
    const res = await request.get(`${API_URL}/api/sessions/${sessionId}/runtime-type`);
    expect(res.ok()).toBe(true);
    expect(await res.json()).toEqual({ runtime: 'test-mode-b' });

    // And the chip is now a read-only identity mark (no dropdown affordance):
    // runtime is immutable for a session's lifetime.
    await expect(statusLine.getByText('test-mode-b')).toBeVisible();
    await expect(statusLine.getByRole('button', { name: 'test-mode-b' })).toHaveCount(0);
  });

  test('session-list rows carry runtime marks naming their owning runtime', async ({ page }) => {
    // Session on the default runtime.
    const chatPage = new ChatPage(page);
    await chatPage.goto(undefined, { dir: agentDir });
    await chatPage.sendMessage('Default runtime session');
    await expect(page.getByText('Echo: Default runtime session')).toBeVisible({
      timeout: 10_000,
    });

    // Second session on the secondary runtime. The id is minted explicitly —
    // without it the loader auto-selects the existing session instead of
    // creating a new one.
    await chatPage.goto(crypto.randomUUID(), { dir: agentDir, runtime: 'test-mode-b' });
    await chatPage.sendMessage('Secondary runtime session');
    await expect(page.getByText('Echo: Secondary runtime session')).toBeVisible({
      timeout: 10_000,
    });

    await new BasePage(page).ensureSidebarOpen();
    const rows = page.getByTestId('session-row');
    await expect(
      rows.filter({ has: page.locator('[aria-label="Runtime: Test Mode"]') })
    ).toHaveCount(1);
    await expect(
      rows.filter({ has: page.locator('[aria-label="Runtime: test-mode-b"]') })
    ).toHaveCount(1);
  });

  test('a turn that ends in error shows the turn-failed notice with a working Retry', async ({
    page,
    request,
  }) => {
    await request.post(`${API_URL}/api/test/scenario`, { data: { name: 'error' } });

    const chatPage = new ChatPage(page);
    await chatPage.goto(undefined, { dir: agentDir });
    await chatPage.sendMessage('please fail');

    // turn_end{terminalReason:'error'} settles the session into the error
    // lifecycle; with no inline error affordance (test-mode history carries no
    // error entry) the panel-level notice is the retry surface.
    const notice = page.getByTestId('turn-failed-notice');
    await expect(notice).toBeVisible({ timeout: 10_000 });
    const retry = notice.getByRole('button', { name: /retry/i });
    await expect(retry).toBeVisible();

    // Retry re-sends the last user message; with the scenario healed the
    // replayed turn succeeds.
    await request.post(`${API_URL}/api/test/scenario`, { data: { name: 'simple-text' } });
    await retry.click();
    await expect(page.getByText('Echo: please fail')).toBeVisible({ timeout: 10_000 });
  });
});
