import type { z } from 'zod';
import type {
  CommunityAdminOwnerReplacementReasonSchema,
  CommunityAdminOwnerReplacementSchema,
} from '@dorkos/shared/community-admin-wire';
import type {
  CommunityWireOwnerReplacementAdminNoticeSchema,
  CommunityWireOwnerReplacementOptionsSchema,
  CommunityWireOwnerReplacementOwnerNoticeSchema,
} from '@dorkos/shared/community-wire';
import { formatReplacementDate } from '../../owner-replacement/dates.js';
import { addPasswordSentence } from '../../owner-replacement/options.js';

/** One owner replacement as the host page lists it. */
export type HostReplacement = z.infer<typeof CommunityAdminOwnerReplacementSchema>;
/** Why the host asked. */
export type ReplacementReason = z.infer<typeof CommunityAdminOwnerReplacementReasonSchema>;
/** The owner's view of an open request. */
export type OwnerNotice = z.infer<typeof CommunityWireOwnerReplacementOwnerNoticeSchema>;
/** An admin's view of an open request. */
export type AdminNotice = z.infer<typeof CommunityWireOwnerReplacementAdminNoticeSchema>;
/** What the owner can do about an open request now. */
export type OwnerOptions = z.infer<typeof CommunityWireOwnerReplacementOptionsSchema>;

/**
 * The shortest waiting period any host can set (`COMMUNITY_OWNER_REPLACEMENT_NOTICE_DAYS`). Said
 * before the notice has gone out, while the real date is not known yet.
 */
const LEAST_WAIT_DAYS = 7;

/** A date as every owner-replacement sentence says it, the same as the emails. */
export function replacementDate(value: string): string {
  return formatReplacementDate(new Date(value));
}

/** The host form's label for each reason. */
export const REASON_LABELS: Record<ReplacementReason, string> = {
  owner_left_group: 'The owner has left the group this community belongs to',
  owner_unreachable: 'The owner can’t be reached',
  other: 'Another reason',
};

/** The reason, as the owner reads it in the community. */
export function reasonSentence(reason: ReplacementReason): string {
  switch (reason) {
    case 'owner_left_group':
      return 'The host was told you’ve left the group this community belongs to.';
    case 'owner_unreachable':
      return 'The host couldn’t reach you.';
    case 'other':
      return 'The host didn’t give a specific reason.';
  }
}

/** Why a request has the longer wait, from what the server recorded when it was made. */
export function longWaitReason(row: HostReplacement): string | null {
  if (row.notice.state === 'failed') return 'The notice couldn’t be delivered by email.';
  if (row.notice.verifiedAddress === false) return 'The owner’s email address was never confirmed.';
  if (row.afterObjection)
    return 'The owner kept ownership before, so this request has the longer wait.';
  if (row.afterWithdrawal)
    return 'An earlier request was withdrawn less than 30 days ago, so this one has the longer wait.';
  if (row.reason === 'owner_left_group')
    return 'Requests saying the owner has left always have the longer wait.';
  return null;
}

/** Where one request stands, in words, for the host's list. */
export function hostRowSentence(row: HostReplacement): string {
  const ended = row.endedAt ? replacementDate(row.endedAt) : '';
  switch (row.state) {
    case 'notifying':
      return 'Sending the notice to the owner.';
    case 'waiting': {
      const until = `The owner has until ${replacementDate(row.claimableAfter!)}.`;
      if (row.wait === 'standard' && row.notice.resolvedAt)
        return `The owner’s mail server accepted the notice on ${replacementDate(row.notice.resolvedAt)}. ${until}`;
      const why = longWaitReason(row);
      return why ? `${until} ${why}` : until;
    }
    case 'claimable':
      return `The new owner can accept until ${replacementDate(row.claimExpiresAt!)}.`;
    case 'completed':
      return `The new owner accepted on ${ended}.`;
    case 'objected':
      return `The owner kept ownership on ${ended}. You can ask again after ${replacementDate(row.cooldownUntil!)}.`;
    case 'withdrawn':
      return `Withdrawn on ${ended} ${
        row.withdrawnBecause === 'suspended'
          ? 'because the community was suspended'
          : row.withdrawnBecause === 'deletion'
            ? 'because the community is being deleted'
            : 'by you'
      }.`;
    case 'superseded':
      return `Ended on ${ended} because the owner handed the community to someone or asked to delete it.`;
    case 'expired':
      return `The new owner didn’t accept in time. Ended on ${ended}.`;
  }
}

/** The cooling-off after the owner's most recent objection, while it lasts. */
export function activeCooldown(
  all: HostReplacement[],
  now: number
): { keptOn: string; askAgainAfter: string } | null {
  const objected = all
    .filter((row) => row.state === 'objected' && row.endedAt && row.cooldownUntil)
    .sort((a, b) => Date.parse(b.endedAt!) - Date.parse(a.endedAt!))[0];
  if (!objected || Date.parse(objected.cooldownUntil!) <= now) return null;
  return { keptOn: objected.endedAt!, askAgainAfter: objected.cooldownUntil! };
}

/** The sentence a cooling-off disables the host's button with. */
export function cooldownSentence(cooldown: { keptOn: string; askAgainAfter: string }): string {
  return `The owner kept ownership on ${replacementDate(cooldown.keptOn)}. You can ask again after ${replacementDate(cooldown.askAgainAfter)}.`;
}

/** The owner's banner. */
export function ownerBannerSentence(notice: Pick<OwnerNotice, 'claimableAfter'>): string {
  const when = notice.claimableAfter
    ? `on or after ${replacementDate(notice.claimableAfter)}`
    : `once a waiting period of at least ${LEAST_WAIT_DAYS} days has passed`;
  return `The host has been asked to make someone else the owner of this community. Unless you keep ownership, that can happen ${when}.`;
}

/** The admins' banner. */
export function adminBannerSentence(notice: Pick<AdminNotice, 'claimableAfter'>): string {
  const until = notice.claimableAfter
    ? `until ${replacementDate(notice.claimableAfter)}`
    : `at least ${LEAST_WAIT_DAYS} days`;
  return `The host has been asked to make someone else the owner. The owner has ${until} to respond.`;
}

/**
 * Only what this owner can do now, besides keeping ownership. `lifecycle` decides what a
 * password would open: a transfer only in an `active` community, so an unknown one promises
 * deletion alone.
 */
export function ownerOptionSentences(options: OwnerOptions, lifecycle: string | null): string[] {
  const sentences: string[] = [];
  if (options.transfer) sentences.push('You can hand the community to someone yourself.');
  if (options.delete) sentences.push('You can delete the community.');
  if (options.needsPassword) sentences.push(addPasswordSentence(lifecycle ?? ''));
  return sentences;
}

/** What keeping ownership does, for the owner's confirm and the emailed link's page. */
export function keepOwnershipSentence(cooldownDays: number): string {
  return `The host’s request will end. The host can ask again after ${cooldownDays} days, and you’ll be told again.`;
}

/** Every member's notice for a week after a new owner took over. */
export function completionSentence(completed: {
  newOwnerDisplayName: string;
  completedAt: string;
}): string {
  return `The host made ${completed.newOwnerDisplayName} the owner of this community on ${replacementDate(completed.completedAt)}.`;
}
