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

/**
 * Build a `config-manager.ts`-shaped source carrying the given migration entries.
 *
 * `somethingElse` closes on a line of its own because the real file's
 * declarations do, and the guard now reads them: a one-line `{}` function would
 * be a fixture the reader could never meet in production.
 */
function sourceWith(entries: string[], declarations: string[] = []): string {
  return [
    '// preamble that is not part of the table',
    'export const CONFIG_MIGRATIONS = {',
    ...entries,
    '} as const;',
    '',
    'export function somethingElse() {',
    '  return 1;',
    '}',
    ...declarations,
  ].join('\n');
}

/** One migration entry, optionally preceded by a comment line documenting it. */
function entry(key: string, body: string, comment?: string): string {
  const lines = comment === undefined ? [] : [`  // ${comment}`];
  lines.push(`  '${key}': (store) => {`, `    ${body}`, '  },');
  return lines.join('\n');
}

/** A top-level helper shaped like the real ones, closing on a line of its own. */
function helper(name: string, body: string, doc = 'documented'): string {
  return [
    '',
    '/**',
    ` * ${doc}`,
    ' */',
    `export function ${name}(store: {`,
    '  get: (key: string) => unknown;',
    '  set: (key: string, value: unknown) => void;',
    '}): void {',
    `  ${body}`,
    '}',
  ].join('\n');
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

// DOR-1135. Nearly every key in the real table is a composite that calls
// helpers, and several are a bare reference and nothing else, so a rule that
// compared only the table slice froze a function NAME while its body stayed
// editable. The demonstration in the ticket is the first case below: the same
// tamper is red inline and was green in a helper.
describe('checkMigrationSafety, for the code a shipped key calls', () => {
  /** The composite shape the real table is mostly made of: a key that only calls. */
  const COMPOSITE = entry('0.57.0', 'backfillAcknowledgement(store);', 'shipped in v0.57.0');

  const ACKNOWLEDGEMENT = helper('backfillAcknowledgement', "store.set('acknowledged', true);");

  /** Reached only by the unshipped `0.59.0` key below, never by `0.57.0`. */
  const LATER = helper('backfillLaterThing', "store.set('later', true);");

  const RELEASED = sourceWith([COMPOSITE], [ACKNOWLEDGEMENT, LATER]);
  const readComposite = (version: string) => (version === '0.58.0' ? RELEASED : null);

  /** Run the rule over a working tree, against the composite release above. */
  const check = (workingSource: string) =>
    checkMigrationSafety({ workingSource, tags: TAGS, readAtTag: readComposite });

  it('fails when a helper the shipped key calls has been tampered with', () => {
    const tampered = helper(
      'backfillAcknowledgement',
      "store.set('acknowledged', true);\n  store.set('somethingAddedLater', true);"
    );

    const res = check(sourceWith([COMPOSITE], [tampered, LATER]));

    expect(res.ok).toBe(false);
    expect(res.problems.join('\n')).toMatch(/"0\.57\.0".*code it reaches/s);
    expect(res.problems.join('\n')).toMatch(/backfillAcknowledgement was edited/);
  });

  it('fails identically when that tamper is written inline in the table instead', () => {
    // The pair is the point: before DOR-1135 this half was red and the half
    // above was green, for the same change to what an upgrading user runs.
    const inline = [
      '  // shipped in v0.57.0',
      "  '0.57.0': (store) => {",
      '    backfillAcknowledgement(store);',
      "    store.set('somethingAddedLater', true);",
      '  },',
    ].join('\n');

    const res = check(sourceWith([inline], [ACKNOWLEDGEMENT, LATER]));

    expect(res.ok).toBe(false);
    expect(res.problems.join('\n')).toMatch(/"0\.57\.0" already shipped/);
  });

  it('follows the calls a helper itself makes', () => {
    const nested = helper('backfillAcknowledgement', 'seedTheFlag(store);');
    const seedBefore = helper('seedTheFlag', "store.set('acknowledged', true);");
    const seedAfter = helper('seedTheFlag', "store.set('acknowledged', false);");

    const releasedNested = sourceWith([COMPOSITE], [nested, seedBefore, LATER]);
    const res = checkMigrationSafety({
      workingSource: sourceWith([COMPOSITE], [nested, seedAfter, LATER]),
      tags: TAGS,
      readAtTag: (v) => (v === '0.58.0' ? releasedNested : null),
    });

    expect(res.ok).toBe(false);
    expect(res.problems.join('\n')).toMatch(/seedTheFlag was edited/);
  });

  it('names a declaration the shipped key now reaches and did not', () => {
    // Moving a helper that used to be imported into this file changes what the
    // key runs while leaving its table slice byte-identical, so the reachability
    // difference is the only thing that can report it.
    const releasedWithoutIt = sourceWith([COMPOSITE], [LATER]);
    const res = checkMigrationSafety({
      workingSource: sourceWith([COMPOSITE], [ACKNOWLEDGEMENT, LATER]),
      tags: TAGS,
      readAtTag: (v) => (v === '0.58.0' ? releasedWithoutIt : null),
    });

    expect(res.ok).toBe(false);
    expect(res.problems.join('\n')).toMatch(/backfillAcknowledgement is now reached and was not/);
  });

  it('names a declaration the shipped key has stopped reaching', () => {
    // The mirror: moving the helper OUT to an import, where no guard reads it.
    const res = check(sourceWith([COMPOSITE], [LATER]));

    expect(res.ok).toBe(false);
    expect(res.problems.join('\n')).toMatch(/backfillAcknowledgement is no longer reached/);
  });

  it('passes when nothing the shipped key reaches has moved', () => {
    expect(check(RELEASED)).toMatchObject({ ok: true, problems: [] });
  });

  it('passes when a NEW key is added below a helper of its own', () => {
    const res = check(
      sourceWith(
        [COMPOSITE, entry('0.59.0', 'backfillBrandNew(store);', 'new work')],
        [ACKNOWLEDGEMENT, LATER, helper('backfillBrandNew', "store.set('brandNew', true);")]
      )
    );

    expect(res).toMatchObject({ ok: true, problems: [] });
  });

  it('passes when the edited helper is reached only by an UNSHIPPED key', () => {
    // `backfillLaterThing` is in the release, but nothing that shipped calls it.
    // Editing it changes nobody's upgrade, so a guard that reddened here would
    // be noise on exactly the workflow it exists to permit.
    const res = check(
      sourceWith(
        [COMPOSITE, entry('0.59.0', 'backfillLaterThing(store);', 'new work')],
        [ACKNOWLEDGEMENT, helper('backfillLaterThing', "store.set('later', 'reworked');")]
      )
    );

    expect(res).toMatchObject({ ok: true, problems: [] });
  });

  it('passes when a shipped key’s helper is only reworded or reflowed', () => {
    // Behavior is what the release ran. Freezing every TSDoc line a shipped
    // migration can reach would make this guard unlandable, so the closure
    // comparison is normalized (`migration-closure.ts`) even though the table
    // slice beside it is byte-for-byte.
    const reworded = helper(
      'backfillAcknowledgement',
      "store.set(\n    'acknowledged',\n    true\n  );",
      'documented, but the sentence was corrected'
    );

    expect(check(sourceWith([COMPOSITE], [reworded, LATER]))).toMatchObject({
      ok: true,
      problems: [],
    });
  });
});
