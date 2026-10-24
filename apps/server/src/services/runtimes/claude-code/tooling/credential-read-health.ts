/** Passive, account-scoped evidence of readable sign-in; never probes credentials. */
import {
  CREDENTIALS_UNREADABLE_CODE,
  CREDENTIALS_UNREADABLE_MESSAGE,
} from '@dorkos/shared/runtime-error-classification';

/** How long prior successful reads explain a subsequent missing init. */
export const RECENT_CREDENTIAL_HEALTH_MS = 5 * 60_000;
/** Minimum gap before readiness retries a hung credential read. */
export const CREDENTIAL_READ_RETRY_MS = 60_000;
/** Short init bound for an account that was readable moments ago. */
export const CREDENTIAL_INIT_TIMEOUT_MS = 15_000;

/** Passive classification exposed to the stall watchdog, keyed by the pinned account root. */
export interface CredentialReadHealth {
  state: 'unknown' | 'healthy' | 'credentials_unreadable';
  lastHealthyAt?: number;
  retryAt?: number;
}
const health = new Map<string, CredentialReadHealth>();

/** Read already-observed health without launching any process or touching a credential store. */
export function credentialReadHealth(root: string | undefined): CredentialReadHealth {
  return root === undefined
    ? { state: 'unknown' }
    : { ...(health.get(root) ?? { state: 'unknown' }) };
}
/** Record a completed sign-in read or runtime init for exactly this account. */
export function noteCredentialsReadable(root: string | undefined, now = Date.now()): void {
  if (root !== undefined) health.set(root, { state: 'healthy', lastHealthyAt: now });
}
/** Record a hung read and impose a cooldown instead of a polling loop. */
export function noteCredentialsUnreadable(root: string | undefined, now = Date.now()): void {
  if (root !== undefined)
    health.set(root, {
      ...credentialReadHealth(root),
      state: 'credentials_unreadable',
      retryAt: now + CREDENTIAL_READ_RETRY_MS,
    });
}
/** Whether a new read must wait; reads resume only after the cooldown. */
export function credentialReadCoolingDown(root: string, now = Date.now()): boolean {
  return (credentialReadHealth(root).retryAt ?? 0) > now;
}
/** Whether this same account produced positive evidence within the recent-health window. */
export function credentialsRecentlyReadable(root: string | undefined, now = Date.now()): boolean {
  const last = credentialReadHealth(root).lastHealthyAt;
  return last !== undefined && now >= last && now - last <= RECENT_CREDENTIAL_HEALTH_MS;
}
/** A hung init/read, deliberately distinct from a signed-out or revoked credential. */
export class CredentialsUnreadableError extends Error {
  readonly code = CREDENTIALS_UNREADABLE_CODE;
  constructor() {
    super(CREDENTIALS_UNREADABLE_MESSAGE);
    this.name = 'CredentialsUnreadableError';
  }
}
/** Test isolation for the passive process-wide account registry. */
export function resetCredentialReadHealth(): void {
  health.clear();
}
