/**
 * Fixture matrix for the DOR-339 migration-safety rule (`migration-safety.ts`).
 *
 * The guard in `config-manager.test.ts` runs this rule against the REAL
 * repository, which means it can only ever exercise the cases the repository
 * happens to be in — today, "everything is fine". The cases that matter are the
 * ones that must FAIL, and staging them for real would mean fabricating tags in
 * a scratch clone. So the rule is pure and the failures are fixtures: hand-built
 * source text plus a fake tag reader, one case per way a migration can be unsafe.
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';

import { checkMigrationSafety, extractMigrationBodies } from './migration-safety.js';

/** Build a `config-manager.ts`-shaped source carrying the given migration entries. */
function sourceWith(entries: string[]): string {
  return [
    '// preamble that is not part of the table',
    'export const CONFIG_MIGRATIONS = {',
    ...entries,
    '} as const;',
    '',
    'export function somethingElse() {}',
  ].join('\n');
}

/** One migration entry, optionally preceded by a comment line documenting it. */
function entry(key: string, body: string, comment?: string): string {
  const lines = comment === undefined ? [] : [`  // ${comment}`];
  lines.push(`  '${key}': (store) => {`, `    ${body}`, '  },');
  return lines.join('\n');
}

const SHIPPED = entry('0.57.0', 'backfillApprovals(store);', 'shipped in v0.57.0');
const RELEASED_SOURCE = sourceWith([entry('1.0.0', "store.set('version', 1);"), SHIPPED]);

/** A reader that answers with `RELEASED_SOURCE` for v0.58.0 and nothing else. */
const readAtTag = (version: string) => (version === '0.58.0' ? RELEASED_SOURCE : null);

const TAGS = ['0.57.0', '0.58.0'];

describe('extractMigrationBodies', () => {
  it('splits the table into one slice per key', () => {
    const bodies = extractMigrationBodies(RELEASED_SOURCE);
    expect(Object.keys(bodies)).toEqual(['1.0.0', '0.57.0']);
    expect(bodies['0.57.0']).toContain('backfillApprovals(store);');
  });

  it('leaves the comment introducing the NEXT key out of the previous key', () => {
    // Otherwise "add a migration, and explain it" would read as "the previous,
    // shipped migration was edited" — a false red on the exact workflow the
    // guard exists to permit.
    const bodies = extractMigrationBodies(
      sourceWith([SHIPPED, entry('0.59.0', 'backfillNewThing(store);', 'the new one')])
    );
    expect(bodies['0.57.0']).not.toContain('the new one');
    expect(bodies['0.57.0']).toBe(extractMigrationBodies(RELEASED_SOURCE)['0.57.0']);
  });

  it('throws rather than reporting an empty table when the constant is renamed', () => {
    expect(() => extractMigrationBodies('export const OTHER_NAME = {\n} as const;')).toThrow(
      /CONFIG_MIGRATIONS/
    );
  });
});

describe('checkMigrationSafety', () => {
  it('passes a new key above the latest release', () => {
    const res = checkMigrationSafety({
      workingSource: sourceWith([SHIPPED, entry('0.59.0', 'backfillNewThing(store);', 'new work')]),
      tags: TAGS,
      readAtTag,
    });
    expect(res).toMatchObject({ ok: true, latestReleased: '0.58.0', problems: [] });
  });

  it('passes a body APPENDED to a key that is above the latest release', () => {
    // The case the sidebar-redesign migration is in, and the one a reader most
    // often gets wrong: composing into an existing key is unsafe only once that
    // key has SHIPPED. `0.59.0` is not in v0.58.0, so it is still new work and
    // its whole body runs for everybody — a second entry inside it is fine, and
    // is what a change whose SCHEMA also ships in 0.59.0 must do rather than
    // opening 0.60.0 and leaving the two a release apart.
    const res = checkMigrationSafety({
      workingSource: sourceWith([
        SHIPPED,
        [
          "  '0.59.0': (store) => {",
          '    backfillNewThing(store);',
          '    migrateSidebarSectionPrefs(store);',
          '  },',
        ].join('\n'),
      ]),
      tags: TAGS,
      readAtTag,
    });
    expect(res).toMatchObject({ ok: true, problems: [] });
  });

  it('passes when every shipped key is byte-identical to the release', () => {
    const res = checkMigrationSafety({
      workingSource: RELEASED_SOURCE,
      tags: TAGS,
      readAtTag,
    });
    expect(res.ok).toBe(true);
  });

  // The DOR-988 case: a body appended to an already-tagged composite key. The
  // key is present in its own tag, so a presence check calls it safe, and the
  // appended body ships dead for everyone already past 0.57.0.
  it('fails when a shipped migration body has drifted', () => {
    const drifted = [
      '  // shipped in v0.57.0',
      "  '0.57.0': (store) => {",
      '    backfillApprovals(store);',
      '    backfillSomethingAddedLater(store);',
      '  },',
    ].join('\n');

    const res = checkMigrationSafety({
      workingSource: sourceWith([entry('1.0.0', "store.set('version', 1);"), drifted]),
      tags: TAGS,
      readAtTag,
    });

    expect(res.ok).toBe(false);
    expect(res.problems.join('\n')).toMatch(/"0\.57\.0" already shipped/);
  });

  // The original DOR-339 case: a key authored at a version that already shipped.
  it('fails a new key that is not above the latest release', () => {
    const res = checkMigrationSafety({
      workingSource: sourceWith([SHIPPED, entry('0.58.0', 'backfillNewThing(store);')]),
      tags: TAGS,
      readAtTag,
    });

    expect(res.ok).toBe(false);
    expect(res.problems.join('\n')).toMatch(/"0\.58\.0" is new here/);
  });

  it('fails a key that is missing from the release that should carry it', () => {
    // 0.57.0 is at or below the latest tag but absent from v0.58.0's file, so it
    // was authored after 0.57.0 shipped: nobody on 0.57.0 or later runs it.
    const res = checkMigrationSafety({
      workingSource: sourceWith([SHIPPED]),
      tags: TAGS,
      readAtTag: (v) => (v === '0.58.0' ? sourceWith([entry('1.0.0', 'noop();')]) : null),
    });

    expect(res.ok).toBe(false);
    expect(res.problems.join('\n')).toMatch(/"0\.57\.0" is new here/);
  });

  it('fails loudly, naming the cause, when the checkout has no tags', () => {
    const res = checkMigrationSafety({
      workingSource: RELEASED_SOURCE,
      tags: [],
      readAtTag,
    });

    expect(res.ok).toBe(false);
    expect(res.latestReleased).toBeNull();
    expect(res.problems.join('\n')).toMatch(/no v\* tags visible/);
    expect(res.problems.join('\n')).toMatch(/fetch-depth: 0/);
  });

  it('blames the RELEASED side, not the working tree, when the tagged file will not parse', () => {
    // The table was shaped differently in older releases, and nobody can go back
    // and fix a tag. Raising out of the parser here would report the author's own
    // file as broken for a restructure that happened releases ago.
    const res = checkMigrationSafety({
      workingSource: RELEASED_SOURCE,
      tags: TAGS,
      readAtTag: () => 'export const MIGRATIONS_UNDER_AN_OLDER_NAME = {\n} as const;',
    });

    expect(res.ok).toBe(false);
    expect(res.problems.join('\n')).toMatch(/as of v0\.58\.0/);
    expect(res.problems.join('\n')).toMatch(/shape changed since that release/);
  });

  it('still raises when the WORKING tree is the unparseable one', () => {
    expect(() =>
      checkMigrationSafety({
        workingSource: 'export const RENAMED_ON_THIS_BRANCH = {\n} as const;',
        tags: TAGS,
        readAtTag,
      })
    ).toThrow(/CONFIG_MIGRATIONS/);
  });

  it('fails loudly when the newest tag exists but its content cannot be read', () => {
    const res = checkMigrationSafety({
      workingSource: RELEASED_SOURCE,
      tags: TAGS,
      readAtTag: () => null,
    });

    expect(res.ok).toBe(false);
    expect(res.problems.join('\n')).toMatch(/refs\/tags\/v0\.58\.0/);
  });

  it('ignores prerelease tags when deciding what the latest release is', () => {
    // A `v0.59.0-rc.1` tag must not make a plain `0.59.0` key look released: the
    // release everyone is upgrading from is still 0.58.0.
    const res = checkMigrationSafety({
      workingSource: sourceWith([SHIPPED, entry('0.59.0', 'backfillNewThing(store);')]),
      tags: [...TAGS, '0.59.0-rc.1', '0.60.0-beta.2'],
      readAtTag,
    });

    expect(res).toMatchObject({ ok: true, latestReleased: '0.58.0' });
  });

  it('rejects a migration key that is not a version at all', () => {
    const res = checkMigrationSafety({
      workingSource: sourceWith([SHIPPED, entry('next', 'backfillNewThing(store);')]),
      tags: TAGS,
      readAtTag,
    });

    expect(res.ok).toBe(false);
    expect(res.problems.join('\n')).toMatch(/"next" is not a valid semver/);
  });
});
