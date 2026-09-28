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

/**
 * The text color of a row's red "out" words. `text-destructive`, not the
 * status error text: the row's tint is covered when it is hovered or selected,
 * and on those grey surfaces the dark theme's `--status-error-fg` measures
 * 4.08:1 (selected), 4.28:1 and 4.33:1 (hover), under the 4.5:1 text needs.
 * `--destructive` clears 4.5:1 on every surface a row sits on in both themes
 * (4.54:1 at its lowest, selected in dark).
 */
export const LIMIT_ACTION_TEXT_CLASS = 'text-destructive';

/** What a limited row shows: its trailing text, and whether it wears the red tint. */
export interface SessionLimitDisplay {
  /** `out · handing off`, `out · needs you` or `out · waiting for reset`. */
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
  if (state === 'handing-off') return { text: 'out · handing off', needsAction: true };
  // The words differ wherever the tint does, so color is never the only
  // signal: the red rows need the person, the neutral ones are waiting.
  if (WAITING_STATES.has(state)) return { text: 'out · waiting for reset', needsAction: false };
  return { text: 'out · needs you', needsAction: true };
}

/**
 * The words a sidebar row shows in place of its time for a session that ran
 * out: `out · handing off` while the work is about to move on its own, `out ·
 * waiting for reset` once the person chose to wait (`waiting-reset`,
 * `reset-ready`), `out · needs you` in every other account-wide limited state
 * (`limited`, `wait-only`, `all-accounts-out`), and `null` when the row shows
 * nothing (see {@link sessionLimitDisplay}).
 *
 * @param limit - The session's usage limit, or nothing when it has none.
 */
export function sessionLimitText(limit: SessionLimitView | null | undefined): string | null {
  return sessionLimitDisplay(limit)?.text ?? null;
}
