/**
 * Keep every browser test off Google Fonts, without changing how the app looks
 * (DOR-4871).
 *
 * The client's default font (`inter`) inserts a `fonts.googleapis.com`
 * stylesheet at startup, and `page.goto` waits for `load`, which waits for that
 * stylesheet. On Nov 20 Google stalled it for 19.6–45.2 s, page loads timed out
 * and the merge queue ejected PRs that had touched nothing near the spec that
 * failed. A browser test has no business depending on a third-party CDN.
 *
 * {@link stubGoogleFonts} answers those requests from this machine instead:
 *
 * - A stylesheet that asks for Inter or JetBrains Mono (the client's default
 *   pairing) gets `@font-face` rules for those families whose files are the
 *   ones `@fontsource-variable/inter` and `@fontsource-variable/jetbrains-mono`
 *   ship (the same variable fonts Google serves), at {@link LOCAL_FONT_BASE}.
 *   Text renders with the real fonts' metrics, so layout matches a run that
 *   reached Google.
 * - Those URLs are answered with the file's bytes, read once.
 * - Any other stylesheet gets an empty one, and any other font file is aborted.
 *   Nothing is passed through: every Google Fonts URL is answered or refused.
 *
 * The first version of this fix seeded the `system` font instead. That changed
 * line widths, and run 44831381307 failed two layout-sensitive specs on it
 * (`sidebar-model-showcase.spec.ts:197`, `file-tree-open.spec.ts:49`).
 *
 * Installed on every context by `fixtures/base.ts`. As a backstop for contexts
 * no fixture reaches (`browser.newContext()` in a spec), `playwright.config.ts`
 * passes Chromium {@link GOOGLE_FONTS_HOST_RULES}, which makes both hosts fail
 * to resolve at once, so an unrouted request errors instead of stalling.
 *
 * @module google-fonts-stub
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { BrowserContext, Route } from '@playwright/test';

/** Google Fonts' stylesheet host — what `loadGoogleFont` inserts a `<link>` to. */
export const GOOGLE_FONTS_CSS = /^https:\/\/fonts\.googleapis\.com\//;

/** Google Fonts' font-file host — what those stylesheets point at. */
export const GOOGLE_FONTS_FILES = /^https:\/\/fonts\.gstatic\.com\//;

/**
 * Where the stubbed stylesheet points its font files. On the real font host so
 * the browser treats it like Google's, under a path Google never serves.
 */
export const LOCAL_FONT_BASE = 'https://fonts.gstatic.com/__dorkos-e2e__/';

/**
 * Chromium switch that makes both Google Fonts hosts fail DNS immediately.
 * Routed requests never reach DNS, so it only affects requests nothing routed.
 */
export const GOOGLE_FONTS_HOST_RULES =
  '--host-resolver-rules=MAP fonts.googleapis.com ~NOTFOUND, MAP fonts.gstatic.com ~NOTFOUND';

/**
 * The client's `inter` pairing, spelled as `font-config.ts` spells it: the
 * Google family name, and the `@fontsource-variable` package with that font.
 */
export const LOCAL_FAMILIES = [
  { family: 'Inter', pkg: '@fontsource-variable/inter' },
  { family: 'JetBrains Mono', pkg: '@fontsource-variable/jetbrains-mono' },
] as const;

type LocalFamily = (typeof LOCAL_FAMILIES)[number]['family'];

const requireFromHere = createRequire(import.meta.url);
const stylesheets = new Map<LocalFamily, string>();
/** Every servable file name, mapped to the package folder that holds it. */
const fileDirs = new Map<string, string>();
const fontBytes = new Map<string, Buffer>();

/**
 * One family's stylesheet: the package's variable-weight CSS, renamed to the
 * family the client asks for (`'Inter'`, not `'Inter Variable'`) and pointed
 * at {@link LOCAL_FONT_BASE}. Keeps the package's per-script `unicode-range`
 * split, as Google's stylesheet does. `font-display: block` so no test sees a
 * fallback-font frame.
 */
export function familyStylesheet(family: LocalFamily): string {
  const cached = stylesheets.get(family);
  if (cached !== undefined) return cached;
  const entry = LOCAL_FAMILIES.find((f) => f.family === family);
  if (!entry) throw new Error(`no local font for ${family}`);
  const dir = dirname(requireFromHere.resolve(`${entry.pkg}/package.json`));
  let count = 0;
  const css = readFileSync(join(dir, 'wght.css'), 'utf8')
    .replace(/font-family: '[^']+ Variable';/g, `font-family: '${family}';`)
    .replace(/font-display: swap;/g, 'font-display: block;')
    .replace(
      /src: url\(\.\/files\/([\w.-]+\.woff2)\) format\('woff2-variations'\);/g,
      (_match, file: string) => {
        count += 1;
        fileDirs.set(file, join(dir, 'files'));
        const url = `${LOCAL_FONT_BASE}${file}`;
        return `src: url('${url}') format('woff2-variations'), url('${url}') format('woff2');`;
      }
    );
  if (count === 0) throw new Error(`${entry.pkg} wght.css lists no woff2 files`);
  stylesheets.set(family, css);
  return css;
}

/** The local families a Google Fonts stylesheet URL asks for, in its order. */
export function localFamiliesIn(url: string): LocalFamily[] {
  const names = new URL(url).searchParams
    .getAll('family')
    .map((family) => family.split(':')[0]?.trim());
  return LOCAL_FAMILIES.map((f) => f.family).filter((family) => names.includes(family));
}

/** Bytes of one of the stylesheets' font files, or `undefined` for any other name. */
export function localFontFile(url: string): Buffer | undefined {
  if (!url.startsWith(LOCAL_FONT_BASE)) return undefined;
  const file = url.slice(LOCAL_FONT_BASE.length).split(/[?#]/)[0] ?? '';
  for (const { family } of LOCAL_FAMILIES) familyStylesheet(family);
  const dir = fileDirs.get(file);
  if (!dir) return undefined;
  let bytes = fontBytes.get(file);
  if (!bytes) {
    bytes = readFileSync(join(dir, file));
    fontBytes.set(file, bytes);
  }
  return bytes;
}

async function answerStylesheet(route: Route): Promise<void> {
  let body: string;
  try {
    body = localFamiliesIn(route.request().url()).map(familyStylesheet).join('\n');
  } catch {
    body = '';
  }
  await route.fulfill({ status: 200, contentType: 'text/css', body });
}

async function answerFontFile(route: Route): Promise<void> {
  let bytes: Buffer | undefined;
  try {
    bytes = localFontFile(route.request().url());
  } catch {
    bytes = undefined;
  }
  if (!bytes) return route.abort();
  await route.fulfill({
    status: 200,
    contentType: 'font/woff2',
    headers: { 'access-control-allow-origin': '*' },
    body: bytes,
  });
}

/**
 * Answer every Google Fonts request on this context without the network.
 *
 * Context-level so a popup or a second page of the same test is covered too.
 * No one-shot count option, on purpose: see GOTCHAS.md on one-shot routes.
 *
 * @param context - The browser context to stub.
 */
export async function stubGoogleFonts(context: Pick<BrowserContext, 'route'>): Promise<void> {
  await context.route(GOOGLE_FONTS_CSS, answerStylesheet);
  await context.route(GOOGLE_FONTS_FILES, answerFontFile);
}
