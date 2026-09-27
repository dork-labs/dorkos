/**
 * Turns session lifecycle transitions into notifications.
 *
 * Two things ride the one seam the projector already fans out
 * (`onProjectorStatusChange`), because both are answers to "what changed about
 * this session":
 *
 * - **A turn finished** — `streaming` settled to `idle`. An Activity row.
 * - **An error started** — a session fell over. Nothing is WRITTEN here: while it
 *   stands, the session's own lifecycle is the truth and the attention surfaces
 *   derive it. What does happen is that the escalation clock starts, because
 *   `session.error` is a Blocking condition and a machine nobody is sitting at
 *   is exactly when one matters (DOR-1387).
 * - **A usage limit** — the turn that fell over carried the account's usage
 *   limit. Told once per account episode as `account.limited`, never as
 *   `session.error`, and never escalated: it ends on its own at the reset.
 * - **An error cleared** — a session that was stopped on an error is not stopped
 *   any more. A standing condition ending, so this is where its one history row
 *   is written; the disarm rides `resolveStanding` rather than happening here.
 *
 * The projector announces a status, never a transition, so this keeps the last
 * lifecycle it saw per session. Both maps here are bounded by the number of
 * live sessions.
 *
 * ## An error EPISODE, not an errored session
 *
 * A session can fall over, be fixed, and fall over again. Those are two
 * separate things to be told about, so the second map stamps when the current
 * episode began and {@link sessionErrorPayload} carries that timestamp into the
 * kind's dedupe key. Both edges of one episode go through that one builder,
 * which is what makes the resolution's key identical to the arm's — and an
 * identical key is the whole disarm. Get that wrong and the phone ping cannot
 * be cancelled (DOR-1387 review).
 *
 * @module services/notifications/emitters/session-lifecycle
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { SessionLifecycle, SessionLimit } from '@dorkos/shared/session-stream';
import { onProjectorStatusChange } from '../../session/session-state-projector.js';
import { resolveAgentIdForPath } from '../../mesh/agent-path-lookup.js';
import { notify, resolveStanding } from '../notification-service.js';
import { armEscalation } from '../escalation-service.js';
import type { NotificationPayload } from '../notification-registry.js';
import { withSessionLimitStore } from '../../session/fleet/session-limit-store.js';
import { getAccountUsageStore } from '../../core/usage/current-usage-store.js';
import { canonicalAccountPath } from '../../core/usage/runtime-accounts.js';
import { runtimeRegistry } from '../../core/runtime-registry.js';
import { LEDGER_RUNTIMES, type LedgerRuntime } from '@dorkos/shared/account-usage';

/**
 * What to call a session in a sentence.
 *
 * The working directory's last segment, which is the identity fallback every
 * other session surface uses. A notification title has to stand on its own in a
 * desktop banner or a chat message, so it cannot be an id.
 *
 * @param cwd - The session's working directory, when the projector knew one.
 */
export function sessionLabelFor(cwd: string | undefined): string {
  if (!cwd) return 'A session';
  return path.basename(cwd) || 'A session';
}

/**
 * Describe one error episode, for both edges of it.
 *
 * The ONE builder both the arm and the resolution go through, because the
 * escalation is disarmed by key: `notificationEntry('session.error')
 * .dedupeKey(payload)` has to produce the same string at the start and the end
 * of an episode, and two hand-written literals are exactly how that stops being
 * true. The label is recomputed from the current `cwd` rather than remembered —
 * it is not part of the key, so a directory that resolved late improves the
 * sentence without breaking the disarm.
 *
 * @param sessionId - The session that stopped.
 * @param cwd - Its working directory, when the projector knew one.
 * @param since - When THIS episode started, stamped once at the error.
 */
function sessionErrorPayload(
  sessionId: string,
  cwd: string | undefined,
  since: string
): NotificationPayload<'session.error'> {
  const agentId = resolveAgentIdForPath(cwd);
  return { sessionId, sessionLabel: sessionLabelFor(cwd), since, ...(agentId ? { agentId } : {}) };
}

/**
 * A short, stable stand-in for an account folder: the first 12 hex digits of
 * the SHA-256 of its canonical path.
 *
 * @param accountPath - The folder the session ran in.
 */
function accountRefOf(accountPath: string): string {
  const canonical = canonicalAccountPath(accountPath, undefined);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}

/** What to call an account with no label, per runtime; never a raw id. */
const UNLABELLED_ACCOUNT: Readonly<Record<LedgerRuntime, string>> = {
  'claude-code': 'Your Claude account',
  codex: 'Your Codex account',
  opencode: 'Your OpenCode account',
};

/**
 * The runtime a session is bound to, for the usage ledgers: its
 * `session_metadata` row, else Claude Code (the only runtime with more than one
 * account, and the one every limit came from before §6 R). Never throws.
 */
function ledgerRuntimeOf(sessionId: string): LedgerRuntime {
  try {
    const bound = runtimeRegistry.getSessionBindings([sessionId]).get(sessionId)?.runtime;
    if (bound && (LEDGER_RUNTIMES as readonly string[]).includes(bound)) {
      return bound as LedgerRuntime;
    }
  } catch {
    // No database yet (a unit test, early boot): fall through.
  }
  return 'claude-code';
}

/**
 * Describe a usage limit a session hit, naming the account the way the
 * operator does.
 *
 * The label comes from the usage store: the account's registered name, or the
 * machine default's. An unregistered folder (`accountId` null) is found by the
 * folder the session's stored limit recorded, which is also its identity in
 * the dedupe key, as a short hash ({@link accountRefOf}) so the path itself is
 * never stored in the notification. The account is looked up in the session's
 * own runtime (spec §6 R): Codex's and OpenCode's `default` is not Claude
 * Code's, so their payload names the runtime, which keeps their episodes apart.
 *
 * @param sessionId - The session that stopped.
 * @param cwd - Its working directory, when the projector knew one.
 * @param limit - The limit its status carries.
 */
function accountLimitedPayload(
  sessionId: string,
  cwd: string | undefined,
  limit: SessionLimit
): NotificationPayload<'account.limited'> {
  const agentId = resolveAgentIdForPath(cwd);
  const accountPath =
    withSessionLimitStore('get', (store) => store.get(sessionId))?.accountPath ?? undefined;
  const runtime = ledgerRuntimeOf(sessionId);
  const usageStore = getAccountUsageStore();
  const usage = limit.accountId
    ? usageStore?.peek(runtime, [limit.accountId])[0]
    : accountPath
      ? (usageStore?.usageAtPath(runtime, accountPath) ?? undefined)
      : undefined;
  return {
    sessionId,
    sessionLabel: sessionLabelFor(cwd),
    accountId: limit.accountId,
    // A raw id (`default`, `default-2`) is never shown: without a label, say what it is.
    accountLabel: usage?.label ?? UNLABELLED_ACCOUNT[runtime],
    ...(runtime !== 'claude-code' ? { runtime } : {}),
    window: limit.window,
    resetsAt: limit.resetsAt,
    since: limit.since,
    ...(!limit.accountId && accountPath ? { accountRef: accountRefOf(accountPath) } : {}),
    ...(agentId ? { agentId } : {}),
  };
}

/**
 * Tell the person again that an account ran out, because the automatic move
 * to another account that was planned for this session could not happen (spec
 * `claude-account-fleet` D9 "Automatic handoff"). Its own dedupe key, so the
 * account's first notice does not swallow it.
 *
 * @param sessionId - The session that stays where it is.
 * @param cwd - Its working directory, when known.
 * @param limit - The limit it still holds.
 */
export function notifyAutoMoveFailed(
  sessionId: string,
  cwd: string | undefined,
  limit: SessionLimit
): void {
  void notify('account.limited', {
    ...accountLimitedPayload(sessionId, cwd, limit),
    autoMoveFailed: true,
  });
}

/**
 * Watch every session's lifecycle and raise what it implies.
 *
 * @returns An unsubscribe function.
 */
export function watchSessionLifecycle(): () => void {
  const previous = new Map<string, SessionLifecycle>();
  /** When each session's CURRENT error episode started. Absent when it is fine. */
  const errorSince = new Map<string, string>();

  return onProjectorStatusChange(({ sessionId, cwd, retiredSessionId, status }) => {
    // A rekey re-announce carries the id this projector streamed under before
    // its canonical id resolved. Retiring it keeps the maps from holding state
    // nothing will ever move again.
    if (retiredSessionId) {
      previous.delete(retiredSessionId);
      errorSince.delete(retiredSessionId);
    }

    const before = previous.get(sessionId);
    previous.set(sessionId, status.lifecycle);
    if (before === status.lifecycle) return;

    if (before === 'streaming' && status.lifecycle === 'idle') {
      // Deliberately raised for every finished turn, including one the operator
      // started by typing here. The seam carries no principal — a turn can be
      // started from the composer, a room, a bridge or a schedule, and the
      // projector knows none of them — so an own-action drop here would be a
      // guess. Presence filtering (spec task 4.1) is what will keep this quiet
      // for somebody watching the session it happened in.
      const agentId = resolveAgentIdForPath(cwd);
      void notify('turn.completed', {
        sessionId,
        sessionLabel: sessionLabelFor(cwd),
        completedAt: new Date().toISOString(),
        ...(agentId ? { agentId } : {}),
      });
      return;
    }

    if (status.lifecycle === 'error' && status.limit) {
      // The turn stopped because the account ran out of usage (spec
      // claude-account-fleet D4). That is not breakage: it ends on its own at a
      // known time, so it is told once per ACCOUNT episode (however many
      // sessions hit it) and arms no `session.error` escalation. With no
      // episode stamped in `errorSince`, the clear below has nothing to resolve.
      void notify('account.limited', accountLimitedPayload(sessionId, cwd, status.limit));
      return;
    }

    if (status.lifecycle === 'error') {
      // A new episode begins, and this is the only place its identity is
      // minted. The early return above means a session already in `error`
      // cannot re-stamp itself.
      const since = new Date().toISOString();
      errorSince.set(sessionId, since);
      armEscalation('session.error', sessionErrorPayload(sessionId, cwd, since));
      return;
    }

    // The map — not `before === 'error'` — is what says an episode this process
    // knows about is ending. Reading the answer off the same state that holds
    // the `since` means there is never a resolution with no timestamp to carry,
    // so no fallback has to be invented for a case that cannot arise.
    const since = errorSince.get(sessionId);
    if (since === undefined) return;
    errorSince.delete(sessionId);
    void resolveStanding('session.error', sessionErrorPayload(sessionId, cwd, since), {
      outcome: 'cleared',
    });
  });
}
