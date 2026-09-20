/**
 * The DOR-339 migration-safety rule, as a pure function over text and tags.
 *
 * `conf` runs a migration only when its key falls in `(storedVersion,
 * projectVersion]`. So a migration authored under a key that is already
 * RELEASED never runs for anybody who is already on that release: no error, no
 * warning, the backfill simply does not happen. That has bitten this repo twice
 * (0.47.0 to 0.48.0, then a 0.54.0 key drafted as "the next version" while
 * v0.54.0 shipped under an open branch), which is why a guard exists at all.
 *
 * The guard that existed before DOR-988 only asked whether a KEY was PRESENT in
 * its own tag. Presence is not the property that matters: a migration body
 * appended to an already-shipped composite key ships dead, because the key
 * itself was present the whole time. So this rule compares CONTENT, and it does
 * it for every key rather than only the newest:
 *
 *   - A key that is in the latest release must be byte-identical to what that
 *     release carries. This is the "never edit a shipped migration" rule from
 *     `contributing/configuration.md`, which nothing enforced before.
 *   - A key that is NOT in the latest release is new work, so it must be
 *     strictly greater than the latest release, or the users already on that
 *     release will never run it.
 *
 * ## Why the table slice is not the whole comparison (DOR-1135)
 *
 * Comparing table text is comparing the CALL, and nearly every key in this table
 * is a composite that calls helpers — several are a bare reference and nothing
 * else. So the byte-identity rule above, on its own, froze the name of a shipped
 * migration's helper while leaving the helper's body editable. That is not a
 * theory: seeding a tamper into `backfillAutonomyAcknowledgement`, which the
 * shipped `'0.57.0'` key calls, returned `ok: true`, while the identical tamper
 * written inline in the table went red.
 *
 * So a shipped key is compared twice. Its table slice must be byte-identical, as
 * before; and the top-level declarations it REACHES — transitively, following
 * calls and the constants they act on — must still be the ones the release
 * carries. The second comparison is normalized rather than byte-for-byte
 * (`migration-closure.ts` explains the normalization and what it is measured
 * against), because a helper's prose is not its behavior and freezing every
 * TSDoc line a shipped migration can reach would make the guard unlandable
 * noise. Behavior is what the release ran, and behavior is what is pinned.
 *
 * The append-only pins next door already hash the same closure, so this is
 * deliberately a second lock on the same door — with a different key. A pin is a
 * value checked into this repository and repinning it is the documented escape
 * hatch; the release tag is not editable at all, so for a key that has SHIPPED
 * there is no escape hatch, which is the correct number.
 *
 * ## The one place the two locks cover different ground (DOR-1732)
 *
 * This rule's closure stops at `config-manager.ts`. The pins next door follow it
 * one module further, into `packages/shared/src/config-schema.ts`, which ten
 * keys reach into. Having no escape hatch is the right answer for the helpers in
 * `config-manager.ts` — they exist for migrations and nothing else, so freezing
 * them costs nobody anything. It is the wrong answer for a schema symbol the
 * running app shares: `claudeAccountId` took a ReDoS fix at v0.73.0, two
 * releases after `'0.65.0'` shipped, and a rule with no hatch would have made
 * that fix unlandable rather than making it visible. So the import hop
 * is pinned rather than frozen, and this rule stays inside the file whose
 * contents only migrations depend on. `migration-closure.ts` holds the full
 * reasoning and the measurement behind it.
 *
 * Pure on purpose: everything that touches git or the filesystem is passed in,
 * so the whole matrix — including the cases that must FAIL — is fixture-testable
 * without staging tags in a scratch repo. `__tests__/migration-safety.test.ts`
 * runs that matrix; `config-manager.test.ts` feeds it the real repository.
 */
import semver from 'semver';

import {
  extractTopLevelDeclarations,
  normalizeForHash,
  reachedDeclarations,
} from './migration-closure.js';

/**
 * Shipped migration keys this repository has deliberately REMOVED, each with the
 * one-line reason it was safe to remove.
 *
 * ## Why removal needs a list rather than a rule
 *
 * Every other loop in this rule walks the WORKING tree, so until DOR-2099 a key
 * that was present in the release and simply deleted here was invisible: no
 * loop ever reached it. The pins next door did not cover it either — they only
 * report a pin left behind without its key, and the commit that deletes a key
 * deletes its pin in the same breath. Deleting a shipped migration therefore
 * passed both guards in silence, which is the opposite of what both exist for.
 *
 * Removal is not always wrong, though, so this is an allowlist rather than a
 * ban. A shipped key owes an upgrading install one state change; when that state
 * change has become empty — the leaf it seeded no longer exists anywhere in the
 * product — the key owes nothing and keeping it costs something. That is a
 * judgement a person makes once, in review, and records here.
 *
 * ## Adding an entry
 *
 * Three things move together, and the guards check two of them:
 *
 * 1. Delete the key (and any helper only it reached) from `CONFIG_MIGRATIONS`.
 * 2. Add its line HERE, with a reason naming why nothing is owed.
 * 3. Delete its pin from `merged-migration-hashes.ts` — `checkAppendOnly`
 *    reports a pin whose key is gone, so this is not optional.
 *
 * An entry whose key is still in the table is refused, so the list cannot rot
 * into a standing excuse for a deletion nobody reviewed.
 */
export const REMOVED_SHIPPED_KEYS: Readonly<Record<string, string>> = {
  '0.71.0':
    'seeded runtimes.dorkosTools; DOR-2099 graduated that experiment and deleted the leaf, so ' +
    'there is no behaviour left for a stored value to select and the state change it owed is ' +
    'empty. Its own removal note sits where the key used to be in config-manager.ts.',
};

/** Everything the rule needs, with git and the filesystem already resolved. */
export interface MigrationSafetyInput {
  /** The working tree's `config-manager.ts` source. */
  workingSource: string;
  /** Every `v*` tag visible in the checkout, with the leading `v` stripped. */
  tags: readonly string[];
  /**
   * Read `config-manager.ts` as of a released version, or `null` when the tag or
   * the file cannot be read.
   *
   * @param version - The release version, without the leading `v`.
   */
  readAtTag: (version: string) => string | null;
  /**
   * Shipped keys whose deletion has been reviewed, defaulting to
   * {@link REMOVED_SHIPPED_KEYS}.
   *
   * Passed in so the fixtures can drive both answers — an unlisted removal must
   * fail and a listed one must pass — while production gets the repository's own
   * list by omitting it. Omission is the SAFE direction: forgetting it means
   * every removal but the recorded ones is refused.
   */
  removedShippedKeys?: Readonly<Record<string, string>>;
}

/** The rule's verdict, with every problem named rather than just a boolean. */
export interface MigrationSafetyResult {
  /** Whether every migration key in the working tree is safe to ship. */
  ok: boolean;
  /** The newest non-prerelease tag the verdict was measured against, if any. */
  latestReleased: string | null;
  /** One line per violation, each naming the key and what is wrong with it. */
  problems: string[];
}

/** Where the migration table starts. Matched exactly so a rename fails loudly. */
const TABLE_HEADER = 'export const CONFIG_MIGRATIONS = {';

/** A top-level key of the migration table: quoted, at exactly two spaces of indent. */
const KEY_LINE = /^ {2}'([^']+)':/gm;

/** A line that carries only a comment or nothing at all. */
const COMMENT_OR_BLANK = /^\s*(\/\/|\/\*|\*|$)/;

/**
 * Split the `CONFIG_MIGRATIONS` table into one source slice per key.
 *
 * A key's slice runs from its own line to the line before the next key's leading
 * comment block. Trailing comments are excluded deliberately: they document the
 * key BELOW them, so counting them as part of the key above would turn "add a
 * new migration, with a comment explaining it" into a false report that the
 * previous, shipped migration had been edited.
 *
 * @param source - The full `config-manager.ts` source text.
 * @returns Each migration key mapped to its own source text, in file order.
 * @throws When the table cannot be located, which means this parser has drifted
 *   from the file rather than that the file is safe.
 */
export function extractMigrationBodies(source: string): Record<string, string> {
  const start = source.indexOf(TABLE_HEADER);
  if (start === -1) {
    throw new Error(
      `Could not find "${TABLE_HEADER}" — the migration guard cannot read the table.`
    );
  }
  const rest = source.slice(start);
  const close = rest.search(/^\} as const;$/m);
  if (close === -1) {
    throw new Error('Could not find the end of CONFIG_MIGRATIONS — the migration guard is stale.');
  }
  const table = rest.slice(0, close);

  const starts: { key: string; at: number }[] = [];
  KEY_LINE.lastIndex = 0;
  for (let m = KEY_LINE.exec(table); m !== null; m = KEY_LINE.exec(table)) {
    starts.push({ key: m[1]!, at: m.index });
  }

  const bodies: Record<string, string> = {};
  starts.forEach(({ key, at }, i) => {
    const end = i + 1 < starts.length ? starts[i + 1]!.at : table.length;
    const lines = table.slice(at, end).split('\n');
    while (lines.length > 0 && COMMENT_OR_BLANK.test(lines[lines.length - 1]!)) lines.pop();
    bodies[key] = lines.join('\n');
  });
  return bodies;
}

/**
 * What one migration key reaches, mapped to the text that decides if it changed.
 *
 * @param slice - The key's own source text, from {@link extractMigrationBodies}.
 * @param declarations - Every top-level declaration in the same file.
 * @returns Each reached declaration's name mapped to its normalized source.
 */
function reachedSources(
  slice: string,
  declarations: Readonly<Record<string, string>>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of reachedDeclarations(slice, declarations)) {
    out[name] = normalizeForHash(declarations[name]!);
  }
  return out;
}

/**
 * Name every way the code a migration reaches differs between two revisions.
 *
 * Three kinds, kept apart because they read differently in a failure message: a
 * helper that was edited, one the key now reaches and did not, and one it has
 * stopped reaching. The last two matter even when every shared body is
 * untouched — a call added inside a helper silently extends what a shipped key
 * does, and a call removed silently takes something away.
 *
 * @param working - The working tree's reached sources, from {@link reachedSources}.
 * @param released - The same, as of the release being compared against.
 * @returns One phrase per difference, in name order; empty when they agree.
 */
function describeClosureDrift(
  working: Readonly<Record<string, string>>,
  released: Readonly<Record<string, string>>
): string[] {
  const names = [...new Set([...Object.keys(working), ...Object.keys(released)])].sort();
  const drift: string[] = [];
  for (const name of names) {
    const here = working[name];
    const there = released[name];
    if (there === undefined) drift.push(`${name} is now reached and was not`);
    else if (here === undefined) drift.push(`${name} is no longer reached`);
    else if (here !== there) drift.push(`${name} was edited`);
  }
  return drift;
}

/** The newest released version among `tags`, ignoring prereleases. */
function latestRelease(tags: readonly string[]): string | null {
  const released = tags.filter((t) => semver.valid(t) !== null && semver.prerelease(t) === null);
  if (released.length === 0) return null;
  return released.reduce((a, b) => (semver.gt(a, b) ? a : b));
}

/**
 * Decide whether every migration key in the working tree is safe to ship.
 *
 * @param input - The working source, the visible tags, and a reader for tagged source.
 * @returns The verdict, naming every problem it found.
 */
export function checkMigrationSafety(input: MigrationSafetyInput): MigrationSafetyResult {
  const latestReleased = latestRelease(input.tags);
  if (latestReleased === null) {
    return {
      ok: false,
      latestReleased: null,
      problems: [
        'no v* tags visible — fetch tags (fetch-depth: 0 in CI); the migration guard cannot run ' +
          'without them, and a checkout that cannot see releases cannot tell a new migration key ' +
          'from one that shipped last week',
      ],
    };
  }

  const releasedSource = input.readAtTag(latestReleased);
  if (releasedSource === null) {
    return {
      ok: false,
      latestReleased,
      problems: [
        `could not read config-manager.ts at refs/tags/v${latestReleased} — the tag exists but ` +
          'its content is unreachable (a partial clone?), so shipped migrations cannot be compared',
      ],
    };
  }

  const working = extractMigrationBodies(input.workingSource);
  const workingDeclarations = extractTopLevelDeclarations(input.workingSource);

  // The released side is parsed inside a try, the working side outside it, and
  // the asymmetry is the point. A throw from the working tree is the author's
  // own file and their own problem, stated plainly. A throw from a TAGGED file
  // is history: the file was shaped differently back then, nobody can go and
  // fix it, and letting the readers raise here would blame the working tree for
  // a restructure that happened releases ago.
  let released: Record<string, string>;
  let releasedDeclarations: Record<string, string>;
  try {
    released = extractMigrationBodies(releasedSource);
    releasedDeclarations = extractTopLevelDeclarations(releasedSource);
  } catch (err) {
    return {
      ok: false,
      latestReleased,
      problems: [
        `could not read config-manager.ts as of v${latestReleased}: its shape changed ` +
          'since that release, so shipped migrations cannot be compared against it. Teach ' +
          `the guard's readers the older shape, or re-cut the comparison against a tag they can ` +
          `read (${err instanceof Error ? err.message : String(err)})`,
      ],
    };
  }

  const problems: string[] = [];
  const removed = input.removedShippedKeys ?? REMOVED_SHIPPED_KEYS;

  // A key the release carries and this tree does not. Checked before the loop
  // below, which can only ever see keys that are still here.
  for (const key of Object.keys(released)) {
    if (working[key] !== undefined || (removed[key]?.trim() ?? '') !== '') continue;
    problems.push(
      `migration "${key}" shipped in v${latestReleased} but is GONE from the table here. An ` +
        'install still upgrading through it silently skips the state change it was owed, and ' +
        'nothing else notices: the pins next door only catch a pin left WITHOUT its key, and a ' +
        'deletion removes both. Put it back, or — if the state change it owed has become empty, ' +
        'because the thing it wrote no longer exists anywhere — record it in ' +
        'REMOVED_SHIPPED_KEYS with a non-empty reason, and delete its pin.'
    );
  }

  // An entry claiming a removal that did not happen. Without this the list rots
  // into a standing excuse for a LATER deletion of that key which nobody read.
  for (const key of Object.keys(removed)) {
    if (working[key] === undefined) continue;
    problems.push(
      `migration "${key}" is listed as removed but is still in CONFIG_MIGRATIONS. Remove the ` +
        'REMOVED_SHIPPED_KEYS entry, or finish the removal it describes.'
    );
  }

  for (const [key, body] of Object.entries(working)) {
    const shipped = released[key];
    if (shipped !== undefined) {
      if (shipped !== body) {
        problems.push(
          `migration "${key}" already shipped in v${latestReleased}, but its body here differs ` +
            'from the released one. Never edit a shipped migration: every user who upgraded past ' +
            'it ran the OLD body and will never run the new one. Open a new key instead.'
        );
        continue;
      }
      const drift = describeClosureDrift(
        reachedSources(body, workingDeclarations),
        reachedSources(shipped, releasedDeclarations)
      );
      if (drift.length > 0) {
        problems.push(
          `migration "${key}" already shipped in v${latestReleased} and its line in the table is ` +
            `unchanged, but the code it reaches is not: ${drift.join('; ')}. The table slice is ` +
            'only the call — the behavior lives in the helpers, and every user who upgraded past ' +
            'this key ran the RELEASED ones. Never edit a helper a shipped migration reaches: ' +
            'open a new key that corrects the state, or add a new function for the new callers ' +
            'and leave this one alone.'
        );
      }
      continue;
    }
    if (semver.valid(key) === null) {
      problems.push(`migration key "${key}" is not a valid semver version`);
      continue;
    }
    if (!semver.gt(key, latestReleased)) {
      problems.push(
        `migration "${key}" is new here but is not greater than the latest release ` +
          `v${latestReleased}. conf only runs a key in (storedVersion, projectVersion], so every ` +
          `user already on ${latestReleased} silently never runs it. Author it under a key ` +
          `strictly greater than v${latestReleased}.`
      );
    }
  }

  return { ok: problems.length === 0, latestReleased, problems };
}
