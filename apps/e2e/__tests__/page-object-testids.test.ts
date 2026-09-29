/**
 * Every test hook a page object names must be something the client renders.
 *
 * `ChatPage.inferenceStreaming` pointed at `inference-indicator-streaming` for
 * months after the component that drew it was deleted (DOR-2546). Nothing
 * failed: a `toBeHidden` on a selector that matches nothing passes at once, and
 * a `waitFor({ state: 'visible' }).catch()` burns its timeout and moves on. So
 * a dozen waits checked nothing, and a hook-name drift can only be caught by
 * reading both sides — which is what this does, statically, in a second.
 *
 * It checks two kinds of hook in `apps/e2e/pages/`:
 *
 * - **testids** — `data-testid="x"`, `data-testid^="x-"`, `getByTestId('x')`
 *   and ``getByTestId(`x-${id}`)``. A full id must appear QUOTED in the client
 *   (`'x'`, `"x"` or `` `x` ``); a prefix (a `^=` selector, or the static head
 *   of a template) must appear after an opening quote or backtick.
 * - **data attributes** in attribute selectors — `[data-turn-status="…"]`. The
 *   attribute's name must appear in the client at all.
 *
 * The client side is `apps/client/src` minus tests and the Dev Playground
 * (`src/dev/`): a hook that only a unit test or a showcase renders is not one
 * the app renders.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PAGES = fileURLToPath(new URL('../pages', import.meta.url));
const CLIENT_SRC = fileURLToPath(new URL('../../client/src', import.meta.url));

/**
 * Hooks a page object may name although no client source renders them, each
 * with the reason. Keep it short: an entry here is a hook this guard cannot see,
 * so it needs a reason a reviewer would accept.
 */
const ALLOWLIST: ReadonlyMap<string, string> = new Map([
  // Both composed by `BarTabStrip` as `${testId}-fade-start` / `-fade-end`
  // (shared/ui/bar-tab-strip.tsx), with `testId` = TOUR_ANCHORS.homeTabs
  // ('home-tabs'). A composed suffix is the one shape a static scan cannot join.
  ['home-tabs-fade-start', 'composed by BarTabStrip from the home-tabs anchor'],
  ['home-tabs-fade-end', 'composed by BarTabStrip from the home-tabs anchor'],
]);

/** Every `.ts`/`.tsx` file under `dir`, skipping tests and the Dev Playground. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules' || path === join(CLIENT_SRC, 'dev')) {
        return [];
      }
      return sources(path);
    }
    if (!/\.tsx?$/.test(name) || /\.(test|spec)\.tsx?$/.test(name)) return [];
    return [path];
  });
}

/** One hook a page object names, and where. */
interface Hook {
  kind: 'testid' | 'testid-prefix' | 'attribute';
  value: string;
  file: string;
}

/** Pull every testid and data-attribute hook out of one page object's source. */
function hooksIn(source: string, file: string): Hook[] {
  const hooks: Hook[] = [];
  // data-testid="x" / data-testid^="x" / data-testid*="x" inside a CSS selector.
  for (const m of source.matchAll(/data-testid([\^*$]?)=\\?["']([^"'\\]*)\\?["']/g)) {
    const [, op, raw] = m;
    const templated = raw!.indexOf('${');
    if (templated === 0) continue; // wholly an expression: nothing static to check
    if (templated > 0) hooks.push({ kind: 'testid-prefix', value: raw!.slice(0, templated), file });
    else if (op === '^') hooks.push({ kind: 'testid-prefix', value: raw!, file });
    else if (op === '') hooks.push({ kind: 'testid', value: raw!, file });
  }
  // getByTestId('x') / getByTestId("x") / getByTestId(`x-${id}`).
  for (const m of source.matchAll(/getByTestId\(\s*(['"`])([^'"`]*)\1/g)) {
    const [, quote, raw] = m;
    const templated = quote === '`' ? raw!.indexOf('${') : -1;
    if (templated === 0) continue;
    if (templated > 0) hooks.push({ kind: 'testid-prefix', value: raw!.slice(0, templated), file });
    else hooks.push({ kind: 'testid', value: raw!, file });
  }
  // [data-foo="…"] / [data-foo] — any data attribute other than the testid.
  for (const m of source.matchAll(/\[(data-[a-z0-9-]+)\s*(?:[\^*$~|]?=|\])/g)) {
    if (m[1] !== 'data-testid') hooks.push({ kind: 'attribute', value: m[1]!, file });
  }
  return hooks;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether the client source renders `hook`, by the rule the module doc states. */
function rendered(hook: Hook, client: string): boolean {
  const value = escape(hook.value);
  switch (hook.kind) {
    case 'testid':
      return new RegExp(`['"\`]${value}['"\`]`).test(client);
    case 'testid-prefix':
      return new RegExp(`['"\`]${value}`).test(client);
    case 'attribute':
      return client.includes(hook.value);
  }
}

describe('page-object test hooks', () => {
  const client = sources(CLIENT_SRC)
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n');
  const hooks = sources(PAGES).flatMap((path) =>
    hooksIn(readFileSync(path, 'utf8'), relative(PAGES, path))
  );

  it('finds the hooks it is meant to check', () => {
    // A regex that silently stopped matching would turn this guard into the
    // vacuous wait it exists to catch.
    expect(hooks.length).toBeGreaterThan(50);
    expect(hooks).toContainEqual({ kind: 'testid', value: 'chat-panel', file: 'ChatPage.ts' });
  });

  it('names only hooks the client renders', () => {
    const missing = hooks
      .filter((hook) => !ALLOWLIST.has(hook.value) && !rendered(hook, client))
      .map((hook) => `${hook.file}: ${hook.kind} "${hook.value}"`);
    expect([...new Set(missing)]).toEqual([]);
  });

  it('allowlists only hooks that are really unrendered and really named', () => {
    // A stale entry would silently re-open the hole for whatever took its name.
    for (const value of ALLOWLIST.keys()) {
      const named = hooks.filter((hook) => hook.value === value);
      expect(named, `${value} is allowlisted but no page object names it`).not.toEqual([]);
      expect(
        named.some((hook) => rendered(hook, client)),
        `${value} is allowlisted but the client renders it`
      ).toBe(false);
    }
  });

  it('would have caught the hook DOR-2546 was about', () => {
    const dead = hooksIn(
      `page.locator('[data-testid="inference-indicator-streaming"]')`,
      'ChatPage.ts'
    );
    expect(dead).toEqual([
      { kind: 'testid', value: 'inference-indicator-streaming', file: 'ChatPage.ts' },
    ]);
    expect(rendered(dead[0]!, client)).toBe(false);
  });
});
