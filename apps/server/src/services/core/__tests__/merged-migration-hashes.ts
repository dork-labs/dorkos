/**
 * The recorded content of every migration key that has been merged (DOR-1222).
 *
 * One line per key in `CONFIG_MIGRATIONS`, holding the hash of everything that
 * key reaches — its slice of the table plus the source of every top-level
 * function in `config-manager.ts` it calls, transitively. How the hash is
 * computed, and what it deliberately does not cover, is in
 * `migration-append-only.ts`. The check runs against the real file in
 * `config-manager.test.ts`.
 *
 * ## The three things that happen to this file
 *
 * - **A new migration key.** Add its line in the SAME pull request that adds the
 *   key. The guard fails until you do, which is the point: a key pinned later
 *   could be quietly rewritten in between, and nothing would show.
 * - **A key's body changes.** The guard fails, and the answer is almost always
 *   to undo the edit and open a NEW key above the newest `v*` tag instead. A
 *   merged body has already run somewhere — see below.
 * - **A repin.** The escape hatch, and the only one. It is a single changed line
 *   in a file that exists for nothing else, so it cannot pass through review
 *   unseen. Bump a hash ONLY with a recorded justification, in the pull request,
 *   naming the population that could have run the old body and why it is empty.
 *
 * ## Why "not tagged yet" is not that justification
 *
 * `conf` runs a key only in `(storedVersion, projectVersion]`, and
 * `projectVersion` is `SERVER_VERSION`: `__CLI_VERSION__` in a built CLI bundle
 * and in the desktop app, `DORKOS_VERSION_OVERRIDE` when set, and `0.0.0` only
 * in a raw dev tree. Every one of those versions is bumped in the repository
 * before the tag exists, so anybody who builds and runs during that window runs
 * the body of that day and stores the version — and never runs the key again.
 * The operator's own machine was stamped `0.59.0` on 2026-08-12 while `0.59.0`
 * was "unreleased", and the two later amendments to that key skipped him in
 * silence. The dogfood machine is always somebody.
 *
 * ## What the pins below are anchored to
 *
 * They were taken on 2026-08-15 from the file as it then stood. For every key up
 * to `0.59.0` that is also provably the released content: `migration-safety.ts`
 * compares each shipped key against its own release tag, and passes. `0.60.0`
 * was open at that moment, and is the first key this rule protects that the
 * tag-based one cannot.
 */

/**
 * Merged migration keys, mapped to the hash of their reachable source.
 *
 * @see `migration-append-only.ts` for what the hash covers.
 */
export const MERGED_MIGRATION_HASHES: Readonly<Record<string, string>> = {
  '1.0.0': 'd9581dbbbe076c86',
  '0.44.0': 'f2ba94bca78b88c3',
  '0.45.0': 'b31feaeea4ceca19',
  '0.46.0': '8104c026de215139',
  '0.48.0': 'e0024e01ef32c58e',
  '0.50.0': '9eeaa46d0a851342',
  '0.52.0': 'e890f012cf25c0eb',
  '0.55.0': '73ed2c988c6fcada',
  '0.57.0': '954f0446102992bc',
  '0.59.0': '0ad7e30a01b71fb3',
  '0.60.0': 'b62005fab21738cc',
};
