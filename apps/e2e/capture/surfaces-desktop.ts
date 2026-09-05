import type { Browser, Page } from '@playwright/test';
import { DESKTOP_VIEWPORT, DEVICE_SCALE_FACTOR, type Theme } from './config.js';
import type { RunRecorder } from './library.js';
import {
  attempt,
  attemptShot,
  isShotSkipped,
  openLiveTurn,
  patch,
  recordLoop,
  seedThemeOnContext,
  shoot,
  sleep,
  url,
  waitForAppShell,
  WAIT_MS,
  type LoopMark,
  type LoopSpec,
} from './lib.js';
import { driveMultiSession, shootMultiSession } from './surfaces-desktop-fleet.js';
import { shootControlCenter, shootSettingsRooms } from './surfaces-desktop-power.js';
import { shootRoomFiles } from './surfaces-desktop-rooms.js';
import { shootTaskRuntimePicker } from './surfaces-desktop-tasks.js';

/**
 * Desktop surface drives: every 1280×800 still and loop, including the
 * onboarding agent-discovery flow. Each `shootX` waits for its money state
 * before the screenshot; each `driveX` is shared between still and loop.
 *
 * Two groups live in sibling modules, both driven from the capture entry points
 * below: the power surfaces (Control Center, Settings → Rooms, the full-power
 * door) in `surfaces-desktop-power`, and the four-agent fleet drive behind
 * `multi-session` in `surfaces-desktop-fleet`.
 *
 * @module capture/surfaces-desktop
 */

/**
 * Capture the cockpit home — the #team room.
 *
 * **This shot currently ships an EMPTY room** ("Nothing said here yet"), and
 * that is a known gap, not the intended frame. Nothing in `seed.ts` puts
 * entries in #team, and nothing can directly: `POST /api/rooms/:id/entries`
 * forces `authorId` to the calling person, so an agent-authored entry only
 * exists as the output of a real turn `RoomTriggerDispatcher` ran.
 * Inhabiting this room therefore means DRIVING it — post as the person and let
 * the default agent's fallback seat answer (`team-room-home` 2.2) — the same
 * shape as `openLiveTurn`, and it needs the test-mode runtime's room-turn
 * behavior confirmed first. Until then the shot is honest but unflattering, and
 * it violates the README's "inhabited app" art direction.
 */
async function shootCockpit(page: Page, theme: Theme, rec: RunRecorder): Promise<void> {
  await page.goto(url('/'));
  await waitForAppShell(page);
  // The composer, not a seeded agent's name: Home is a room now
  // (`team-room-home` D3.2), so the money state is "the room has drawn" rather
  // than "the activity feed has an agent in it".
  await page.waitForSelector('[data-testid="home-composer"]', { timeout: WAIT_MS });
  await shoot(page, 'cockpit', theme, rec);
}

/** Capture the fleet/agents list. */
async function shootAgents(page: Page, theme: Theme, rec: RunRecorder): Promise<void> {
  await page.goto(url('/team?view=table'));
  await page.getByText('Sentinel', { exact: false }).first().waitFor({ timeout: WAIT_MS });
  await shoot(page, 'agents', theme, rec);
}

/** Capture the mesh topology graph. */
async function shootTopology(page: Page, theme: Theme, rec: RunRecorder): Promise<void> {
  await page.goto(url('/team?view=topology'));
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
  // Cards render the humanized display label (`packageDisplayLabel`), not the
  // raw slug, so wait for "Code Reviewer" — the rendered name of the
  // `code-reviewer` fixture — not its id (#371).
  await page.getByText('Code Reviewer', { exact: false }).first().waitFor({ timeout: WAIT_MS });
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
  // The scheduled-job row shows the bare job name (`schedule.name`), not a
  // "Schedule task: " prefix — DOR-635 (#552) dropped the prefix in favor of a
  // "Jobs it will schedule" section heading. Filtered to the visible match: the
  // install preview’s collapsed file list (DOR-1339) also renders that job’s
  // path, and the hidden `<span>` holding it sorts ahead of the row.
  await page
    .getByText('nightly-code-review', { exact: false })
    .filter({ visible: true })
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
 * Canvas right-panel split (founder art direction: chat keeps the wider column,
 * the document gets a genuinely readable one — 45% ≈ 576px at the 1280px capture
 * viewport).
 *
 * This was 58% for one release, to dodge two product bugs rather than shoot them:
 * the six-tab strip left the active Canvas tab's label clipped at 45% (DOR-471),
 * and the composer's status line landed on the `full` tier's 640px floor where
 * items painted over each other (DOR-461). Both are fixed — the strip now scrolls
 * the selected tab into view, and no status item can render outside its own box —
 * so the split is back where the art direction wanted it.
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
  // `?settings=account` is a legacy id since DOR-1758 — the map lands it on the
  // Access tab, scrolled to its account section — so the PANEL is Access and the
  // "DorkOS account" heading is that section's.
  await page.goto(url('/team?settings=account'));
  const panel = page.getByRole('tabpanel', { name: 'Access' });
  await panel.getByRole('heading', { name: 'DorkOS account' }).waitFor({ timeout: WAIT_MS });
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
 * Atlas's profile from the Team table, open the Personality row's picker (the
 * animated radar), and step through presets so the visualization morphs and
 * flashes in response. Ends on a vivid preset.
 */
async function drivePersonality(page: Page, mark?: LoopMark): Promise<void> {
  await seedRightPanelSplit(page, PERSONALITY_PANEL_PCT);
  await page.goto(url('/team?view=table'));
  // The docked profile binds to the agent whose row action opened it — a bare
  // ?agent= URL param resolves against the default cwd instead.
  // Scoped to the table row: the sidebar carries its own "Open atlas’s
  // profile" control, and the sidebar entry’s composed accessible name now
  // contains that string too (the Asks work, DOR-1330, appends "Awaiting your
  // approval"), so an unscoped match went from one element to three.
  await page
    .getByRole('row')
    .getByRole('button', { name: 'Open atlas\u2019s profile', exact: true })
    .click({ timeout: WAIT_MS });
  // Personality is a row on the profile's root that opens a popover, and its
  // accessible name carries the current archetype after the label — hence the
  // prefix match rather than an exact one.
  await page
    .getByRole('button', { name: /^Personality/ })
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
 * Drive the onboarding conversation to the agent-discovery beat and let the real
 * unified scanner sweep the seeded projects tree until the mixed-harness
 * candidates are on screen. Requires onboarding to be un-dismissed first.
 *
 * Three things shape this drive, all from the conversational redesign
 * (ADR 260722-111314/111315) that left it broken between DOR-460 and DOR-472:
 *
 * - **It routes past the personality beat by skipping it, never by confirming
 *   it.** DOR-472 gave that beat a real "Skip this step" control
 *   (`skip-personality`), which advances one beat and — unlike
 *   `confirm-personality` — writes no traits. So this drive never touches
 *   DorkBot's on-disk manifest, the write whose confinement to the sandboxed
 *   `DORK_HOME` was never confirmed and which is why the previous pass refused
 *   to drive through here.
 * - **It routes past the profile beat the same way.** DOR-705 inserted
 *   `'profile'` into `BEAT_ORDER` between `'personality'` and `'discovery'`,
 *   so a drive that stops skipping at `skip-personality` now stalls waiting
 *   for a discovery consent chip the conversation never reaches; `skip-profile`
 *   advances past it without writing a role.
 * - **Discovery is consent-first**, so the scan starts on "Sure, look around",
 *   not on arrival at the beat.
 *
 * Verified in a real browser through the consent chips (DOR-472). The candidate
 * wait after consent is the pre-redesign recipe, carried forward unchanged: it
 * depends on the seeded `DISCOVERY_PROJECTS` tree, not on the flow.
 *
 * A timeout here costs one run and only one run. `WAIT_MS` (20s) outlives the
 * beat's own `DISCOVERY_TIMEOUT_MS` (8s), so a scan slower than 8s makes the app
 * hand the conversation off to the handoff beat — which writes `completedAt` —
 * while this wait spends its remaining budget on cards that will never arrive.
 * `attempt` records that failure and the shot keeps its last asset. The next run
 * starts clean because `reopenOnboarding` clears `completedAt` too, so the
 * overlay genuinely reopens rather than inheriting a finished onboarding.
 */
async function driveOnboardingDiscovery(page: Page): Promise<void> {
  // With onboarding un-dismissed the wizard replaces the app shell entirely,
  // so the boot signal is the welcome screen itself.
  await page.goto(url('/'));
  await page.getByText('Get Started', { exact: true }).first().click({ timeout: WAIT_MS });
  // The ready-state CTA reads "Meet DorkBot"; its testid predates that copy.
  await page.getByTestId('onboarding-get-started').click({ timeout: WAIT_MS });
  // The power stage (DOR-1431) sits between the readiness check and the DorkBot
  // conversation. "Decide later" advances without writing a power choice, the
  // same no-write routing as the two skips below.
  await page.getByTestId('onboarding-power-decide-later').click({ timeout: WAIT_MS });
  await page.getByTestId('skip-personality').click({ timeout: WAIT_MS });
  await page.getByTestId('skip-profile').click({ timeout: WAIT_MS });
  await page.getByText('Sure, look around', { exact: true }).click({ timeout: WAIT_MS });
  await page.locator('[data-slot="candidate-card"]').nth(3).waitFor({ timeout: WAIT_MS });
  await sleep(800); // let the remaining candidate cards animate in
}

/**
 * Capture the onboarding agent-discovery surface: the light still plus the dark
 * loop (whose poster is extracted from the loop's own first frame). One of the
 * run's two closing drives (the full-power door is the other) — it flips the
 * global onboarding state, drives the wizard, then restores the dismissed state
 * for reproducibility, so it goes after every shot that reads that state.
 */
export async function captureAgentDiscovery(browser: Browser, rec: RunRecorder): Promise<void> {
  // Skip when this shot is not ours to capture — a human override supplies it,
  // or it belongs to another shard. Either way, don't flip global onboarding.
  if (isShotSkipped('agent-discovery')) {
    process.stdout.write('  ⤿ agent-discovery skipped (captured elsewhere)\n');
    return;
  }
  // Mirrors the "Replay setup" reset in `PreferencesTab`: `completedAt` is the
  // authoritative "onboarding is done" gate, so clearing `dismissedAt` alone
  // leaves the overlay shut for good once any run reaches the handoff beat.
  const reopenOnboarding = () =>
    patch('/api/config', {
      onboarding: {
        completedSteps: [],
        skippedSteps: [],
        startedAt: null,
        dismissedAt: null,
        completedAt: null,
      },
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
  await attemptShot('control-center', 'control-center-light', () =>
    shootControlCenter(page, theme, rec)
  );
  await attemptShot('settings-rooms', 'settings-rooms-light', () =>
    shootSettingsRooms(page, theme, rec)
  );
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
  await attemptShot('room-files', 'room-files-light', () => shootRoomFiles(page, theme, rec));
  await attemptShot('task-runtime-picker', 'task-runtime-picker-light', () =>
    shootTaskRuntimePicker(page, theme, rec)
  );
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
        await page.goto(url('/team?view=topology'));
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
