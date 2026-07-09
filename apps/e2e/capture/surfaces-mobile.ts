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

/**
 * Drive the mobile session list: launch two live turns first (an already-open
 * list does not grow rows for brand-new sessions), then land on the session
 * view and open the sidebar sheet — the full-screen session list a phone user
 * sees, with working/approval indicators pulsing on the live rows.
 */
async function driveMobileSessions(page: Page): Promise<void> {
  const cwd = path.join(FLEET_ROOT, 'atlas');
  const live = [
    { id: randomUUID(), prompt: 'Ship the retry-queue fix and rerun CI', scenario: 'demo-coding' },
    { id: randomUUID(), prompt: 'Rotate the webhook signing secret', scenario: 'demo-approval' },
  ];
  for (const s of live) {
    await post('/api/test/scenario', { name: s.scenario, sessionId: s.id });
    await post(`/api/sessions/${s.id}/messages`, { content: s.prompt, cwd });
  }
  await page.goto(url(`/session?session=${live[0]!.id}&dir=${encodeURIComponent(cwd)}`));
  await page.waitForSelector('[data-testid="chat-panel"]', { timeout: WAIT_MS });
  await sleep(1200); // let liveness reach the list stores
  await page.locator('[data-sidebar="trigger"]').first().tap();
  await page.locator('[data-testid="session-row"]').first().waitFor({ timeout: WAIT_MS });
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
 * Capture the mobile set: session-list, streaming-chat, and tool-approval light
 * stills, plus the mobile chat loop (whose dark poster is extracted from the
 * loop's own first frame at process time). Runs late so the session list is
 * maximally inhabited.
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
