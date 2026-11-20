/**
 * What DorkOS tells the owner when a new way to prove their sign-in is added:
 * a passkey or an authenticator app (DOR-3647). The emitter is
 * `routes/owner-factors.ts`.
 *
 * Declared here and spread into the registry, like `web-device-notifications.ts`.
 * One row per factor. It names the kind and, for a passkey, the address it
 * works on: never a key, a code or a secret.
 *
 * @module services/core/auth/factors/sign-in-check-notifications
 */
import type { NotificationRegistryEntry } from '../../../notifications/notification-registry.js';

/** The payload of the one kind, joined into `NotificationPayloads`. */
export interface SignInCheckPayloads {
  /** A passkey or authenticator app was added to the owner's account. */
  'signin.check_added': {
    /** The new factor's id. The subject. */
    factorId: string;
    kind: 'passkey' | 'authenticator';
    /** A passkey's address, e.g. `localhost`. */
    host?: string;
  };
}

/** The remedy every row names. */
const REMEDY = 'Not you? Remove it in Settings, then change your password.';

/** The one entry, spread into the registry's `ENTRIES`. */
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
    title: (p) =>
      p.kind === 'passkey'
        ? 'A passkey was added on this computer'
        : 'An authenticator app was added',
    body: (p) => (p.kind === 'passkey' && p.host ? `It works on ${p.host}. ${REMEDY}` : REMEDY),
    dedupeKey: (p) => `signin-check:${p.factorId}`,
    relay: 'never',
  },
};
