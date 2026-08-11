import path from 'path';
import { randomUUID } from 'crypto';
import type { Browser, Page } from '@playwright/test';
import {
  FLEET_ROOT,
  MOBILE_SCALE_FACTOR,
  MOBILE_VIDEO_SIZE,
  MOBILE_VIEWPORT,
  type Theme,
} from './config.js';
import type { RunRecorder } from './library.js';
import {
  attemptShot,
  mintVideoDir,
  openLiveTurn,
  post,
  seedThemeOnContext,
  SETTLE_MS,
  sleep,
  url,
  WAIT_MS,
} from './lib.js';

/**
 * Mobile surface drives: 390×844 @3x stills of the session list, a streaming
 * chat, and a tool approval, plus the recorded mobile chat loop.
 *
 * @module capture/surfaces-mobile
 */

/** Duration of the recorded mobile chat loop. */
const MOBILE_LOOP_MS = 9000;

/** Open a fresh mobile browser context (390×844 @3x, touch). */
async function newMobileContext(browser: Browser, options?: { video?: boolean }) {
  return browser.newContext({
    viewport: MOBILE_VIEWPORT,
    deviceScaleFactor: MOBILE_SCALE_FACTOR,
    isMobile: true,
    hasTouch: true,
    ...(options?.video
      ? { recordVideo: { dir: mintVideoDir(), size: MOBILE_VIDEO_SIZE } }
      : { reducedMotion: 'reduce' as const }),
  });
}

/** Pause after a turn is triggered, so the roster can resolve it as that agent's newest. */
const MOBILE_RESOLVE_MS = 1200;

/** The two agents the phone drive puts to work — the last one opened lands on screen. */
const MOBILE_FLEET: readonly { agent: string; prompt: string; scenario: string }[] = [
  { agent: 'scout', prompt: 'Rotate the webhook signing secret', scenario: 'demo-approval' },
  { agent: 'atlas', prompt: 'Ship the retry-queue fix and rerun CI', scenario: 'demo-coding' },
];

/**
 * Slide the sidebar sheet open and wait until it is really up.
 *
 * On a phone the sidebar is a sheet (`data-mobile="true"`), and it closes
 * itself on any navigation — so every pass through the drive has to open it
 * again rather than assume it stayed.
 */
async function openMobileSidebar(page: Page): Promise<void> {
  await page.locator('[data-sidebar="trigger"]').first().tap();
  await page.locator('[data-mobile="true"]').first().waitFor({ timeout: WAIT_MS });
  await sleep(500); // let the sheet finish sliding in
}

/**
 * Drive the phone's session sheet: start one agent's turn, open that agent from
 * the sheet's roster, and repeat — so the sheet ends up showing Now (what is
 * running, and who stopped to ask) over the two live conversations in Today,
 * one green and one amber.
 *
 * Same two rules as the desktop fleet drive (`driveMultiSession`), for the same
 * reasons: a conversation only earns a Today row once this person has opened it
 * from the panel, and each turn is triggered just before its agent is opened so
 * both rows are still live when the shutter falls. The extra wrinkle here is
 * that tapping a row navigates, and navigating closes the sheet — so the sheet
 * is re-opened for each agent, and once more at the end for the shot itself.
 */
async function driveMobileSessions(page: Page): Promise<void> {
  await page.goto(url('/'));
  await page.waitForSelector('[data-testid="app-shell"]', { timeout: WAIT_MS });
  for (const entry of MOBILE_FLEET) {
    const id = randomUUID();
    const cwd = path.join(FLEET_ROOT, entry.agent);
    await post('/api/test/scenario', { name: entry.scenario, sessionId: id });
    await post(`/api/sessions/${id}/messages`, { content: entry.prompt, cwd });
    await sleep(MOBILE_RESOLVE_MS);
    await openMobileSidebar(page);
    await page
      .getByRole('button', { name: `Switch to ${entry.agent}` })
      .first()
      .tap({ timeout: WAIT_MS });
    await page.waitForURL(new RegExp(`session=${id}`), { timeout: WAIT_MS });
    await sleep(600);
  }
  await openMobileSidebar(page);
  await page
    .locator('[data-sidebar-zone="today"] [data-sidebar-row]')
    .nth(MOBILE_FLEET.length - 1)
    .waitFor({ timeout: WAIT_MS });
  // Opening a conversation scrolls its Today row into view; put Now back on
  // top so the sheet reads from the summary down to the rows it summarises.
  await page.locator('[data-sidebar-zone="now"]').first().scrollIntoViewIfNeeded();
  await sleep(400);
}

/** Drive a streaming coding turn on the phone (shared by still and loop). */
async function driveMobileChat(page: Page): Promise<void> {
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
}

/** Drive a tool-approval prompt on the phone. */
async function driveMobileApproval(page: Page): Promise<void> {
  await openLiveTurn(page, 'demo-approval', 'Migrate the auth tokens table', 'atlas');
  await page.locator('[data-testid="tool-approval"]').first().waitFor({ timeout: WAIT_MS });
}

/** Shoot one raw mobile still into the run under the given surface name. */
async function shootMobile(
  page: Page,
  surface: string,
  theme: Theme,
  rec: RunRecorder
): Promise<void> {
  await sleep(SETTLE_MS);
  const buffer = await page.screenshot({ type: 'png' });
  await rec.saveStill(buffer, surface, theme);
  process.stdout.write(`  ✓ raw ${surface}-${theme}.png\n`);
}

/** Record the raw mobile chat loop (dark, 390×844). */
async function recordMobileChatLoop(browser: Browser, rec: RunRecorder): Promise<void> {
  const ctx = await newMobileContext(browser, { video: true });
  await seedThemeOnContext(ctx, 'dark');
  const page = await ctx.newPage();
  const video = page.video();
  const startedAt = Date.now();
  let headTrimMs = 0;
  try {
    await openLiveTurn(
      page,
      'demo-coding',
      'Add token-bucket rate limiting to the API middleware',
      'atlas'
    );
    await page.locator('[data-testid="tool-call-card"]').first().waitFor({ timeout: WAIT_MS });
    // The stream ramps on camera during the hold; trim the navigation before it.
    headTrimMs = Date.now() - startedAt;
    await sleep(MOBILE_LOOP_MS);
  } finally {
    await ctx.close();
  }
  if (!video) return;
  await rec.saveLoop(await video.path(), {
    surface: 'mobile-chat',
    width: MOBILE_VIDEO_SIZE.width,
    height: MOBILE_VIDEO_SIZE.height,
    headTrimMs,
  });
  process.stdout.write(`  ✓ raw mobile-chat-dark.webm (mark ${headTrimMs}ms)\n`);
}

/**
 * Capture the mobile set: session-sheet, streaming-chat, and tool-approval light
 * stills, plus the mobile chat loop (whose dark poster is extracted from the
 * loop's own first frame at process time). Runs late so the Now zone carries
 * the whole stack's outstanding work, not just this drive's.
 */
export async function captureMobile(browser: Browser, rec: RunRecorder): Promise<void> {
  const ctx = await newMobileContext(browser);
  await seedThemeOnContext(ctx, 'light');
  const page = await ctx.newPage();
  await attemptShot('mobile-sessions', 'mobile-sessions-light', async () => {
    await driveMobileSessions(page);
    await shootMobile(page, 'mobile-sessions', 'light', rec);
  });
  await attemptShot('mobile-approval', 'mobile-approval-light', async () => {
    await driveMobileApproval(page);
    await shootMobile(page, 'mobile-approval', 'light', rec);
  });
  // Light still backs cards; the loop's own first frame is the dark poster.
  await attemptShot('mobile-chat', 'mobile-chat-light', async () => {
    await driveMobileChat(page);
    await shootMobile(page, 'mobile-chat', 'light', rec);
  });
  await ctx.close();

  await attemptShot('mobile-chat', 'mobile-chat-loop', () => recordMobileChatLoop(browser, rec));
}
