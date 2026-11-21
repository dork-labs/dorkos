/**
 * What DorkOS tells the owner when a way to prove their sign-in is added or
 * removed: a passkey or an authenticator app (DOR-3647). The emitter is
 * `routes/owner-factors.ts`.
 *
 * Declared here and spread into the registry, like `web-device-notifications.ts`.
 * One row per factor. It names the kind and, for a passkey, the address it
 * works on: never a key, a code or a secret.
 *
 * @module services/core/auth/factors/sign-in-check-notifications
 */
import type { NotificationRegistryEntry } from '../../../notifications/notification-registry.js';

/** The payloads, joined into `NotificationPayloads`. */
export interface SignInCheckPayloads {
  /** A passkey or authenticator app was added to the owner's account. */
  'signin.check_added': {
    /** The new factor's id. The subject. */
    factorId: string;
    kind: 'passkey' | 'authenticator';
    /** A passkey's address, e.g. `localhost`. */
    host?: string;
  };
  /** A passkey or authenticator app was removed from the owner's account. */
  'signin.check_removed': {
    /** The removed factor's id. The subject. */
    factorId: string;
    kind: 'passkey' | 'authenticator';
  };
}

/** The remedy every row names. */
const REMEDY = 'Not you? Remove it in Settings, then change your password.';

/** The entries, spread into the registry's `ENTRIES`. */
export const SIGN_IN_CHECK_ENTRIES: {
  [K in keyof SignInCheckPayloads]: NotificationRegistryEntry<K>;
} = {
  'signin.check_added': {
    kind: 'signin.check_added',
    // Notable: nothing waits on a person, but the owner should see it.
    tier: 'notable',
    storage: 'event',
    subjectType: 'system',
    locate: (p) => ({ subjectId: p.factorId }),
    title: (p) => (p.kind === 'passkey' ? 'A passkey was added' : 'An authenticator app was added'),
    body: (p) => (p.kind === 'passkey' && p.host ? `It works on ${p.host}. ${REMEDY}` : REMEDY),
    dedupeKey: (p) => `signin-check:${p.factorId}`,
    relay: 'never',
  },
  'signin.check_removed': {
    kind: 'signin.check_removed',
    tier: 'notable',
    storage: 'event',
    subjectType: 'system',
    locate: (p) => ({ subjectId: p.factorId }),
    title: (p) =>
      p.kind === 'passkey' ? 'A passkey was removed' : 'An authenticator app was removed',
    body: () => 'Not you? Change your password, then add a sign-in check again.',
    dedupeKey: (p) => `signin-check-removed:${p.factorId}`,
    relay: 'never',
  },
};
