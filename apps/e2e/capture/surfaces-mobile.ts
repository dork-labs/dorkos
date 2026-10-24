import type { Browser, Page } from '@playwright/test';
import { MOBILE_SCALE_FACTOR, MOBILE_VIDEO_SIZE, MOBILE_VIEWPORT, type Theme } from './config.js';
import type { RunRecorder } from './library.js';
import {
  attemptShot,
  mintVideoDir,
  newCaptureContext,
  openDirectChats,
  openLiveTurn,
  seedThemeOnContext,
  SETTLE_MS,
  sleep,
  waitForAppShell,
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
  return newCaptureContext(browser, {
    viewport: MOBILE_VIEWPORT,
    deviceScaleFactor: MOBILE_SCALE_FACTOR,
    isMobile: true,
    hasTouch: true,
    ...(options?.video
      ? { recordVideo: { dir: mintVideoDir(), size: MOBILE_VIDEO_SIZE } }
      : { reducedMotion: 'reduce' as const }),
  });
}

/** The two agents the phone drive puts to work — the last one opened lands on screen. */
const MOBILE_FLEET: readonly { agent: string; prompt: string; scenario: string }[] = [
  { agent: 'scout', prompt: 'Rotate the webhook signing secret', scenario: 'demo-approval' },
  { agent: 'atlas', prompt: 'Ship the retry-queue fix and rerun CI', scenario: 'demo-coding' },
];

/**
 * Raise one of the phone's bottom-bar destinations and wait until it is really
 * up.
 *
 * **There is no sidebar sheet on a phone any more** (DOR-1078 P4): the shell
 * mounts `MobileTabsLayout` instead, four destinations along the bottom and no
 * hamburger to open — the old `[data-sidebar="trigger"]` is not rendered at this
 * width at all. Each panel stays mounted and is put away with `visibility`, so
 * "it is up" is the panel being *visible*, not being present. A panel is lowered
 * by any navigation, so every pass through the drive raises it again.
 *
 * @param page - The phone page.
 * @param tab - Which destination: `home` is the sidebar's list, with answer cards on top.
 */
async function openMobileTab(page: Page, tab: 'home'): Promise<void> {
  await page.getByTestId(`mobile-tab-${tab}`).tap({ timeout: WAIT_MS });
  await page.getByTestId(`mobile-tab-panel-${tab}`).waitFor({ state: 'visible', timeout: WAIT_MS });
  await sleep(500); // let the panel finish rising
}

/**
 * Drive the phone's Home panel: the person starts a new chat with each agent in
 * turn, so Home ends up showing the card for the one who stopped to ask, over
 * Direct messages with both agents in it.
 *
 * Same two rules as the desktop fleet drive (`driveMultiSession`), for the same
 * reasons: the agents' Direct chats are opened first, because the sidebar lists
 * an agent once there is a direct message with it; and each turn starts just
 * before the next, so both are still running when the shutter falls.
 *
 * The bottom bar keeps Home and the open chat apart, so Home is raised at the
 * end for the shot itself.
 */
async function driveMobileSessions(page: Page): Promise<void> {
  await openDirectChats(MOBILE_FLEET.map((entry) => entry.agent));
  for (const entry of MOBILE_FLEET) {
    await openLiveTurn(page, entry.scenario, entry.prompt, entry.agent);
    await sleep(600);
  }
  await waitForAppShell(page);
  await openMobileTab(page, 'home');
  await page
    .locator('[data-sidebar-section="dms"] [data-sidebar-row]')
    .nth(MOBILE_FLEET.length - 1)
    .waitFor({ timeout: WAIT_MS });
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
  let headTrimMs: number;
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
 * Capture the mobile set: Home-panel, streaming-chat, and tool-approval light
 * stills, plus the mobile chat loop (whose dark poster is extracted from the
 * loop's own first frame at process time). Runs late so Home's answer cards
 * carry the whole stack's outstanding asks, not just this drive's.
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
