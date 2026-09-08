// Drift guard between the two tsconfigs that both compile `apps/client/src`.
//
// `apps/client/tsconfig.json` excludes two globs — the lint guards' fixture
// slices, one under `entities/` and one under every other layer — because
// DOR-1821 made those fixtures resident in `src/layers/` for the whole client
// test run (written by `globalSetup` before any worker starts, removed after
// the last one finishes). A directory that sits there for the whole run is
// not a test-time-only concern: `apps/obsidian-plugin/tsconfig.json` also
// compiles `../client/src` (its `include` names that path directly), and its
// `exclude` had never heard of either glob.
//
// So whenever turbo overlaps client `test` with obsidian `typecheck` — the
// pre-push gate and `pnpm verify` both do — `pnpm --filter @dorkos/obsidian-
// plugin typecheck` walks straight into the fixtures and exits 2 on three
// errors nobody wrote (DOR-1881): two implicit-`any` returns from the
// deliberate cross-entity cycle, and a `vi` that only Vitest's globals supply.
//
// The fix is a mirror, not a shared array: each glob gets rewritten with the
// `../client/` prefix the obsidian config's own `include` and `paths` already
// use to reach that tree. A mirror can silently stop mirroring the moment
// either file's `exclude` changes without the other, which is exactly the
// failure mode DOR-1821 introduced here in the first place — so this guard
// derives the client's fixture globs from its `exclude` array (rather than
// hardcoding them a second time) and asserts every one of them, rewritten, is
// present in the obsidian config. A third fixture glob added to the client
// tsconfig tomorrow is covered by this guard the day it lands, not the day
// someone remembers this file.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

const CLIENT_TSCONFIG = path.join(repoRoot, 'apps/client/tsconfig.json');
const OBSIDIAN_TSCONFIG = path.join(repoRoot, 'apps/obsidian-plugin/tsconfig.json');

/**
 * What a resident lint-fixture glob looks like: a path segment wrapped in double
 * underscores that names itself a fixture (`__dag-fixture-*__`,
 * `__slice-fixture-*__`). Matching the shape, rather than subtracting a list of
 * "structural" entries, is what keeps this guard honest about its own scope: an
 * ordinary exclude added to the client tomorrow (`src/generated/**`, say) is not
 * a fixture, does not need mirroring, and must not turn this test red — a guard
 * that cries wolf is a guard somebody deletes.
 */
const FIXTURE_GLOB = /__[\w*-]*fixture[\w*-]*__/;

/**
 * The `exclude` array from one tsconfig.json.
 *
 * Parsed with TypeScript's own reader, because both files carry `//` comments,
 * which `JSON.parse` rejects. A hand-rolled comment stripper would be one more
 * thing that can quietly return the wrong array and make this test vacuous.
 *
 * @param tsconfigPath - Absolute path of the tsconfig.json to read.
 * @returns Its `exclude` array.
 */
function readExclude(tsconfigPath: string): string[] {
  const text = readFileSync(tsconfigPath, 'utf-8');
  const parsed = ts.parseConfigFileTextToJson(tsconfigPath, text);
  expect(parsed.error, `could not parse ${tsconfigPath}`).toBeUndefined();
  const exclude = (parsed.config as { exclude?: unknown })?.exclude;
  expect(Array.isArray(exclude), `${tsconfigPath} has no exclude array`).toBe(true);
  return exclude as string[];
}

describe('the obsidian tsconfig mirrors the client’s resident lint-fixture excludes', () => {
  it('excludes every client fixture glob, rewritten with the ../client/ prefix', () => {
    const clientExclude = readExclude(CLIENT_TSCONFIG);
    const fixtureGlobs = clientExclude.filter((entry) => FIXTURE_GLOB.test(entry));

    // Guards the guard: this must never pass by finding nothing to check.
    // DOR-1821's two fixture globs are real, and a client tsconfig that
    // stopped excluding them would be its own regression, not a green light
    // for this file to go quiet about the obsidian side too.
    expect(fixtureGlobs.length).toBeGreaterThan(0);

    const obsidianExclude = readExclude(OBSIDIAN_TSCONFIG);
    const missing = fixtureGlobs
      .map((glob) => `../client/${glob}`)
      .filter((rewritten) => !obsidianExclude.includes(rewritten));

    expect(
      missing,
      missing.length
        ? `\n${missing.join('\n')}\n\n` +
            `apps/client/tsconfig.json excludes these (as fixture globs without the ` +
            `../client/ prefix), but apps/obsidian-plugin/tsconfig.json does not exclude ` +
            `the rewritten path — even though its own \`include\` also compiles ` +
            `../client/src. Add the missing entries to its \`exclude\` array, or ` +
            `\`pnpm --filter @dorkos/obsidian-plugin typecheck\` exits 2 on errors nobody ` +
            `wrote whenever it overlaps the client test run that makes these fixtures ` +
            `resident (DOR-1821, DOR-1881).`
        : ''
    ).toEqual([]);
  });
});
