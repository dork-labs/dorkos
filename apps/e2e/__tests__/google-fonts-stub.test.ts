import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  E2E_FONT_FAMILY,
  FONT_FAMILY_KEY,
  GOOGLE_FONTS_CSS,
  GOOGLE_FONTS_FILES,
  stubGoogleFonts,
} from '../google-fonts-stub';

/**
 * Guards DOR-4871: no browser test may wait on Google Fonts.
 *
 * Both halves fail nothing if deleted — the suite only goes red again on the
 * day Google stalls, on whichever spec is loading a page at the time — so they
 * are pinned here, where removing one is a red unit test that names the cause.
 *
 * @module __tests__/google-fonts-stub
 */

type Handler = (route: {
  fulfill: (response: unknown) => Promise<void>;
  abort: () => Promise<void>;
}) => unknown;

/** A context that records what was routed, and how many arguments each `route` call got. */
function fakeContext() {
  const routes: { pattern: RegExp; handler: Handler; argCount: number }[] = [];
  const context = {
    route: vi.fn(async (...args: unknown[]) => {
      routes.push({
        pattern: args[0] as RegExp,
        handler: args[1] as Handler,
        argCount: args.length,
      });
    }),
  };
  return { context, routes };
}

/** Run the handler that would answer `url`, and report what it did. */
async function answer(routes: ReturnType<typeof fakeContext>['routes'], url: string) {
  const matched = routes.find((r) => r.pattern.test(url));
  if (!matched) return 'network';
  const fulfill = vi.fn(async (_response: unknown) => {});
  const abort = vi.fn(async () => {});
  await matched.handler({ fulfill, abort });
  if (fulfill.mock.calls.length) return { fulfilled: fulfill.mock.calls[0]?.[0] };
  if (abort.mock.calls.length) return 'aborted';
  return 'unanswered';
}

describe('stubGoogleFonts', () => {
  it('answers the stylesheet with an empty one and aborts the font files', async () => {
    const { context, routes } = fakeContext();
    await stubGoogleFonts(context as never);

    expect(
      await answer(
        routes,
        'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono&display=swap'
      )
    ).toEqual({ fulfilled: { status: 200, contentType: 'text/css', body: '' } });
    expect(await answer(routes, 'https://fonts.gstatic.com/s/inter/v13/abc.woff2')).toBe('aborted');
  });

  it('leaves the app under test alone', async () => {
    const { context, routes } = fakeContext();
    await stubGoogleFonts(context as never);

    expect(await answer(routes, 'http://localhost:4241/')).toBe('network');
    expect(await answer(routes, 'http://localhost:4241/api/health')).toBe('network');
  });

  it('never makes a one-shot route (GOTCHAS.md)', async () => {
    const { context, routes } = fakeContext();
    await stubGoogleFonts(context as never);

    expect(routes.map((r) => r.argCount)).toEqual([2, 2]);
    expect(routes.map((r) => r.pattern)).toEqual([GOOGLE_FONTS_CSS, GOOGLE_FONTS_FILES]);
  });
});

describe('every browser test boots on the system font', () => {
  it('seeds the system font into every origin the config stores state for', async () => {
    const { default: config } = await import('../playwright.config.js');
    const state = config.use?.storageState;
    if (!state || typeof state === 'string') throw new Error('expected an inline storageState');

    expect(state.origins.length).toBeGreaterThan(0);
    for (const origin of state.origins) {
      expect(origin.localStorage, origin.origin).toContainEqual({
        name: FONT_FAMILY_KEY,
        value: E2E_FONT_FAMILY,
      });
    }
  });

  it('installs the stub on the context of every test that uses the shared fixture', () => {
    // Source-level, because a Playwright `test` cannot be asked which fixtures
    // it overrides outside a runner.
    const source = readFileSync(
      fileURLToPath(new URL('../fixtures/index.ts', import.meta.url)),
      'utf8'
    );
    expect(source).toMatch(
      /context: async \(\{ context \}, use\) => \{\s*await stubGoogleFonts\(context\);/
    );
  });
});
