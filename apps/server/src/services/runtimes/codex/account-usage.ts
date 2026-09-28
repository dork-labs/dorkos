/**
 * Codex's usage readings into the account usage store, and a hard limit into
 * the session's `limit` (spec `claude-account-fleet` §6 R and D4).
 *
 * Codex has one account per machine, `default` (contract rev 6d), so every
 * reading is recorded as (`codex`, `default`). The readings are the
 * `rate_limits` payloads Codex itself wrote into the rollout tail DorkOS
 * already reads at turn end (`turn-context-usage.ts`), mapped by the shared
 * `codexObservations`. Nothing here asks OpenAI anything or reads a credential.
 *
 * A limit is detected when a plain window reads `rejected` or at 100% or
 * more (Codex leaves `rate_limit_reached_type` null in real records even at
 * 100%), or when the turn failed with Codex's own usage-limit error. Like the
 * Claude Code path (`claude-code/accounts/session-limit.ts`), the limit is
 * kept in the `session_limits` table and returned as the `session_status`
 * that carries it, so `account.limited` and the out-of-usage flow apply.
 *
 * Never throws: a failed store or table write costs the reading, never the turn.
 *
 * @module services/runtimes/codex/account-usage
 */
import {
  IMPLICIT_ACCOUNT_ID,
  codexObservations,
  type LedgerObservation,
} from '@dorkos/shared/account-usage';
import type { SessionLimit } from '@dorkos/shared/schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import { logger } from '../../../lib/logger.js';
import { getAccountUsageStore } from '../../core/usage/current-usage-store.js';
import { limitScopeOf, withSessionLimitStore } from '../../session/fleet/session-limit-store.js';

/** The window key a limit carries when nothing said which window it was. */
const UNKNOWN_LIMIT_WINDOW = 'unknown';

/**
 * Codex's own words for a turn that stopped on the account's usage limit, as
 * real rollouts record them ("You've hit your usage limit. Visit … or try
 * again at …", `codex_error_info: usage_limit_exceeded`). Narrow on purpose:
 * an ordinary failure, or a bare 429 from a short-term throttle, must never
 * read as the account running out.
 */
const USAGE_LIMIT_PATTERNS: readonly RegExp[] = [
  /\bhit your usage limit\b/i,
  /\busage_limit_(?:exceeded|reached)\b/i,
];

/**
 * Whether a Codex failure message means the account ran out of usage.
 *
 * @param message - The CLI's failure text (`turn.failed`'s `error.message`).
 */
export function isCodexUsageLimitMessage(message: string): boolean {
  return USAGE_LIMIT_PATTERNS.some((pattern) => pattern.test(message));
}

/** The window a limit names, and when it resets. */
export interface CodexLimitWindow {
  /** The ledger window key, or `unknown`. */
  window: string;
  /** When it resets, ISO-8601, or `null`. */
  resetsAt: string | null;
}

type WindowObservation = Extract<LedgerObservation, { key: string }>;

function isWindow(observation: LedgerObservation): observation is WindowObservation {
  return 'key' in observation;
}

/** The candidate with the latest `resetsAt` (an unknown reset ranks last). */
function latestReset(candidates: readonly WindowObservation[]): WindowObservation | undefined {
  return candidates.reduce<WindowObservation | undefined>((best, next) => {
    if (!best) return next;
    if (next.resetsAt === null || next.resetsAt === undefined) return best;
    if (best.resetsAt === null || best.resetsAt === undefined) return next;
    return Date.parse(next.resetsAt) > Date.parse(best.resetsAt) ? next : best;
  }, undefined);
}

function hitLimit(o: WindowObservation): boolean {
  return (
    o.status === 'rejected' || (o.usedPct !== null && o.usedPct !== undefined && o.usedPct >= 100)
  );
}

/**
 * The limit one turn's readings imply, or `null` when there is none.
 *
 * A plain (main-limit) window marked `rejected` wins; if several are, the one
 * with the LATEST reset, since the session cannot run until all clear. Then a
 * plain window at 100% or more, again the latest reset. A `model:*` bucket
 * never stops the account on its own; it names the window only when the turn
 * failed on a limit and no plain window did. A failed turn with nothing to
 * name it falls back to `unknown`.
 *
 * @param observations - This turn's readings (from `codexObservations`).
 * @param turnFailedOnLimit - Whether the turn failed with a usage-limit error.
 */
export function codexLimitOf(
  observations: readonly LedgerObservation[],
  turnFailedOnLimit: boolean
): CodexLimitWindow | null {
  const windows = observations.filter(isWindow);
  const plain = windows.filter((o) => !o.key.startsWith('model:'));
  const chosen =
    latestReset(plain.filter((o) => o.status === 'rejected')) ??
    latestReset(plain.filter(hitLimit)) ??
    (turnFailedOnLimit ? latestReset(windows.filter(hitLimit)) : undefined);
  if (chosen) return { window: chosen.key, resetsAt: chosen.resetsAt ?? null };
  return turnFailedOnLimit ? { window: UNKNOWN_LIMIT_WINDOW, resetsAt: null } : null;
}

/** Per-turn state this module reads and writes. */
export interface CodexUsageTurnState {
  /** The DorkOS session id the turn's events are stamped with. */
  readonly sessionId: string;
  /** Set once this turn reported a limit, so a turn yields one limit status. */
  limitReportedThisTurn?: boolean;
}

/**
 * Record one finished turn's rate limits against Codex's `default` account and,
 * when they (or the failure) show the account ran out, set the session's
 * `limit`. Returns the `session_status` carrying the limit, or `null`.
 *
 * @param state - The turn (mutated: the once-per-turn flag).
 * @param rateLimits - The turn's `rate_limits` payloads, from the rollout tail.
 * @param turnFailedOnLimit - Whether the turn failed with a usage-limit error.
 * @param now - When the turn ended.
 */
export function noteCodexTurnUsage(
  state: CodexUsageTurnState,
  rateLimits: readonly unknown[],
  turnFailedOnLimit: boolean,
  now: Date = new Date()
): StreamEvent | null {
  const observedAt = now.toISOString();
  const observations = rateLimits.flatMap((payload) =>
    codexObservations(payload, observedAt, 'rollout')
  );
  if (observations.length > 0) {
    try {
      getAccountUsageStore()?.record('codex', { accountId: IMPLICIT_ACCOUNT_ID }, observations);
    } catch (err) {
      logger.warn('[account-usage] could not record a Codex usage reading', { err: String(err) });
    }
  }

  const found = codexLimitOf(observations, turnFailedOnLimit);
  if (!found || state.limitReportedThisTurn) return null;
  state.limitReportedThisTurn = true;

  const usage = safeDefaultUsage();
  const limit: SessionLimit = {
    accountId: usage?.accountId ?? IMPLICIT_ACCOUNT_ID,
    window: found.window,
    resetsAt: found.resetsAt,
    since: observedAt,
    plan: { mode: 'ask' },
  };
  withSessionLimitStore('upsert', (store) =>
    store.upsert({
      sessionId: state.sessionId,
      limit,
      scope: limitScopeOf(found.window),
      accountPath: usage?.path || null,
    })
  );
  return { type: 'session_status', data: { sessionId: state.sessionId, limit } };
}

/** Codex's `default` account usage, or `null`; never throws. */
function safeDefaultUsage() {
  try {
    return getAccountUsageStore()?.peek('codex', [IMPLICIT_ACCOUNT_ID])[0] ?? null;
  } catch {
    return null;
  }
}
