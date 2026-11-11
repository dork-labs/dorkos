/**
 * The recorded content of every migration key that has been merged (DOR-1222).
 *
 * One line per key in `CONFIG_MIGRATIONS`, holding the hash of everything that
 * key reaches — its slice of the table plus the source of every top-level
 * function and constant it reaches, transitively, across `config-manager.ts`,
 * the files of `config-migrations/` and `packages/shared/src/config-schema.ts`. How the hash is computed, and what it
 * deliberately does not cover, is in `migration-append-only.ts`. The check runs
 * against the real files in `config-manager.test.ts`.
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
 * `migration-safety.ts` reads `config-manager.ts` (and, since the table moved,
 * `config-migrations/`) as of the NEWEST `v*` tag
 * (`v0.59.0`) and requires every key present there to be byte-identical, and it
 * passes. Note what that does and does not say — it compares against one tag,
 * not against the release each key first shipped in, so it proves the bodies
 * match `v0.59.0`, not that they never moved before it. `0.60.0` is absent from
 * that tag, so nothing compares it at all, and it is the first key this rule
 * protects that the tag-based one cannot.
 *
 * ## The one bulk repin, and why it is not the thing this file warns about
 *
 * On 2026-09-05 (DOR-1732) ten pins moved at once: `0.55.0`, `0.57.0`, `0.59.0`,
 * `0.64.0`, `0.65.0` and `0.69.0` through `0.73.0`. **No migration body changed.**
 * The closure was widened to follow those keys one module further, into
 * `packages/shared/src/config-schema.ts`, so each of the ten now hashes strictly
 * more source than it did — the same code it always ran, plus the code it always
 * reached and nothing was watching.
 *
 * That is the one justification a bulk repin can have, and it is the opposite of
 * the failure this file exists to catch: nobody's config changed, and the ten
 * keys are exactly the ten the old walk could not see. What they gained is
 * checkable rather than asserted — `0.57.0` picks up `toSidebarItemRef`,
 * `0.65.0` picks up `claudeAccountId` and `slugifyAccountId`, and the five from
 * `0.69.0` up pick up the one line of `USER_CONFIG_DEFAULTS` they seed from.
 * Editing `toSidebarItemRef` used to leave all 382 guard tests green; that is
 * what these ten lines buy.
 *
 * A repin that moves several pins for any OTHER reason is still what the drift
 * message says it is.
 */

/**
 * Merged migration keys, mapped to the hash of their reachable source.
 *
 * @see `migration-append-only.ts` for what the hash covers.
 */
export const MERGED_MIGRATION_HASHES: Readonly<Record<string, string>> = {
  '1.0.0': '9a591bc7ff1a3550',
  '0.90.0': '2a30712ca430861e',
  '0.91.0': '30da56ef99455780',
  '0.92.0': 'a20fb19630e429c0',
  '0.93.0': 'bee1d2f63686b908',
  '0.94.0': '5d49ce223e1dd85b',
  '0.96.0': 'b1a49add76cd1e77',
  '0.98.0': 'ad2d43f24dbb5539',
  '0.99.0': '64c93d0cd4bbda18',
  '0.100.0': 'e4e8b2c7da813bba',
  '0.101.0': 'c58f3d0d465fea96',
  '0.102.0': '69018336eba5fdf8',
  '0.103.0': '2fe40c4203d96494',
  '0.105.0': '5edf2dbb89497d39',
  '0.106.0': 'ea7ac4ac17d2f6f9',
  '0.107.0': '0278269fc0feab22',
  '0.108.0': 'ea35e19961d42fad',
  '0.109.0': 'dc175e61c4be5d68',
  '0.112.0': '9b25a4fc6a4d7e97',
  '0.113.0': 'f2e1a3d90e9b13c2',
  '0.114.0': 'a672ee4363778105',
  '0.115.0': '5d18782f3c42da3b',
  '0.116.0': 'afa8f0d26ee78823',
  '0.120.0': '433081f657bb7311',
  '0.123.0': '297ee7664012f265',
  '0.124.1': '6b4605cc2f8ec6d9',
  '0.125.0': 'df151a21ff6af5c1',
  '0.126.1': '7dbf9f4cd8eebcc2',
  '0.126.5': '14ac74ddaed44726',
  '0.133.0': 'ce482f4970474746',
};
