import type { Pool, PoolClient } from 'pg';
import type { CommunityConfig } from '../config.js';
import { transaction } from '../data.js';
import { queueNotice } from '../mail/outbox.js';
import { endOwnerReplacement } from './end.js';
import { currentOwnerAccount, replacementWait, type OwnerReplacementRow } from './records.js';

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
/** How long the named account has to take ownership once the wait ends. */
const OWNER_REPLACEMENT_CLAIM_DAYS = 14;
/** The reminder goes this long before the new owner could take over. */
const OWNER_REPLACEMENT_REMINDER_MS = 48 * HOUR_MS;
/** How often the timeline looks for replacements with something due. */
const OWNER_REPLACEMENT_POLL_MS = 60_000;
/** At most this many replacements move per tick, so one tick never runs unbounded. */
const PER_TICK = 50;

/** What one tick did, for the caller and tests. */
export interface TimelineTick {
  resolved: number;
  reminded: number;
  claimable: number;
  expired: number;
}

/** One replacement as the timeline reads it under the community lock. */
type TimelineRow = Omit<OwnerReplacementRow, 'requested_by_label'> & {
  reminder_queued_at: Date | null;
  notice_promised_at: Date | null;
};

/**
 * Lock the community, then re-read one replacement under it. Every transition runs this first:
 * a replacement found due before the lock was granted may have been closed by an objection, a
 * cancel, or a completion since, and then the transition does nothing.
 */
async function lockDue(
  client: PoolClient,
  communityId: string,
  replacementId: string
): Promise<TimelineRow | null> {
  await client.query('SELECT 1 FROM communities WHERE id=$1 FOR UPDATE', [communityId]);
  const row = await client.query<TimelineRow>(
    'SELECT * FROM owner_replacements WHERE community_id=$1 AND id=$2 FOR UPDATE',
    [communityId, replacementId]
  );
  return row.rows[0] ?? null;
}

type Due = { id: string; community_id: string };

async function due(pool: Pool, sql: string, now: Date): Promise<Due[]> {
  return (await pool.query<Due>(`${sql} ORDER BY requested_at,id LIMIT ${PER_TICK}`, [now])).rows;
}

/**
 * Move every owner replacement whose next step is due, one transaction per replacement:
 *
 * - **Notice resolves.** Once the notice message is accepted or failed, the request records
 *   that outcome and when, and waits. The new owner may claim after the short wait N only when
 *   the mail server accepted the notice, the address was marked verified when it was sent, the
 *   owner never objected before, no request was withdrawn in the 30 days before, and the reason
 *   is not that the owner left the group; otherwise after the long wait U. Both count from when
 *   the notice resolved, and the date is never earlier than one a notice already promised.
 * - **Reminder.** 48 hours before that date, one reminder is queued. It never moves the date.
 * - **Claimable.** At that date the claim opens for 14 days. No audit row: nobody acted.
 * - **Expired.** When the claim window closes unclaimed, the request ends and the owner is told.
 *
 * @param now - The clock every date here is judged by; tests inject it.
 */
export async function advanceOwnerReplacements(input: {
  pool: Pool;
  config: Pick<CommunityConfig, 'ownerReplacement'>;
  now: Date;
}): Promise<TimelineTick> {
  const { pool, config, now } = input;
  const tick: TimelineTick = { resolved: 0, reminded: 0, claimable: 0, expired: 0 };

  const resolvable = await due(
    pool,
    `SELECT r.id,r.community_id,r.requested_at FROM owner_replacements r
     WHERE r.state='notifying' AND EXISTS(
       SELECT 1 FROM notice_outbox o
       WHERE o.subject_id=r.id AND o.community_id=r.community_id
         AND o.kind='owner_replacement.notice' AND o.state IN ('accepted','failed')
         AND COALESCE(o.accepted_at,o.failed_at)<=$1)`,
    now
  );
  for (const candidate of resolvable) {
    const moved = await transaction(pool, async (client) => {
      const row = await lockDue(client, candidate.community_id, candidate.id);
      if (row?.state !== 'notifying') return false;
      const outcome = await client.query<{ state: 'accepted' | 'failed'; at: Date }>(
        `SELECT state,COALESCE(accepted_at,failed_at) AS at FROM notice_outbox
         WHERE subject_id=$1 AND community_id=$2 AND kind='owner_replacement.notice'
           AND state IN ('accepted','failed')
         ORDER BY COALESCE(accepted_at,failed_at) LIMIT 1`,
        [row.id, row.community_id]
      );
      const notice = outcome.rows[0];
      if (!notice) return false;
      const wait = replacementWait({ ...row, notice_state: notice.state });
      const days =
        wait === 'standard'
          ? config.ownerReplacement.noticeDays
          : config.ownerReplacement.unreachableDays;
      // Never earlier than a date a notice already promised the owner: the settings may have
      // been lowered since that notice was written.
      const counted = notice.at.getTime() + days * DAY_MS;
      const claimableAfter = new Date(
        Math.max(counted, row.notice_promised_at?.getTime() ?? counted)
      );
      await client.query(
        `UPDATE owner_replacements SET state='waiting',notice_state=$2,notice_resolved_at=$3,
           verified_address=COALESCE(verified_address,false),claimable_after=$4
         WHERE id=$1`,
        [row.id, notice.state, notice.at, claimableAfter]
      );
      return true;
    });
    if (moved) tick.resolved++;
  }

  const remindable = await due(
    pool,
    `SELECT id,community_id FROM owner_replacements
     WHERE state='waiting' AND reminder_queued_at IS NULL
       AND claimable_after - interval '48 hours'<=$1 AND claimable_after>$1`,
    now
  );
  for (const candidate of remindable) {
    const moved = await transaction(pool, async (client) => {
      const row = await lockDue(client, candidate.community_id, candidate.id);
      if (
        row?.state !== 'waiting' ||
        row.reminder_queued_at ||
        !row.claimable_after ||
        row.claimable_after.getTime() - OWNER_REPLACEMENT_REMINDER_MS > now.getTime() ||
        row.claimable_after.getTime() <= now.getTime()
      )
        return false;
      const owner = await currentOwnerAccount(client, row.community_id);
      if (owner)
        await queueNotice(
          client,
          {
            communityId: row.community_id,
            kind: 'owner_replacement.reminder',
            subjectId: row.id,
            recipientUserId: owner,
          },
          now
        );
      await client.query('UPDATE owner_replacements SET reminder_queued_at=$2 WHERE id=$1', [
        row.id,
        now,
      ]);
      return true;
    });
    if (moved) tick.reminded++;
  }

  const claimable = await due(
    pool,
    `SELECT id,community_id FROM owner_replacements
     WHERE state='waiting' AND claimable_after<=$1`,
    now
  );
  for (const candidate of claimable) {
    const moved = await transaction(pool, async (client) => {
      const row = await lockDue(client, candidate.community_id, candidate.id);
      if (row?.state !== 'waiting' || !row.claimable_after || row.claimable_after > now)
        return false;
      await client.query(
        `UPDATE owner_replacements SET state='claimable',claim_expires_at=$2 WHERE id=$1`,
        [row.id, new Date(row.claimable_after.getTime() + OWNER_REPLACEMENT_CLAIM_DAYS * DAY_MS)]
      );
      return true;
    });
    if (moved) tick.claimable++;
  }

  const expirable = await due(
    pool,
    `SELECT id,community_id FROM owner_replacements
     WHERE state='claimable' AND claim_expires_at<=$1`,
    now
  );
  for (const candidate of expirable) {
    const moved = await transaction(pool, async (client) => {
      const row = await lockDue(client, candidate.community_id, candidate.id);
      if (row?.state !== 'claimable' || !row.claim_expires_at || row.claim_expires_at > now)
        return false;
      return (
        (await endOwnerReplacement(client, {
          communityId: row.community_id,
          replacementId: row.id,
          ending: { state: 'expired' },
          now,
        })) !== null
      );
    });
    if (moved) tick.expired++;
  }
  return tick;
}

/**
 * Run the timeline in the background and return its timer for the shutdown path. One tick at a
 * time on this replica; every transition re-reads its replacement under the community lock, so
 * two replicas never move one replacement twice.
 */
export function startOwnerReplacementTimeline(options: {
  pool: Pool;
  config: Pick<CommunityConfig, 'ownerReplacement'>;
  pollMs?: number;
}): ReturnType<typeof setInterval> {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void advanceOwnerReplacements({ pool: options.pool, config: options.config, now: new Date() })
      .catch((error: unknown) => {
        console.error(
          'Community owner-replacement timeline unavailable',
          error instanceof Error ? error.name : 'unknown'
        );
      })
      .finally(() => {
        running = false;
      });
  }, options.pollMs ?? OWNER_REPLACEMENT_POLL_MS);
  timer.unref();
  return timer;
}
