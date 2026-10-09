/**
 * What the app says about a chat that ran out of usage (spec
 * `claude-account-ui` §6.2, §6.3). Pure: the server decides the limit's state;
 * this turns it into the session header badge's words and whether the chat
 * still needs the person, which is also when the chat list counts it as
 * needing you (spec `your-activity-first`).
 *
 * @module entities/session/lib/session-limit-text
 */
import {
  limitScopeOf,
  limitStateOf,
  type LimitState,
  type SessionLimitView,
} from '@/layers/shared/lib';

/** What a limited chat shows: its words, and whether it still needs the person. */
export interface SessionLimitDisplay {
  /** `out · handing off`, `out · needs you` or `out · waiting for reset`. */
  text: string;
  /**
   * True while the account is out and the session needs action (red tint and
   * red text); false once the person chose to wait (`waiting-reset`,
   * `reset-ready`), which reads in neutral grey (decision Q13).
   */
  needsAction: boolean;
}

/** The limit states that are settled on waiting: no longer asking for anything. */
const WAITING_STATES: ReadonlySet<LimitState> = new Set(['waiting-reset', 'reset-ready']);

/**
 * How a chat's usage limit reads, or `null` when there is nothing to say
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
  if (state === 'handing-off') return { text: 'out · handing off', needsAction: true };
  // The words differ wherever the tint does, so color is never the only
  // signal: the red rows need the person, the neutral ones are waiting.
  if (WAITING_STATES.has(state)) return { text: 'out · waiting for reset', needsAction: false };
  return { text: 'out · needs you', needsAction: true };
}
