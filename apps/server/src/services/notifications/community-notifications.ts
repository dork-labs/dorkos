/**
 * The notifications about spaces this install connected, spread into the registry's `ENTRIES`
 * beside the rest: someone asking to take over a space the person owns (DOR-2543), and teammates'
 * turns in a space reaching the monthly limit its owner set (DOR-2956). Their subject is the
 * owner's connection ref, which the app's link turns into that space's page.
 *
 * @module services/notifications/community-notifications
 */
import type { NotificationActionDTO } from '@dorkos/shared/notification-schemas';
import { ownerReplacementWhen } from './notification-copy.js';
import type { NotificationRegistryEntry } from './notification-registry.js';

/** The payload each space notification carries. */
export interface CommunityNotificationPayloads {
  /**
   * Someone asked the host to make someone else the owner of a community this person owns, or
   * that request completed (DOR-2543). Raised from the owner's own connection list, the only
   * connection the Community tells; see `emitters/community-owner-replacement.ts`.
   */
  'community.owner-replacement': {
    /** The owner's connection ref: the subject, and where "Open" goes. */
    ref: string;
    /** What this DorkOS calls the community. */
    communityLabel: string;
    replacementId: string;
  } & (
    | {
        phase: 'open';
        /** The new owner can take over at any time now. */
        claimable: boolean;
        /** The earliest it can happen, ISO 8601; `null` until the owner's notice resolves. */
        claimableAfter: string | null;
      }
    | { phase: 'completed'; newOwnerDisplayName: string }
  );
  /**
   * Teammates' turns in a space reached the monthly limit its owner set (DOR-2956). Raised by the
   * space's spending counter (`communities/remote/wake/teammate-spend.ts`), once a month.
   */
  'community.teammate-limit': {
    /** The owner's connection ref: the subject, and where "Open" goes. */
    ref: string;
    /** What this DorkOS calls the space. */
    communityLabel: string;
    /** The limit reached, in US dollars. */
    limitUsd: number;
    /** The month, `YYYY-MM` (UTC). */
    month: string;
  };
}

/** The two space kinds. */
type CommunityKind = keyof CommunityNotificationPayloads;

/**
 * How long one owner-replacement notice stays deduped: longer than any request can stay open,
 * which is the Community's longest wait (180 days) plus its 14-day claim window.
 */
const OWNER_REPLACEMENT_DEDUPE_WINDOW_MS = 210 * 24 * 60 * 60 * 1000;

/**
 * How long one teammate-limit notice stays deduped: a little past the longest month, so the
 * same space and month is told once. The counter's own record is what makes it once a month.
 */
const TEAMMATE_LIMIT_DEDUPE_WINDOW_MS = 32 * 24 * 60 * 60 * 1000;

/** "Open" goes to the space's own page. */
const OPEN_ACTION: NotificationActionDTO[] = [{ id: 'open', label: 'Open', style: 'primary' }];

/** The space entries, spread into the registry's `ENTRIES`. */
export const COMMUNITY_NOTIFICATION_ENTRIES: {
  [K in CommunityKind]: NotificationRegistryEntry<K>;
} = {
  'community.owner-replacement': {
    // Raised by `emitters/community-owner-replacement.ts` from the owner's connection list and
    // its hourly background check (`community-owner-notice-sweep.ts`, DOR-2760).
    // `notable`, never `blocking`: nothing is stuck, the wait is at least a week, and the
    // Community also emails the owner; it badges the bell and never reaches a phone.
    kind: 'community.owner-replacement',
    tier: 'notable',
    storage: 'event',
    // There is no community subject type; the subject id is the connection ref, which the
    // app's link turns into that community's page.
    subjectType: 'system',
    locate: (p) => ({ subjectId: p.ref }),
    title: (p) =>
      p.phase === 'open'
        ? `Someone asked to take over ${p.communityLabel}`
        : `${p.newOwnerDisplayName} is now the owner of ${p.communityLabel}`,
    body: (p) =>
      p.phase === 'open'
        ? `Unless you keep ownership, the host can make someone else its owner ${ownerReplacementWhen(p)}. Open the space to keep it.`
        : 'You are still a member.',
    actions: () => OPEN_ACTION,
    dedupeKey: (p) => `owner-replacement:${p.ref}:${p.replacementId}:${p.phase}`,
    // Longer than any request can stay open (the Community's longest wait, 180 days, plus its
    // 14-day claim window). The table keeps only 30 days, so the emitter's own ledger is what
    // makes it once for the whole life of a request.
    dedupeWindowMs: OWNER_REPLACEMENT_DEDUPE_WINDOW_MS,
    relay: 'never',
  },

  'community.teammate-limit': {
    // Raised by the space's spending counter (`communities/remote/wake/teammate-spend.ts`), which
    // keeps its own record of having told the owner this month. `notable`: nothing is broken,
    // teammates' posts simply wake nobody until next month or a higher limit.
    kind: 'community.teammate-limit',
    tier: 'notable',
    storage: 'event',
    subjectType: 'system',
    locate: (p) => ({ subjectId: p.ref }),
    title: (p) => `Teammates reached your limit in ${p.communityLabel}`,
    body: () => 'Their messages won’t wake your agents until next month, or a higher limit.',
    actions: () => OPEN_ACTION,
    dedupeKey: (p) => `teammate-limit:${p.ref}:${p.month}`,
    dedupeWindowMs: TEAMMATE_LIMIT_DEDUPE_WINDOW_MS,
    relay: 'never',
  },
};
