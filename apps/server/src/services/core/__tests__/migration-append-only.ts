/**
 * The DOR-1222 append-only rule: a merged migration body never changes again.
 *
 * `migration-safety.ts` next door measures every migration key against the
 * newest `v*` TAG. That leaves one window open, and the window is where the bug
 * lives: between the commit that merges a migration and the tag that releases
 * it, the tag-based rule says "this key is new work" and lets its body be
 * rewritten freely.
 *
 * It ran anyway. `conf` executes a key only in `(storedVersion,
 * projectVersion]`, and `projectVersion` is whatever `SERVER_VERSION` resolves
 * to on the machine that booted — `__CLI_VERSION__` in a built CLI bundle, the
 * same version in the desktop app, `DORKOS_VERSION_OVERRIDE` when set. Only a
 * raw dev tree is exempt, because `apps/server/package.json` reads `0.0.0`.
 * Every one of those versions is bumped in the repository BEFORE the tag exists,
 * so anyone who builds and runs during that window is stamped with the new
 * version and has run the body of that day. The operator's own machine is the
 * worked example: `~/.dork/config.json` was stamped `0.59.0` on 2026-08-12 while
 * `0.59.0` was still "unreleased", and both later amendments to that key —
 * `welcomeBack.offersEnabled` OFF to ON, then the composer prefs seed — skipped
 * him in silence. The dogfood machine is always somebody.
 *
 * So the licence "nobody has run it yet" is not available from the tag, and in
 * practice is not available at all. This rule replaces it with one that can be
 * checked: **once a migration is merged, its body is frozen.** A change of mind
 * opens a NEW key above the newest tag, written so it can tell the two states
 * apart, rather than editing a body some installs already ran.
 *
 * ## What is hashed, and why that shape
 *
 * The hash covers the key's whole reachable CLOSURE, not its line in the table.
 * Half the table is a bare reference (`'0.50.0': backfillSidebarDefaults`), so a
 * rule that hashed only the table slice would pin nothing but a function NAME —
 * which is exactly the hole `contributing/configuration.md` recorded: DOR-1121
 * edited `backfillWelcomeBackDefaults`, a helper the table merely calls, and no
 * guard could see it. So the closure is the table slice plus the source of every
 * top-level declaration in `config-manager.ts` it reaches, transitively, sorted
 * by name so moving a declaration within the file is not a change.
 *
 * The walk, the normalization and the boundary they stop at all live in
 * `migration-closure.ts`, because the tag-based rule needs the same three for
 * the same reason (DOR-1135). Read that module's header before trusting a pin;
 * this one only decides what a moved hash means.
 *
 * A pin still moves for a code change and stays put for a prose one, so a stale
 * COMMENT inside a shipped body is correctable in place here — the byte-identity
 * rule next door refuses that. The two rules disagree there on purpose, and the
 * stricter one wins for keys that have shipped.
 *
 * Pure on purpose, like `migration-safety.ts`: text in, verdict out, so the
 * cases that must FAIL are fixture-testable. `migration-append-only.test.ts`
 * runs that matrix; `config-manager.test.ts` feeds it the real file and the
 * pinned hashes in `merged-migration-hashes.ts`.
 */
import { createHash } from 'crypto';

import { extractMigrationBodies } from './migration-safety.js';
import {
  extractTopLevelDeclarations,
  normalizeForHash,
  reachedDeclarations,
} from './migration-closure.js';

/** How many hex characters of the SHA-256 a pin carries. */
const HASH_LENGTH = 16;

/**
 * The full reachable source of one migration key: its table slice plus every
 * top-level function it calls, transitively, in name order.
 *
 * @param key - The migration key, as written in `CONFIG_MIGRATIONS`.
 * @param source - The full `config-manager.ts` source text.
 * @returns The concatenated closure text.
 * @throws When the key is not in the table.
 */
export function migrationClosure(key: string, source: string): string {
  const bodies = extractMigrationBodies(source);
  const slice = bodies[key];
  if (slice === undefined) {
    throw new Error(`migration key "${key}" is not in CONFIG_MIGRATIONS`);
  }
  const declarations = extractTopLevelDeclarations(source);

  // Name order, so moving a declaration within the file is not a change.
  return [
    slice,
    ...reachedDeclarations(slice, declarations).map((name) => declarations[name]!),
  ].join('\n');
}

/**
 * The pinned hash of one migration key's closure.
 *
 * @param key - The migration key, as written in `CONFIG_MIGRATIONS`.
 * @param source - The full `config-manager.ts` source text.
 * @returns A truncated SHA-256 of the normalized closure. Truncated because a
 *   pin is read by people in a diff and this is an accident guard, not a
 *   security boundary.
 */
export function migrationHash(key: string, source: string): string {
  return createHash('sha256')
    .update(normalizeForHash(migrationClosure(key, source)))
    .digest('hex')
    .slice(0, HASH_LENGTH);
}

/**
 * Every migration key in the table, mapped to its closure hash.
 *
 * @param source - The full `config-manager.ts` source text.
 * @returns Each migration key mapped to the hash of its reachable closure.
 */
function migrationHashes(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(extractMigrationBodies(source))) {
    out[key] = migrationHash(key, source);
  }
  return out;
}

/** The verdict, with every drift named rather than just a boolean. */
export interface AppendOnlyResult {
  /** Whether every merged migration still hashes to what it was pinned at. */
  ok: boolean;
  /** One entry per problem, each naming the key and what to do about it. */
  problems: string[];
  /** What the working tree hashes to, so a repin can be copied from here. */
  hashes: Record<string, string>;
}

/** Why a body may never be edited once merged, said once and reused. */
const RULE =
  'A migration body is APPEND-ONLY from the moment it merges, not from the moment it is ' +
  'tagged. conf runs a key only in (storedVersion, projectVersion], and every build that ' +
  'is not a raw dev tree — a built CLI, the desktop app, the dogfood machine — resolves ' +
  'SERVER_VERSION to the version already bumped in the repo, runs the body of that day, and ' +
  'stores that version. It never runs the key again. "It is not tagged yet" is not evidence ' +
  'that nobody ran it (DOR-1222).';

/**
 * Decide whether every migration key still matches the hash it was pinned at.
 *
 * @param source - The working tree's `config-manager.ts` source.
 * @param pinned - The recorded hash per merged migration key.
 * @returns The verdict, naming every drift and how to answer it.
 */
export function checkAppendOnly(
  source: string,
  pinned: Readonly<Record<string, string>>
): AppendOnlyResult {
  const hashes = migrationHashes(source);
  const problems: string[] = [];
  const drifted: string[] = [];

  for (const [key, hash] of Object.entries(hashes)) {
    const pin = pinned[key];
    if (pin === undefined) {
      problems.push(
        `migration "${key}" is not pinned. A new key is pinned in the SAME pull request that ` +
          `introduces it, so that every later edit to it is visible as a changed pin rather ` +
          `than an invisible rewrite. Add '${key}': '${hash}' to merged-migration-hashes.ts.`
      );
      continue;
    }
    if (pin !== hash) {
      drifted.push(key);
      problems.push(
        `migration "${key}" changed after it was pinned (pinned ${pin}, now ${hash}). ${RULE} ` +
          `Change of mind: open a NEW key strictly above the newest v* tag, written to tell a ` +
          `value this body seeded from one a person chose. Repinning is the escape hatch and it ` +
          `needs a recorded justification that NO install can have run the old body. For any key ` +
          `at or below the version this repository currently carries, that has never been true — ` +
          `and a key above it stops being safe the moment the release bump lands, which is not a ` +
          `moment anybody is notified of.`
      );
    }
  }

  if (drifted.length > 1) {
    problems.push(
      `${drifted.length} keys moved together (${drifted.join(', ')}), which usually means a ` +
        'HELPER they all reach was edited rather than any one body. There is one version of ' +
        'that which is legitimate and recurring: extending a fill-if-absent helper and adding a ' +
        'NEW key that re-runs it, so the population who already passed the older keys is covered ' +
        'by the new one (the backfillRoomsDefaults pattern). If that is what this is, repin the ' +
        'older keys and say in the pull request which new key covers them. If there is no new ' +
        'key, this is an edit to what those migrations did, and it reaches nobody who has run ' +
        'them.'
    );
  }

  for (const key of Object.keys(pinned)) {
    if (hashes[key] === undefined) {
      problems.push(
        `migration "${key}" is pinned but is no longer in CONFIG_MIGRATIONS. Migrations are ` +
          'append-only: a key that shipped must stay, or an install still upgrading through it ' +
          'silently skips the state change it was owed.'
      );
    }
  }

  return { ok: problems.length === 0, problems, hashes };
}
