import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  GOOGLE_FONTS_CSS,
  GOOGLE_FONTS_FILES,
  GOOGLE_FONTS_HOST_RULES,
  stubGoogleFonts,
} from '../google-fonts-stub';

/**
 * Guards DOR-4871: no browser test may wait on Google Fonts, and none may look
 * different for it.
 *
 * Deleting any of this fails nothing on a normal day — the suite only goes red
 * again on the day Google stalls, on whichever spec is loading a page at the
 * time — so it is pinned here, where removing a piece is a red unit test that
 * names the cause.
 *
 * @module __tests__/google-fonts-stub
 */

/** A font a person can pick in Settings, which still loads from Google. */
const GEIST_URL =
  'https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono&display=swap';

type Outcome = 'network' | 'aborted' | 'unanswered' | { fulfilled: Record<string, unknown> };

type Handler = (route: {
  request: () => { url: () => string };
  fulfill: (response: unknown) => Promise<void>;
  abort: () => Promise<void>;
  continue: () => Promise<void>;
  fallback: () => Promise<void>;
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

async function stubbed() {
  const { context, routes } = fakeContext();
  await stubGoogleFonts(context as never);
  return routes;
}

/**
 * Run the handler that would answer `url`, and report what it did. Letting a
 * request through (`continue`, `fallback`) counts as reaching the network.
 */
async function answer(routes: Awaited<ReturnType<typeof stubbed>>, url: string): Promise<Outcome> {
  const matched = routes.find((r) => r.pattern.test(url));
  if (!matched) return 'network';
  const fulfill = vi.fn(async (_response: unknown) => {});
  const abort = vi.fn(async () => {});
  const passThrough = vi.fn(async () => {});
  await matched.handler({
    request: () => ({ url: () => url }),
    fulfill,
    abort,
    continue: passThrough,
    fallback: passThrough,
  });
  if (passThrough.mock.calls.length) return 'network';
  if (fulfill.mock.calls.length) {
    return { fulfilled: fulfill.mock.calls[0]?.[0] as Record<string, unknown> };
  }
  if (abort.mock.calls.length) return 'aborted';
  return 'unanswered';
}

describe('stubGoogleFonts', () => {
  it('answers every stylesheet with an empty one', async () => {
    const routes = await stubbed();
    for (const url of [
      GEIST_URL,
      'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono',
      'https://fonts.googleapis.com/css?family=Roboto',
    ]) {
      expect(await answer(routes, url), url).toEqual({
        fulfilled: { status: 200, contentType: 'text/css', body: '' },
      });
    }
  });

  it('aborts every font file', async () => {
    const routes = await stubbed();
    for (const url of [
      'https://fonts.gstatic.com/s/inter/v13/abc.woff2',
      'https://fonts.gstatic.com/s/geist/v1/x.woff2',
    ]) {
      expect(await answer(routes, url), url).toBe('aborted');
    }
  });

  it('lets no Google Fonts request reach the network', async () => {
    const routes = await stubbed();
    for (const url of [
      GEIST_URL,
      'https://fonts.googleapis.com/',
      'https://fonts.googleapis.com/icon?family=Material+Icons',
      'https://fonts.googleapis.com/css2?family=%%%',
      'https://fonts.gstatic.com/',
      'https://fonts.gstatic.com/s/jetbrainsmono/v18/x.woff2',
    ]) {
      const outcome = await answer(routes, url);
      expect(outcome, url).not.toBe('network');
      expect(outcome, url).not.toBe('unanswered');
    }
  });

  it('leaves the app under test alone', async () => {
    const routes = await stubbed();
    expect(await answer(routes, 'http://localhost:4241/')).toBe('network');
    expect(await answer(routes, 'http://localhost:4241/api/health')).toBe('network');
  });

  it('never makes a one-shot route (GOTCHAS.md)', async () => {
    const routes = await stubbed();
    expect(routes.map((r) => r.argCount)).toEqual([2, 2]);
    expect(routes.map((r) => r.pattern)).toEqual([GOOGLE_FONTS_CSS, GOOGLE_FONTS_FILES]);
  });
});

describe('the default font keeps the suite looking as it did', () => {
  it('ships with the client, so the empty stylesheet never replaces it', () => {
    // Read as text: apps/e2e depends on no client code. An empty stylesheet for
    // the default would drop text to a fallback font with other widths, which
    // is what broke two layout-sensitive specs (DOR-4871); DOR-4872 put the
    // default in the client instead.
    const source = readFileSync(
      fileURLToPath(new URL('../../client/src/layers/shared/lib/font-config.ts', import.meta.url)),
      'utf8'
    );
    const inter = source.slice(source.indexOf("key: 'inter'"), source.indexOf("key: 'geist'"));
    expect(inter).toContain('googleFontsUrl: null');
    expect(inter).not.toContain('fonts.googleapis.com');
  });
});

describe('every browser test is covered', () => {
  it('installs the stub on the context of every test built on fixtures/base', () => {
    // Source-level, because a Playwright `test` cannot be asked which fixtures
    // it overrides outside a runner.
    const source = readFileSync(
      fileURLToPath(new URL('../fixtures/base.ts', import.meta.url)),
      'utf8'
    );
    expect(source).toMatch(
      /context: async \(\{ context \}, use\) => \{\s*await stubGoogleFonts\(context\);/
    );
    const index = readFileSync(
      fileURLToPath(new URL('../fixtures/index.ts', import.meta.url)),
      'utf8'
    );
    expect(index).toContain("import { test as base } from './base';");
  });

  it('makes Google Fonts unresolvable for any context no fixture reaches', async () => {
    const { default: config } = await import('../playwright.config.js');
    expect(config.use?.launchOptions?.args).toContain(GOOGLE_FONTS_HOST_RULES);
    expect(GOOGLE_FONTS_HOST_RULES).toContain('MAP fonts.googleapis.com ~NOTFOUND');
    expect(GOOGLE_FONTS_HOST_RULES).toContain('MAP fonts.gstatic.com ~NOTFOUND');
    for (const project of config.projects ?? []) {
      expect(project.use?.launchOptions, project.name).toBeUndefined();
    }
  });

  it('has no spec take its test straight from @playwright/test', () => {
    // A spec that did would not get the stub.
    const offenders = readdirTs(fileURLToPath(new URL('../tests', import.meta.url))).filter(
      (file) =>
        /import\s+\{[^}]*\btest\b[^}]*\}\s*from\s*'@playwright\/test'/.test(
          readFileSync(file, 'utf8').replace(/import\s+type\s+\{[^}]*\}[^;]*;/g, '')
        )
    );
    expect(offenders).toEqual([]);
  });
});

function readdirTs(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => `${entry.parentPath}/${entry.name}`);
}
