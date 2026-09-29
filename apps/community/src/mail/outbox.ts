import type { Pool, PoolClient } from 'pg';

type Queryable = Pick<Pool | PoolClient, 'query'>;

/** Every kind of notice the Community can mail. The table's check constraint lists the same. */
export const NOTICE_KINDS = [
  'owner_replacement.notice',
  'owner_replacement.reminder',
  'owner_replacement.claim_reissued',
  'owner_replacement.ended',
  'owner_replacement.completed',
] as const;

/** One kind of mailed notice. */
export type NoticeKind = (typeof NOTICE_KINDS)[number];

/** A notice to queue: what it is about and whose account it goes to, never an address. */
export interface NoticeRequest {
  communityId: string;
  kind: NoticeKind;
  /** The record the notice is about, such as an owner replacement. */
  subjectId: string;
  /** The recipient's account. The worker reads its email only when it sends. */
  recipientUserId: string;
}

/** Resolved messages are kept this long after they resolve, then deleted. */
const RETENTION = "interval '30 days'";

/**
 * Queue one notice inside the caller's transaction, so it exists exactly when the change that
 * causes it commits. It is due at once. Returns the new message's id.
 *
 * @param now - When it was queued. Its 72-hour retry window counts from here; tests inject it.
 */
export async function queueNotice(
  client: Queryable,
  notice: NoticeRequest,
  now: Date = new Date()
): Promise<string> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO notice_outbox(community_id,kind,subject_id,recipient_user_id,next_attempt_at,created_at)
     VALUES($1,$2,$3,$4,$5,$5) RETURNING id`,
    [notice.communityId, notice.kind, notice.subjectId, notice.recipientUserId, now]
  );
  return inserted.rows[0].id;
}

/** Delete messages 30 days after they were accepted or failed. Returns how many went. */
export async function pruneNoticeOutbox(pool: Queryable, now: Date = new Date()): Promise<number> {
  const result = await pool.query(
    `DELETE FROM notice_outbox
     WHERE state IN ('accepted','failed')
       AND COALESCE(accepted_at,failed_at) < $1::timestamptz - ${RETENTION}`,
    [now]
  );
  return result.rowCount ?? 0;
}
