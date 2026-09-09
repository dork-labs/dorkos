/**
 * Why each swept path goes — one plain sentence per cause, written down once
 * (DOR-1906).
 *
 * A sweep removes files, and a list of paths with no reasons beside them is a
 * list a person has to take on trust. `.claude/skills/beta` and
 * `.codex/hooks.json` disappear for entirely different reasons — one because the
 * skill it pointed at is gone, the other because nothing projects hooks there
 * any more — and "orphaned projections" as a single heading over both says
 * neither. Every surface that shows the list shows the reason with it: the
 * terminal's `--check` and `--fix` blocks, the app's removal disclosure and its
 * "what changed" summary, and the server's own log when it sweeps unattended.
 *
 * **The sentences live here and nowhere else.** They are the same words in the
 * terminal and on screen, for the same reason every projection `reason` is: two
 * surfaces describing one fact in two voices is how a person stops trusting
 * either.
 *
 * ## The cause is which finder found the path
 *
 * `applyPlan` runs six sweeps and `checkPlan` runs their six `find*` twins, and
 * each one knows exactly one thing about every path it hands back — which
 * predicate matched. That is the whole of the cause, so the reason is attached
 * where the sweep is called rather than carried through six return types.
 *
 * Two refinements are read off the PATH, because the finder that produced them
 * really did match two different facts:
 *
 * - a stranded atomic-write temp under a wrapper directory is debris from an
 *   interrupted write, not an uninstalled package (`atomic-write.ts` explains
 *   why age is what tells a stranded one from a live one);
 * - nothing else. Everything a finder yields under one cause shares one reason.
 *
 * @module apply/sweep-reasons
 */
import { basename } from 'node:path';
import type { SweptPath } from '../plan/types.js';
import { isAtomicTempName } from './atomic-write.js';

/**
 * Every reason a sweep can give, keyed by the finder that produces it.
 *
 * Plain sentences, in the second person the rest of the report uses. Two of them
 * are deliberately not about a package being gone: the generated hooks file is
 * one a hook policy (or the last hook-bearing package) stopped asking for, and
 * `.claude/settings.local.json` is not removed at all — it keeps every key the
 * person owns and loses only the entries DorkOS merged in, which is the one line
 * in the list that has always had to say so.
 *
 * The last two are the global sweep's (`apply/global-apply.ts`), and they are
 * two rather than one because a global link goes for two genuinely different
 * reasons: the package was uninstalled, or the package is still installed and no
 * longer has a skill of that name. "No longer installed here" would be wrong
 * about both — there is no `here` at global scope — which is why they do not
 * reuse `installed-skill`.
 */
export const SWEEP_REASONS = {
  'installed-skill': 'The package this skill came from is no longer installed here.',
  'authored-link': 'The skill this link pointed to is gone.',
  'generated-hooks': 'DorkOS wrote this, and no hooks project here any more.',
  'command-wrapper': 'The package this command came from is no longer installed here.',
  'settings-hooks': 'Only the hook entries DorkOS added go; your own settings stay.',
  'stale-temp': 'A half-written file an interrupted sync left behind.',
  'global-package-gone':
    'The package this skill came from is no longer installed for all your projects.',
  'global-skill-gone': 'The package this skill came from no longer has a skill of this name.',
  'global-folder-unshared':
    'You stopped sharing your all-projects packages with the agent tools that read this folder.',
} as const satisfies Record<string, string>;

/** Which sweep found a path — the whole of what decides its reason. */
export type SweepCause = keyof typeof SWEEP_REASONS;

/**
 * Pair every path with the one sentence saying why it goes.
 *
 * The order and the membership of `paths` are preserved exactly, so the reasoned
 * list and the bare one a caller already has are the same list twice — which is
 * what lets `swept` stay `string[]` for the callers that only ever wanted paths.
 *
 * @param paths - the repo-relative paths one sweep (or its `find*` twin) named.
 * @param cause - which sweep named them.
 * @returns each path with its reason, in the order given.
 */
export function explainSweep(paths: readonly string[], cause: SweepCause): SweptPath[] {
  return paths.map((path) => ({ path, reason: sweepReason(path, cause) }));
}

/**
 * The sentence for one path, with the two path-readable refinements applied.
 *
 * Only the command sweeps can yield a stranded temp — they are the two
 * directories the engine enumerates by wildcard — so the check is scoped to
 * them rather than run over every path, where a person's own file called
 * `.tmp-…` could otherwise borrow a reason that is not about it.
 */
function sweepReason(path: string, cause: SweepCause): string {
  if (cause === 'command-wrapper' && isAtomicTempName(basename(path))) {
    return SWEEP_REASONS['stale-temp'];
  }
  return SWEEP_REASONS[cause];
}
