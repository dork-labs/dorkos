/**
 * Every space page in these browser tests runs under the page's real content security policy
 * (DOR-2957): the server adds it to every page however a spec serves it. This `test` fails any
 * test during which a page broke that policy, so a spec that passes proves its flow works under
 * it. Every spec imports `test` and `expect` from here, never from `@playwright/test`
 * (`apps/server/src/services/spaces/__tests__/browser-tests-csp.test.ts` checks).
 *
 * It watches every browser context, the default one and those a spec makes itself with
 * `browser.newContext()` or `browser.newPage()`, through two signals: the page's own
 * `securitypolicyviolation` event, and the console line Chromium writes for each refusal.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  test as base,
  expect,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';

/** What a page reports when it refuses something under its policy. */
const REPORT_PREFIX = 'CSP violation:';

/** The refusals seen since the last test checked, as readable lines. */
const violations: string[] = [];
const watched = new WeakSet<BrowserContext>();

/** Start collecting one context's refusals. */
async function watch(context: BrowserContext): Promise<void> {
  if (watched.has(context)) return;
  watched.add(context);
  await context.addInitScript((prefix) => {
    document.addEventListener('securitypolicyviolation', (event) => {
      console.error(
        `${prefix} ${event.effectiveDirective} blocked ${event.blockedURI || 'inline'} at ${event.documentURI}` +
          (event.sourceFile
            ? ` (${event.sourceFile}:${event.lineNumber}:${event.columnNumber})`
            : '')
      );
    });
  }, REPORT_PREFIX);
  context.on('console', (message) => {
    const text = message.text();
    if (text.startsWith(REPORT_PREFIX) || /Content Security Policy/u.test(text))
      violations.push(withoutFragments(`${message.page()?.url() ?? 'a page'}: ${text}`));
  });
}

/** A report line with every `#…` cut from its addresses: a link's fragment can be its secret. */
function withoutFragments(line: string): string {
  return line.replaceAll(/#[^\s)'":]*/gu, '#…');
}

/**
 * Take the refusals seen so far in this test, so a test that provokes one on purpose can check
 * it. Whatever is left when the test ends fails it.
 */
export function takeViolations(): string[] {
  return violations.splice(0);
}

/** Make every context this browser opens a watched one. */
function watchBrowser(browser: Browser): void {
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...args) => {
    const context = await newContext(...args);
    await watch(context);
    return context;
  };
}

const AXE_SOURCE = readFileSync(
  createRequire(import.meta.url).resolve('axe-core/axe.min.js'),
  'utf8'
);

/**
 * Load axe into a page for an accessibility audit. A `<script>` tag would be inline script, which
 * the page's policy refuses; evaluated through the browser's own tools, it is not page script.
 */
export async function injectAxe(page: Page): Promise<void> {
  await page.evaluate(AXE_SOURCE);
}

/** Playwright's `test`, failing any test during which a page broke its security policy. */
export const test = base.extend<{ cspGuard: void }, { cspBrowser: void }>({
  cspBrowser: [
    async ({ browser }, use) => {
      watchBrowser(browser);
      await use();
    },
    { scope: 'worker', auto: true },
  ],
  context: async ({ context }, use) => {
    await watch(context);
    await use(context);
  },
  cspGuard: [
    // Depends on the browser watch, so every context a test opens is watched before it starts.
    async ({ cspBrowser: _watching }, use) => {
      violations.length = 0;
      await use();
      const seen = violations.splice(0);
      expect(seen, 'the page broke its content security policy').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
