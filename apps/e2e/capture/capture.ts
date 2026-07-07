import { chromium, type Browser } from '@playwright/test';
import { bootStack } from './boot.js';
import { prepareFilesystem, seedData } from './seed.js';
import { resetOutputDir, writeManifest, type AssetEntry } from './optimize.js';
import { sleep } from './lib.js';
import { captureAgentDiscovery, captureLightStills, captureLoops } from './surfaces-desktop.js';
import { captureMobile } from './surfaces-mobile.js';

/**
 * Entry point for the product-capture pipeline. Boots a test-mode DorkOS stack,
 * seeds deterministic demo data, drives the real UI through every money state
 * (desktop stills per theme, dynamic loops, mobile, onboarding discovery), and
 * writes optimized stills + short video loops (plus a manifest) into
 * `apps/site/public/product`. One command, fully reproducible.
 *
 * Run with: `pnpm --filter @dorkos/e2e capture`.
 *
 * @module capture/capture
 */

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
    await seedData();

    process.stdout.write('▸ Capturing…\n');
    browser = await chromium.launch();
    await captureLightStills(browser, assets);
    await captureLoops(browser, assets);
    // Mobile runs after the loops so the multi-session drives above have
    // already filled the sidebar with realistic, distinct session rows.
    await captureMobile(browser, assets);
    // Onboarding discovery runs dead last: it flips global onboarding state,
    // which every other capture requires dismissed.
    await captureAgentDiscovery(browser, assets);

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
