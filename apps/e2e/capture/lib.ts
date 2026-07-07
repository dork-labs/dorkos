import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { randomUUID } from 'crypto';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { API_URL, CLIENT_URL, FLEET_ROOT, VIDEO_SIZE, type Theme } from './config.js';
import { writeLoop, writeStill, type AssetEntry } from './optimize.js';

/**
 * Shared plumbing for the capture surfaces: URL/theme helpers, API calls,
 * still/loop writers, and the error-isolated `attempt` wrapper. Surface drives
 * live in `surfaces-desktop.ts` / `surfaces-mobile.ts`; the entry point is
 * `capture.ts`.
 *
 * @module capture/lib
 */

/** Settle delay after a surface reports ready, letting late paints land. */
export const SETTLE_MS = 900;
/** Default selector-wait budget. */
export const WAIT_MS = 20_000;

/** Absolute client URL for a path. */
export function url(pathname: string): string {
  return `${CLIENT_URL}${pathname}`;
}

/** Sleep for `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Seed the theme on a recording/capture context *before any page script runs*.
 *
 * Playwright records from page creation, so the old approach (navigate, then set
 * the theme) put a light-mode boot frame on film — every dark loop opened light
 * and flipped. An init script instead sets `localStorage` and the `dark` class
 * on `documentElement` before the app's own scripts execute, so the very first
 * recorded frame is already in the target theme. The `localStorage` write is
 * guarded because it throws on the initial `about:blank` (opaque origin); it
 * lands on the first real navigation, which is what the app reads.
 */
export async function seedThemeOnContext(ctx: BrowserContext, theme: Theme): Promise<void> {
  await ctx.addInitScript((t) => {
    try {
      localStorage.setItem('dorkos-theme', t);
    } catch {
      // about:blank has an opaque origin; the write lands on the real navigation.
    }
    document.documentElement.classList.toggle('dark', t === 'dark');
  }, theme);
}

/** POST JSON, ignoring the response body. */
export async function post(pathname: string, body: unknown): Promise<Response> {
  return fetch(`${API_URL}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** PATCH JSON, throwing on a non-2xx response. */
export async function patch(pathname: string, body: unknown): Promise<void> {
  const res = await fetch(`${API_URL}${pathname}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PATCH ${pathname} → ${res.status}: ${await res.text()}`);
}

/** Screenshot the viewport and write it as an optimized still. */
export async function shoot(
  page: Page,
  surface: string,
  theme: Theme,
  assets: AssetEntry[]
): Promise<void> {
  await sleep(SETTLE_MS);
  const buffer = await page.screenshot({ type: 'png' });
  assets.push(await writeStill(buffer, surface, theme));
  process.stdout.write(`  ✓ ${surface}-${theme}.png\n`);
}

/** Run one surface capture with error isolation so a single failure never aborts the run. */
export async function attempt(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    process.stdout.write(`  ✗ ${label} skipped: ${err instanceof Error ? err.message : err}\n`);
  }
}

/**
 * Open a fresh session page, then trigger a scenario turn via the API so the
 * already-subscribed page receives the live stream (required for transient
 * events like `ui_command`). Returns once the message is accepted.
 */
export async function openLiveTurn(
  page: Page,
  scenario: string,
  prompt: string,
  agent: string
): Promise<void> {
  const sessionId = randomUUID();
  const cwd = path.join(FLEET_ROOT, agent);
  await post('/api/test/scenario', { name: scenario, sessionId });
  await page.goto(url(`/session?session=${sessionId}&dir=${encodeURIComponent(cwd)}`));
  await page.waitForSelector('[data-testid="chat-panel"]', { timeout: WAIT_MS });
  await post(`/api/sessions/${sessionId}/messages`, { content: prompt, cwd });
}

/**
 * Expand the desktop shell's shadcn sidebar and wait until it reads expanded.
 * The offcanvas-collapsed sidebar stays in the DOM translated off-screen, so
 * row/text visibility probes pass spuriously — the wrapper's `data-state`
 * attribute is the only trustworthy signal.
 */
export async function ensureDesktopSidebarExpanded(page: Page): Promise<void> {
  const wrapper = page.locator('[data-slot="sidebar"]').first();
  await wrapper.waitFor({ state: 'attached', timeout: WAIT_MS });
  if ((await wrapper.getAttribute('data-state')) !== 'expanded') {
    await page.locator('[data-sidebar="trigger"]').first().click();
  }
  await page
    .locator('[data-slot="sidebar"][data-state="expanded"]')
    .first()
    .waitFor({ state: 'attached', timeout: WAIT_MS });
}

/**
 * Marks the frame where a loop's action begins, relative to recording start.
 * A drive calls it once when the money content is on screen; the editing stage
 * head-trims everything before it. Idempotent — only the first call counts.
 */
export type LoopMark = () => void;

/** A single recorded loop. */
export interface LoopSpec {
  readonly surface: string;
  readonly durationMs: number;
  /**
   * Drive the page while the context records. Call `mark()` at the moment the
   * loop's content should start (before an in-drive animation like the
   * personality morphs or canvas typing). Drives that build their money state
   * and return — leaving the post-drive hold to animate — can ignore `mark`;
   * the head-trim then defaults to drive completion.
   */
  readonly drive: (page: Page, mark: LoopMark) => Promise<void>;
}

/** Mint a unique temp directory for one recording. */
export function mintVideoDir(): string {
  return path.join(os.tmpdir(), `dorkos-capture-video-${randomUUID()}`);
}

/** Record one dark-theme loop in an isolated video context, then edit + encode it. */
export async function recordLoop(
  browser: Browser,
  spec: LoopSpec,
  assets: AssetEntry[]
): Promise<void> {
  const videoDir = mintVideoDir();
  const ctx = await browser.newContext({
    viewport: VIDEO_SIZE,
    recordVideo: { dir: videoDir, size: VIDEO_SIZE },
  });
  await seedThemeOnContext(ctx, 'dark');
  const page = await ctx.newPage();
  const video = page.video();
  const startedAt = Date.now();
  let markMs: number | null = null;
  const mark: LoopMark = () => {
    if (markMs === null) markMs = Date.now() - startedAt;
  };
  try {
    await spec.drive(page, mark);
    // No explicit mark → head-trim to the moment the drive finished building
    // the money state (the post-drive hold then animates on camera).
    if (markMs === null) markMs = Date.now() - startedAt;
    await sleep(spec.durationMs);
  } finally {
    await ctx.close();
  }
  if (!video) return;
  assets.push(
    ...(await writeLoop({
      sourcePath: await video.path(),
      surface: spec.surface,
      width: VIDEO_SIZE.width,
      height: VIDEO_SIZE.height,
      headTrimMs: markMs ?? 0,
    }))
  );
  await fs.rm(videoDir, { recursive: true, force: true });
  process.stdout.write(`  ✓ ${spec.surface}-dark.webm (+ poster)\n`);
}
