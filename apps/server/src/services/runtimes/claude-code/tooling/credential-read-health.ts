/** Passive, account-scoped evidence of readable sign-in; never probes credentials. */
import {
  CREDENTIALS_UNREADABLE_CODE,
  CREDENTIALS_UNREADABLE_MESSAGE,
} from '@dorkos/shared/runtime-error-classification';

/** Minimum gap before readiness retries a hung credential read. */
export const CREDENTIAL_READ_RETRY_MS = 60_000;
/** What a start that never initializes tells people when no sign-in read hung (DOR-3670). */
export const SLOW_START_MESSAGE = 'The agent took too long to start. It will try again.';

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
/**
 * Record a hung sign-in read and impose a cooldown instead of a polling loop.
 * Only a credential read that hung calls this, never a slow start (DOR-3670):
 * a relaunch that takes long to initialize says nothing about the sign-in.
 */
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
/** Whether a sign-in read for exactly this account is known to have hung, and not since recovered. */
export function credentialReadHung(root: string | undefined): boolean {
  return credentialReadHealth(root).state === 'credentials_unreadable';
}
/** A hung init/read, deliberately distinct from a signed-out or revoked credential. */
export class CredentialsUnreadableError extends Error {
  readonly code = CREDENTIALS_UNREADABLE_CODE;
  constructor() {
    super(CREDENTIALS_UNREADABLE_MESSAGE);
    this.name = 'CredentialsUnreadableError';
  }
}
/** A start that never initialized while no sign-in read had hung: slow, not signed out (DOR-3670). */
export class SlowStartError extends Error {
  readonly code = 'slow_start';
  constructor() {
    super(SLOW_START_MESSAGE);
    this.name = 'SlowStartError';
  }
}
/** Test isolation for the passive process-wide account registry. */
export function resetCredentialReadHealth(): void {
  health.clear();
}
