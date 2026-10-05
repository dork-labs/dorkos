import type { PoolClient } from 'pg';
import type { CommunityConfig } from '../config.js';
import { plainTextMail } from '../mail/messages.js';
import { queueNotice } from '../mail/outbox.js';
import type { NoticeComposer, NoticeComposers } from '../mail/worker.js';
import { OIDC_PROVIDER_ID } from '../oidc.js';

/** The name a person knows a sign-in by: "Google", "GitHub", or the host's button label. */
export function signInName(providerId: string, config: Pick<CommunityConfig, 'oidc'>): string {
  if (providerId === 'google') return 'Google';
  if (providerId === 'github') return 'GitHub';
  if (providerId === OIDC_PROVIDER_ID) return config.oidc?.label ?? 'Single sign-on';
  return 'Another';
}

/**
 * Record that a sign-in was linked to an account, in the caller's transaction: one
 * `member.sign_in_linked` audit event in every community the account is in, by the person
 * themselves, naming the provider and how it was proven (`cleared` after a never-confirmed
 * account was cleared, `password` after its password was entered). With `notice`, one
 * `account.sign_in_linked` mail is queued, attached to the account's earliest active membership
 * (none when it has none): one link, one message.
 */
export async function recordSignInLinked(
  client: PoolClient,
  input: {
    userId: string;
    memberIds: readonly string[];
    changedFields: readonly string[];
    notice: boolean;
    now: Date;
  }
): Promise<void> {
  const audited = await client.query<{ id: string; community_id: string; member_id: string }>(
    `INSERT INTO audit_events(community_id,actor_member_id,action,subject_id,changed_fields)
     SELECT community_id,id,'member.sign_in_linked',id,$2::text[] FROM members
     WHERE id=ANY($1::uuid[]) ORDER BY community_id,id
     RETURNING id,community_id,subject_id AS member_id`,
    [input.memberIds, input.changedFields]
  );
  if (!input.notice || !audited.rowCount) return;
  const earliest = await client.query<{ id: string }>(
    `SELECT id FROM members WHERE id=ANY($1::uuid[]) AND active
     ORDER BY created_at,id LIMIT 1`,
    [input.memberIds]
  );
  const event = audited.rows.find((row) => row.member_id === earliest.rows[0]?.id);
  if (!event) return;
  await queueNotice(
    client,
    {
      communityId: event.community_id,
      kind: 'account.sign_in_linked',
      subjectId: event.id,
      recipientUserId: input.userId,
    },
    input.now
  );
}

/** The date and time a person reads in the message, in UTC. */
function when(date: Date): string {
  return `${date.toLocaleString('en-GB', {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })} (UTC)`;
}

/**
 * The `account.sign_in_linked` message: which sign-in was linked and when, whether the old
 * password and sign-ins were removed, and how to undo it. It reads the audit event the link
 * recorded, so the message says what happened even if the account changed since.
 */
function composeSignInLinked(config: Pick<CommunityConfig, 'oidc' | 'publicUrl'>): NoticeComposer {
  return async ({ pool, notice }) => {
    const event = await pool.query<{ changed_fields: string[]; created_at: Date }>(
      `SELECT changed_fields,created_at FROM audit_events
       WHERE community_id=$1 AND id=$2 AND action='member.sign_in_linked'`,
      [notice.communityId, notice.subjectId]
    );
    const row = event.rows[0];
    if (!row) return null;
    const [provider, ...how] = row.changed_fields;
    const name = signInName(provider, config);
    return plainTextMail('A sign-in was linked to your account', [
      `${name} sign-in was linked to your account at ${config.publicUrl} on ${when(row.created_at)}.`,
      how.includes('cleared')
        ? "Your account's email had never been confirmed, so its old password and other sign-ins were removed, and every device signed in before was signed out."
        : how.includes('password')
          ? "It was linked after your account's password was entered."
          : '',
      "If this wasn't you, open Settings, Account and remove it, or ask your space's owner for help.",
    ]);
  };
}

/** The composer for the linked-sign-in notice. */
export function signInLinkComposers(
  config: Pick<CommunityConfig, 'oidc' | 'publicUrl'>
): NoticeComposers {
  return { 'account.sign_in_linked': composeSignInLinked(config) };
}
