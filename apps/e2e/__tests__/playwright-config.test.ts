import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Guards the invariant DOR-1243 depends on: every `webServer` leg in
 * `playwright.config.ts` carries a DISTINCT `timeout`. Playwright's own
 * readiness-timeout error names only the millisecond number — `Timed out
 * waiting 180000ms from config.webServer.` — never the leg (verified against
 * the installed `playwright@1.59.1`: `webServerPlugin.js`'s
 * `_waitForProcess` throws that string with no access to the leg's `name`).
 * A duplicate timeout would make a future CI timeout ambiguous between two
 * legs; this test fails loudly the moment that happens instead of leaving it
 * to be rediscovered the next time the marketing-site leg goes red.
 *
 * `E2E_SITE` is set before the config module is imported so the Marketing
 * Site leg — normally opt-in — is included: it is one of the five legs this
 * invariant covers, and skipping it here would leave its timeout unchecked.
 *
 * @module __tests__/playwright-config
 */
describe('playwright.config.ts webServer legs', () => {
  let timeouts: number[];

  beforeAll(async () => {
    // Deliberate direct process.env access: this package has no env.ts (see
    // playwright.config.ts's own top-of-file disable), and this sets the flag
    // the config module itself reads, not a config read of our own.
    // eslint-disable-next-line no-restricted-syntax
    process.env.E2E_SITE = '1';
    const { default: config } = await import('../playwright.config.js');
    const webServer = config.webServer;
    const legs = Array.isArray(webServer) ? webServer : webServer ? [webServer] : [];
    timeouts = legs.map((leg) => leg.timeout ?? 0);
  });

  it('gives every leg a distinct readiness timeout', () => {
    // Five legs expected: Express API, Vite Client, Express API (test-mode),
    // Vite Client (test-mode), Marketing Site — the last only present
    // because E2E_SITE was set above before the config was imported.
    expect(timeouts.length).toBe(5);
    expect(new Set(timeouts).size).toBe(timeouts.length);
  });
});
