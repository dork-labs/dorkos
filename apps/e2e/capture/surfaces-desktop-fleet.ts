import type { Page } from '@playwright/test';
import { MULTI_SESSION_PROMPTS, type Theme } from './config.js';
import type { RunRecorder } from './library.js';
import {
  ensureDesktopSidebarExpanded,
  openLiveTurn,
  shoot,
  sleep,
  waitForAppShell,
  WAIT_MS,
} from './lib.js';

/**
 * The fleet drive behind the `multi-session` shot: four agents put to work at
 * once, so the Now/Today sidebar has real concurrent conversations to summarise.
 *
 * Split out of `surfaces-desktop` (which was over the 500-line limit) because
 * this is the one drive that runs several turns at once — it owns a turn
 * model, a prompt cursor, and the pacing that keeps every row live through
 * both the still and the loop. Nothing else reads any of it. Both the still and the loop are driven
 * from `surfaces-desktop`.
 *
 * @module capture/surfaces-desktop-fleet
 */

/** Settle beat after an agent's conversation opens, before the next one does. */
const MULTI_SESSION_SETTLE_MS = 600;
/**
 * The agents the fleet drive puts to work, in the order it opens them.
 *
 * **Four agents, not four sessions on one agent**, and the last one listed is
 * where the drive lands — so its transcript is what the main pane shows. Three
 * runtimes are on screen at once (`sentinel` runs opencode, `scout` codex,
 * `forge`/`atlas` claude-code), which is exactly what this surface's feature
 * card promises: one app, whatever each agent runs on.
 */
const MULTI_SESSION_AGENTS: readonly string[] = ['sentinel', 'forge', 'scout', 'atlas'];
/** The one agent whose turn stops for a permission prompt, so a row reads amber. */
const MULTI_SESSION_APPROVAL_AGENT = 'sentinel';
/** Rotates through the prompt pool so repeated drives mint distinct titles. */
let multiSessionPromptCursor = 0;

/** One agent's turn for the fleet drive: who, what the person asks, and how it runs. */
interface FleetTurn {
  readonly agent: string;
  readonly prompt: string;
  readonly scenario: string;
}

/** The turns this drive will run, one per agent. */
function planFleetTurns(): FleetTurn[] {
  return MULTI_SESSION_AGENTS.map((agent) => ({
    agent,
    prompt: MULTI_SESSION_PROMPTS[multiSessionPromptCursor++ % MULTI_SESSION_PROMPTS.length]!,
    scenario: agent === MULTI_SESSION_APPROVAL_AGENT ? 'demo-approval' : 'demo-coding',
  }));
}

/**
 * Drive the fleet moment on the Now/Today/Library sidebar: the person starts a
 * new chat with each agent in turn, so the panel ends up holding four
 * concurrent conversations at once, three streaming green and one stopped
 * amber on a permission prompt, with Now summarising them above ("N working",
 * "sentinel › Waiting on you").
 *
 * Two things about this shape are load-bearing:
 *
 * - **Every chat is one this person started.** Today lists the chats this
 *   person touched, and an agent click opens the one they touched last
 *   (DOR-2789). A turn started behind the app's back is neither, so it would
 *   draw no row, and clicking its agent would open an older chat instead.
 *   {@link openLiveTurn} opens a new chat and sends through the composer, the
 *   product's own path, and the chat page records the open.
 * - **Turns start one at a time.** A `demo-coding` turn only runs for about
 *   fourteen seconds; starting all four up front left the earliest ones
 *   finished before the still, and long finished before the end of the loop's
 *   hold. Starting each just before the next keeps every row live through both.
 *
 * The panel builds its rows from `SidebarRowModel` (`[data-sidebar-row]`).
 */
export async function driveMultiSession(page: Page): Promise<void> {
  const turns = planFleetTurns();
  for (const turn of turns) {
    await openLiveTurn(page, turn.scenario, turn.prompt, turn.agent);
    await sleep(MULTI_SESSION_SETTLE_MS);
  }
  await waitForAppShell(page);
  await ensureDesktopSidebarExpanded(page);

  const todayRows = page.locator('[data-sidebar-zone="today"] [data-sidebar-row]');
  await todayRows.nth(turns.length - 1).waitFor({ timeout: WAIT_MS });
  // A streaming row reserves a verb line and the leaf fills it in ("Editing a
  // file…") — the proof the rows are live rather than merely present.
  await page
    .locator('[data-sidebar-zone="today"] [data-slot="sidebar-row-second-line"]')
    .first()
    .waitFor({ timeout: WAIT_MS });
  // Opening a conversation scrolls its Today row into view, which walks the
  // panel down past Now. Bring Now back so the frame carries the whole story:
  // what needs you, how much is running, and the four rows it is running in.
  // Scrolled by locator rather than by wheel — the panel is not the element
  // under the cursor after a row click, and a wheel aimed at a guessed point
  // silently did nothing.
  await page.locator('[data-sidebar-zone="now"]').first().scrollIntoViewIfNeeded();
  await sleep(400);
}

/**
 * Capture the multi-session sidebar: the Now zone counting the running work and
 * naming what is blocked, over four live conversations in Today.
 */
export async function shootMultiSession(page: Page, theme: Theme, rec: RunRecorder): Promise<void> {
  await driveMultiSession(page);
  await sleep(1500); // let indicators and the viewed transcript fill in
  await shoot(page, 'multi-session', theme, rec);
}
