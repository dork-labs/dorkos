import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { randomUUID } from 'crypto';
import { chromium, type Browser, type Page } from '@playwright/test';
import {
  API_URL,
  CLIENT_URL,
  DESKTOP_VIEWPORT,
  DEVICE_SCALE_FACTOR,
  FLEET_ROOT,
  MOBILE_VIEWPORT,
  THEMES,
  VIDEO_SIZE,
  type Theme,
} from './config.js';
import { bootStack } from './boot.js';
import { prepareFilesystem, seedData, type SeededSession } from './seed.js';
import {
  resetOutputDir,
  writeLoop,
  writeManifest,
  writeStill,
  type AssetEntry,
} from './optimize.js';

/**
 * Entry point for the product-capture pipeline. Boots a test-mode DorkOS stack,
 * seeds deterministic demo data, drives the real UI through every money state,
 * and writes optimized stills + short video loops (plus a manifest) into
 * `apps/site/public/product`. One command, fully reproducible.
 *
 * Run with: `pnpm --filter @dorkos/e2e capture`.
 *
 * @module capture/capture
 */

/** Settle delay after a surface reports ready, letting late paints land. */
const SETTLE_MS = 900;
/** Default selector-wait budget. */
const WAIT_MS = 20_000;

/** Absolute client URL for a path. */
function url(pathname: string): string {
  return `${CLIENT_URL}${pathname}`;
}

/** Sleep for `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Wait for the app shell, then apply and persist the theme for this context. */
async function primeTheme(page: Page, theme: Theme): Promise<void> {
  await page.goto(url('/'));
  await page.waitForSelector('[data-testid="app-shell"]', { timeout: WAIT_MS });
  await page.evaluate((t) => {
    localStorage.setItem('dorkos-theme', t);
    document.documentElement.classList.toggle('dark', t === 'dark');
  }, theme);
}

/** POST JSON, ignoring the response body. */
async function post(pathname: string, body: unknown): Promise<Response> {
  return fetch(`${API_URL}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Screenshot the viewport and write it as an optimized still. */
async function shoot(
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
async function attempt(label: string, fn: () => Promise<void>): Promise<void> {
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
async function openLiveTurn(
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

// --- Static surfaces ---------------------------------------------------------

/** Capture the cockpit/dashboard home. */
async function shootCockpit(page: Page, theme: Theme, assets: AssetEntry[]): Promise<void> {
  await page.goto(url('/'));
  await page.waitForSelector('[data-testid="app-shell"]', { timeout: WAIT_MS });
  await page.getByText('Atlas', { exact: false }).first().waitFor({ timeout: WAIT_MS });
  await shoot(page, 'cockpit', theme, assets);
}

/** Capture the fleet/agents list. */
async function shootAgents(page: Page, theme: Theme, assets: AssetEntry[]): Promise<void> {
  await page.goto(url('/agents?view=list'));
  await page.getByText('Sentinel', { exact: false }).first().waitFor({ timeout: WAIT_MS });
  await shoot(page, 'agents', theme, assets);
}

/** Capture the mesh topology graph. */
async function shootTopology(page: Page, theme: Theme, assets: AssetEntry[]): Promise<void> {
  await page.goto(url('/agents?view=topology'));
  await page
    .locator('[data-testid="agent-node"], .react-flow__node')
    .first()
    .waitFor({ timeout: WAIT_MS });
  await sleep(1500); // let the ELK/ReactFlow layout settle
  await shoot(page, 'topology', theme, assets);
}

/** Capture the Tasks screen with an expanded run history. */
async function shootTasks(page: Page, theme: Theme, assets: AssetEntry[]): Promise<void> {
  await page.goto(url('/tasks'));
  await page
    .getByText('Nightly dependency audit', { exact: false })
    .first()
    .waitFor({ timeout: WAIT_MS });
  await page.locator('div[role="button"]', { hasText: 'Nightly dependency audit' }).first().click();
  await page.getByText('No new advisories', { exact: false }).first().waitFor({ timeout: WAIT_MS });
  await shoot(page, 'tasks', theme, assets);
}

/** Capture the in-app marketplace browse view. */
async function shootMarketplace(page: Page, theme: Theme, assets: AssetEntry[]): Promise<void> {
  await page.goto(url('/marketplace'));
  await page.getByText('code-reviewer', { exact: false }).first().waitFor({ timeout: WAIT_MS });
  await shoot(page, 'marketplace', theme, assets);
}

// --- Live surfaces -----------------------------------------------------------

/**
 * Capture a rich chat turn. Waits for the third tool card (Read → Edit → Bash)
 * and the summary heading so the transcript shows streamed markdown, a code
 * block, and multiple tool cards — a full, inhabited chat surface.
 */
async function shootChatStreaming(page: Page, theme: Theme, assets: AssetEntry[]): Promise<void> {
  await openLiveTurn(
    page,
    'demo-coding',
    'Add token-bucket rate limiting to the API middleware',
    'atlas'
  );
  await page.locator('[data-testid="tool-call-card"]').first().waitFor({ timeout: WAIT_MS });
  // Let the full turn stream in (paced ~8s) so the transcript shows markdown, a
  // code block, and the tool calls — a full, inhabited chat surface.
  await page
    .getByText("Here's what changed", { exact: false })
    .first()
    .waitFor({ timeout: WAIT_MS });
  await shoot(page, 'chat-streaming', theme, assets);
}

/** Capture a tool-approval prompt. */
async function shootToolApproval(page: Page, theme: Theme, assets: AssetEntry[]): Promise<void> {
  await openLiveTurn(page, 'demo-approval', 'Migrate the auth tokens table', 'atlas');
  await page.locator('[data-testid="tool-approval"]').first().waitFor({ timeout: WAIT_MS });
  await shoot(page, 'tool-approval', theme, assets);
}

/** Capture the canvas open beside chat with a document. */
async function shootCanvas(page: Page, theme: Theme, assets: AssetEntry[]): Promise<void> {
  await openLiveTurn(
    page,
    'demo-canvas',
    'Write up the rate-limiting design in the canvas',
    'atlas'
  );
  await page.locator('[data-slot="canvas"]').first().waitFor({ timeout: WAIT_MS });
  await sleep(1200); // let the canvas content stream in
  await shoot(page, 'canvas', theme, assets);
}

/** Capture every desktop still for one theme in a single context. */
async function captureThemeStills(
  browser: Browser,
  theme: Theme,
  assets: AssetEntry[]
): Promise<void> {
  const ctx = await browser.newContext({
    viewport: DESKTOP_VIEWPORT,
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
    reducedMotion: 'reduce',
  });
  const page = await ctx.newPage();
  await primeTheme(page, theme);
  await attempt(`cockpit-${theme}`, () => shootCockpit(page, theme, assets));
  await attempt(`agents-${theme}`, () => shootAgents(page, theme, assets));
  await attempt(`topology-${theme}`, () => shootTopology(page, theme, assets));
  await attempt(`tasks-${theme}`, () => shootTasks(page, theme, assets));
  await attempt(`marketplace-${theme}`, () => shootMarketplace(page, theme, assets));
  await attempt(`chat-streaming-${theme}`, () => shootChatStreaming(page, theme, assets));
  await attempt(`tool-approval-${theme}`, () => shootToolApproval(page, theme, assets));
  await attempt(`canvas-${theme}`, () => shootCanvas(page, theme, assets));
  await ctx.close();
}

/** Capture one 390px-wide mobile shot of the session view. */
async function captureMobile(
  browser: Browser,
  seeded: SeededSession[],
  assets: AssetEntry[]
): Promise<void> {
  const session = seeded.find((s) => s.scenario === 'demo-coding') ?? seeded[0];
  if (!session) return;
  const ctx = await browser.newContext({
    viewport: MOBILE_VIEWPORT,
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
    reducedMotion: 'reduce',
    isMobile: true,
    hasTouch: true,
  });
  const page = await ctx.newPage();
  await primeTheme(page, 'light');
  await attempt('mobile-cockpit', async () => {
    await page.goto(
      url(`/session?session=${session.sessionId}&dir=${encodeURIComponent(session.cwd)}`)
    );
    await page.waitForSelector('[data-testid="chat-panel"]', { timeout: WAIT_MS });
    await sleep(SETTLE_MS);
    const buffer = await page.screenshot({ type: 'png' });
    assets.push(await writeStill(buffer, 'mobile-cockpit', 'light'));
    process.stdout.write('  ✓ mobile-cockpit-light.png\n');
  });
  await ctx.close();
}

/** A single recorded loop. */
interface LoopSpec {
  readonly surface: string;
  readonly durationMs: number;
  /** Drive the page; the context records the whole time. */
  readonly drive: (page: Page) => Promise<void>;
}

/** Record one dark-theme loop in an isolated video context. */
async function recordLoop(browser: Browser, spec: LoopSpec, assets: AssetEntry[]): Promise<void> {
  const videoDir = path.join(os.tmpdir(), `dorkos-capture-video-${randomUUID()}`);
  const ctx = await browser.newContext({
    viewport: VIDEO_SIZE,
    recordVideo: { dir: videoDir, size: VIDEO_SIZE },
  });
  const page = await ctx.newPage();
  const video = page.video();
  try {
    await primeTheme(page, 'dark');
    await spec.drive(page);
    await sleep(spec.durationMs);
  } finally {
    await ctx.close();
  }
  if (!video) return;
  const src = await video.path();
  assets.push(
    await writeLoop(src, spec.surface, 'dark', VIDEO_SIZE.width, VIDEO_SIZE.height, spec.durationMs)
  );
  await fs.rm(videoDir, { recursive: true, force: true });
  process.stdout.write(`  ✓ ${spec.surface}-dark.webm\n`);
}

/** Record the dynamic-moment loops. */
async function captureLoops(browser: Browser, assets: AssetEntry[]): Promise<void> {
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
      drive: async (page) => {
        await openLiveTurn(
          page,
          'demo-canvas',
          'Write up the rate-limiting design in the canvas',
          'atlas'
        );
        await page.locator('[data-slot="canvas"]').first().waitFor({ timeout: WAIT_MS });
      },
    },
  ];
  for (const spec of specs) {
    await attempt(`${spec.surface}-loop`, () => recordLoop(browser, spec, assets));
  }
}

/** Orchestrate the full capture run. */
async function main(): Promise<void> {
  process.stdout.write('▸ Preparing filesystem…\n');
  await prepareFilesystem();
  await resetOutputDir();

  process.stdout.write('▸ Booting test-mode stack (building server deps)…\n');
  const stack = await bootStack();
  let browser: Browser | undefined;
  const assets: AssetEntry[] = [];
  try {
    process.stdout.write('▸ Seeding demo data…\n');
    const seeded = await seedData();

    process.stdout.write('▸ Capturing…\n');
    browser = await chromium.launch();
    for (const theme of THEMES) {
      process.stdout.write(`  · theme: ${theme}\n`);
      await captureThemeStills(browser, theme, assets);
    }
    await captureMobile(browser, seeded, assets);
    await captureLoops(browser, assets);

    await writeManifest(assets);
    const totalMb = (assets.reduce((s, a) => s + a.bytes, 0) / 1e6).toFixed(2);
    process.stdout.write(`▸ Done: ${assets.length} assets, ${totalMb} MB total.\n`);
  } finally {
    if (browser) await browser.close();
    stack.teardown();
    // Give child processes a moment to exit before the event loop drains.
    await sleep(500);
  }
}

main().catch((err) => {
  process.stderr.write(`Capture failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 1;
});
