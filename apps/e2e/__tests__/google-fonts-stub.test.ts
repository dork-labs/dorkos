import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  GOOGLE_FONTS_CSS,
  GOOGLE_FONTS_FILES,
  GOOGLE_FONTS_HOST_RULES,
  LOCAL_FAMILIES,
  LOCAL_FONT_BASE,
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

/** What the client's default `inter` pairing asks for (`font-config.ts`). */
const INTER_URL =
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono&display=swap';
const LATIN = `${LOCAL_FONT_BASE}inter-latin-wght-normal.woff2`;
const MONO_LATIN = `${LOCAL_FONT_BASE}jetbrains-mono-latin-wght-normal.woff2`;

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

function fulfilled(outcome: Outcome): Record<string, unknown> {
  if (typeof outcome === 'string') throw new Error(`expected a fulfilled response, got ${outcome}`);
  return outcome.fulfilled;
}

describe('stubGoogleFonts', () => {
  it("answers the client's stylesheet with Inter and JetBrains Mono faces on local URLs", async () => {
    const response = fulfilled(await answer(await stubbed(), INTER_URL));
    expect(response).toMatchObject({ status: 200, contentType: 'text/css' });

    const css = String(response.body);
    expect(css).toContain("font-family: 'Inter';");
    expect(css).not.toContain('Inter Variable');
    expect(css).toContain('font-weight: 100 900;');
    expect(css).toContain('font-display: block;');
    expect(css).toContain(`url('${LATIN}') format('woff2-variations')`);
    expect(css).toContain(`url('${LATIN}') format('woff2')`);
    expect(css).toContain("font-family: 'JetBrains Mono';");
    expect(css).not.toContain('JetBrains Mono Variable');
    expect(css).toContain(`url('${MONO_LATIN}') format('woff2-variations')`);
    expect(css).toContain(`url('${MONO_LATIN}') format('woff2')`);
    // Every font URL the stylesheet names is on the local path.
    const urls = [...css.matchAll(/url\('([^']+)'\)/g)].map((m) => m[1]);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(url?.startsWith(LOCAL_FONT_BASE), url).toBe(true);
  });

  it('answers each local font URL with the real woff2 bytes', async () => {
    const routes = await stubbed();
    for (const url of [LATIN, MONO_LATIN]) {
      const response = fulfilled(await answer(routes, url));
      expect(response, url).toMatchObject({ status: 200, contentType: 'font/woff2' });
      const body = response.body as Buffer;
      expect(Buffer.isBuffer(body), url).toBe(true);
      expect(body.length, url).toBeGreaterThan(1000);
      expect(body.subarray(0, 4).toString('latin1'), url).toBe('wOF2');
    }
  });

  it('answers a stylesheet for one of the two with only that family', async () => {
    const routes = await stubbed();
    const mono = String(
      fulfilled(await answer(routes, 'https://fonts.googleapis.com/css2?family=JetBrains+Mono'))
        .body
    );
    expect(mono).toContain("font-family: 'JetBrains Mono';");
    expect(mono).not.toContain("font-family: 'Inter';");
  });

  it('answers another family with an empty stylesheet', async () => {
    const routes = await stubbed();
    for (const url of [
      'https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono&display=swap',
      'https://fonts.googleapis.com/css2?family=Inter+Tight:wght@400',
      'https://fonts.googleapis.com/css?family=Roboto',
    ]) {
      expect(await answer(routes, url), url).toEqual({
        fulfilled: { status: 200, contentType: 'text/css', body: '' },
      });
    }
  });

  it('aborts any other font file, including unknown names on the local path', async () => {
    const routes = await stubbed();
    for (const url of [
      'https://fonts.gstatic.com/s/inter/v13/abc.woff2',
      `${LOCAL_FONT_BASE}not-a-font.woff2`,
      `${LOCAL_FONT_BASE}../package.json`,
    ]) {
      expect(await answer(routes, url), url).toBe('aborted');
    }
  });

  it('lets no Google Fonts request reach the network', async () => {
    const routes = await stubbed();
    for (const url of [
      INTER_URL,
      LATIN,
      'https://fonts.googleapis.com/',
      'https://fonts.googleapis.com/icon?family=Material+Icons',
      'https://fonts.googleapis.com/css2?family=%%%',
      'https://fonts.gstatic.com/',
      MONO_LATIN,
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

describe('the families served are the ones the client asks for', () => {
  it("matches the inter pairing's names in font-config.ts", () => {
    // Read as text: apps/e2e depends on no client code.
    const source = readFileSync(
      fileURLToPath(new URL('../../client/src/layers/shared/lib/font-config.ts', import.meta.url)),
      'utf8'
    );
    const inter = source.slice(source.indexOf("key: 'inter'"), source.indexOf("key: 'geist'"));
    expect(inter).toContain("sans: \"'Inter', ");
    expect(inter).toContain("mono: \"'JetBrains Mono', ");
    expect(inter).toContain('family=Inter:');
    expect(inter).toContain('family=JetBrains+Mono&');
    expect(LOCAL_FAMILIES.map((f) => f.family)).toEqual(['Inter', 'JetBrains Mono']);
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
    // A spec that did would get neither the stub nor Inter.
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
