import { test, expect, request as apiRequest } from '@playwright/test';
import type { Page } from '@playwright/test';
import fs from 'fs/promises';
import path from 'path';
import { BasePage } from '../pages/BasePage.js';
import { ChatPage } from '../pages/ChatPage.js';
import { caretOffset, composerText, expectComposerText } from '../pages/composer-probe.js';
import { registerSessionReadStateTests } from './chat/session-read-state.js';
import { registerNowSurvivesReloadTests } from './dashboard-sidebar/now-survives-reload.js';
import { registerSendLandsInTodayTests } from './dashboard-sidebar/send-lands-in-today.js';

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
  // The agent is created at <boundary>/tmp/dorkos-e2e-agent — the server derives it from the
  // resolved directory boundary, so it is in-bounds whatever DORKOS_BOUNDARY is set to.
  const seedRes = await request.post(`${API_URL}/api/test/seed-agent`);
  // The seed route refuses when the runtime its manifest declares is registered
  // here — that would bind every seeded session to it instead of the server
  // default (DOR-991). Read the refusal out loud; without this the suite fails
  // later with an undefined agentDir and no hint why.
  if (!seedRes.ok()) {
    throw new Error(`seed-agent failed (${seedRes.status()}): ${await seedRes.text()}`);
  }
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

    // simple-text scenario echoes: "Echo: Hello". Scoped to the transcript
    // because the words are in the DOM twice while the turn is live — the
    // message, and the screen-reader announcer mirroring it (see GOTCHAS).
    await expect(page.getByTestId('transcript-feed').getByText(/Echo:/)).toBeVisible({
      timeout: 10_000,
    });
  });

  test('renders tool call card for tool-call scenario', async ({ page, request }) => {
    await request.post(`${API_URL}/api/test/scenario`, {
      data: { name: 'tool-call' },
    });

    // Turn off auto-hide, which is a stored preference and defaults to ON.
    //
    // A tool call that is ALREADY complete on the frame its part first mounts is
    // never rendered at all — not hidden with CSS, simply not in the DOM. The
    // built-in scenarios are documented as zero-latency and yield the whole turn
    // in one synchronous pass, and at `turn_end` the live bubble is replaced by
    // the rebuilt history message, which remounts the part as complete. So this
    // card was only ever visible for as long as the assertion could outrun the
    // turn, and it lost that race for good once the API leg stopped restarting
    // under `tsx watch`.
    //
    // Set here rather than in `ChatPage` so every other spec keeps the shipped
    // default. What auto-hide does in its own right has no browser coverage.
    await page.addInitScript(() => {
      localStorage.setItem('dorkos-auto-hide-tool-calls', 'false');
    });

    const chatPage = new ChatPage(page);
    await chatPage.goto(undefined, { dir: agentDir });
    await chatPage.sendMessage('Run bash');

    // tool-call scenario emits a Bash tool call
    await expect(chatPage.toolCallCards.first()).toBeVisible({ timeout: 10_000 });
  });

  test('long messages lay out with true row heights — no overlap, full scroll height', async ({
    page,
    request,
  }) => {
    // Regression class for the frozen-measurement bug (DOR-163 review): a
    // measurer that answers from a never-seeded cache freezes every row at the
    // 80px estimate, so tall messages overlap and the scroll height collapses
    // to count * estimate. This drives real long messages through the real
    // virtualizer and asserts the *layout*, which unit tests (mocked
    // virtualizer) can never see.
    await request.post(`${API_URL}/api/test/scenario`, {
      data: { name: 'simple-text' },
    });

    const chatPage = new ChatPage(page);
    await chatPage.goto(undefined, { dir: agentDir });

    // Three long prompts; simple-text echoes each back, so every turn adds a
    // user row AND an assistant row that both wrap far past the 80px estimate.
    const filler =
      'This sentence pads the message so the rendered row wraps well past the height estimate. ';
    for (let i = 1; i <= 3; i++) {
      await chatPage.sendMessage(`Long message ${i}: ${filler.repeat(6)}`);
      // Scoped to the transcript: the echo is in the DOM twice whenever the
      // announcer catches the turn arriving (see GOTCHAS), and a bare
      // `getByText` then resolves to two elements. Playwright treats that
      // strict-mode violation as non-retriable, so the assertion fails on its
      // first poll rather than waiting the announcer out — which is exactly how
      // this failed on CI, where the stream renders across enough frames for the
      // announcer to adopt the message. Locally the turn lands in one batch and
      // the announcer stays silent, so only the slower runner ever saw it.
      await expect(
        page.getByTestId('transcript-feed').getByText(new RegExp(`Echo: Long message ${i}:`))
      ).toBeVisible({
        timeout: 10_000,
      });
    }

    // Every virtualizer row is rendered (6 messages, overscan 5).
    const rows = chatPage.messageList.locator('[data-index]');
    await expect(rows).toHaveCount(6);

    /** Viewport boxes of every rendered row, sorted by message index. */
    const collectBoxes = async () => {
      const count = await rows.count();
      const boxes: { index: number; y: number; height: number }[] = [];
      for (let i = 0; i < count; i++) {
        const row = rows.nth(i);
        const index = Number(await row.getAttribute('data-index'));
        const box = await row.boundingBox();
        if (!box) throw new Error(`row ${index} has no bounding box`);
        boxes.push({ index, y: box.y, height: box.height });
      }
      return boxes.sort((a, b) => a.index - b.index);
    };

    // Measurements propagate through a ResizeObserver tick after the last
    // token lands, so poll the worst consecutive-row overlap down to sub-pixel
    // rounding (2px) instead of asserting a single racy snapshot.
    await expect
      .poll(
        async () => {
          const boxes = await collectBoxes();
          let worstOverlap = 0;
          for (let i = 1; i < boxes.length; i++) {
            worstOverlap = Math.max(
              worstOverlap,
              boxes[i - 1].y + boxes[i - 1].height - boxes[i].y
            );
          }
          return worstOverlap;
        },
        { timeout: 10_000 }
      )
      .toBeLessThanOrEqual(2);

    const boxes = await collectBoxes();

    // Rows were REALLY measured: a frozen-at-estimate layout positions rows
    // 80px apart, while these long messages render far taller than that.
    expect(Math.max(...boxes.map((b) => b.height))).toBeGreaterThan(120);

    // The scrollable height covers the true content: at least the sum of the
    // rendered rows' heights (a collapsed total would be count * 80 + padding).
    const sumOfRowHeights = boxes.reduce((acc, b) => acc + b.height, 0);
    const scrollHeight = await page.locator('.chat-scroll-area').evaluate((el) => el.scrollHeight);
    expect(scrollHeight).toBeGreaterThanOrEqual(sumOfRowHeights);
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
    // Pins the FULL-reset contract over the real HTTP stack. Test-mode history
    // is reconstructed from the DorkOS-owned event stream, persisted in TWO
    // tiers: the live per-session projector AND the durable SQLite
    // `session_events` store (DOR-189), which the history read prefers. A reset
    // that cleared tracked metadata + projectors but left the durable rows would
    // resurrect pre-reset history the moment the same id is used again
    // (review finding, acceptance run 20260611-145454; durable-tier gap DOR-334).
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
    // The selection closes the dropdown. Wait for it to be fully closed before
    // reopening — a reopen click that lands during Radix's close animation
    // toggles the menu shut instead of open (the reopen flake this guards).
    await expect(secondary).toBeHidden();

    // Known-but-unregistered runtimes (OpenCode, Codex) surface through the
    // picker's "Add a runtime" entry, which opens the setup panel with a
    // needs-setup section per runtime.
    await statusLine.getByRole('button', { name: 'test-mode-b' }).click();
    const addRuntime = page.getByRole('menuitem', { name: /add a runtime/i });
    await expect(addRuntime).toBeVisible();
    await addRuntime.click();
    await expect(page.getByTestId('runtime-setup-panel')).toBeVisible();
    const codexSection = page.getByTestId('runtime-section-codex');
    await expect(page.getByTestId('runtime-section-opencode')).toBeVisible();
    await expect(codexSection).toBeVisible();

    // The copyable install command lives behind each runtime's "Setup details"
    // disclosure (ADR-0317 moved the default path to a one-click Connect action,
    // demoting the raw shell command to the Advanced reveal). Expanding it
    // surfaces the per-runtime "Copy install command" button.
    await codexSection.getByRole('button', { name: /setup details/i }).click();
    await expect(
      codexSection.getByRole('button', { name: /copy install command/i }).first()
    ).toBeVisible();
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
    // Scoped to the transcript: the echo is in the DOM twice while the turn is
    // live — the message and the screen-reader announcer mirroring it (see
    // GOTCHAS). Preventive per DOR-1184: this echo has no sentence terminator
    // today, so it doesn't race the announcer's immediate-sentence path, but
    // that's a fact about the fixture text, not a guarantee.
    await expect(page.getByTestId('transcript-feed').getByText('Echo: Hello')).toBeVisible({
      timeout: 10_000,
    });

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

  test('session-list rows carry runtime marks naming their owning runtime', async ({
    page,
    request,
  }) => {
    // Session on the default runtime.
    const chatPage = new ChatPage(page);
    await chatPage.goto(undefined, { dir: agentDir });
    await chatPage.sendMessage('Default runtime session');
    // Scoped to the transcript — see GOTCHAS (announcer duplicates the echo).
    await expect(
      page.getByTestId('transcript-feed').getByText('Echo: Default runtime session')
    ).toBeVisible({
      timeout: 10_000,
    });

    // Assert the BINDING before the mark, so a session that lands on the wrong
    // runtime says so here instead of surfacing as "0 rows matched" five
    // seconds later. This is the check that names the DOR-991 cause: the
    // seeded agent's manifest runtime silently became a registered one, and
    // every "default runtime" session moved onto it.
    const defaultSessionId = await chatPage.getSessionId();
    expect(defaultSessionId).toBeTruthy();
    const boundTo = await request.get(`${API_URL}/api/sessions/${defaultSessionId}/runtime-type`);
    expect(boundTo.ok()).toBe(true);
    expect(await boundTo.json()).toEqual({ runtime: 'test-mode' });

    // Second session on the secondary runtime. The id is minted explicitly —
    // without it the loader auto-selects the existing session instead of
    // creating a new one.
    await chatPage.goto(crypto.randomUUID(), { dir: agentDir, runtime: 'test-mode-b' });
    await chatPage.sendMessage('Secondary runtime session');
    // Scoped to the transcript — see GOTCHAS (announcer duplicates the echo).
    await expect(
      page.getByTestId('transcript-feed').getByText('Echo: Secondary runtime session')
    ).toBeVisible({
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

  test('a turn that ends in error shows an inline error block with a working Retry', async ({
    page,
    request,
  }) => {
    await request.post(`${API_URL}/api/test/scenario`, { data: { name: 'error' } });

    const chatPage = new ChatPage(page);
    await chatPage.goto(undefined, { dir: agentDir });
    await chatPage.sendMessage('please fail');

    // The 'error' scenario yields a full-fidelity typed error event
    // (category 'execution_error'), which the projector folds into the turn as
    // an inline error part. That renders the inline ErrorMessageBlock — the
    // retry surface — and deliberately SUPPRESSES the panel-level
    // turn-failed-notice (no double affordance, per shouldShowTurnFailedNotice;
    // the notice's own no-inline-error path is covered by turn-failed-notice.test.tsx).
    const errorBlock = page.getByTestId('error-message-block');
    await expect(errorBlock).toBeVisible({ timeout: 10_000 });
    await expect(errorBlock.getByText('Agent stopped unexpectedly')).toBeVisible();
    await expect(page.getByTestId('turn-failed-notice')).toHaveCount(0);
    const retry = errorBlock.getByRole('button', { name: /retry/i });
    await expect(retry).toBeVisible();

    // Retry re-sends the last user message; with the scenario healed the
    // replayed turn succeeds.
    await request.post(`${API_URL}/api/test/scenario`, { data: { name: 'simple-text' } });
    await retry.click();
    // Scoped to the transcript — see GOTCHAS (announcer duplicates the echo).
    await expect(page.getByTestId('transcript-feed').getByText('Echo: please fail')).toBeVisible({
      timeout: 10_000,
    });
  });
});

// Universal command intents in the inline slash palette (DOR-109, VC2 + VC3
// enabled side). Backed by the test-mode runtime, whose caps declare
// `commandIntents.compact.supported === true` (Phase 2 task 2.3), so the compact
// row renders ENABLED here. The DISABLED "Not supported by {runtime}" side (VC3
// negative) is NOT reachable in this environment: the test-mode server registers
// only `test-mode` + `test-mode-b` (both supported), codex is not a registered
// runtime here, and `buildPaletteCommands` renders an unresolved (undefined) caps
// map as enabled — so no palette row is ever disabled against this server. That
// gating branch is covered by the Phase 3 unit tests
// (features/chat/model/__tests__/build-palette-commands.test.ts +
// features/commands CommandPalette gating), which mock caps to supported:false.
// The intent rows themselves are client-side (COMMAND_INTENTS), so these
// assertions hold on a cold session with no prior turn.
test.describe('Command Intents — inline palette dedupe + alias hints', () => {
  test('shows exactly one row per canonical intent, folding the native runtime command', async ({
    page,
  }) => {
    const chatPage = new ChatPage(page);
    await chatPage.goto(undefined, { dir: agentDir });

    // Typing `/` opens the palette with every command; each canonical intent
    // appears once — a runtime's own command for the same action folds into the
    // single intent row rather than doubling (the dedupe pass).
    await chatPage.openCommandPalette('/');
    await expect(chatPage.paletteRow('/compact')).toHaveCount(1);
    await expect(chatPage.paletteRow('/clear')).toHaveCount(1);
    await expect(chatPage.paletteRow('/context')).toHaveCount(1);

    // The plain-language intent descriptions render (writing-for-humans).
    await expect(
      chatPage.commandPalette.getByText('Shrink the conversation to free up context')
    ).toBeVisible();
  });

  test('typing an alias fuzzy-matches the intent and shows the "matched /{alias}" hint', async ({
    page,
  }) => {
    const chatPage = new ChatPage(page);
    await chatPage.goto(undefined, { dir: agentDir });

    // `/compress` is a cross-agent alias of `compact`; typing it ranks the
    // compact intent and surfaces the shipped alias hint so a user's muscle
    // memory resolves to the right intent.
    await chatPage.openCommandPalette('/compress');
    await expect(chatPage.paletteRow('/compact')).toHaveCount(1);
    await expect(chatPage.commandPalette.getByText('matched /compress')).toBeVisible();
  });

  test('the compact row is ENABLED on a runtime that supports it (test-mode)', async ({ page }) => {
    const chatPage = new ChatPage(page);
    await chatPage.goto(undefined, { dir: agentDir });

    // test-mode declares compact supported, so the row is selectable — not the
    // greyed, aria-disabled "Not supported by {runtime}" state (which the unit
    // tests cover for an unsupporting runtime).
    await chatPage.openCommandPalette('/compact');
    const compactRow = chatPage.paletteRow('/compact');
    await expect(compactRow).toHaveCount(1);
    await expect(compactRow).toHaveAttribute('aria-disabled', 'false');
  });
});

// Fleet-level context health surfaces (DOR-113, task 4.3). Backed by the
// test-mode runtime, which emits NO context reading — no `contextTokens` on its
// list rows and no `contextUsage` on its `session_status` fan-out — so every row
// resolves to the honest "unknown" gauge and the fleet summary bar correctly
// hides (nothing to report). This is the one state test-mode can drive; the
// populated "N near full" bar and a live known gauge require a real reading and
// are covered by the RTL tests (SessionContextGauge / FleetContextBar /
// useFleetContextRollup).
test.describe('Fleet context health — per-row gauge + honest unknown', () => {
  test('each session row shows a context gauge that reads as a deliberate unknown state', async ({
    page,
    request,
  }) => {
    await request.post(`${API_URL}/api/test/scenario`, { data: { name: 'simple-text' } });

    // Create a real session so the sidebar list has a row to gauge.
    const chatPage = new ChatPage(page);
    await chatPage.goto(undefined, { dir: agentDir });
    await chatPage.sendMessage('Hello');
    // Scoped to the transcript — see GOTCHAS (announcer duplicates the echo).
    await expect(page.getByTestId('transcript-feed').getByText('Echo: Hello')).toBeVisible({
      timeout: 10_000,
    });

    await new BasePage(page).ensureSidebarOpen();

    // The session list carries a per-row context gauge.
    const row = page.getByTestId('session-row').first();
    await expect(row).toBeVisible({ timeout: 10_000 });
    await expect(row.getByTestId('session-context-gauge')).toBeVisible();

    // With no reading available, the gauge reads as a deliberate MUTED
    // "unknown" — never a fabricated 0% or a broken/error state.
    await expect(row.getByLabel('Context usage unknown')).toBeVisible();
    await expect(row.getByText('0%')).toHaveCount(0);

    // Every row is unknown ⇒ nothing to summarize ⇒ the fleet summary bar hides
    // itself (spec §8b: hidden when nothing to report), rather than showing a
    // hollow "0 near full".
    await expect(page.getByTestId('fleet-context-bar')).toHaveCount(0);
  });
});

// Live-remount extension slots on an agent/cwd switch instead of reloading the page
// (DOR-363, PR #322). Switching agents changes the selected working directory, and
// extension discovery is cwd-scoped (global `~/.dork/extensions` + `{cwd}/.dork/extensions`),
// so a switch can add or remove extensions. The fix replaced a full `location.reload()`
// (fired ~1.5s after a toast) with an in-place slot remount — every scrap of in-flight
// SPA state (open session, scroll, unsent composer draft) is preserved.
//
// These tests live in chat-mock.spec.ts on purpose: the mock server is shared mutable
// state and the `chromium-mock` project runs this single file sequentially (see
// playwright.config.ts). They are NOT in CI (same precedent as send-message.spec.ts).
// Run locally against the built mock stack:
//   pnpm --filter @dorkos/e2e exec playwright test --project=chromium-mock -g "live remount"
//
// Two agents are registered via the mesh (so they appear in the command palette) at
// derived sibling dirs of the seed-agent boundary path. Test B additionally drops a
// minimal cwd-scoped extension into project A only — a valid manifest is enough: server
// discovery counts it in the cwd diff even though it never compiles or activates, which
// is exactly what flips `useCwdExtensionSync` into its remount branch (the branch that
// used to reload). No extension build pipeline is needed.
test.describe('Extensions — live remount on agent/cwd switch (DOR-363)', () => {
  /** cwd-scoped extension id dropped into project A for Test B. */
  const EXT_ID = 'e2e-remount-probe';
  /** Project A — the agent switched TO; carries the cwd-scoped extension in Test B. */
  let dirA: string;
  /** Project B — the agent the page loads on; never carries a cwd-scoped extension. */
  let dirB: string;

  /** `.dork/extensions` root for a project dir. */
  const extRoot = (dir: string) => path.join(dir, '.dork', 'extensions');

  test.beforeAll(async () => {
    const ctx = await apiRequest.newContext();
    // Learn a boundary-safe base directory from the seed route, then derive two
    // siblings so registration passes the server's directory boundary check.
    const seed = await ctx.post(`${API_URL}/api/test/seed-agent`);
    const { agentDir: baseDir } = (await seed.json()) as { agentDir: string };
    dirA = `${baseDir}-remount-a`;
    dirB = `${baseDir}-remount-b`;
    await fs.mkdir(dirA, { recursive: true });
    await fs.mkdir(dirB, { recursive: true });
    // Register both with the mesh so the command palette lists them as switchable
    // agents. `registerByPath` writes each agent's manifest and returns 201.
    for (const [dir, name] of [
      [dirA, 'Alpha Remount Agent'],
      [dirB, 'Bravo Remount Agent'],
    ] as const) {
      const res = await ctx.post(`${API_URL}/api/mesh/agents`, {
        data: { path: dir, overrides: { name, runtime: 'claude-code' } },
      });
      if (!res.ok()) throw new Error(`Failed to register ${name}: ${res.status()}`);
    }
    await ctx.dispose();
  });

  test.afterAll(async () => {
    await fs.rm(extRoot(dirA), { recursive: true, force: true }).catch(() => {});
    await fs.rm(extRoot(dirB), { recursive: true, force: true }).catch(() => {});
  });

  /**
   * Open the global command palette (Cmd/Ctrl+K), filter to `agentName`, drill into
   * its actions sub-menu, and click "Open Here" — the exact user path
   * `handleAgentSelect` → `setDir`, which sets `selectedCwd` and client-navigates
   * (never a full document load).
   */
  async function switchAgentViaPalette(page: Page, agentName: string): Promise<void> {
    await page.keyboard.press('Meta+k');
    // By test id, not by placeholder. The placeholder is user-facing copy: it
    // changed once already (DOR-630 put rooms in the palette) and took this
    // helper's two callers down with it, silently — a `getByPlaceholder` that
    // matches nothing waits out its timeout instead of naming what is missing.
    const search = page.getByTestId('command-palette-input');
    await search.waitFor({ state: 'visible', timeout: 10_000 });
    await search.fill(agentName);
    await page
      .getByRole('option', { name: new RegExp(agentName, 'i') })
      .first()
      .click();
    // The sub-menu clears the search and auto-selects "Open Here".
    await page.getByRole('option', { name: /open here/i }).click();
  }

  /**
   * Assert no full document reload happened: no `load` event fires within the window
   * where the old code reloaded (~1.5s after the switch), and the in-memory marker —
   * a faithful proxy for all preserved SPA state, including the unsent composer draft,
   * which lives in the same in-memory session store — survived. A `location.reload()`
   * wipes both.
   */
  async function expectNoReload(page: Page): Promise<void> {
    const reloaded = await page
      .waitForEvent('load', { timeout: 2_500 })
      .then(() => true)
      .catch(() => false);
    expect(reloaded, 'a full document reload fired (regression: location.reload is back)').toBe(
      false
    );
    const marker = await page.evaluate(
      () => (window as Window & { __remountSentinel?: string }).__remountSentinel
    );
    expect(marker, 'window marker was wiped — the page did a full reload').toBe('alive');
  }

  /** Type an unsent draft, then plant the in-memory reload marker. */
  async function primeComposerAndMarker(chatPage: ChatPage, page: Page): Promise<void> {
    await chatPage.input.fill('SENTINEL-unsent-draft');
    await page.evaluate(() => {
      (window as Window & { __remountSentinel?: string }).__remountSentinel = 'alive';
    });
  }

  // Test A — the baseline the founder actually saw. With NO project-scoped extension,
  // the discovered set is identical in both projects, so `useCwdExtensionSync` reports
  // `changed: false` and never touches the slots (no toast, and — pre-fix OR post-fix —
  // no reload). This is precisely why the remount fix is invisible without a
  // project-scoped extension: switching agents is already a pure client-side transition.
  test('switching agents with no scoped extension is a pure SPA transition (no reload)', async ({
    page,
  }) => {
    await fs.rm(extRoot(dirA), { recursive: true, force: true });
    await fs.rm(extRoot(dirB), { recursive: true, force: true });

    const chatPage = new ChatPage(page);
    await chatPage.goto(undefined, { dir: dirB });
    await primeComposerAndMarker(chatPage, page);

    await switchAgentViaPalette(page, 'Alpha Remount Agent');

    // The cockpit switched to the target agent's working directory.
    await expect
      .poll(() => new URL(page.url()).searchParams.get('dir'), { timeout: 10_000 })
      .toBe(dirA);

    await expectNoReload(page);
  });

  // Test B — the regression guard. Project A carries a cwd-scoped extension and B does
  // not, so switching B → A flips the discovered set (`changed: true`). That fires the
  // exact branch the old code reloaded from — here it must instead show the quiet
  // "Project extensions updated" toast and live-remount, with NO page reload.
  test('an extension-set change on switch live-remounts (toast), never reloads', async ({
    page,
    request,
  }) => {
    // Drop a minimal valid manifest into project A only; ensure B has none.
    const extDir = path.join(extRoot(dirA), EXT_ID);
    await fs.mkdir(extDir, { recursive: true });
    await fs.writeFile(
      path.join(extDir, 'extension.json'),
      JSON.stringify({
        id: EXT_ID,
        name: 'E2E Remount Probe',
        version: '0.0.0',
        description: 'Cwd-scoped extension present only in project A (e2e fixture).',
      })
    );
    await fs.rm(extRoot(dirB), { recursive: true, force: true });

    // Prime the server's cwd to B so the measured switch into A yields a deterministic
    // `added` diff regardless of any prior cwd left by an earlier test.
    await request.post(`${API_URL}/api/extensions/cwd-changed`, { data: { cwd: dirB } });

    const chatPage = new ChatPage(page);
    await chatPage.goto(undefined, { dir: dirB });
    await primeComposerAndMarker(chatPage, page);

    await switchAgentViaPalette(page, 'Alpha Remount Agent');

    // The scoped set changed → the remount branch runs: a quiet toast, no reload.
    await expect(page.getByText('Project extensions updated')).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(() => new URL(page.url()).searchParams.get('dir'), { timeout: 10_000 })
      .toBe(dirA);

    await expectNoReload(page);
  });
});

/**
 * The chat composer with formatting-as-you-type ON (`ui.composer.richText`,
 * DOR-948).
 *
 * ## Why this lives in THIS file
 *
 * It was written as its own spec file with its own Playwright project, and that
 * was wrong in a way only the full suite showed. Projects run concurrently, and
 * `POST /api/test/reset` — which this file's own header documents as wiping the
 * default scenario, tracked sessions and projectors GLOBALLY — is called by
 * every test on both sides. Run alone, both suites were green (15/15 and 5/5);
 * run together, five tests failed across them.
 *
 * So this follows the instruction `playwright.config.ts` already carried: add
 * new mock-server suites HERE. The file is `mode: 'default'`, sequential on one
 * worker, which is the only thing that makes a server-global preference safe to
 * flip at all.
 *
 * `ui.composer.richText` is exactly such a preference — there is no per-tab
 * override, so it is on for every page against this leg while these tests run.
 * `afterAll` restores whatever it found, including when a test fails; without
 * that, every later spec would quietly run against a different composer.
 */
test.describe('the chat composer with formatting on', () => {
  /** Whatever the preference was before this describe touched it. */
  let previousRichText = false;

  test.beforeAll(async () => {
    const context = await apiRequest.newContext({ baseURL: API_URL });
    try {
      const current = await context.get('/api/config');
      const config = (await current.json()) as { ui?: { composer?: { richText?: boolean } } };
      previousRichText = config.ui?.composer?.richText ?? false;
      const res = await context.patch('/api/config', {
        data: { ui: { composer: { richText: true } } },
      });
      if (!res.ok()) throw new Error(`could not turn rich text on: ${res.status()}`);
    } finally {
      await context.dispose();
    }
  });

  test.afterAll(async () => {
    const context = await apiRequest.newContext({ baseURL: API_URL });
    try {
      await context.patch('/api/config', {
        data: { ui: { composer: { richText: previousRichText } } },
      });
    } finally {
      await context.dispose();
    }
  });

  /**
   * Open chat and wait for the RICH field, not merely for a composer.
   *
   * The editor is lazy and the preference arrives from an async config read, so
   * the composer is briefly the plain textarea. Waiting for the contenteditable
   * is what makes every test below about the field it claims to be about.
   *
   * @param page - The page to drive.
   */
  async function openRichChat(page: Page): Promise<ChatPage> {
    const chatPage = new ChatPage(page);
    await chatPage.goto(undefined, { dir: agentDir });
    await expect(page.locator('[contenteditable="true"]')).toBeVisible({ timeout: 20_000 });
    // The same locator every page object uses, resolving to the rich field: the
    // swap kept one control's identity rather than adding a second one, which
    // is what every existing spec depends on.
    await expect(chatPage.input).toHaveAttribute('contenteditable', 'true');
    return chatPage;
  }

  /** Messages the person has sent, as the transcript renders them. */
  function userMessages(page: Page) {
    return page.locator('[data-testid="message-item"][data-role="user"]');
  }

  test('Enter builds a list and only sends once the list is done', async ({ page }) => {
    const chatPage = await openRichChat(page);
    const composer = chatPage.input;
    await composer.click();

    await composer.pressSequentially('- a');
    await expect(composer.locator('li')).toHaveCount(1);
    await composer.press('Enter');
    await composer.pressSequentially('b');
    await expect(composer.locator('li')).toHaveCount(2);

    // Enter on the empty third item leaves the list rather than sending.
    await composer.press('Enter');
    await composer.press('Enter');
    await expect(composer.locator('li')).toHaveCount(2);
    await expect(composer.locator('p')).toHaveCount(1);

    // THE ASSERTION THIS SUITE EXISTS FOR. Four Enters have been pressed inside
    // a list and NOTHING has been sent — locked decision 2, and the one rung
    // with no textarea equivalent to fall back on.
    await expect(userMessages(page)).toHaveCount(0);

    await composer.pressSequentially('and a sentence');
    await composer.press('Enter');

    // Exactly one, not "at least one": the claim is that the four earlier
    // Enters were absorbed by the list, and only `toHaveCount(1)` can fail if
    // any of them sent.
    await expect(userMessages(page)).toHaveCount(1, { timeout: 20_000 });
    await expectComposerText(composer, '');
  });

  test('bold renders in the field and the sent message still carries markdown', async ({
    page,
  }) => {
    const chatPage = await openRichChat(page);
    const composer = chatPage.input;
    await composer.click();

    await composer.pressSequentially('**bold** please');

    // On screen: a real <strong>, and the asterisks are gone.
    await expect(composer.locator('strong')).toHaveText('bold');
    expect(await composerText(composer)).toBe('bold please');

    await composer.press('Enter');

    // On the wire: the markdown source, unchanged. The editor is a view over
    // markdown, not a new message format.
    const sent = userMessages(page).first();
    await expect(sent).toBeVisible({ timeout: 20_000 });
    await expect(sent).toContainText('**bold** please');
  });

  test('syntax the box does not preview stays literal', async ({ page }) => {
    const chatPage = await openRichChat(page);
    const composer = chatPage.input;
    await composer.click();

    // Backticks at the start of a line are the strongest case: recognizing a
    // fenced block would give Enter a THIRD meaning, and the locked decision
    // authorized exactly one exception.
    await composer.pressSequentially('```');
    expect(await composerText(composer)).toBe('```');
    await expect(composer.locator('pre, code')).toHaveCount(0);

    await composer.pressSequentially(' and > quote and ~~strike~~');
    expect(await composerText(composer)).toBe('``` and > quote and ~~strike~~');
    await expect(composer.locator('blockquote, s, del')).toHaveCount(0);
  });

  test('Shift+Enter is a newline and sends nothing', async ({ page }) => {
    const chatPage = await openRichChat(page);
    const composer = chatPage.input;
    await composer.click();

    await composer.pressSequentially('first');
    await composer.press('Shift+Enter');
    await composer.pressSequentially('second');

    await expect(composer.locator('br')).toHaveCount(1);
    await expect(userMessages(page)).toHaveCount(0);
    // The caret is past both words, so the break is inside the document rather
    // than something the browser painted around it.
    expect(await caretOffset(composer)).toBe('firstsecond'.length);
  });

  test('the command palette opens over the rich field and Enter picks a row', async ({ page }) => {
    const chatPage = await openRichChat(page);

    await chatPage.openCommandPalette('/');
    await expect(chatPage.paletteOptions.first()).toBeVisible({ timeout: 10_000 });

    // Enter belongs to the palette while it has rows — it must not send, and it
    // must not reach the list handler either.
    await chatPage.input.press('Enter');

    await expect(chatPage.commandPalette).toBeHidden({ timeout: 10_000 });
    await expect(userMessages(page)).toHaveCount(0);
  });
});

// Cross-device read state for chat sessions (DOR-1040). Declared in its own
// module but registered INTO this file, and that is the point: `/api/test/reset`
// above deletes every tracked session's transcript, and Playwright schedules
// separate spec FILES onto concurrent workers — so a suite that needs a
// transcript to survive a minute of browser work has to be on this file's
// worker rather than beside it. See the module header for the full argument.
registerSessionReadStateTests({ apiUrl: API_URL, agentDir: () => agentDir });

// The sidebar's Heads up zone surviving a page load (DOR-1136). Registered here for
// the same reason as the suite above — it needs the `error` scenario, which only
// this leg has — and because the defect is about what a FRESH page connection is
// told, which no unit test can observe.
registerNowSurvivesReloadTests({ apiUrl: API_URL, agentDir: () => agentDir });

// Writing in a conversation puts it in Today (DOR-1156). Registered here because
// it drives a real send, which is free and deterministic only on this leg — and
// because what it asserts happens on the OTHER side of a navigation, which is
// exactly what a jsdom render cannot walk through.
registerSendLandsInTodayTests({ apiUrl: API_URL, agentDir: () => agentDir });
/**
 * Conversations in ⌘K (spec `sidebar-now-today-library` P3, §15).
 *
 * Two claims cannot be settled anywhere else. **Finding a conversation and
 * landing in it** is a claim about the whole chain — the recent-sessions route,
 * the server-derived title, Fuse, cmdk's selection and the router — and every
 * link of it is stubbed in jsdom. **The truncation budget** is a claim about a
 * computed layout, and jsdom computes none: every element there is 0×0 and
 * every Tailwind class resolves to nothing.
 *
 * In this file rather than one of its own because the mock server is global
 * mutable state and `POST /api/test/reset` wipes it for everyone — the config
 * says new mock-server suites belong here, and this one needs the same seeded
 * agent and the same default `simple-text` scenario the beforeEach above sets up.
 *
 * Nothing here spends money: the title comes from the real `deriveSessionTitle`
 * over a real first message, answered by TestModeRuntime.
 */
test.describe('conversations in the command palette', () => {
  /**
   * A phrase nothing else on this server answers to — not an agent, not a room,
   * not a slash command, not a directory. It has to be unique, or the claim
   * below is about the palette listing everything rather than about the title
   * matching.
   */
  const TITLE_WORD = 'Zanzibar';

  /**
   * The agent this suite talks to — registered with the MESH, not merely seeded
   * on disk.
   *
   * That distinction is the whole reason this hook exists. `GET
   * /api/sessions/recent` fans out over `meshCore.listWithPaths()`, so a
   * directory the mesh has never heard of contributes no sessions however many
   * it holds — and the palette's Recent list came up empty with a conversation
   * plainly on screen. `POST /api/test/seed-agent` writes a manifest to disk and
   * stops there; registration is a separate act.
   *
   * `runtime: 'codex'` for the same reason `seed-agent` declares it: a manifest
   * runtime beats the server default whenever this process registers it, and
   * this server never registers codex — so the session lands on `test-mode`,
   * which is what makes it free.
   */
  let paletteAgentDir: string;

  test.beforeAll(async () => {
    const ctx = await apiRequest.newContext();
    const seed = await ctx.post(`${API_URL}/api/test/seed-agent`);
    const { agentDir: baseDir } = (await seed.json()) as { agentDir: string };
    paletteAgentDir = `${baseDir}-palette`;
    await fs.mkdir(paletteAgentDir, { recursive: true });
    const res = await ctx.post(`${API_URL}/api/mesh/agents`, {
      data: { path: paletteAgentDir, overrides: { name: 'Palette Test Agent', runtime: 'codex' } },
    });
    if (!res.ok()) {
      throw new Error(`Failed to register the palette agent: ${res.status()}`);
    }
    await ctx.dispose();
  });

  /**
   * Start a conversation whose title contains {@link TITLE_WORD}, and answer
   * with the session id the server minted for it.
   *
   * The title is not set here: the first MESSAGE is, and the server derives the
   * title from it. That is the point — what a person types into ⌘K later is
   * what the product decided to call the conversation.
   */
  async function startNamedSession(page: Page): Promise<string> {
    const chatPage = new ChatPage(page);
    await chatPage.goto(undefined, { dir: paletteAgentDir });
    await chatPage.sendMessage(`${TITLE_WORD} migration plan`);
    await expect(page.getByTestId('transcript-feed').getByText(/Echo:/)).toBeVisible({
      timeout: 15_000,
    });
    await expect(page).toHaveURL(/session=/, { timeout: 15_000 });
    const sessionId = new URL(page.url()).searchParams.get('session');
    expect(sessionId).not.toBeNull();
    return sessionId as string;
  }

  /**
   * Open the palette the way a person does, and wait for it.
   *
   * The app-ready wait is load-bearing: these cases navigate to `/` first, and
   * a ⌘K pressed at a shell that has not mounted yet is a keystroke nobody is
   * listening for — which reads as "the palette never opened".
   */
  async function openPalette(page: Page) {
    await new BasePage(page).waitForAppReady();
    await page.keyboard.press('ControlOrMeta+k');
    const input = page.getByTestId('command-palette-input');
    await expect(input).toBeVisible({ timeout: 15_000 });
    return input;
  }

  /** The palette row for the conversation this suite started. */
  const namedRow = (page: Page) =>
    page
      .locator('[cmdk-root] [role="option"]')
      .filter({ hasText: new RegExp(TITLE_WORD, 'i') })
      .first();

  test('typing a conversation title and pressing Enter lands in that conversation', async ({
    page,
  }) => {
    const sessionId = await startNamedSession(page);

    // Leave it, so arriving back is a real navigation and not a page that never
    // moved.
    await page.goto('/');
    await expect(page).not.toHaveURL(/session=/);

    const input = await openPalette(page);
    await input.fill(TITLE_WORD.toLowerCase());

    await expect(namedRow(page)).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press('Enter');

    await expect(page).toHaveURL(new RegExp(`session=${sessionId}`), { timeout: 15_000 });
  });

  test('a conversation row spends the sidebar’s truncation budget', async ({ page }) => {
    await startNamedSession(page);
    await page.goto('/');

    const input = await openPalette(page);
    await input.fill(TITLE_WORD.toLowerCase());

    const row = namedRow(page);
    await expect(row).toBeVisible({ timeout: 15_000 });

    // `Agent › title`, whole and untruncated, in the row's own tooltip.
    await expect(row).toHaveAttribute('title', /›/);

    const budget = await row.evaluate((el) => {
      const line = el.querySelector('[data-slot="palette-session-line"]');
      const who = el.querySelector('[data-slot="palette-session-who"]');
      const title = el.querySelector('[data-slot="palette-session-title"]');
      if (!line || !who || !title) return null;

      // What `6ch` is worth in the title's OWN font, measured rather than
      // guessed: `ch` is the advance width of a "0" in the element's font, so
      // the number differs per family and per size and there is no arithmetic
      // that gets it from a font-size.
      //
      // The probe goes INSIDE the title and copies no font properties at all,
      // which is the whole trick. Copying a handful of them onto a sibling
      // looks equivalent and is not: `ch` also moves with the things a font
      // shorthand does not carry — variation settings, optical sizing, feature
      // settings, stretch — so a probe that names four properties resolves
      // `6ch` in a subtly different font than the element it is standing in
      // for. That cost 0.7px here, against a 0.5px tolerance, and it would
      // drift again with any font change. Inheritance is exact by
      // construction; a copied list is exact only until someone adds a
      // property to it.
      const titleStyle = getComputedStyle(title);
      const probe = document.createElement('span');
      probe.style.position = 'absolute';
      probe.style.visibility = 'hidden';
      probe.style.display = 'inline-block';
      probe.style.width = '6ch';
      title.appendChild(probe);
      const sixCh = probe.getBoundingClientRect().width;
      probe.remove();

      return {
        lineWidth: line.getBoundingClientRect().width,
        whoMaxWidth: getComputedStyle(who).maxWidth,
        titleMinWidth: titleStyle.minWidth,
        sixCh,
      };
    });

    expect(budget).not.toBeNull();
    const { lineWidth, whoMaxWidth, titleMinWidth, sixCh } = budget!;
    expect(lineWidth).toBeGreaterThan(0);
    expect(sixCh).toBeGreaterThan(0);

    // The agent name is capped at 42% of the line (BC-25). Browsers resolve a
    // percentage max-width to px in `getComputedStyle`, but either spelling is
    // permitted — and `none`, which is what a missing class gives, is not.
    if (whoMaxWidth.endsWith('%')) {
      expect(whoMaxWidth).toBe('42%');
    } else {
      expect(parseFloat(whoMaxWidth)).toBeCloseTo(lineWidth * 0.42, 0);
    }

    // And the title floor is SIX characters of the font it is drawn in, not
    // merely "some number of pixels". A `> 0` assertion here survives the class
    // being cut to `min-w-[1px]` — the budget gutted, the test still green —
    // which is precisely the shape of check this suite exists to avoid.
    // (`row-grammar.test.ts` pins the literal; this pins what it BUYS.)
    expect(parseFloat(titleMinWidth)).toBeCloseTo(sixCh, 0);
  });

  test('the untyped palette is Continue, Recent and New — and nothing else', async ({ page }) => {
    await startNamedSession(page);
    await page.goto('/');

    await openPalette(page);

    const headings = page.locator('[cmdk-root] [cmdk-group-heading]');
    await expect(headings.filter({ hasText: 'Recent' }).first()).toBeVisible({ timeout: 15_000 });

    // Every heading the untyped palette draws is one of the three. The
    // "Features" and "Quick Actions" dumps this replaced would both fail here.
    const texts = await headings.allTextContents();
    expect(texts.length).toBeGreaterThan(0);
    for (const text of texts) {
      expect(['Continue', 'Recent', 'New']).toContain(text.trim());
    }
  });
});
