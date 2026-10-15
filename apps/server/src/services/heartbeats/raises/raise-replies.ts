/**
 * How an open raise closes on an answer (spec `heartbeats` §9.2): its reader
 * posted in the DM it landed in, after it.
 *
 * Only the reader's own post counts, and only in a `dm` room: a bridged
 * outsider, another person, or the agent posting again closes nothing. One
 * query answers every open raise at once, so the outbox's one-minute tick
 * costs a single read however many raises are open.
 *
 * @module services/heartbeats/raises/raise-replies
 */
import { inArray, sql } from 'drizzle-orm';
import { heartbeatOutbox, type Db } from '@dorkos/db';

/** Someone who posted after an open raise's message, in its DM. */
interface ReplyRow {
  /** The outbox row. */
  id: string;
  /** Who the raise was for. */
  toAccount: string;
  /** Who posted. */
  authorId: string;
}

/**
 * Close every open raise its reader answered.
 *
 * @param db - The server's database.
 * @param recipientAuthor - The room author a reader posts as, or null when none.
 * @param agentId - Only this agent's raises, or every agent's when absent.
 * @returns How many closed.
 */
export function closeAnsweredRaises(
  db: Db,
  recipientAuthor: (toAccount: string) => string | null,
  agentId?: string
): number {
  const rows = db.all<ReplyRow>(sql`
    SELECT o.id AS id, o.to_account AS toAccount, r.author_id AS authorId
    FROM heartbeat_outbox o
    JOIN room_entries s ON s.id = o.delivered_entry_id
    JOIN rooms dm ON dm.id = s.room_id AND dm.kind = 'dm'
    JOIN room_entries r ON r.room_id = s.room_id AND r.seq > s.seq AND r.kind = 'post'
    JOIN authors a ON a.id = r.author_id AND a.kind = 'human'
    WHERE o.state = 'delivered' ${agentId ? sql`AND o.agent_id = ${agentId}` : sql``}
    GROUP BY o.id, r.author_id
  `);
  const answered = new Set<string>();
  for (const row of rows) {
    if (recipientAuthor(row.toAccount) === row.authorId) answered.add(row.id);
  }
  if (answered.size === 0) return 0;
  // `closed_at` stays the moment it was delivered: the urgent ceiling counts it there.
  db.update(heartbeatOutbox)
    .set({ state: 'resolved' })
    .where(inArray(heartbeatOutbox.id, [...answered]))
    .run();
  return answered.size;
}
