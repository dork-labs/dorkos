import path from 'path';
import { fileURLToPath } from 'url';
import { chromium, type Browser } from '@playwright/test';
import { bootStack } from './boot.js';
import { prepareFilesystem, seedData } from './seed.js';
import { createRunRecorder } from './library.js';
import { autoSkippedShotIds } from './overrides.js';
import { setAutoSkip, sleep } from './lib.js';
import { captureAgentDiscovery, captureLightStills, captureLoops } from './surfaces-desktop.js';
import { captureMobile } from './surfaces-mobile.js';

/**
 * The RECORD phase: boot a test-mode DorkOS stack, seed deterministic demo
 * data, drive the real UI through every money state, and save RAW, untouched
 * recordings and screenshots into the media library (`library/<run-id>/raw/` +
 * `run.json`). No editing happens here — the process phase (`process.ts`) owns
 * trim, seam, encode, and poster, so editing changes never require re-recording.
 *
 * Run with: `pnpm --filter @dorkos/e2e capture:record`.
 *
 * @module capture/record
 */

/** Record one full run into the library and return its run id. */
export async function runRecordPhase(): Promise<string> {
  process.stdout.write('▸ Preparing filesystem…\n');
  await prepareFilesystem();

  // Shots whose media a human override supplies (skipAuto) are never driven.
  const skip = await autoSkippedShotIds();
  setAutoSkip(skip);
  if (skip.size > 0) {
    process.stdout.write(
      `▸ Skipping ${skip.size} shot(s) supplied by overrides: ${[...skip].join(', ')}\n`
    );
  }

  process.stdout.write('▸ Booting test-mode stack (building server deps)…\n');
  const stack = await bootStack();
  let browser: Browser | undefined;
  try {
    process.stdout.write('▸ Seeding demo data…\n');
    await seedData();

    const rec = await createRunRecorder();
    process.stdout.write(`▸ Recording raws (run ${rec.runId})…\n`);
    browser = await chromium.launch();
    await captureLightStills(browser, rec);
    await captureLoops(browser, rec);
    // Mobile runs after the loops so the multi-session drives above have
    // already filled the sidebar with realistic, distinct session rows.
    await captureMobile(browser, rec);
    // Onboarding discovery runs dead last: it flips global onboarding state,
    // which every other capture requires dismissed.
    await captureAgentDiscovery(browser, rec);
    await rec.finalize();
    return rec.runId;
  } finally {
    if (browser) await browser.close();
    stack.teardown();
    // Give child processes a moment to exit before the event loop drains.
    await sleep(500);
  }
}

const isMain =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runRecordPhase().catch((err) => {
    process.stderr.write(`Record failed: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exitCode = 1;
  });
}
