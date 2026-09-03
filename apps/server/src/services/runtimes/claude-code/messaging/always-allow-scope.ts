/**
 * What an "Always Allow" card is actually about to grant.
 *
 * DorkOS forwards the SDK's `PermissionUpdate[]` suggestions verbatim when a
 * person presses "Always Allow" — a settled decision, not revisited here
 * (`SessionStore.adoptSuggestedMode`). But the CLI persists a suggestion whose
 * `destination` names a settings FILE, so one click on one card can move the
 * operator's project or global defaults, and the card used to say nothing about
 * that. This module reads the destinations back out and reduces them to the one
 * word the card puts beside the button (DOR-1462).
 *
 * It is a LABEL, never a filter: nothing here changes which suggestions are
 * forwarded. Stripping the wide ones is a separate, deliberately deferred
 * decision that waits on a per-session rule store.
 *
 * @module runtimes/claude-code/messaging/always-allow-scope
 */
import type { PermissionUpdate, PermissionUpdateDestination } from '@anthropic-ai/claude-agent-sdk';
import type { AlwaysAllowScope } from '@dorkos/shared/types';
import { logger } from '../../../../lib/logger.js';

/**
 * Where each SDK destination writes, in the terms the card speaks.
 *
 * `session` and `cliArg` both die with the process the grant was given to, so
 * they are the same promise to a person. The three settings files differ in who
 * they reach: `localSettings` and `projectSettings` are both this project (one
 * is the machine-local override of the other), while `userSettings` is
 * `~/.claude/settings.json` — every Claude session on the machine, DorkOS or
 * not.
 */
const SCOPE_BY_DESTINATION: Record<PermissionUpdateDestination, AlwaysAllowScope> = {
  session: 'session',
  cliArg: 'session',
  localSettings: 'project',
  projectSettings: 'project',
  userSettings: 'user',
};

/** Widest last — a batch is described by the furthest-reaching thing in it. */
const SCOPE_ORDER: readonly AlwaysAllowScope[] = ['session', 'project', 'user'];

/**
 * The scope an accepted "Always Allow" grants, for a card to name.
 *
 * The WIDEST destination in the batch wins, because the button is one click and
 * a person is owed the largest thing it does — a batch that sets a session mode
 * and also writes the user settings file reaches every Claude session, and
 * saying "this session" of it would be the exact dishonesty this exists to end.
 *
 * A destination this SDK version did not have is read as `user` rather than
 * ignored: over-claiming costs a person one moment of caution, and
 * under-claiming is how a global default moves unannounced.
 *
 * @param suggestions - The SDK permission updates the card would forward.
 * @returns The scope to name, or `undefined` when there is no "Always Allow" to
 *   describe (no suggestions means no button).
 */
export function alwaysAllowScopeOf(
  suggestions: readonly PermissionUpdate[] | undefined
): AlwaysAllowScope | undefined {
  if (suggestions === undefined || suggestions.length === 0) return undefined;
  let widest: AlwaysAllowScope = 'session';
  for (const update of suggestions) {
    const scope = SCOPE_BY_DESTINATION[update.destination] as AlwaysAllowScope | undefined;
    if (scope === undefined) {
      logger.warn('[alwaysAllowScope] unknown permission destination, reading it as global', {
        destination: update.destination,
        type: update.type,
      });
      return 'user';
    }
    if (SCOPE_ORDER.indexOf(scope) > SCOPE_ORDER.indexOf(widest)) widest = scope;
  }
  return widest;
}

/**
 * The destinations a card's suggestions would write to, for the log line that
 * raises it.
 *
 * Deliberately the RAW SDK names rather than the reduced scope: the point of
 * the log is to answer, after a week of real use, which destinations actually
 * turn up on real cards — the question that decides whether wide scopes should
 * ever be stripped. A reduced label would have already thrown that away.
 *
 * @param suggestions - The SDK permission updates the card would forward.
 * @returns One entry per suggestion, in the order they would be applied.
 */
export function suggestionDestinations(
  suggestions: readonly PermissionUpdate[] | undefined
): PermissionUpdateDestination[] {
  return (suggestions ?? []).map((update) => update.destination);
}
