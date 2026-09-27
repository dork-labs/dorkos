/**
 * Turns a hard usage limit Claude Code reported into the session's `limit`
 * (spec `claude-account-fleet` D4).
 *
 * Only what the official binary already hands the SDK is read: the
 * `rate_limit_event` it forwards and the `rate_limit` error on its own
 * synthetic assistant message. Nothing here asks Anthropic anything, and
 * nothing reads a credential (spec §8).
 *
 * Two event mappers call {@link reportSessionLimit}, once each at most per
 * turn between them: the `rate_limit` assistant error (the turn stopped), and a
 * `rejected` event that extra usage is not covering (the turn is about to
 * stop). The first one wins, so a turn yields one limit status.
 *
 * Like the usage feed beside it, this never throws: a failed table write costs
 * the limit's survival across a restart, never the turn.
 *
 * @module services/runtimes/claude-code/accounts/session-limit
 */
import type { StreamEvent } from '@dorkos/shared/types';
import type { SessionLimit } from '@dorkos/shared/schemas';
import { getAccountUsageStore } from '../../../core/usage/current-usage-store.js';
import { limitScopeOf, withSessionLimitStore } from '../../../session/fleet/session-limit-store.js';
import type { AgentSession } from '../agent-types.js';
import { resolveActiveClaudeRoot } from '../claude-config-dir.js';
import { recordSessionUsage } from './account-usage-feed.js';

/** The window key a limit carries when nothing said which window it was. */
export const UNKNOWN_LIMIT_WINDOW = 'unknown';

/** The fields of a session this module reads and writes. */
export type LimitSession = Pick<
  AgentSession,
  | 'sdkSessionId'
  | 'launchedAccountRoot'
  | 'accountRoot'
  | 'limitReportedThisTurn'
  | 'rejectedLimitThisTurn'
  | 'cwd'
>;

/**
 * Whether a `rate_limit_event` means the turn stopped: `rejected`, and extra
 * usage is not carrying on in its place. The SDK also sends `rejected` for a
 * window extra usage covers, and then the turn continues.
 *
 * @param info - The event's `rate_limit_info`.
 */
export function rejectionStopsTurn(info: Record<string, unknown>): boolean {
  return info.status === 'rejected' && info.isUsingOverage !== true && info.overageInUse !== true;
}

/**
 * Report this turn's usage limit, once: build the session's `limit`, keep it
 * in the `session_limits` table, and return the `session_status` that carries
 * it. `null` when this turn already reported one.
 *
 * The window and reset come from, in order: the `rejected` event this turn saw,
 * then the account's current rejected window in the usage store, then
 * `unknown` and `null`. When only the error arrived and the window is known,
 * the ledger records that window as rejected too.
 *
 * @param session - The session whose turn stopped.
 * @param sessionId - The DorkOS id the turn's events are stamped with.
 * @param now - The moment the limit was hit.
 */
export function reportSessionLimit(
  session: LimitSession,
  sessionId: string,
  now: Date = new Date()
): StreamEvent | null {
  if (session.limitReportedThisTurn) return null;
  session.limitReportedThisTurn = true;

  const root = session.launchedAccountRoot ?? session.accountRoot ?? resolveActiveClaudeRoot();
  const usage = safeUsageAt(root);
  const fromEvent = session.rejectedLimitThisTurn;
  const window = fromEvent?.window ?? usage?.limit?.window ?? UNKNOWN_LIMIT_WINDOW;
  const resetsAt = fromEvent ? fromEvent.resetsAt : (usage?.limit?.resetsAt ?? null);
  const since = now.toISOString();
  const scope = limitScopeOf(window);
  // `ask` and `limited` until the out-of-usage flow (spec D9) works out the
  // plan and the state, which it does as soon as the session holds this limit.
  const limit: SessionLimit = {
    accountId: usage?.accountId ?? null,
    window,
    resetsAt,
    since,
    plan: { mode: 'ask' },
    scope,
    state: 'limited',
  };

  // Only the error came: the ledger never heard this window say `rejected`
  // this turn, so say it for the error.
  if (!fromEvent && window !== UNKNOWN_LIMIT_WINDOW) {
    recordSessionUsage(session, [
      {
        key: window,
        usedPct: null,
        status: 'rejected',
        resetsAt,
        observedAt: since,
        source: 'sdk_event',
      },
    ]);
  }

  // Keyed by the canonical id (the SDK's), which is what the projector and
  // every rekey use; the id a turn was asked with is only a hint after the
  // session's first rename.
  const key = session.sdkSessionId || sessionId;
  withSessionLimitStore('upsert', (store) =>
    store.upsert({ sessionId: key, limit, scope, accountPath: root, cwd: session.cwd ?? null })
  );

  return { type: 'session_status', data: { sessionId, limit } };
}

/** The usage of the account at `root`, or `null`; never throws. */
function safeUsageAt(root: string) {
  try {
    return getAccountUsageStore()?.usageAtPath('claude-code', root) ?? null;
  } catch {
    return null;
  }
}
