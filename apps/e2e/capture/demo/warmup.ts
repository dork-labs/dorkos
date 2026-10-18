import { chromium } from '@playwright/test';
import { DESKTOP_VIEWPORT, MOBILE_VIEWPORT } from '../config.js';
import { RIGHT_PANEL_STATE_KEY } from './config.js';

/**
 * Open every page the demo's flows start on, once, in a hidden browser, before
 * the demo says it is up.
 *
 * The demo client is a Vite dev server, and a fresh one finds some libraries
 * only when a page first imports them (the composer's editor loads lazily, for
 * one). Finding one re-bundles the libraries under new names while the page
 * that asked still holds the old ones: two copies of React, and the page falls
 * over with "Invalid hook call" on camera. Seen on the first run of this
 * command: the phone-approval chat crashed the moment its composer mounted.
 * Loading each page here first lets Vite settle on one set before a person
 * opens anything; a page that still finds something new is reloaded, which is
 * the cure a person would otherwise have to know.
 *
 * Best-effort: a page that will not load here is reported and skipped, never
 * fatal, because the stack itself is already up and seeded.
 *
 * @param urls - The pages to open.
 * @param panelTab - A right-panel tab to have open on every page, when one should be warmed too.
 */
export async function warmUp(urls: readonly string[], panelTab?: string): Promise<void> {
  const browser = await chromium.launch();
  try {
    for (const viewport of [DESKTOP_VIEWPORT, MOBILE_VIEWPORT]) {
      const page = await browser.newPage({ viewport });
      if (panelTab) {
        // Every page with the right panel open on this tab, so the tab's own
        // code is loaded before anyone films it beside a chat.
        await page.addInitScript(
          ([key, tab]) => localStorage.setItem(key, JSON.stringify({ open: true, activeTab: tab })),
          [RIGHT_PANEL_STATE_KEY, panelTab] as const
        );
      }
      for (const target of urls) {
        try {
          // Two loads: the first is the one that finds new libraries; the
          // second proves the page renders on the settled set.
          for (let pass = 0; pass < 2; pass++) {
            // `load`, not `networkidle`: the app holds event streams open, so
            // the network never goes idle.
            await page.goto(target, { waitUntil: 'load', timeout: 90_000 });
            await page.waitForTimeout(5_000);
          }
        } catch (err) {
          process.stdout.write(
            `  ! warm-up skipped ${target}: ${err instanceof Error ? err.message.split('\n')[0] : err}\n`
          );
        }
      }
      await page.close();
    }
  } finally {
    await browser.close();
  }
}
