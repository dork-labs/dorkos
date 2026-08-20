/**
 * The recorded content of every migration key that has been merged (DOR-1222).
 *
 * One line per key in `CONFIG_MIGRATIONS`, holding the hash of everything that
 * key reaches — its slice of the table plus the source of every top-level
 * function and constant in `config-manager.ts` it reaches, transitively. How the
 * hash is computed, and what it deliberately does not cover, is in
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
 * They were taken on 2026-08-15 from the file as it then stood. For every key at
 * or below `0.59.0` that is also the content the newest release carries:
 * `migration-safety.ts` reads `config-manager.ts` as of the NEWEST `v*` tag
 * (`v0.59.0`) and requires every key present there to be byte-identical, and it
 * passes. Note what that does and does not say — it compares against one tag,
 * not against the release each key first shipped in, so it proves the bodies
 * match `v0.59.0`, not that they never moved before it. `0.60.0` is absent from
 * that tag, so nothing compares it at all, and it is the first key this rule
 * protects that the tag-based one cannot.
 */

/**
 * Merged migration keys, mapped to the hash of their reachable source.
 *
 * @see `migration-append-only.ts` for what the hash covers.
 */
export const MERGED_MIGRATION_HASHES: Readonly<Record<string, string>> = {
  '1.0.0': '9a591bc7ff1a3550',
  '0.44.0': 'd2106597bd208151',
  '0.45.0': '292d5e311cd9c205',
  '0.46.0': '773a11b00bd2ee3e',
  '0.48.0': '704ab3fe78619f5a',
  '0.50.0': '6a3bcd3c7a5b56c7',
  '0.52.0': '3e3196cd69d496ca',
  '0.55.0': '5347a36ea943854b',
  '0.57.0': 'e415a30a8bc51166',
  '0.59.0': '126395e65f206262',
  '0.60.0': '45129eaa96cce263',
  '0.62.0': '622b3a68f4579a0c',
  '0.63.0': '3641c16254095166',
  '0.64.0': '2ba829b016b59c8c',
};
