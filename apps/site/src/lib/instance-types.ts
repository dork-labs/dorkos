/**
 * Client-safe view types for the device-link instance registry
 * (accounts-and-auth P2, task 2.3).
 *
 * Kept free of any server imports so both the server-only
 * `@/lib/instance-service` and the client UI (`/activate`, `/account/instances`)
 * can share the same shapes without pulling Better Auth into the browser bundle.
 *
 * @module lib/instance-types
 */

/** The registry view rendered at `/account/instances`. */
export interface InstanceView {
  /** Instance id (equals the owning API key's metadata `instanceId`). */
  id: string;
  /** Human-readable instance name. */
  name: string;
  /** `process.platform` of the instance. */
  platform: string;
  /** DorkOS version the instance is running. */
  dorkosVersion: string;
  /** ISO timestamp the instance first linked. */
  createdAt: string;
  /** ISO timestamp of the last heartbeat. */
  lastSeenAt: string;
  /** ISO timestamp of revocation, or null while the link is live. */
  revokedAt: string | null;
}

/** The `/activate` pre-approval status a user code resolves to. */
export type PendingInstanceStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'invalid';

/** What `/activate` shows for a looked-up user code. */
export interface PendingInstanceView {
  /** Current device-authorization status for the code. */
  status: PendingInstanceStatus;
  /** Requesting instance name, when the code resolved to a real record. */
  name?: string;
  /** Requesting instance platform, when known. */
  platform?: string;
}
