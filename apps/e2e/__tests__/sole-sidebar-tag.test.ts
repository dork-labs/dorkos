import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SOLE_SIDEBAR_TAG } from '../fixtures/sole-access';

/**
 * Every spec that drives the shared sidebar panel wears the tag that gives it
 * sole access (DOR-1420).
 *
 * The tag is what makes `fixtures/sole-access.ts` do anything, and a tag is a
 * thing somebody has to remember. This is the remembering: a new spec added
 * beside the others goes red here until it either takes the lock or says, in
 * this file, why it does not need it.
 *
 * **Four ways a spec can look covered and not be**, each of which a reviewer
 * produced by hand and each of which now fails here:
 *
 * - the tag is simply missing;
 * - the tag is present but the spec imports `test` from `@playwright/test`, so
 *   the fixture that reads the tag is not in the picture at all;
 * - the identifier appears in a title or a comment rather than in a `{ tag: … }`
 *   option, so a substring search is satisfied by prose;
 * - the file named in the exemption list is gone, leaving an exemption that
 *   excuses nothing and hides the next file to take its name.
 *
 * Deliberately a source scan rather than a Playwright run. What is being checked
 * is that the tag is WRITTEN, and the only run that could observe its absence is
 * a concurrent one against a real server — which is precisely the run this suite
 * does not do on a PR.
 */
const SIDEBAR_TESTS = join(import.meta.dirname, '..', 'tests', 'dashboard-sidebar');

/**
 * The import that puts the locking fixture in a spec's path.
 *
 * A spec that reaches straight for `@playwright/test` gets Playwright's own
 * `test`, which knows nothing about `soleSidebar` — so the tag is decoration and
 * the spec runs unlocked. Half this suite imports that way legitimately
 * (`playwright.config.ts` says so about `storageState`), which is exactly why a
 * tagged spec doing it is worth catching.
 */
const FIXTURE_IMPORT = "from '../../fixtures'";

/**
 * The specs in that directory that do NOT touch the shared sidebar, each with
 * the reason it is exempt.
 *
 * Short by design. A file that reaches for `basePage`, `roomsApi` or the app's
 * own panel belongs in the tagged set, whatever it is called.
 */
const NO_SHARED_SIDEBAR: Record<string, string> = {
  // Drives the Dev Playground's hand-built fixtures at `/dev`, and asserts it
  // asks the server for nothing at all. There is no shared panel to hold, and
  // its cases run to 150s — holding the lock across them would serialize the
  // whole family for nothing.
  'sidebar-model-showcase.spec.ts': 'renders the Dev Playground, never the app’s sidebar',
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

/**
 * Whether a describe header actually PASSES the tag, rather than mentioning it.
 *
 * The identifier alone is not evidence: a title that names the tag, or a comment
 * above the describe explaining why it has one, satisfies a substring search
 * while the option that does the work is absent. The option is what the fixture
 * reads, so the option is what this looks for.
 *
 * @param header - One header from {@link topLevelDescribes}.
 */
function passesTheTag(header: string): boolean {
  return /\{\s*tag:\s*[^}]*SOLE_SIDEBAR_TAG/.test(header);
}

describe('the dashboard-sidebar specs take sole access', () => {
  const specs = readdirSync(SIDEBAR_TESTS).filter((name) => name.endsWith('.spec.ts'));

  it('finds the specs at all, so an empty sweep cannot pass', () => {
    expect(specs.length).toBeGreaterThan(5);
  });

  it('excuses only files that are actually there', () => {
    // An exemption for a file that has been renamed or deleted excuses nothing,
    // and quietly pre-approves whatever file next takes that name.
    const missing = Object.keys(NO_SHARED_SIDEBAR).filter((name) => !specs.includes(name));
    expect(
      missing,
      'NO_SHARED_SIDEBAR names specs that no longer exist — drop the entries'
    ).toEqual([]);
  });

  it.each(specs)('%s declares whether it shares the sidebar', (name) => {
    const source = readFileSync(join(SIDEBAR_TESTS, name), 'utf8');
    const describes = topLevelDescribes(source);
    expect(describes.length, `${name} declares no top-level test.describe`).toBeGreaterThan(0);

    if (name in NO_SHARED_SIDEBAR) {
      expect(
        describes.some(passesTheTag),
        `${name} is exempt (${NO_SHARED_SIDEBAR[name]}) but takes the lock anyway — ` +
          'drop the exemption or drop the tag'
      ).toBe(false);
      return;
    }

    const untagged = describes.filter((header) => !passesTheTag(header));
    expect(
      untagged,
      `${name} drives the shared sidebar without ${SOLE_SIDEBAR_TAG}, so a concurrent ` +
        'local run can seed rows into the panel it is measuring. Pass ' +
        '`{ tag: SOLE_SIDEBAR_TAG }` to test.describe, or add the file to NO_SHARED_SIDEBAR with its reason.'
    ).toEqual([]);

    // The tag only does something through this package's own `test`. Asserted
    // per file rather than once, because it is the same mistake as forgetting
    // the tag and it looks even more convincing.
    expect(
      source.includes(FIXTURE_IMPORT),
      `${name} is tagged ${SOLE_SIDEBAR_TAG} but does not import test from ${FIXTURE_IMPORT}, ` +
        'so the fixture that takes the lock never runs and the tag is decoration'
    ).toBe(true);
  });
});
