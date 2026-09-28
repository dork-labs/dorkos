/**
 * What a sidebar row says about a session that ran out of usage (spec
 * `claude-account-ui` §6.2). Pure: the server decides the limit's state; this
 * only turns it into the row's words and whether it still needs the person.
 *
 * @module entities/session/lib/session-limit-text
 */
import {
  limitScopeOf,
  limitStateOf,
  type LimitState,
  type SessionLimitView,
} from '@/layers/shared/lib';

/** What a limited row shows: its trailing text, and whether it wears the red tint. */
export interface SessionLimitDisplay {
  /** `out · handing off` or `out · waiting for reset`. */
  text: string;
  /**
   * True while the account is out and the session needs action (red tint and
   * red text); false once the person chose to wait (`waiting-reset`,
   * `reset-ready`), which reads in the row's neutral grey (decision Q13).
   */
  needsAction: boolean;
}

/** The limit states that are settled on waiting: no longer asking for anything. */
const WAITING_STATES: ReadonlySet<LimitState> = new Set(['waiting-reset', 'reset-ready']);

/**
 * How a sidebar row shows a session's usage limit, or `null` when it shows
 * nothing: no limit, a `moved` session (its work lives in the new session,
 * Q14), or a limit on one model only (the account still runs another model,
 * and the status-bar chip carries the detail).
 *
 * @param limit - The session's usage limit, or nothing when it has none.
 */
export function sessionLimitDisplay(
  limit: SessionLimitView | null | undefined
): SessionLimitDisplay | null {
  if (!limit || limitScopeOf(limit) === 'model') return null;
  const state = limitStateOf(limit);
  if (state === 'moved') return null;
  return {
    text: state === 'handing-off' ? 'out · handing off' : 'out · waiting for reset',
    needsAction: !WAITING_STATES.has(state),
  };
}

/**
 * The words a sidebar row shows in place of its time for a session that ran
 * out: `out · handing off` while the work is about to move on its own, `out ·
 * waiting for reset` in every other account-wide limited state, and `null`
 * when the row shows nothing (see {@link sessionLimitDisplay}).
 *
 * @param limit - The session's usage limit, or nothing when it has none.
 */
export function sessionLimitText(limit: SessionLimitView | null | undefined): string | null {
  return sessionLimitDisplay(limit)?.text ?? null;
}
