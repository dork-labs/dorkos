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
 * else (agent/channel/task/external), preserving relative order within each
 * bucket. `origin` absent on a session means `user` — the unmarked default —
 * so untouched runtimes (codex, opencode) put every session in `conversations`.
 * Pure and synchronous; callers slice each bucket to their own row cap
 * (MAX_PREVIEW_SESSIONS in AgentListItem, MAX_RECENT_ROWS in
 * RecentSessionsSection) AFTER partitioning, not before — partitioning must
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
