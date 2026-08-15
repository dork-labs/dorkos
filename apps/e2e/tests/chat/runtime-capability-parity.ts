/**
 * The cockpit reads the RUNTIME's capability descriptors, not Claude's
 * (ADR-0256, L-10).
 *
 * ## What this suite is, and what it deliberately is not
 *
 * The multi-runtime promise is that DorkOS drives Claude Code, Codex and
 * OpenCode through one interface and adapts to what each declares. Above the
 * unit level that promise has, until now, had no coverage at all — and it is
 * worth being exact about why, because the obvious plan does not work.
 *
 * **Real Codex and OpenCode cannot be driven here.** Both spawn or manage a real
 * process and need model credentials, which a PR runner does not have and must
 * not be given (`playwright.config.ts`, `INCLUDE_INTEGRATION`). So a spec that
 * opened a codex session and a claude-code session side by side would be an
 * `@integration` spec that never runs, which is not coverage.
 *
 * **And a matrix over toggled capability flags is not reachable either.**
 * `TEST_MODE_CAPABILITIES` is a frozen constant; the second instance this leg
 * registers (`test-mode-b`) is that same object with a different `type`. There
 * is no switch for `supportsToolApproval`, `supportsSteer` or the persistent
 * session, so a "capability variant" would mean adding env-driven capability
 * sets to the product for the sole benefit of a test. Worth doing one day —
 * it is the only route to a real matrix — but it is a product change, not test
 * coverage, and it is not smuggled in here.
 *
 * **The composer does not gate on those flags anyway.** A grep of
 * `apps/client/src` for `supportsToolApproval`, `supportsSteer` and
 * `supportsPersistentSession` finds them in the dev playground's fake transport
 * and nowhere else in shipping code. So the "affordances hidden, not dead"
 * claim, as it is usually stated about the composer, has nothing behind it to
 * assert yet.
 *
 * ## What IS real, and is what this asserts
 *
 * Two places in the shipping client genuinely read a runtime's descriptors, and
 * this leg is the one place a browser can see a non-Claude runtime at all:
 *
 * 1. **The permission control names the mode using the RUNTIME's own
 *    descriptor.** Test-mode declares three permission-mode ids — `always-allow`,
 *    `always-deny`, `scripted` — chosen precisely so they do NOT overlap with
 *    Claude's, because (its constant's own words) "any UI that still renders a
 *    hardcoded Claude permission-mode list will fail visibly". A session on this
 *    leg must therefore read `Permissions: Always allow`, a label that exists in
 *    no Claude-shaped list.
 * 2. **A runtime that declares it cannot track cost shows no cost.** Test-mode
 *    declares `supportsCostTracking: false`, and the status bar gates the whole
 *    usage item on it — hidden, never a zero.
 *
 * ## Why a module and not a spec file
 *
 * The same constraint `session-read-state.ts` states at length: the mock server
 * is global mutable state, `POST /api/test/reset` wipes it for everyone, and
 * Playwright schedules separate spec FILES onto concurrent workers. New
 * mock-server suites belong in `chat-mock.spec.ts` or in a module it registers.
 * The `.ts` extension is load-bearing for the second reason that file gives too:
 * every `*.spec.ts` under `tests/chat/` runs on the COCKPIT leg against a real,
 * billable runtime.
 *
 * @module tests/chat/runtime-capability-parity
 */
import { test, expect } from '@playwright/test';
import { ChatPage } from '../../pages/ChatPage.js';

/** The same ceiling the rest of the suite uses — a bound on a stall, not a delay. */
const SERVER_ROUND_TRIP_MS = 30_000;

/**
 * The permission mode test-mode declares as its default, as a person reads it.
 *
 * From `TEST_MODE_CAPABILITIES.permissionModes` — `default: 'always-allow'`,
 * whose descriptor's label is this. Deliberately outside `PermissionModeSchema`,
 * which is the whole point of it.
 */
const TEST_MODE_DEFAULT_LABEL = 'Always allow';

/**
 * Labels that belong to Claude Code and to nothing else.
 *
 * If any of these is on screen for a test-mode session, something is rendering a
 * hardcoded list instead of asking the runtime — which is the exact failure
 * ADR-0256 put these divergent ids in place to catch.
 */
const CLAUDE_ONLY_LABELS = [/^Plan$/, /^Accept edits$/, /^Bypass permissions$/];

/**
 * Register the runtime-descriptor parity tests into `chat-mock.spec.ts`.
 *
 * @param deps.agentDir - The seeded agent's directory, read fresh per test
 *   because the file's `beforeEach` re-seeds it.
 */
export function registerRuntimeCapabilityParityTests(deps: { agentDir: () => string }): void {
  test.describe('the cockpit adapts to the runtime it is talking to', () => {
    test('the permission control names a mode only THIS runtime declares', async ({ page }) => {
      const chatPage = new ChatPage(page);
      await chatPage.goto(undefined, { dir: deps.agentDir() });
      // A turn first, and the control says why: until a session has one, the
      // permission item is disabled behind a "Send a message first" tooltip, and
      // there is no runtime bound to ask for descriptors yet. Asserting before
      // that is asserting about a page with no runtime on it.
      await chatPage.sendMessage('hello');
      await expect(page.getByTestId('transcript-feed')).toContainText(/Echo:/, {
        timeout: SERVER_ROUND_TRIP_MS,
      });

      // The status bar's permission control. Its accessible name is
      // `Permissions: <label>`, and the label comes from the descriptor the
      // RUNTIME declared for the session's current mode — falling back to the
      // shared Claude-shaped names only when no descriptor matches. So the name
      // being test-mode's own is the assertion: it cannot be produced by a
      // hardcoded list, because no Claude-shaped list contains it.
      const permissions = page.getByRole('button', {
        name: new RegExp(`^Permissions: ${TEST_MODE_DEFAULT_LABEL}$`),
      });
      await expect(permissions).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });

      // And none of Claude's. Stated as a count of zero rather than as "not
      // visible": a hardcoded list would put these in the DOM, and an element
      // that is merely off-screen still matches.
      await permissions.click();
      // By attribute rather than by role: the popover is responsive and becomes
      // a drawer on a narrow viewport, which is a different role for the same
      // surface. The exact-match attribute cannot collide with the trigger,
      // whose own name carries the current mode after a colon.
      const dial = page.locator('[aria-label="Permissions"]');
      await expect(dial).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
      for (const label of CLAUDE_ONLY_LABELS) {
        await expect(
          dial.getByText(label),
          `the permission dial offered a Claude Code mode to a runtime that never declared it`
        ).toHaveCount(0);
      }
    });

    test('a runtime that cannot track cost shows no cost, rather than zero', async ({ page }) => {
      const chatPage = new ChatPage(page);
      await chatPage.goto(undefined, { dir: deps.agentDir() });
      // **A turn, because the turn is what reports the usage this gate is
      // about.** The item's condition is
      // `usage && hasRenderableUsage(usage) && supportsCostTracking`, and for a
      // long time the `simple-text` scenario reported no usage at all — so the
      // FIRST conjunct was false for every test-mode session and this assertion
      // was true no matter what the capability said. It stayed green with the
      // flag flipped to `true`, which is a test that cannot fail.
      //
      // The scenario now reports a real pay-as-you-go cost
      // (`scenario-store.ts`), so after this turn the only thing between that
      // number and the status bar is `supportsCostTracking: false`. Flip that
      // constant and this line goes red — which is the drill that proved it.
      await chatPage.sendMessage('what does this cost');
      await expect(page.getByTestId('transcript-feed')).toContainText(/Echo:/, {
        timeout: SERVER_ROUND_TRIP_MS,
      });

      // A count of zero, not a hidden class: an item drawn and hidden is still an
      // item that read the wrong descriptor.
      await expect(page.getByTestId('status-item-usage')).toHaveCount(0);
    });
  });
}
