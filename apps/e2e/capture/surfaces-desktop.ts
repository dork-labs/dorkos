import path from 'path';
import { randomUUID } from 'crypto';
import type { Browser, Page } from '@playwright/test';
import {
  DESKTOP_VIEWPORT,
  DEVICE_SCALE_FACTOR,
  FLEET_ROOT,
  MULTI_SESSION_PROMPTS,
  type Theme,
} from './config.js';
import type { RunRecorder } from './library.js';
import {
  attempt,
  attemptShot,
  ensureDesktopSidebarExpanded,
  isShotSkipped,
  openLiveTurn,
  patch,
  post,
  recordLoop,
  seedThemeOnContext,
  shoot,
  sleep,
  url,
  WAIT_MS,
  type LoopMark,
  type LoopSpec,
} from './lib.js';

/**
 * Desktop surface drives: every 1280×800 still and loop, including the
 * onboarding agent-discovery flow. Each `shootX` waits for its money state
 * before the screenshot; each `driveX` is shared between still and loop.
 *
 * @module capture/surfaces-desktop
 */

/** Capture the cockpit/dashboard home. */
async function shootCockpit(page: Page, theme: Theme, rec: RunRecorder): Promise<void> {
  await page.goto(url('/'));
  await page.waitForSelector('[data-testid="app-shell"]', { timeout: WAIT_MS });
  await page.getByText('Atlas', { exact: false }).first().waitFor({ timeout: WAIT_MS });
  await shoot(page, 'cockpit', theme, rec);
}

/** Capture the fleet/agents list. */
async function shootAgents(page: Page, theme: Theme, rec: RunRecorder): Promise<void> {
  await page.goto(url('/agents?view=list'));
  await page.getByText('Sentinel', { exact: false }).first().waitFor({ timeout: WAIT_MS });
  await shoot(page, 'agents', theme, rec);
}

/** Capture the mesh topology graph. */
async function shootTopology(page: Page, theme: Theme, rec: RunRecorder): Promise<void> {
  await page.goto(url('/agents?view=topology'));
  await page
    .locator('[data-testid="agent-node"], .react-flow__node')
    .first()
    .waitFor({ timeout: WAIT_MS });
  await sleep(1500); // let the ELK/ReactFlow layout settle
  await shoot(page, 'topology', theme, rec);
}

/** Capture the Tasks screen with an expanded run history. */
async function shootTasks(page: Page, theme: Theme, rec: RunRecorder): Promise<void> {
  await page.goto(url('/tasks'));
  await page
    .getByText('Nightly dependency audit', { exact: false })
    .first()
    .waitFor({ timeout: WAIT_MS });
  await page.locator('div[role="button"]', { hasText: 'Nightly dependency audit' }).first().click();
  await page.getByText('No new advisories', { exact: false }).first().waitFor({ timeout: WAIT_MS });
  await shoot(page, 'tasks', theme, rec);
}

/** Capture the in-app marketplace browse view. */
async function shootMarketplace(page: Page, theme: Theme, rec: RunRecorder): Promise<void> {
  await page.goto(url('/marketplace'));
  await page.getByText('code-reviewer', { exact: false }).first().waitFor({ timeout: WAIT_MS });
  await shoot(page, 'marketplace', theme, rec);
}

/**
 * Capture the marketplace package detail sheet: navigating straight to
 * `?pkg=code-reviewer` (the same URL param clicking a card writes) opens it
 * without a click. `code-reviewer` is a real, on-disk fixture package (see
 * `MARKETPLACE_FIXTURE_PACKAGES`), so the sheet's permission preview is a
 * genuine `PermissionPreviewBuilder` result — not installed, so the money
 * state is the "Permissions & Effects" section (a bundled task among its
 * effects) plus the Install action.
 */
async function shootMarketplaceDetail(page: Page, theme: Theme, rec: RunRecorder): Promise<void> {
  await page.goto(url('/marketplace?pkg=code-reviewer'));
  await page
    .getByText('Permissions & Effects', { exact: true })
    .first()
    .waitFor({ timeout: WAIT_MS });
  await page
    .getByText('Schedule task: nightly-code-review', { exact: false })
    .first()
    .waitFor({ timeout: WAIT_MS });
  await shoot(page, 'marketplace-detail', theme, rec);
}

/**
 * Capture the Installed packages panel with a global install plus an
 * agent-scoped install of the same package ("Overrides global") — both real,
 * seeded via `POST /packages/flow/install` (see `seedMarketplaceInstalls` in
 * `seed.ts`). Skipped automatically (via `attemptShot`) if that seeding
 * failed, rather than shooting an empty or faked panel.
 */
async function shootMarketplaceInstalled(
  page: Page,
  theme: Theme,
  rec: RunRecorder
): Promise<void> {
  await page.goto(url('/marketplace?view=installed'));
  await page.getByText('Overrides global', { exact: true }).first().waitFor({ timeout: WAIT_MS });
  await shoot(page, 'marketplace-installed', theme, rec);
}

/**
 * Capture a rich chat turn. Waits for the tool cards and the summary heading so
 * the transcript shows streamed markdown, a code block, and multiple tool
 * cards — a full, inhabited chat surface.
 */
async function shootChatStreaming(page: Page, theme: Theme, rec: RunRecorder): Promise<void> {
  await openLiveTurn(
    page,
    'demo-coding',
    'Add token-bucket rate limiting to the API middleware',
    'atlas'
  );
  await page.locator('[data-testid="tool-call-card"]').first().waitFor({ timeout: WAIT_MS });
  await page
    .getByText("Here's what changed", { exact: false })
    .first()
    .waitFor({ timeout: WAIT_MS });
  await shoot(page, 'chat-streaming', theme, rec);
}

/**
 * Drive the generative-UI hero turn: a short intro sentence streams in, then a
 * `dorkos-ui` fence streams open (the skeleton shows while it's open), closes,
 * and the fleet-status widget draws in. Once the outro lands, scrolls the
 * transcript to the bottom so the whole card — stats, chart, timeline, action
 * buttons — sits in frame with no "new messages" pill. Shared by the still and
 * the loop.
 */
async function driveGenUiWidgets(page: Page, mark?: LoopMark): Promise<void> {
  await openLiveTurn(page, 'demo-gen-ui', 'How is the fleet doing today?', 'atlas');
  // The streaming intro is the money content — start the loop the moment it appears,
  // so the recording carries streaming text → skeleton → widget draw-on.
  await page
    .getByText('Checking on the fleet', { exact: false })
    .first()
    .waitFor({ timeout: WAIT_MS });
  mark?.();
  await page.getByText('Fleet status', { exact: true }).first().waitFor({ timeout: WAIT_MS });
  // The outro is the turn's final content; once it lands the widget is complete.
  await page.getByText('Say the word', { exact: false }).first().waitFor({ timeout: WAIT_MS });
  // The turn anchors to its start, leaving the card's tail below the fold —
  // wheel the transcript to the bottom to frame the full card and buttons.
  await page.mouse.move(640, 400);
  await page.mouse.wheel(0, 2000);
  await sleep(1500); // let the scroll settle and the widget's motion finish
}

/** Capture the generative-UI fleet-status widget (card, stats, chart, timeline, actions). */
async function shootGenUiWidgets(page: Page, theme: Theme, rec: RunRecorder): Promise<void> {
  await driveGenUiWidgets(page);
  await shoot(page, 'gen-ui-widgets', theme, rec);
}

/**
 * The accessible name of the `board` cell the drive clicks — row 3, column 3
 * (1-based, `BoardCell`'s label convention), the square that completes the
 * seeded opening board's main diagonal (`demo-scenario-tictactoe.ts`).
 */
const TICTACTOE_WINNING_CELL_LABEL = 'Row 3, column 3: empty — play here';

/**
 * Drive the tic-tac-toe board end to end: the intro line and the mid-game
 * board stream in and settle (a brief hold lets the "board with a few moves
 * already on" beat read before anything moves), then a REAL click on an empty
 * cell — the same `POST /api/sessions/:id/ui-action` channel a genuine move
 * uses — completes the player's diagonal. The mark draws itself instantly
 * (optimistic placement); the agent's reply streams in with one line of trash
 * talk, the board's win-line stroke, and a celebrating mood face. Shared by
 * the still and the loop; `mark()` (loop only) starts the recording the
 * moment the opening board's content appears, so the loop opens on the same
 * "board mid-render" beat the still never shows.
 */
async function driveTicTacToe(page: Page, mark?: LoopMark): Promise<void> {
  await openLiveTurn(page, 'demo-gen-ui-tictactoe', "Let's finish this one", 'atlas');
  // The intro line is the money content — start the loop the moment it appears, so
  // the recording carries the board's own draw-on, not just the aftermath.
  await page.getByText('Your move', { exact: false }).first().waitFor({ timeout: WAIT_MS });
  mark?.();
  // The outro lands once the board has fully drawn in.
  await page.getByText("Board's set", { exact: false }).first().waitFor({ timeout: WAIT_MS });
  await sleep(1200); // hold on the settled opening board before the click
  await page
    .getByRole('button', { name: TICTACTOE_WINNING_CELL_LABEL })
    .click({ timeout: WAIT_MS });
  // The mood bubble is the reply turn's final content — once it lands, the
  // win-line has already started its draw (it fires on the same mount).
  await page.getByText('Well played', { exact: false }).first().waitFor({ timeout: WAIT_MS });
  await sleep(1500); // let the win-line stroke, mood entrance, and confetti settle
}

/** Capture the tic-tac-toe widget mid-celebration (drawn win-line, celebrating mood face). */
async function shootTicTacToe(page: Page, theme: Theme, rec: RunRecorder): Promise<void> {
  await driveTicTacToe(page);
  await shoot(page, 'gen-ui-tictactoe', theme, rec);
}

/** Capture a tool-approval prompt. */
async function shootToolApproval(page: Page, theme: Theme, rec: RunRecorder): Promise<void> {
  await openLiveTurn(page, 'demo-approval', 'Migrate the auth tokens table', 'atlas');
  await page.locator('[data-testid="tool-approval"]').first().waitFor({ timeout: WAIT_MS });
  await shoot(page, 'tool-approval', theme, rec);
}

/**
 * Seed the right-panel split before navigation, so the panel mounts at the
 * given width. Writes the exact JSON react-resizable-panels persists for
 * `autoSaveId="app-shell-right-panel"`. An init script (not a post-navigation
 * evaluate): a loop runs in a fresh context still on about:blank, where
 * localStorage is an opaque origin and a direct evaluate throws — the init
 * script lands the write before the panel mounts on the real navigation.
 */
async function seedRightPanelSplit(page: Page, rightPct: number): Promise<void> {
  const layout = JSON.stringify({
    'main-content,right-panel': { expandToSizes: {}, layout: [100 - rightPct, rightPct] },
  });
  await page.addInitScript((value) => {
    try {
      localStorage.setItem('react-resizable-panels:app-shell-right-panel', value);
    } catch {
      // about:blank opaque origin — the write lands on the real navigation.
    }
  }, layout);
}

/**
 * Canvas right-panel split (founder art direction: the document needs a
 * genuinely readable column, not a sliver — 45% ≈ 576px at the 1280px capture
 * viewport).
 */
const CANVAS_PANEL_PCT = 45;

/** Drive the canvas open beside chat (shared by the still and the loop). */
async function driveCanvasOpen(page: Page): Promise<void> {
  await seedRightPanelSplit(page, CANVAS_PANEL_PCT);
  await openLiveTurn(
    page,
    'demo-canvas',
    'Write up the rate-limiting design in the canvas',
    'atlas'
  );
  await page.locator('[data-slot="canvas"]').first().waitFor({ timeout: WAIT_MS });
  await sleep(1200); // let the canvas content stream in
}

/** Capture the canvas open beside chat with a document. */
async function shootCanvas(page: Page, theme: Theme, rec: RunRecorder): Promise<void> {
  await driveCanvasOpen(page);
  await shoot(page, 'canvas', theme, rec);
}

/** Interval between keystrokes while typing into the canvas editor. */
const TYPE_DELAY_MS = 55;

/**
 * Drive a real edit of the file-backed canvas document: enter edit mode via the
 * pencil control, place the cursor at the end, and type a new markdown section
 * (Milkdown converts the `## ` and `- ` shorthands live). Autosave persists it
 * through `PUT /api/files/content` — a genuine Notion-style editing moment.
 */
async function driveCanvasEditing(page: Page, mark?: LoopMark): Promise<void> {
  await driveCanvasOpen(page);
  await page.getByRole('button', { name: 'Edit document' }).click();
  const editor = page.locator(
    '[data-slot="canvas"] .ProseMirror, [data-slot="canvas"] [contenteditable="true"]'
  );
  await editor.first().waitFor({ timeout: WAIT_MS });
  // The typing is the money content — start the loop here, before the keystrokes.
  mark?.();
  // Land the cursor in the last block, then jump to the document end.
  await editor.first().locator('> *:last-child').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('## Open questions', { delay: TYPE_DELAY_MS });
  await page.keyboard.press('Enter');
  await page.keyboard.type('Should the bucket be per-route or global? ', { delay: TYPE_DELAY_MS });
  await page.keyboard.type('Per-route needs a **budget registry** first.', {
    delay: TYPE_DELAY_MS,
  });
}

/** Capture the canvas mid-edit (editor active, freshly typed section visible). */
async function shootCanvasEditing(page: Page, theme: Theme, rec: RunRecorder): Promise<void> {
  await driveCanvasEditing(page);
  await shoot(page, 'canvas-editing', theme, rec);
}

/**
 * Open the shell's right panel when it isn't already — Files/Canvas/Terminal
 * tabs are always in the DOM (see `RightPanelContainer`) but collapsed to zero
 * width, and unlike the canvas/personality drives, opening Files has no
 * server-pushed `ui_command` to reveal the panel for us.
 */
async function ensureRightPanelOpen(page: Page): Promise<void> {
  const openButton = page.getByRole('button', { name: 'Open right panel' });
  if (await openButton.count()) {
    await openButton.click();
  }
}

/**
 * Drive the Workbench money shot: open the Files tab, expand the seeded
 * `src/` folder, and click `rate-limiter.ts` — the same `open_file` ui-action
 * the agent's own file tool and chat-triggered opens use — which switches the
 * active right-panel tab to Canvas and renders the file read-only in
 * CodeMirror, tab strip still visible above it. The chat turn runs
 * `demo-rate-limiter-explainer` (a real short explanation, not the generic
 * `simple-text` echo stub) so the visible reply reads as substantive.
 */
async function driveWorkbench(page: Page): Promise<void> {
  await seedRightPanelSplit(page, CANVAS_PANEL_PCT);
  await openLiveTurn(
    page,
    'demo-rate-limiter-explainer',
    'Walk me through the rate limiter you added',
    'atlas'
  );
  // Wait for the reply's closing clause so the still shows the complete
  // streamed answer, not a mid-stream fragment.
  await page
    .getByText('no new infra to stand up', { exact: false })
    .first()
    .waitFor({ timeout: WAIT_MS });
  await ensureRightPanelOpen(page);
  await page.getByRole('tab', { name: 'Files' }).click({ timeout: WAIT_MS });
  const srcFolder = page.getByRole('treeitem', { name: 'src' });
  await srcFolder.waitFor({ timeout: WAIT_MS });
  await srcFolder.click();
  const file = page.getByRole('treeitem', { name: 'rate-limiter.ts' });
  await file.waitFor({ timeout: WAIT_MS });
  await file.click();
  await page.locator('[data-slot="canvas"] .cm-content').first().waitFor({ timeout: WAIT_MS });
  await page.getByText('takeToken', { exact: false }).first().waitFor({ timeout: WAIT_MS });
  await sleep(800); // let CodeMirror's syntax highlighting settle
}

/** Capture the Workbench: Files tab open, `src/` expanded, a code file open in Canvas. */
async function shootWorkbench(page: Page, theme: Theme, rec: RunRecorder): Promise<void> {
  await driveWorkbench(page);
  await shoot(page, 'workbench', theme, rec);
}

/** Open Settings → DorkOS account, link, and shoot the pending then linked states. */
async function shootCloudLink(page: Page, theme: Theme, rec: RunRecorder): Promise<void> {
  await page.goto(url('/agents?settings=account'));
  // The tabpanel holds two "DorkOS account" headings — the navigation panel
  // title (h3) and CloudLinkPanel's own heading (the only h2) — so pin the
  // settle wait to heading level 2 to stay strict-safe.
  const panel = page.getByRole('tabpanel', { name: 'DorkOS account' });
  await panel
    .getByRole('heading', { name: 'DorkOS account', level: 2 })
    .waitFor({ timeout: WAIT_MS });
  await panel.getByRole('button', { name: 'Link this instance' }).click({ timeout: WAIT_MS });

  // Pending: the code + the "waiting" status render immediately (optimistic).
  await panel
    .getByText('Waiting for you to approve', { exact: false })
    .waitFor({ timeout: WAIT_MS });
  await shoot(page, 'accounts-pending', theme, rec);

  // Linked: the fake auto-flips; the client's 2500ms status poll lands "Linked"
  // within a couple of ticks. Wait the money state — no arbitrary sleep.
  await panel.getByText('Linked', { exact: true }).waitFor({ timeout: WAIT_MS });
  await panel.getByText('Dork Labs', { exact: false }).waitFor({ timeout: WAIT_MS });
  await shoot(page, 'accounts-linked', theme, rec);
}

/**
 * Drive the fan-out turn with three concurrently running sub-agents and wait
 * until all three blocks are on screen and reporting activity. Expands the
 * first block so its live "Last tool" line is visible.
 */
async function driveSubagents(page: Page): Promise<void> {
  await openLiveTurn(
    page,
    'demo-subagents',
    'Run the weekly hygiene sweep across server, client, and docs',
    'atlas'
  );
  await page.locator('[data-testid="subagent-block"]').nth(2).waitFor({ timeout: WAIT_MS });
  await page.locator('[data-testid="subagent-block"] button').first().click();
  // Let a few progress beats land so tool counts and "Last tool" lines show.
  await sleep(2500);
}

/** Capture the sub-agents surface (three running agent blocks). */
async function shootSubagents(page: Page, theme: Theme, rec: RunRecorder): Promise<void> {
  await driveSubagents(page);
  await shoot(page, 'subagents', theme, rec);
}

/** Stagger between concurrent multi-session turn triggers. */
const MULTI_SESSION_STAGGER_MS = 700;
/** How many concurrent sessions each multi-session drive launches. */
const MULTI_SESSION_COUNT = 4;
/** Rotates through the prompt pool so repeated drives mint distinct titles. */
let multiSessionPromptCursor = 0;

/**
 * Drive the fleet moment: launch four concurrent turns (three coding streams +
 * one approval-blocked) across separate sessions, THEN open the session view
 * with the sidebar visible — the freshly mounted list includes every new row,
 * pulsing green and amber while the turns stream. (Triggers come first because
 * an already-mounted list does not grow rows for brand-new sessions.)
 */
async function driveMultiSession(page: Page): Promise<void> {
  const cwd = path.join(FLEET_ROOT, 'atlas');
  const prompts = Array.from(
    { length: MULTI_SESSION_COUNT },
    () => MULTI_SESSION_PROMPTS[multiSessionPromptCursor++ % MULTI_SESSION_PROMPTS.length]!
  );
  const sessions = prompts.map((prompt, i) => ({
    id: randomUUID(),
    prompt,
    // The last session blocks on an approval so one row pulses amber, not green.
    scenario: i === MULTI_SESSION_COUNT - 1 ? 'demo-approval' : 'demo-coding',
  }));
  for (const s of sessions) {
    await post('/api/test/scenario', { name: s.scenario, sessionId: s.id });
  }
  for (const s of sessions) {
    await post(`/api/sessions/${s.id}/messages`, { content: s.prompt, cwd });
    await sleep(MULTI_SESSION_STAGGER_MS);
  }

  const first = sessions[0]!;
  await page.goto(url(`/session?session=${first.id}&dir=${encodeURIComponent(cwd)}`));
  await page.waitForSelector('[data-testid="chat-panel"]', { timeout: WAIT_MS });
  await ensureDesktopSidebarExpanded(page);
  // All four rows present in the freshly mounted, expanded list.
  await page
    .locator('[data-testid="session-row"]')
    .nth(MULTI_SESSION_COUNT - 1)
    .waitFor({ timeout: WAIT_MS });
}

/** Capture the multi-session cockpit (sidebar alive with concurrent streams). */
async function shootMultiSession(page: Page, theme: Theme, rec: RunRecorder): Promise<void> {
  await driveMultiSession(page);
  await sleep(1500); // let indicators and the viewed transcript fill in
  await shoot(page, 'multi-session', theme, rec);
}

/** Pause between personality preset selections so each radar morph reads fully. */
const PERSONALITY_MORPH_MS = 1600;

/**
 * Personality right-panel split (founder art direction: the radar reads far
 * better with a generous right column — 35% ≈ 448px at the 1280px capture
 * viewport).
 */
const PERSONALITY_PANEL_PCT = 35;

/**
 * Drive the agent personality picker: seed a wide right-panel split, open
 * Atlas's profile panel via its Manage control, open the personality picker
 * (the animated radar), and step through presets so the visualization morphs
 * and flashes in response. Ends on a vivid preset.
 */
async function drivePersonality(page: Page, mark?: LoopMark): Promise<void> {
  await seedRightPanelSplit(page, PERSONALITY_PANEL_PCT);
  await page.goto(url('/agents?view=list'));
  // The agent-hub panel binds to the agent whose Manage control opened it —
  // a bare ?agent= URL param resolves against the default cwd instead.
  await page.getByRole('button', { name: 'Manage atlas' }).click({ timeout: WAIT_MS });
  await page
    .locator('[data-testid="personality-picker-trigger"]')
    .first()
    .click({ timeout: WAIT_MS });
  await page.locator('[data-testid="personality-radar"]').first().waitFor({ timeout: WAIT_MS });
  const pills = page.locator('[data-testid="preset-pills"]');
  await pills.waitFor({ timeout: WAIT_MS });
  // The radar morphs are the money content — start the loop on the settled
  // radar, just before the preset clicks drive it.
  mark?.();
  for (const preset of [/hotshot/i, /sage/i, /mad scientist/i]) {
    await pills.getByRole('button', { name: preset }).click();
    await sleep(PERSONALITY_MORPH_MS);
  }
}

/** Capture the personality picker settled on a vivid preset. */
async function shootPersonality(page: Page, theme: Theme, rec: RunRecorder): Promise<void> {
  await drivePersonality(page);
  await shoot(page, 'personality', theme, rec);
}

/**
 * Drive the onboarding wizard to the agent-discovery step and let the real
 * unified scanner sweep the seeded projects tree until the mixed-harness
 * candidates are on screen. Requires onboarding to be un-dismissed first.
 */
async function driveOnboardingDiscovery(page: Page): Promise<void> {
  // With onboarding un-dismissed the wizard replaces the app shell entirely,
  // so the boot signal is the welcome screen itself.
  await page.goto(url('/'));
  // Welcome → Requirements → Meet DorkBot → Discovery. Meet DorkBot is
  // advanced via the nav bar's Skip: its Continue writes DorkBot traits under
  // the DorkOS home, which sits outside the capture-world boundary.
  await page.getByText('Get Started', { exact: true }).first().click({ timeout: WAIT_MS });
  await page.getByText('Continue', { exact: true }).first().click({ timeout: WAIT_MS });
  await page.getByText('Skip', { exact: true }).first().click({ timeout: WAIT_MS });
  // The discovery step auto-starts its scan; wait for the seeded fleet.
  await page.locator('[data-slot="candidate-card"]').nth(3).waitFor({ timeout: WAIT_MS });
  await sleep(800); // let the remaining candidate cards animate in
}

/**
 * Capture the onboarding agent-discovery surface: the light still plus the dark
 * loop (whose poster is extracted from the loop's own first frame). Runs last —
 * it flips the global onboarding state, drives the wizard, then restores the
 * dismissed state for reproducibility.
 */
export async function captureAgentDiscovery(browser: Browser, rec: RunRecorder): Promise<void> {
  // Skip when this shot is not ours to capture — a human override supplies it,
  // or it belongs to another shard. Either way, don't flip global onboarding.
  if (isShotSkipped('agent-discovery')) {
    process.stdout.write('  ⤿ agent-discovery skipped (captured elsewhere)\n');
    return;
  }
  const reopenOnboarding = () =>
    patch('/api/config', {
      onboarding: { dismissedAt: null, completedSteps: [], skippedSteps: [] },
    });
  const dismissOnboarding = () =>
    patch('/api/config', { onboarding: { dismissedAt: '2026-07-01T00:00:00.000Z' } });

  try {
    await attempt('agent-discovery-light', async () => {
      await reopenOnboarding();
      const ctx = await browser.newContext({
        viewport: DESKTOP_VIEWPORT,
        deviceScaleFactor: DEVICE_SCALE_FACTOR,
        reducedMotion: 'reduce',
      });
      await seedThemeOnContext(ctx, 'light');
      try {
        const page = await ctx.newPage();
        await driveOnboardingDiscovery(page);
        await shoot(page, 'agent-discovery', 'light', rec);
      } finally {
        await ctx.close();
      }
    });
    await attempt('agent-discovery-loop', async () => {
      await reopenOnboarding();
      await recordLoop(
        browser,
        { surface: 'agent-discovery', durationMs: 3500, drive: driveOnboardingDiscovery },
        rec
      );
    });
  } finally {
    await dismissOnboarding();
  }
}

/**
 * Capture the desktop light stills in a single themed context. The site's
 * ProductFrame consumes light stills for every surface and dark PNGs only as
 * loop posters — and those posters are now extracted from each loop's own first
 * frame — so there is no separate dark-still pass.
 */
export async function captureLightStills(browser: Browser, rec: RunRecorder): Promise<void> {
  const theme: Theme = 'light';
  const ctx = await browser.newContext({
    viewport: DESKTOP_VIEWPORT,
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
    reducedMotion: 'reduce',
  });
  await seedThemeOnContext(ctx, theme);
  const page = await ctx.newPage();
  await attemptShot('cockpit', 'cockpit-light', () => shootCockpit(page, theme, rec));
  await attemptShot('agents', 'agents-light', () => shootAgents(page, theme, rec));
  await attemptShot('tasks', 'tasks-light', () => shootTasks(page, theme, rec));
  await attemptShot('marketplace', 'marketplace-light', () => shootMarketplace(page, theme, rec));
  await attemptShot('marketplace-detail', 'marketplace-detail-light', () =>
    shootMarketplaceDetail(page, theme, rec)
  );
  await attemptShot('marketplace-installed', 'marketplace-installed-light', () =>
    shootMarketplaceInstalled(page, theme, rec)
  );
  await attemptShot('tool-approval', 'tool-approval-light', () =>
    shootToolApproval(page, theme, rec)
  );
  await attemptShot('topology', 'topology-light', () => shootTopology(page, theme, rec));
  await attemptShot('chat-streaming', 'chat-streaming-light', () =>
    shootChatStreaming(page, theme, rec)
  );
  await attemptShot('gen-ui-widgets', 'gen-ui-widgets-light', () =>
    shootGenUiWidgets(page, theme, rec)
  );
  await attemptShot('gen-ui-tictactoe', 'gen-ui-tictactoe-light', () =>
    shootTicTacToe(page, theme, rec)
  );
  await attemptShot('subagents', 'subagents-light', () => shootSubagents(page, theme, rec));
  await attemptShot('multi-session', 'multi-session-light', () =>
    shootMultiSession(page, theme, rec)
  );
  await attemptShot('personality', 'personality-light', () => shootPersonality(page, theme, rec));
  // Canvas (and Files/Canvas workbench) surfaces run last: opening the right
  // panel pins it open (per-agent, persisted) for the rest of the context,
  // which would bleed an open panel into later shots.
  await attemptShot('canvas', 'canvas-light', () => shootCanvas(page, theme, rec));
  await attemptShot('canvas-editing', 'canvas-editing-light', () =>
    shootCanvasEditing(page, theme, rec)
  );
  await attemptShot('workbench', 'workbench-light', () => shootWorkbench(page, theme, rec));
  // Runs last: linking persists a token into the isolated capture config, and
  // running last keeps that state from bleeding into any earlier surface.
  // The guard keys on `accounts-pending` for the WHOLE single-flow pair —
  // both stills ride one drive (and one shard-0 pin), so one check decides both.
  if (!isShotSkipped('accounts-pending')) {
    await attempt('accounts (pending→linked)', () => shootCloudLink(page, theme, rec));
  }
  await ctx.close();
}

/** Record the dynamic-moment desktop loops. */
export async function captureLoops(browser: Browser, rec: RunRecorder): Promise<void> {
  const specs: LoopSpec[] = [
    {
      surface: 'chat-streaming',
      durationMs: 8000,
      drive: async (page) => {
        await openLiveTurn(
          page,
          'demo-coding',
          'Add token-bucket rate limiting to the API middleware',
          'atlas'
        );
        await page.locator('[data-testid="tool-call-card"]').first().waitFor({ timeout: WAIT_MS });
      },
    },
    {
      surface: 'topology',
      durationMs: 6000,
      drive: async (page) => {
        await page.goto(url('/agents?view=topology'));
        await page
          .locator('[data-testid="agent-node"], .react-flow__node')
          .first()
          .waitFor({ timeout: WAIT_MS });
      },
    },
    {
      surface: 'canvas',
      durationMs: 7000,
      drive: driveCanvasOpen,
    },
    // Intro text streaming into a `dorkos-ui` fence, skeleton, then the
    // fleet-status widget drawing in (stats, chart, timeline, actions). The
    // drive itself carries the motion (streaming → skeleton → draw-on →
    // scroll-to-frame), so the post-drive hold is a short settled beat.
    {
      surface: 'gen-ui-widgets',
      durationMs: 3000,
      drive: driveGenUiWidgets,
    },
    // The board settles, a real click completes the diagonal, and the reply
    // streams in with the win-line stroke and a celebrating mood face — an
    // extra tail hold lets the confetti and mood idle fully play out.
    {
      surface: 'gen-ui-tictactoe',
      durationMs: 2200,
      drive: driveTicTacToe,
    },
    // The fleet money shot: sidebar rows pulsing while four sessions stream.
    {
      surface: 'multi-session',
      durationMs: 11000,
      drive: driveMultiSession,
    },
    // Three sub-agents fanning out, reporting tools, and settling one by one
    // (drive expands the first block so its live "Last tool" line updates on
    // camera).
    {
      surface: 'subagents',
      durationMs: 9000,
      drive: driveSubagents,
    },
    // A real edit landing in the canvas editor, keystroke by keystroke.
    {
      surface: 'canvas-editing',
      durationMs: 3000,
      drive: driveCanvasEditing,
    },
    // The personality radar morphing through presets (drive performs the
    // clicks, so the recording carries every morph + flash).
    {
      surface: 'personality',
      durationMs: 2500,
      drive: drivePersonality,
    },
  ];
  for (const spec of specs) {
    await attemptShot(spec.surface, `${spec.surface}-loop`, () => recordLoop(browser, spec, rec));
  }
}
