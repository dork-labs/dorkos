/**
 * What "Always Allow" promises, in words.
 *
 * The button forwards the runtime's own permission suggestions untouched, and
 * some of those are written to settings FILES rather than to this conversation
 * — so the same button can mean three very different things. These are the
 * three sentences that difference is worth, chosen to describe the REACH a
 * person will feel rather than the file the runtime writes: nobody thinks in
 * `~/.claude/settings.json`, they think in "every Claude session I ever open"
 * (DOR-1462).
 *
 * @module features/ask/lib/always-allow-scope-label
 */
import type { AlwaysAllowScope } from '@dorkos/shared/types';

/** The scope sentence for each grant reach, as shown beside "Always Allow". */
const SCOPE_LABELS: Record<AlwaysAllowScope, string> = {
  session: 'this session',
  project: 'this project',
  user: 'all your Claude sessions',
};

/**
 * The words for a grant's reach, for the card to put beside "Always Allow".
 *
 * @param scope - The reach the server named, or `undefined` when it named none.
 * @returns The sentence, or `undefined` when there is nothing honest to say —
 *   the button then carries no scope rather than a guessed one.
 */
export function alwaysAllowScopeLabel(scope: AlwaysAllowScope | undefined): string | undefined {
  return scope === undefined ? undefined : SCOPE_LABELS[scope];
}
