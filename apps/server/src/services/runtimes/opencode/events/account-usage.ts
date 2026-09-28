/**
 * OpenCode's spend and provider limits into the account usage store, and a
 * provider limit into the session's `limit` (spec `claude-account-fleet` §6 R
 * and D4).
 *
 * OpenCode has one account per machine, `default` (contract rev 6d), so every
 * reading is recorded as (`opencode`, `default`):
 *
 * - **Spend.** Each assistant message's `cost` (USD), which the sidecar already
 *   reports on `message.updated`, adds to `spend.costUsd` for the current UTC
 *   calendar month (source `sidecar`). The running total starts from what the
 *   store holds, and the store read the ledger file at boot, so a restart does
 *   not reset the month. A new month starts again from this turn's cost.
 *   `limitUsd` has no writer yet (a provider budget lookup is a follow-up), so
 *   it stays `null` unless another writer set one this month.
 * - **Limits.** A turn that fails with a provider rate limit (HTTP 429) or a
 *   credit or payment error (HTTP 402, out of credits) records a window-less
 *   `rate_limit:<provider>` or `credits:<provider>` entry (source `error`,
 *   status `rejected`, `usedPct` null, `resetsAt` when the provider said), and
 *   sets the session's `limit` (window `unknown`) the same way the Claude Code
 *   path does, so `account.limited` and the out-of-usage flow apply.
 *
 * Only what the sidecar already hands over is read. Never throws: a failed
 * store or table write costs the reading, never the turn.
 *
 * @module services/runtimes/opencode/events/account-usage
 */
import type { AssistantMessage, Event } from '@opencode-ai/sdk';
import {
  IMPLICIT_ACCOUNT_ID,
  ledgerSlug,
  type LedgerObservation,
} from '@dorkos/shared/account-usage';
import type { SessionLimit } from '@dorkos/shared/schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import { logger } from '../../../../lib/logger.js';
import { getAccountUsageStore } from '../../../core/usage/current-usage-store.js';
import { withSessionLimitStore } from '../../../session/fleet/session-limit-store.js';

/** The window key a limit carries when the error named none. */
const UNKNOWN_LIMIT_WINDOW = 'unknown';

/**
 * A completed message counts toward this turn's spend only if it completed
 * after the turn began, less this much slack for the two clocks on one
 * machine. An older message the sidecar re-announces was counted by its own turn.
 */
const COMPLETED_BEFORE_TURN_SLACK_MS = 1_000;

/** Provider words for "no money left" (checked before a 429: OpenAI's quota error is a 429). */
const CREDIT_PATTERNS: readonly RegExp[] = [
  /\binsufficient[_\s](?:credits?|balance|funds|quota)\b/i,
  /\bpayment required\b/i,
  /\bout of credits\b/i,
  /\brequires more credits\b/i,
  /\bexceeded your current quota\b/i,
];

/** Provider words for "slow down". */
const RATE_LIMIT_PATTERNS: readonly RegExp[] = [
  /\brate[_\s-]?limit(?:ed)?\b/i,
  /\btoo many requests\b/i,
];

/** The turn state this module reads and writes. */
export interface OpenCodeUsageTurnState {
  /** The DorkOS session id the turn's events are stamped with. */
  readonly sessionId: string;
  /** The clock readings are stamped with (epoch ms). */
  readonly clock: () => number;
  /** When the turn began (epoch ms). */
  readonly turnStartedAtMs: number;
  /** The cost already added to spend, per assistant message id. */
  readonly spentByMessageId: Map<string, number>;
  /** The provider of the turn's latest assistant message, for naming a limit. */
  providerId?: string;
  /** Set once this turn reported a limit. */
  limitReportedThisTurn?: boolean;
}

/** One OpenCode session error, as `session.error` carries it. */
type OpenCodeSessionError = NonNullable<
  Extract<Event, { type: 'session.error' }>['properties']['error']
>;

/** A provider limit a failure implies. */
export interface OpenCodeLimitSignal {
  /** `rate_limit` for a 429, `credits` for payment required or out of credits. */
  kind: 'rate_limit' | 'credits';
  /** When the provider said it clears, ISO-8601, or `null`. */
  resetsAt: string | null;
}

/** The first moment of `now`'s UTC calendar month, ISO-8601. */
export function utcMonthStart(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/**
 * Add one assistant message's cost to OpenCode's monthly spend. Idempotent per
 * message: a message the sidecar announces again adds only what its cost grew
 * by, and one that completed before this turn began adds nothing.
 *
 * @param state - The turn (mutated: what each message already added).
 * @param assistant - The completed assistant message.
 * @param now - When it was seen.
 */
export function recordOpenCodeSpend(
  state: OpenCodeUsageTurnState,
  assistant: AssistantMessage,
  now: Date = new Date()
): void {
  const completed = assistant.time.completed;
  if (completed === undefined) return;
  if (completed < state.turnStartedAtMs - COMPLETED_BEFORE_TURN_SLACK_MS) return;
  if (typeof assistant.cost !== 'number' || !Number.isFinite(assistant.cost)) return;
  const already = state.spentByMessageId.get(assistant.id) ?? 0;
  const added = assistant.cost - already;
  if (added <= 0) return;

  const store = getAccountUsageStore();
  if (!store) return;
  try {
    const periodStart = utcMonthStart(now);
    const held = store.peek('opencode', [IMPLICIT_ACCOUNT_ID])[0]?.spend ?? null;
    const sameMonth = held !== null && held.periodStart === periodStart;
    const total = (sameMonth ? held.costUsd : 0) + added;
    // A fact merges newest-`observedAt`-wins and keeps the stored one on a tie,
    // so a second message in the same millisecond would be dropped with its
    // cost. Stamping past the held reading makes the new total always newer.
    const heldAt = held ? Date.parse(held.observedAt) : NaN;
    const observedAt = new Date(
      Number.isFinite(heldAt) ? Math.max(now.getTime(), heldAt + 1) : now.getTime()
    );
    store.record('opencode', { accountId: IMPLICIT_ACCOUNT_ID }, [], {
      spend: {
        periodStart,
        costUsd: total,
        limitUsd: sameMonth ? (held.limitUsd ?? null) : null,
        observedAt: observedAt.toISOString(),
        source: 'sidecar',
      },
    });
    // Count the message only once its cost is in the total, so a write that
    // did not land is retried by the message's next announcement.
    if (store.peek('opencode', [IMPLICIT_ACCOUNT_ID])[0]?.spend?.costUsd === total) {
      state.spentByMessageId.set(assistant.id, assistant.cost);
    }
  } catch (err) {
    logger.warn('[account-usage] could not record OpenCode spend', { err: String(err) });
  }
}

/** A `Retry-After` header as an ISO time: seconds from now, or an HTTP date. */
function retryAfterOf(headers: unknown, now: Date): string | null {
  if (typeof headers !== 'object' || headers === null) return null;
  const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === 'retry-after');
  const value = typeof entry?.[1] === 'string' ? entry[1].trim() : '';
  if (value === '') return null;
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    return new Date(now.getTime() + Number(value) * 1000).toISOString();
  }
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

/**
 * Whether a turn failure is a provider rate limit or a credit/payment error,
 * and when it clears. Narrow on purpose: an HTTP 402 or 429 from the provider,
 * or the providers' own wording for either; anything else is an ordinary error.
 *
 * @param error - The `session.error` payload.
 * @param now - When it was seen, for a `Retry-After` in seconds.
 */
export function openCodeLimitSignal(
  error: OpenCodeSessionError | undefined,
  now: Date = new Date()
): OpenCodeLimitSignal | null {
  if (!error || error.name === 'MessageAbortedError' || error.name === 'ProviderAuthError') {
    return null;
  }
  const data = error.data as Record<string, unknown>;
  const message = typeof data.message === 'string' ? data.message : '';
  const status = typeof data.statusCode === 'number' ? data.statusCode : undefined;
  const resetsAt = retryAfterOf(data.responseHeaders, now);
  if (status === 402 || CREDIT_PATTERNS.some((p) => p.test(message))) {
    return { kind: 'credits', resetsAt };
  }
  if (status === 429 || RATE_LIMIT_PATTERNS.some((p) => p.test(message))) {
    return { kind: 'rate_limit', resetsAt };
  }
  return null;
}

/**
 * Report a provider limit this turn failed on, once: record the window-less
 * `rate_limit:<provider>` or `credits:<provider>` entry, keep the session's
 * `limit` in the `session_limits` table, and return the `session_status` that
 * carries it. `null` when this turn already reported one. With no known
 * provider the ledger entry is skipped (it has no key), but the limit is set.
 *
 * @param state - The turn (mutated: the once-per-turn flag).
 * @param signal - What {@link openCodeLimitSignal} found.
 * @param now - When the turn failed.
 */
export function reportOpenCodeLimit(
  state: OpenCodeUsageTurnState,
  signal: OpenCodeLimitSignal,
  now: Date = new Date()
): StreamEvent | null {
  if (state.limitReportedThisTurn) return null;
  state.limitReportedThisTurn = true;
  const since = now.toISOString();
  const store = getAccountUsageStore();

  const slug = state.providerId !== undefined ? ledgerSlug(state.providerId) : null;
  if (slug !== null && store) {
    const entry: LedgerObservation = {
      key: `${signal.kind}:${slug}`,
      usedPct: null,
      status: 'rejected',
      resetsAt: signal.resetsAt,
      observedAt: since,
      source: 'error',
    };
    try {
      store.record('opencode', { accountId: IMPLICIT_ACCOUNT_ID }, [entry]);
    } catch (err) {
      logger.warn('[account-usage] could not record an OpenCode limit', { err: String(err) });
    }
  }

  let accountId: string | null = IMPLICIT_ACCOUNT_ID;
  try {
    accountId = store?.peek('opencode', [IMPLICIT_ACCOUNT_ID])[0]?.accountId ?? accountId;
  } catch {
    // Keep the ambient id: OpenCode has no other account.
  }
  const limit: SessionLimit = {
    accountId,
    window: UNKNOWN_LIMIT_WINDOW,
    resetsAt: signal.resetsAt,
    since,
    plan: { mode: 'ask' },
  };
  withSessionLimitStore('upsert', (limits) =>
    limits.upsert({ sessionId: state.sessionId, limit, scope: 'account', accountPath: null })
  );
  return { type: 'session_status', data: { sessionId: state.sessionId, limit } };
}
