/** Synchronous session-record admission and retirement, shared with the idle sweep. */
import {
  SessionCapacityError,
  sessionCapacityMessage,
  type SessionCapacity,
} from '@dorkos/shared/running-chats';
import type { AgentSession } from '../../agent-types.js';
import { SESSIONS } from '../../../../../config/constants.js';

export interface SessionRecordPolicy {
  /** Work outside the record: opening turns, projectors, locks and background work. */
  isHoldingWork?: (id: string) => boolean;
  /** Give back resources for every alias before a reclaimed slot is reused. */
  onEvict?: (ids: string[]) => void;
}

/** Every alias is checked before retirement, and forgotten together. */
function idsOf(id: string, session: AgentSession, index: Map<string, string>): string[] {
  return [
    ...new Set([
      id,
      session.sdkSessionId,
      ...[...index].filter(([, key]) => key === id).map(([alias]) => alias),
    ]),
  ];
}

function busy(
  id: string,
  session: AgentSession,
  index: Map<string, string>,
  policy: SessionRecordPolicy
): boolean {
  return (
    session.activeQuery !== undefined ||
    session.pendingInteractions.size > 0 ||
    idsOf(id, session, index).some((alias) => policy.isHoldingWork?.(alias) === true)
  );
}

/** Remove one record and all its index aliases. Never touches durable settings or transcripts. */
export function forgetSessionRecord(
  sessions: Map<string, AgentSession>,
  index: Map<string, string>,
  id: string
): string[] {
  const session = sessions.get(id);
  if (!session) return [];
  const ids = idsOf(id, session, index);
  for (const interaction of session.pendingInteractions.values()) clearTimeout(interaction.timeout);
  for (const [alias, key] of index) if (key === id) index.delete(alias);
  sessions.delete(id);
  return ids;
}

/**
 * No await between selection, eviction and the caller's insert: concurrent starts cannot overfill.
 *
 * A brand-new record is idle until its turn opens, so between insert and
 * `activeQuery` only the caller's turn lock (`isHoldingWork`) keeps it from
 * being reclaimed by the next start. Every path that creates a record at the
 * cap must take the session's lock first, as `trigger-turn` and
 * `session_start` do. Message staging (`deliverIntoTurn`) skips the lock, which
 * is safe only because it targets a chat that already exists.
 */
export function reclaimSessionRecord(
  sessions: Map<string, AgentSession>,
  index: Map<string, string>,
  policy: SessionRecordPolicy
): void {
  if (sessions.size < SESSIONS.MAX_SESSIONS) return;
  let oldest: [string, AgentSession] | undefined;
  for (const entry of sessions) {
    if (busy(entry[0], entry[1], index, policy)) continue;
    if (!oldest || entry[1].lastActivity < oldest[1].lastActivity) oldest = entry;
  }
  if (!oldest) throw new SessionCapacityError(SESSIONS.MAX_SESSIONS);
  const retired = forgetSessionRecord(sessions, index, oldest[0]);
  policy.onEvict?.(retired);
}

/** The reported refusal and admission use exactly the same busy predicate. */
export function sessionRecordCapacity(
  sessions: Map<string, AgentSession>,
  index: Map<string, string>,
  policy: SessionRecordPolicy
): Omit<SessionCapacity, 'runtime'> {
  const live = [...sessions].filter(([id, session]) => busy(id, session, index, policy)).length;
  const available = Math.max(0, SESSIONS.MAX_SESSIONS - live);
  return {
    limit: SESSIONS.MAX_SESSIONS,
    records: sessions.size,
    live,
    available,
    message: available === 0 ? sessionCapacityMessage(SESSIONS.MAX_SESSIONS) : null,
  };
}
