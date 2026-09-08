/**
 * What may occupy a `generate` target, and what a person is told when it may not.
 *
 * A generate target is a path the engine writes a whole file to. Two shapes are
 * refused there before any question of ownership arises, because in both cases
 * the bytes DorkOS would write do not end up at the path it was asked to write:
 *
 * - a **directory**. `writeFileSync` fails with EISDIR, and a directory somebody
 *   made is their content whatever it is called. Before this rule `--check`
 *   called it drift and told the person to run `--fix`, which then died mid-loop.
 * - a **live symlink**. Both reading and writing succeed — somewhere else. That
 *   is not a hypothetical: a `.codex/hooks.json` linked to a file outside the
 *   repo had the sidecar migration rewrite the OUTSIDE file, a path no ownership
 *   rule in this package has ever been asked about.
 *
 * A DEAD link is deliberately not here: nothing is at the end of it, so there is
 * nothing to protect, and `apply.ts` removes it and writes (AP-05).
 *
 * @module apply/generate-occupants
 */
import { occupantKind } from './link-state.js';

/** What a person is told when a directory sits where a generated file goes. */
export const GENERATE_DIRECTORY_REASON =
  'blocked by a directory — DorkOS writes a file at this path. Move or delete the ' +
  'directory, then re-run';

/**
 * What a person is told when a live symlink sits where a generated file goes.
 * It names the consequence rather than just the rule: following the link would
 * write over whatever is at the other end.
 */
export const GENERATE_SYMLINK_REASON =
  'blocked by a symlink — DorkOS writes a real file at this path, and writing ' +
  'through the link would change whatever it points at instead. Replace it with a ' +
  'file, or delete it, then re-run';

/**
 * Why the engine may not write a generate target, judged on shape alone.
 *
 * One predicate, read by `applyGenerate` (which stops) and by the blocked-target
 * scanner (which reports), so `--check` and `--fix` can never disagree about a
 * path neither of them may touch.
 *
 * @param absTarget - absolute path of the generate target.
 * @returns the reason to report, or `undefined` when the shape permits a write.
 */
export function blockingGenerateOccupant(absTarget: string): string | undefined {
  switch (occupantKind(absTarget)) {
    case 'directory':
      return GENERATE_DIRECTORY_REASON;
    case 'live-link':
      return GENERATE_SYMLINK_REASON;
    default:
      return undefined; // absent, a dead link, or a real file: ownership decides
  }
}
