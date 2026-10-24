#!/usr/bin/env node
/**
 * Capture and measure the rendered page: the browser leg of a UI audit or a design review.
 *
 * It screenshots every route at every viewport in both themes (plus the preference modes you
 * ask for), then measures what actually painted: every icon's box, every text run's computed
 * font-size / line-height / letter-spacing and its contrast against what is behind it, every
 * interactive element's hit box, every text field's font-size, page-level horizontal overflow,
 * and the focus ring of the first N tab stops. Anything under a floor in `floors.json` comes
 * back as a flag tagged with the rule it breaks (a section of contributing/design-review.md).
 *
 * Read-only by construction: it navigates, resizes, emulates media, presses Tab and takes
 * pictures. It never clicks. The only state it writes is the theme key in a throwaway browser
 * context's localStorage.
 *
 * Usage:
 *   node measure.mjs --url http://localhost:6241 --routes /,/settings --out /tmp/audit
 *     [--viewports 390x844,375x667,768x1024,1440x900] [--themes light,dark]
 *     [--modes base,contrast-more,forced-colors,reduced-motion]   # extra modes are screenshot-only
 *     [--focus-walk 12] [--wait 1500] [--wait-for <css>] [--full-page]
 *     [--theme-key dorkos-theme] [--floors ./floors.json] [--max-flags 400]
 *     [--ignore '<css>']   # skip anything inside these (e.g. the playground's own chrome)
 *
 * Playwright: resolves `playwright-core`, then `playwright`, then `@playwright/test` (this repo
 * has the last in apps/e2e). It looks in PLAYWRIGHT_FROM, then this folder, then apps/e2e, and
 * never in the current directory. Set PLAYWRIGHT_FROM=<dir> to resolve from somewhere else, and
 * CHROME_PATH=<binary> to use a specific Chromium (e.g. a headless shell).
 *
 * It refuses any --url on port 4242, the operator's own DorkOS, however the host is spelled.
 *
 * Output (in --out): shots/<route>/<w>x<h>-<theme>[-<mode>].png, measure.json (every flag plus
 * per-capture stats), summary.md (counts by rule and severity, worst offenders first).
 */
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { focusWalkPage } from './focus-walk.mjs';
import { measureInPage } from './in-page.mjs';
import { writeReport } from './report.mjs';
import { playwrightRoots, refuseUrl } from './guards.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- args
function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) continue;
    const key = k.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) a[key] = true;
    else {
      a[key] = next;
      i++;
    }
  }
  return a;
}
const args = parseArgs(process.argv.slice(2));
if (!args.url) {
  console.error('measure.mjs: --url is required (see the header of this file for usage)');
  process.exit(2);
}
const refusal = refuseUrl(String(args.url));
if (refusal) {
  console.error(`measure.mjs: ${refusal}`);
  process.exit(2);
}
const base = String(args.url).replace(/\/$/, '');
const routes = String(args.routes ?? '/')
  .split(',')
  .map((r) => r.trim())
  .filter(Boolean);
const viewports = String(args.viewports ?? '390x844,375x667,768x1024,1440x900')
  .split(',')
  .map((v) => {
    const [w, h] = v.split('x').map(Number);
    return { w, h };
  });
const themes = String(args.themes ?? 'light,dark').split(',');
const modes = String(args.modes ?? 'base').split(',');
const out = resolve(String(args.out ?? './measure-out'));
const waitMs = Number(args['wait'] ?? 1500);
const waitFor = args['wait-for'] ? String(args['wait-for']) : null;
const focusWalk = Number(args['focus-walk'] ?? 0);
const themeKey = String(args['theme-key'] ?? 'dorkos-theme');
const maxFlags = Number(args['max-flags'] ?? 400);
const ignore = args.ignore ? String(args.ignore) : null;
const floors = JSON.parse(
  readFileSync(resolve(String(args.floors ?? join(here, 'floors.json'))), 'utf8')
);

// ---------------------------------------------------------------- playwright
function loadChromium() {
  for (const root of playwrightRoots(process.env.PLAYWRIGHT_FROM, here)) {
    const req = createRequire(join(root, 'noop.js'));
    for (const name of ['playwright-core', 'playwright', '@playwright/test']) {
      try {
        const mod = req(name);
        if (mod.chromium) return mod.chromium;
      } catch {
        /* try the next one */
      }
    }
  }
  console.error(
    'measure.mjs: no Playwright found. Set PLAYWRIGHT_FROM to a dir with playwright-core installed.'
  );
  process.exit(2);
}
const chromium = loadChromium();

// ---------------------------------------------------------------- run
const slug = (r) => (r === '/' ? 'root' : r.replace(/^\/|\/$/g, '').replace(/[^a-z0-9]+/gi, '-'));
mkdirSync(out, { recursive: true });
const launchOpts = { headless: true };
if (process.env.CHROME_PATH) launchOpts.executablePath = process.env.CHROME_PATH;
const browser = await chromium.launch(launchOpts);
const captures = [];
const allFlags = [];

try {
  for (const route of routes) {
    mkdirSync(join(out, 'shots', slug(route)), { recursive: true });
    for (const vp of viewports) {
      const isPhone = vp.w <= floors.phoneMaxWidth;
      for (const theme of themes) {
        const context = await browser.newContext({
          viewport: { width: vp.w, height: vp.h },
          deviceScaleFactor: 2,
          isMobile: isPhone,
          hasTouch: isPhone,
          colorScheme: theme === 'dark' ? 'dark' : 'light',
        });
        await context.addInitScript(
          ([k, v]) => {
            try {
              localStorage.setItem(k, v);
            } catch {
              /* storage may be blocked; colorScheme still applies */
            }
          },
          [themeKey, theme]
        );
        const page = await context.newPage();
        const consoleErrors = [];
        page.on(
          'console',
          (m) => m.type() === 'error' && consoleErrors.push(m.text().slice(0, 200))
        );
        await page.goto(base + route, { waitUntil: 'domcontentloaded', timeout: 30000 });
        if (waitFor) await page.waitForSelector(waitFor, { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(waitMs);
        for (const mode of modes) {
          const media = {
            colorScheme: theme === 'dark' ? 'dark' : 'light',
            reducedMotion: 'no-preference',
            forcedColors: 'none',
          };
          if (mode === 'reduced-motion') media.reducedMotion = 'reduce';
          if (mode === 'forced-colors') media.forcedColors = 'active';
          if (mode === 'contrast-more') media.contrast = 'more';
          try {
            await page.emulateMedia(media);
          } catch {
            delete media.contrast; // older Playwright has no `contrast`
            await page.emulateMedia(media);
            if (mode === 'contrast-more')
              console.warn(
                'measure.mjs: this Playwright cannot emulate prefers-contrast; contrast-more shot is the base'
              );
          }
          await page.waitForTimeout(mode === 'base' ? 0 : 400);
          const name = `${vp.w}x${vp.h}-${theme}${mode === 'base' ? '' : '-' + mode}.png`;
          const shot = join('shots', slug(route), name);
          await page.screenshot({ path: join(out, shot), fullPage: !!args['full-page'] });
          const cap = {
            route,
            viewport: `${vp.w}x${vp.h}`,
            device: isPhone ? 'phone' : 'desktop',
            theme,
            mode,
            shot,
          };
          if (mode === 'base') {
            let m = await page.evaluate(measureInPage, { floors, isPhone, ignore });
            if (m.stats.text === 0) {
              // A cold dev server can hand back a blank first paint. Reload once before believing it.
              await page.reload({ waitUntil: 'domcontentloaded' });
              if (waitFor) await page.waitForSelector(waitFor, { timeout: 15000 }).catch(() => {});
              await page.waitForTimeout(waitMs * 2);
              await page.screenshot({ path: join(out, shot), fullPage: !!args['full-page'] });
              m = await page.evaluate(measureInPage, { floors, isPhone, ignore });
              if (m.stats.text === 0)
                console.warn(
                  `measure.mjs: ${route} ${cap.viewport} ${theme} painted no text; check the screenshot`
                );
            }
            cap.stats = m.stats;
            cap.ramp = m.ramp;
            cap.iconSizes = m.iconSizes;
            cap.consoleErrors = consoleErrors.slice(0, 10);
            const tag = (f) => ({ ...f, route, viewport: cap.viewport, theme });
            allFlags.push(...m.flags.map(tag));
            if (focusWalk > 0) {
              const ff = await focusWalkPage(
                page,
                focusWalk,
                floors.focus.minRingPx,
                isPhone,
                ignore,
                join(out, 'shots', slug(route)),
                `${vp.w}x${vp.h}-${theme}`
              );
              allFlags.push(...ff.map(tag));
            }
            cap.flagCount = m.flags.length;
          }
          captures.push(cap);
          console.log(
            `  ${route} ${cap.viewport} ${theme} ${mode}${cap.flagCount !== undefined ? ` · ${cap.flagCount} flags` : ''}`
          );
        }
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
}

writeReport({ base, routes, viewports, themes, modes, floors, out, maxFlags, allFlags, captures });
