import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SOLE_SIDEBAR_TAG } from '../fixtures/sole-access';

/**
 * Every spec that drives the shared cockpit sidebar wears the tag that gives it
 * sole access (DOR-1420).
 *
 * The tag is what makes `fixtures/sole-access.ts` do anything, and a tag is a
 * thing somebody has to remember. This is the remembering: a new spec added
 * beside the others goes red here until it either takes the lock or says, in
 * this file, why it does not need it.
 *
 * Deliberately a source scan rather than a Playwright run. What is being checked
 * is that the tag is WRITTEN, and the only run that could observe its absence is
 * a concurrent one against a real server — which is precisely the run this suite
 * does not do on a PR.
 */
const SIDEBAR_TESTS = join(import.meta.dirname, '..', 'tests', 'dashboard-sidebar');

/**
 * The specs in that directory that do NOT touch the shared sidebar, each with
 * the reason it is exempt.
 *
 * Short by design. A file that reaches for `basePage`, `roomsApi` or the
 * cockpit's own panel belongs in the tagged set, whatever it is called.
 */
const NO_SHARED_SIDEBAR: Record<string, string> = {
  // Drives the Dev Playground's hand-built fixtures at `/dev`, and asserts it
  // asks the server for nothing at all. There is no shared panel to hold, and
  // its cases run to 150s — holding the lock across them would serialize the
  // whole family for nothing.
  'sidebar-model-showcase.spec.ts': 'renders the Dev Playground, never the cockpit sidebar',
};

/**
 * Every top-level `test.describe(...)` HEADER in a spec — the call's arguments,
 * up to the body's `=> {`, which is where a tag goes.
 *
 * The header rather than the line, because Prettier decides how many lines the
 * call takes: a title long enough to wrap leaves `test.describe(` alone on its
 * own line with the tag on the next one, and a line-at-a-time reader calls that
 * untagged. (It did, on `sidebar-today.spec.ts`, the moment formatting ran.)
 *
 * @param source - The spec's text.
 */
function topLevelDescribes(source: string): string[] {
  return source
    .split(/^test\.describe\(/m)
    .slice(1)
    .map((rest) => `test.describe(${rest.split('=> {')[0] ?? ''}`);
}

describe('the dashboard-sidebar specs take sole access', () => {
  const specs = readdirSync(SIDEBAR_TESTS).filter((name) => name.endsWith('.spec.ts'));

  it('finds the specs at all, so an empty sweep cannot pass', () => {
    expect(specs.length).toBeGreaterThan(5);
  });

  it.each(specs)('%s declares whether it shares the sidebar', (name) => {
    const source = readFileSync(join(SIDEBAR_TESTS, name), 'utf8');
    const describes = topLevelDescribes(source);
    expect(describes.length, `${name} declares no top-level test.describe`).toBeGreaterThan(0);

    if (name in NO_SHARED_SIDEBAR) {
      expect(
        source.includes('SOLE_SIDEBAR_TAG'),
        `${name} is exempt (${NO_SHARED_SIDEBAR[name]}) but takes the lock anyway — ` +
          'drop the exemption or drop the tag'
      ).toBe(false);
      return;
    }

    const untagged = describes.filter((line) => !line.includes('SOLE_SIDEBAR_TAG'));
    expect(
      untagged,
      `${name} drives the shared cockpit sidebar without ${SOLE_SIDEBAR_TAG}, so a concurrent ` +
        'local run can seed rows into the panel it is measuring. Pass ' +
        '`{ tag: SOLE_SIDEBAR_TAG }` to test.describe, or add the file to NO_SHARED_SIDEBAR with its reason.'
    ).toEqual([]);
  });
});
