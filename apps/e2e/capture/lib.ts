import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { randomUUID } from 'crypto';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { API_URL, CLIENT_URL, FLEET_ROOT, VIDEO_SIZE, type Theme } from './config.js';
import type { RunRecorder } from './library.js';

/**
 * Shared plumbing for the capture surfaces: URL/theme helpers, API calls, the
 * raw still/loop recorders, and the error-isolated `attempt` wrapper. The
 * record phase only saves raws into the media library; all editing happens in
 * the process phase (`optimize.ts`). Surface drives live in
 * `surfaces-desktop.ts` / `surfaces-mobile.ts`; entry points are `record.ts`,
 * `process.ts`, and `capture.ts`.
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

/** Screenshot the viewport and save the raw, untouched PNG into the run. */
export async function shoot(
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

/** Run one surface capture with error isolation so a single failure never aborts the run. */
export async function attempt(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    process.stdout.write(`  ✗ ${label} skipped: ${err instanceof Error ? err.message : err}\n`);
  }
}

/** Shot ids the record phase must not capture (a `skipAuto` override supplies them). */
let autoSkip = new Set<string>();

/**
 * Shot ids this process is assigned to capture, or `null` for "capture
 * everything". A serial record leaves it `null`; a parallel shard worker sets it
 * to its partition so every other shot is skipped without driving its surface.
 */
let assignedShots: Set<string> | null = null;

/** Set the shots the record phase skips; call once before capturing (see `record.ts`). */
export function setAutoSkip(ids: Set<string>): void {
  autoSkip = ids;
}

/**
 * Restrict this process to a subset of shots (a parallel shard's partition).
 * Pass `null` (the default) to capture every registered shot.
 */
export function setAssignedShots(ids: Set<string> | null): void {
  assignedShots = ids;
}

/** True when this process is not assigned a shot (another shard captures it). */
function isUnassigned(shotId: string): boolean {
  return assignedShots !== null && !assignedShots.has(shotId);
}

/**
 * True when a shot must not be captured by this process — either a human
 * override supplies it (`skipAuto`) or it belongs to a different shard.
 */
export function isShotSkipped(shotId: string): boolean {
  return autoSkip.has(shotId) || isUnassigned(shotId);
}

/**
 * Like {@link attempt}, but keyed to a shot id: the capture is skipped entirely
 * (and logged) when a human override supplies the shot (`skipAuto`), or when the
 * shot belongs to another shard — so the record phase never wastes time driving
 * a surface it is not responsible for.
 */
export async function attemptShot(
  shotId: string,
  label: string,
  fn: () => Promise<void>
): Promise<void> {
  if (autoSkip.has(shotId)) {
    process.stdout.write(`  ⤿ ${label} skipped (override supplies it)\n`);
    return;
  }
  if (isUnassigned(shotId)) return; // captured by another shard; stay quiet
  await attempt(label, fn);
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

/** Record one dark-theme loop in an isolated video context and save the raw recording. */
export async function recordLoop(
  browser: Browser,
  spec: LoopSpec,
  rec: RunRecorder
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
  await rec.saveLoop(await video.path(), {
    surface: spec.surface,
    width: VIDEO_SIZE.width,
    height: VIDEO_SIZE.height,
    headTrimMs: markMs ?? 0,
  });
  await fs.rm(videoDir, { recursive: true, force: true });
  process.stdout.write(`  ✓ raw ${spec.surface}-dark.webm (mark ${markMs ?? 0}ms)\n`);
}
