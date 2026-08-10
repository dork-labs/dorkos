import type { Session } from '@dorkos/shared/types';

/** Result of partitioning a session list by origin. */
export interface SessionOriginPartition {
  /** Sessions whose resolved origin is `user` (absent `origin` defaults to `user`). */
  conversations: Session[];
  /** Every non-user-origin session, in the same relative order as the input. */
  automated: Session[];
}

/**
 * Split a session list into user-initiated conversations and everything
 * else (agent/channel/room/task/external), preserving relative order within
 * each bucket. `origin` absent on a session means `user` — the unmarked default
 * — so untouched runtimes (codex, opencode) put every session in
 * `conversations`.
 *
 * **`room` is in the automated bucket, and that is the point of it.** A room
 * turn is an engine run under a thread the reader can already see (ADR
 * 260808-140954): the room row IS that conversation, so listing the run beside
 * it lists one thing twice. The origin is assigned server-side from the
 * `room_sessions` binding (`services/session/room-origin-overlay.ts`), because
 * nothing in a room turn's transcript says where it came from.
 * Pure and synchronous; callers slice each bucket to their own row cap
 * (MAX_JUMP_BACK_IN in the recents model) AFTER partitioning, not before —
 * partitioning must see the full list so a conversation doesn't get bumped out
 * of the cap by automated sessions ahead of it in raw recency order. The
 * session switcher caps nothing: it is the surface an operator opens to see
 * everything, so a cap there would defeat the reason they opened it.
 *
 * @param sessions - Sessions to partition, in their existing order
 */
export function partitionSessionsByOrigin(sessions: Session[]): SessionOriginPartition {
  const conversations: Session[] = [];
  const automated: Session[] = [];
  for (const session of sessions) {
    if (!session.origin || session.origin === 'user') {
      conversations.push(session);
    } else {
      automated.push(session);
    }
  }
  return { conversations, automated };
}
