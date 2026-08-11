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
 * (MAX_PREVIEW_SESSIONS in AgentListItem, MAX_JUMP_BACK_IN in the recents
 * model) AFTER partitioning, not before — partitioning must
 * see the full list so a conversation doesn't get bumped out of the cap by
 * automated sessions ahead of it in raw recency order.
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

/**
 * The subset of `ids` that count as live — **the one definition of liveness the
 * whole cockpit shares** (`design-decisions.md` §18).
 *
 * §18's Signal → Rendering table reads "Automated session activity → Nothing.
 * No bold, no badge", directly under the line naming approval / question /
 * wedged / idle-timeout as the only things that enter Now. So a scheduled run
 * or a room's own turn is not in any count of what is running: not the
 * sidebar's "N working", not an agent row's "N live" chip, not ⌘K's Continue.
 * Three surfaces reading one function is what stops them from disagreeing,
 * which is exactly what they did before this existed (DOR-1137).
 *
 * **The carve-out is Now, and it is elsewhere.** An automated session that is
 * blocked — waiting on an approval, asking a question, wedged — still reaches
 * the operator, as an attention item through `entities/attention`, which reads
 * no origin at all. Only the liveness COUNT excludes automation.
 *
 * **An id with no session record is kept.** Origin lives on the session record
 * and every caller's record list is a trimmed window, so an unknown id is one
 * whose origin is unknown rather than one known to be automated — and hiding a
 * human turn is the worse error of the two.
 *
 * @param ids - Candidate session ids, in the caller's own order.
 * @param sessions - Every session record the caller can see. Duplicates are
 *   harmless; only the ids of the automated ones are read.
 */
export function humanOriginSessionIds(
  ids: readonly string[],
  sessions: readonly Session[]
): readonly string[] {
  const automated = new Set(partitionSessionsByOrigin([...sessions]).automated.map((s) => s.id));
  if (automated.size === 0) return ids;
  return ids.filter((id) => !automated.has(id));
}
