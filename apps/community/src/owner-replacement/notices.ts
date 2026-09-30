import type { Pool } from 'pg';
import type { CommunityConfig } from '../config.js';
import { plainTextMail, type ComposedMail } from '../mail/messages.js';
import type { ClaimedNotice, NoticeComposer, NoticeComposers } from '../mail/worker.js';
import { accountHasPassword } from '../routes/account/account-password.js';
import { formatReplacementDate } from './dates.js';
import { mintObjectToken } from './object-tokens.js';
import { ownerReplacementOptions } from './options.js';
import {
  OPEN_REPLACEMENT_STATES,
  replacementWait,
  type OwnerReplacementReason,
  type OwnerReplacementState,
} from './records.js';

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
/**
 * A reminder sent this close to the date, or closer, drops "in 2 days": it is queued 48 hours
 * before, but a busy mail server can hold it for a day or more.
 */
const REMINDER_IN_TWO_DAYS_MS = 36 * HOUR_MS;

/** The reminder's "when" sentence, true however late the reminder is sent. */
function reminderWhen(earliest: Date, date: string, now: Date): string {
  const left = earliest.getTime() - now.getTime();
  if (left >= REMINDER_IN_TWO_DAYS_MS)
    return `If you do nothing, that can happen in 2 days, on or after ${date}.`;
  if (left > 0) return `If you do nothing, that can happen on or after ${date}.`;
  return 'If you do nothing, that can happen at any time now.';
}

type Settings = Pick<CommunityConfig, 'publicUrl' | 'ownerReplacement'>;

/** What every owner-replacement message reads about its request, as of the send. */
interface NoticeSubject {
  state: OwnerReplacementState;
  reason: OwnerReplacementReason;
  after_objection: boolean;
  after_withdrawal: boolean;
  claimable_after: Date | null;
  /** The latest date a message about this request promised, while it was notifying. */
  notice_promised_at: Date | null;
  community_name: string;
  lifecycle: string;
  new_owner_name: string | null;
}

async function readSubject(pool: Pool, notice: ClaimedNotice): Promise<NoticeSubject | null> {
  const row = await pool.query<NoticeSubject>(
    `SELECT r.state,r.reason,r.after_objection,r.after_withdrawal,r.claimable_after,
       r.notice_promised_at,
       c.name AS community_name,c.lifecycle,m.display_name AS new_owner_name
     FROM owner_replacements r JOIN communities c ON c.id=r.community_id
     LEFT JOIN members m ON m.community_id=r.community_id AND m.id=r.new_owner_member_id
     WHERE r.community_id=$1 AND r.id=$2`,
    [notice.communityId, notice.subjectId]
  );
  return row.rows[0] ?? null;
}

/** The subject line every message about a request to take over this community carries. */
function takeoverSubject(community: string): string {
  return `Someone asked to take over ${community}`;
}

/**
 * The earliest date the new owner could take over, as the owner should be told it. Once the
 * notice has resolved it is the stored date. Before then it is this send's time plus the wait
 * this notice would get if the mail server takes it now, read with the address's verified flag
 * as it is now. The stored date is counted from the acceptance, which is never earlier than
 * this send, so the owner is told a date no later than the real one: "on or after" stays true.
 */
function earliestDate(subject: NoticeSubject, verified: boolean, now: Date, settings: Settings) {
  if (subject.claimable_after) return subject.claimable_after;
  const wait = replacementWait({
    notice_state: 'accepted',
    verified_address: verified,
    after_objection: subject.after_objection,
    after_withdrawal: subject.after_withdrawal,
    reason: subject.reason,
  });
  const days =
    wait === 'standard'
      ? settings.ownerReplacement.noticeDays
      : settings.ownerReplacement.unreachableDays;
  return new Date(now.getTime() + days * DAY_MS);
}

/** The owner's other ways out, only those this owner has now, and the community's address. */
function optionParagraphs(
  subject: NoticeSubject,
  hasPassword: boolean,
  communityUrl: string
): string[] {
  const options = ownerReplacementOptions({ lifecycle: subject.lifecycle, hasPassword });
  const paragraphs: string[] = [];
  if (options.transfer)
    paragraphs.push(
      `If you can sign in, you can also hand the community to someone yourself from its Settings: ${communityUrl}`
    );
  if (options.delete)
    paragraphs.push('If you can sign in, you can also delete the community from its Settings.');
  if (options.needsPassword)
    paragraphs.push('To hand it to someone or delete it, add a password to your account first.');
  if (!options.transfer) paragraphs.push(`The community: ${communityUrl}`);
  return paragraphs;
}

/**
 * The notice, the reminder, and the claim-reissued message: each carries its own fresh
 * object-only link, and only while the request is still open. While the notice has not
 * resolved, each records the date it promised; the notice also records the owner's verified
 * flag as of this send, since it decides the wait.
 */
function composeOpenNotice(settings: Settings, kind: 'notice' | 'reminder' | 'claim_reissued') {
  const composer: NoticeComposer = async ({ pool, notice, now }) => {
    const subject = await readSubject(pool, notice);
    if (!subject || !OPEN_REPLACEMENT_STATES.includes(subject.state)) return null;
    const account = await pool.query<{ emailVerified: boolean }>(
      'SELECT "emailVerified" FROM "user" WHERE id=$1',
      [notice.recipientUserId]
    );
    const verified = account.rows[0]?.emailVerified === true;
    // Before the notice resolves, every email names one date. A claim link sent again says
    // "the earliest date is still …", so it repeats the date already promised. The notice names
    // its own counted date, but never one earlier than an email already promised (a claim link
    // sent first, while the address was still unconfirmed, may have promised the long wait).
    const counted = earliestDate(subject, verified, now, settings);
    const promised = subject.claimable_after ? null : subject.notice_promised_at;
    const earliest = !promised
      ? counted
      : kind === 'claim_reissued'
        ? promised
        : new Date(Math.max(counted.getTime(), promised.getTime()));
    // While the notice has not resolved, every message records the latest date it promised:
    // the stored date may never be earlier. Only the notice records the address's verified
    // flag, since that is what decides the wait.
    await pool.query(
      `UPDATE owner_replacements SET
         verified_address=CASE WHEN $5 THEN $3 ELSE verified_address END,
         notice_promised_at=GREATEST(notice_promised_at,$4::timestamptz)
       WHERE community_id=$1 AND id=$2 AND state='notifying'`,
      [notice.communityId, notice.subjectId, verified, earliest, kind === 'notice']
    );
    const date = formatReplacementDate(earliest);
    const link = await mintObjectToken(pool, {
      communityId: notice.communityId,
      replacementId: notice.subjectId,
      outboxId: notice.id,
      publicUrl: settings.publicUrl,
      now,
    });
    const communityUrl = `${settings.publicUrl}/c/${notice.communityId}`;
    const keep = `To keep ownership, open this link and press Keep ownership. You don't need to sign in: ${link}`;
    const hasPassword = await accountHasPassword(pool, notice.recipientUserId);
    const opening =
      kind === 'claim_reissued'
        ? [
            `The host sent the link for the new owner again. Nothing else changed. The earliest date is still ${date}.`,
          ]
        : [
            `The host of ${subject.community_name} has been asked to make someone else its owner.`,
            kind === 'reminder'
              ? reminderWhen(earliest, date, now)
              : `If you do nothing, that can happen on or after ${date}.`,
          ];
    return plainTextMail(takeoverSubject(subject.community_name), [
      ...opening,
      keep,
      ...optionParagraphs(subject, hasPassword, communityUrl),
    ]);
  };
  return composer;
}

/** The message when a request ends without the owner acting: withdrawn or expired. */
function composeEnded(settings: Settings): NoticeComposer {
  return async ({ pool, notice }): Promise<ComposedMail | null> => {
    const subject = await readSubject(pool, notice);
    if (!subject) return null;
    const sentence =
      subject.state === 'withdrawn'
        ? 'The host withdrew its request. Nothing changed.'
        : subject.state === 'expired'
          ? 'The request expired. Nothing changed.'
          : null;
    if (!sentence) return null;
    return plainTextMail(`The request to take over ${subject.community_name} has ended`, [
      sentence,
      `The community: ${settings.publicUrl}/c/${notice.communityId}`,
    ]);
  };
}

/** The message to the old owner once the account named in the request took ownership. */
function composeCompleted(settings: Settings): NoticeComposer {
  return async ({ pool, notice }): Promise<ComposedMail | null> => {
    const subject = await readSubject(pool, notice);
    if (subject?.state !== 'completed' || !subject.new_owner_name) return null;
    return plainTextMail(`${subject.community_name} has a new owner`, [
      `${subject.new_owner_name} is now the owner of ${subject.community_name}. You are still a member.`,
      `The community: ${settings.publicUrl}/c/${notice.communityId}`,
    ]);
  };
}

/**
 * The composer for every owner-replacement notice kind. Each is minimal on purpose: what is
 * happening, the date, and how to keep ownership. None carries a claim token, the host's reason
 * or reference, or anything from inside the community; only the notice, the reminder, and the
 * claim-reissued message carry an object-only link.
 */
export function ownerReplacementComposers(settings: Settings): NoticeComposers {
  return {
    'owner_replacement.notice': composeOpenNotice(settings, 'notice'),
    'owner_replacement.reminder': composeOpenNotice(settings, 'reminder'),
    'owner_replacement.claim_reissued': composeOpenNotice(settings, 'claim_reissued'),
    'owner_replacement.ended': composeEnded(settings),
    'owner_replacement.completed': composeCompleted(settings),
  };
}
