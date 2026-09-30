import type { z } from 'zod';
import type {
  CommunityAdminTakedownCategorySchema,
  CommunityAdminTakedownEvidenceStateSchema,
  CommunityAdminTakedownSchema,
} from '@dorkos/shared/community-admin-wire';
import {
  COMMUNITY_TAKEDOWN_CATEGORY_SENTENCES,
  type CommunityWireTakedownNoticeSchema,
} from '@dorkos/shared/community-wire';
import { readStorage, writeStorage } from '../remembered-community.js';

/** Why the host removed something. */
export type TakedownCategory = z.infer<typeof CommunityAdminTakedownCategorySchema>;
/** Where a takedown's evidence copy stands. */
export type EvidenceState = z.infer<typeof CommunityAdminTakedownEvidenceStateSchema>;
/** A takedown as the host page lists it: ids and states, never content. */
export type HostTakedown = z.infer<typeof CommunityAdminTakedownSchema>;
/** One takedown as its owner, an admin, or its author is told about it. */
export type TakedownNotice = z.infer<typeof CommunityWireTakedownNoticeSchema>;

/** The four reasons, in the order the host page offers them, with the words it shows. */
export const TAKEDOWN_CATEGORIES: readonly { value: TakedownCategory; label: string }[] = [
  { value: 'illegal_content', label: 'Illegal content' },
  { value: 'child_safety', label: 'Child safety' },
  { value: 'legal_order', label: 'Legal order' },
  { value: 'terms_violation', label: 'Breaks your terms' },
];

/** A category's short label on the host page. */
export function categoryLabel(category: TakedownCategory): string {
  return TAKEDOWN_CATEGORIES.find((item) => item.value === category)!.label;
}

/** The one sentence the owner and the author read for a category. */
export function categorySentence(category: TakedownCategory): string {
  return COMMUNITY_TAKEDOWN_CATEGORY_SENTENCES[category];
}

/**
 * Whether the owner and the author are told, before the host changes it: not for child safety,
 * where telling the uploader can warn someone under investigation; yes for every other reason.
 */
export function defaultNotify(category: TakedownCategory): boolean {
  return category !== 'child_safety';
}

/** Where a takedown's copy for the authorities stands, as the host page says it. */
export const EVIDENCE_WORDING: Record<EvidenceState, string> = {
  stored: 'Copy saved',
  pending: 'Saving the copy…',
  retrying: 'Couldn’t save the copy yet; retrying',
  failed: 'Couldn’t save the copy',
  not_configured: 'No evidence store',
  nothing_to_preserve: 'Nothing left to save',
  held_on_primary: 'Kept on this server until you release it',
};

/** What a host takedown removed, said by kind and ID. */
export function hostTargetLabel(target: HostTakedown['target']): string {
  switch (target.kind) {
    case 'entry':
      return `Message ${target.entryId}`;
    case 'attachment':
      return `File ${target.attachmentId}`;
    case 'icon':
      return 'Community icon';
    case 'community':
      return 'Whole community';
  }
}

/** What a notice is about, as the owner's list names it. */
export function noticeTargetLabel(kind: TakedownNotice['targetKind']): string {
  return kind === 'entry' ? 'A message' : kind === 'attachment' ? 'A file' : 'The community icon';
}

/** A takedown's day, as people read it. */
export function takedownDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, { dateStyle: 'long' });
}

/** What an author's banner calls the removed thing. */
const AUTHOR_WHAT: Record<TakedownNotice['targetKind'], string> = {
  entry: 'one of your messages',
  attachment: 'one of your files',
  // An icon has no author; the notices route never marks one `yours`. Said plainly all the same.
  icon: 'the community icon',
};

/** The author's banner: what was removed, when, and why. */
export function authorBannerText(notice: TakedownNotice): string {
  const what = AUTHOR_WHAT[notice.targetKind];
  return `The host removed ${what} on ${takedownDate(notice.createdAt)}. ${categorySentence(notice.category)}`;
}

const SEEN_KEY = 'communityTakedownsSeen';

/** One member's dismissals in one community: two people sharing a browser never share them. */
function seenKey(communityId: string, memberId: string): string {
  return `${SEEN_KEY}:${communityId}:${memberId}`;
}

/**
 * The takedowns this browser has already shown their author, per community and member. A
 * convenience only: without storage the banner shows again on the next visit, the safe side.
 */
export function readSeenTakedowns(
  communityId: string,
  memberId: string,
  storage: () => Storage = () => localStorage
): Set<string> {
  const raw = readStorage(storage, seenKey(communityId, memberId));
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    return new Set(
      Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
    );
  } catch {
    return new Set();
  }
}

/** Remember that the author dismissed one takedown's banner in this browser. */
export function rememberSeenTakedown(
  communityId: string,
  memberId: string,
  takedownId: string,
  storage: () => Storage = () => localStorage
): void {
  const seen = readSeenTakedowns(communityId, memberId, storage);
  seen.add(takedownId);
  writeStorage(storage, seenKey(communityId, memberId), JSON.stringify([...seen]));
}
