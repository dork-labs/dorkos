import path from 'path';
import { randomUUID } from 'crypto';
import type { Page } from '@playwright/test';
import { FLEET_ROOT, MULTI_SESSION_PROMPTS, type Theme } from './config.js';
import type { RunRecorder } from './library.js';
import { ensureDesktopSidebarExpanded, post, shoot, sleep, url, WAIT_MS } from './lib.js';

/**
 * The fleet drive behind the `multi-session` shot: four agents put to work at
 * once, so the Now/Today sidebar has real concurrent conversations to summarise.
 *
 * Split out of `surfaces-desktop` (which was over the 500-line limit) because
 * this is the one drive that plans and triggers its own turns rather than
 * reusing `openLiveTurn` — it owns a turn model, a prompt cursor, and the
 * pacing constants that keep every row live through both the still and the
 * loop. Nothing else reads any of it. Both the still and the loop are driven
 * from `surfaces-desktop`.
 *
 * @module capture/surfaces-desktop-fleet
 */

/** Settle beat after an agent's conversation opens, before the next one does. */
const MULTI_SESSION_SETTLE_MS = 600;
/** Pause after a turn is triggered, so the roster can resolve it as that agent's newest. */
const MULTI_SESSION_RESOLVE_MS = 1200;
/**
 * The agents the fleet drive puts to work, in the order it opens them.
 *
 * **Four agents, not four sessions on one agent**, and the last one listed is
 * where the drive lands — so its transcript is what the main pane shows. Three
 * runtimes are on screen at once (`sentinel` runs opencode, `scout` codex,
 * `forge`/`atlas` claude-code), which is exactly what this surface's feature
 * card promises: one cockpit, whatever each agent runs on.
 */
const MULTI_SESSION_AGENTS: readonly string[] = ['sentinel', 'forge', 'scout', 'atlas'];
/** The one agent whose turn stops for a permission prompt, so a row reads amber. */
const MULTI_SESSION_APPROVAL_AGENT = 'sentinel';
/** Rotates through the prompt pool so repeated drives mint distinct titles. */
let multiSessionPromptCursor = 0;

/** One agent's live conversation for the fleet drive. */
interface FleetTurn {
  readonly id: string;
  readonly agent: string;
  readonly cwd: string;
  readonly prompt: string;
  readonly scenario: string;
}

/** The turns this drive will run, one per agent, with fresh session ids. */
function planFleetTurns(): FleetTurn[] {
  return MULTI_SESSION_AGENTS.map((agent) => ({
    id: randomUUID(),
    agent,
    cwd: path.join(FLEET_ROOT, agent),
    prompt: MULTI_SESSION_PROMPTS[multiSessionPromptCursor++ % MULTI_SESSION_PROMPTS.length]!,
    scenario: agent === MULTI_SESSION_APPROVAL_AGENT ? 'demo-approval' : 'demo-coding',
  }));
}

/** Trigger one agent's turn through the test-mode seam. */
async function startFleetTurn(turn: FleetTurn): Promise<void> {
  await post('/api/test/scenario', { name: turn.scenario, sessionId: turn.id });
  await post(`/api/sessions/${turn.id}/messages`, { content: turn.prompt, cwd: turn.cwd });
}

/**
 * Drive the fleet moment on the redesigned Now/Today/Library sidebar: start one
 * agent's turn, open that agent from the roster, and repeat down the fleet — so
 * the panel ends up holding four concurrent conversations at once, three
 * streaming green and one stopped amber on a permission prompt, with Now
 * summarising them above ("N working", "sentinel › Waiting on you").
 *
 * Two things about this shape are load-bearing, and both come from the
 * Now/Today/Library redesign (DOR-1066/1068/1071):
 *
 * - **The clicks ARE the drive.** Today's membership is "conversations this
 *   person has been in" (`select-today-items`, BC-15), read from the
 *   interaction record `SidebarChrome.openSession` writes — and the server half
 *   of that key (`userLastMessageAt`) has no source yet. A `page.goto` into a
 *   session therefore leaves no trace: only the one session in the URL would
 *   draw a row, as the anchor. Opening each agent from its roster row (BC-34)
 *   is the product's own path to a populated Today, and the only honest one.
 * - **Turns start one at a time, just before their agent is opened.** Every
 *   click costs a second or two, and a `demo-coding` turn only runs for about
 *   fourteen; launching all four up front left the earliest ones finished
 *   before the still, and long finished before the end of the loop's hold.
 *   Staggering the triggers alongside the clicks keeps every row live through
 *   both.
 *
 * The old drive waited on `[data-testid="session-row"]`, which the redesign
 * stopped mounting in the sidebar entirely — the panel builds its rows from
 * `SidebarRowModel` now (`[data-sidebar-row]`), and `SessionRowFull`/`Compact`
 * survive only on the profile's Sessions page.
 */
export async function driveMultiSession(page: Page): Promise<void> {
  const turns = planFleetTurns();
  await page.goto(url('/'));
  await page.waitForSelector('[data-testid="app-shell"]', { timeout: WAIT_MS });
  await ensureDesktopSidebarExpanded(page);

  for (const turn of turns) {
    await startFleetTurn(turn);
    await sleep(MULTI_SESSION_RESOLVE_MS);
    await page
      .getByRole('button', { name: `Switch to ${turn.agent}` })
      .first()
      .click({ timeout: WAIT_MS });
    // The agent row resumes that agent's newest conversation, which is the turn
    // just started — waiting on its id proves the click landed there rather
    // than on one of the seeded, long-finished sessions.
    await page.waitForURL(new RegExp(`session=${turn.id}`), { timeout: WAIT_MS });
    await sleep(MULTI_SESSION_SETTLE_MS);
  }

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
 * Capture the multi-session cockpit: the Now zone counting the running work and
 * naming what is blocked, over four live conversations in Today.
 */
export async function shootMultiSession(page: Page, theme: Theme, rec: RunRecorder): Promise<void> {
  await driveMultiSession(page);
  await sleep(1500); // let indicators and the viewed transcript fill in
  await shoot(page, 'multi-session', theme, rec);
}
