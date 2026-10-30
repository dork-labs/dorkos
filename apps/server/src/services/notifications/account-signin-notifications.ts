/**
 * What DorkOS tells the person when a Claude account folder holds a sign-in
 * it has not seen there before, or a different one than it had (DOR-3245).
 * The emitter is `emitters/account-signin-review.ts`.
 *
 * Declared here and spread into the registry, like `web-device-notifications.ts`.
 *
 * A notice, never a hold: the turn that noticed it ran, and nothing waits on
 * the person. Until they confirm it in Settings → Runtimes, DorkOS only stops
 * picking that folder on its own. Emails are masked; the row never carries an
 * account or organization id. Once per sign-in: the dedupe key is a hash of
 * the folder and its identity, so a restart does not say it again.
 *
 * @module services/notifications/account-signin-notifications
 */
import type { NotificationRegistryEntry } from './notification-registry.js';

/** The payload of the one kind, joined into `NotificationPayloads`. */
export interface AccountSigninPayloads {
  /** A Claude folder's sign-in is new to DorkOS, or changed. */
  'account.signin_review': {
    /** The account folder. The subject. */
    accountRoot: string;
    /** What the person calls the account. */
    accountName: string;
    /** `new` for a folder DorkOS has not confirmed, `changed` for a different sign-in. */
    change: 'new' | 'changed';
    /** The masked email it holds now, e.g. `a…@example.com`. */
    email?: string;
    /** For `changed`: the masked email it held before. */
    previousEmail?: string;
    /** For `changed`: whether it is in a different organization now. */
    orgChanged?: boolean;
    /** A short hash of the folder and its identity, so one sign-in is said once. */
    fingerprint: string;
  };
}

/**
 * As long as the inbox keeps a row (`NOTIFICATION_RETENTION_DAYS`, 30): dedupe
 * reads the stored rows, so a longer window would claim a silence it cannot keep.
 */
export const SIGNIN_REVIEW_DEDUPE_MS = 30 * 24 * 60 * 60 * 1000;

/** The one entry, spread into the registry's `ENTRIES`. */
export const ACCOUNT_SIGNIN_ENTRIES: {
  [K in keyof AccountSigninPayloads]: NotificationRegistryEntry<K>;
} = {
  'account.signin_review': {
    kind: 'account.signin_review',
    // Notable: in the inbox, never a phone, and nothing waits on it.
    tier: 'notable',
    storage: 'event',
    // Opens Settings → Runtimes, where the person confirms or keeps it.
    subjectType: 'system',
    locate: (p) => ({ subjectId: `signin-review:${p.fingerprint}` }),
    title: (p) =>
      p.change === 'new'
        ? `New Claude sign-in${p.email ? ` ${p.email}` : ''} on ${p.accountName}`
        : `${p.accountName}'s Claude sign-in changed`,
    body: (p) =>
      p.change === 'new'
        ? 'Confirm it so DorkOS can pick it on its own.'
        : `${p.previousEmail ?? 'Before'} → ${p.email ?? 'another sign-in'}${
            p.orgChanged ? ', in another organization' : ''
          }. Keep it?`,
    dedupeKey: (p) => `signin-review:${p.fingerprint}`,
    dedupeWindowMs: SIGNIN_REVIEW_DEDUPE_MS,
    relay: 'never',
  },
};
