/**
 * When a revoked instance's connections end, and the options every entry
 * point that ends them shares.
 *
 * @module lib/connectors/managed/instance-revocation/policy
 */
import {
  productionManagedCleanupProvider,
  type ManagedCleanupProvider,
} from '../event-cleanup-service';

/**
 * How long a revoked instance's connections are kept before they are ended.
 *
 * Zero: they end the moment the link is revoked. Relinking a machine today
 * creates a new instance, and every managed connection is reachable only from
 * the instance that created it, so a kept connection could never be used
 * again. It would only keep a person's sign-in alive at the service. If a
 * same-person relink ever adopts its predecessor's connections, this is the
 * one value to raise; the revoke route and the sweep both decide through
 * {@link revokedInstanceConnectionsDue}, and such a relink would read it
 * there too. Erasing an account never waits.
 */
export const REVOKED_INSTANCE_CONNECTION_GRACE_MS: number = 0;

/**
 * Whether a revoked instance's connections are due to be ended.
 *
 * With no grace period, every revoked instance is due, without comparing
 * clocks: `revoked_at` is a timestamp without a time zone, so a database or
 * server running in another zone could otherwise make a just-revoked instance
 * look revoked in the future and silently skip it.
 *
 * @param revokedAt - When the instance's link was revoked.
 * @param now - The current time.
 */
export function revokedInstanceConnectionsDue(revokedAt: Date, now: Date): boolean {
  if (REVOKED_INSTANCE_CONNECTION_GRACE_MS === 0) return true;
  return now.getTime() - revokedAt.getTime() >= REVOKED_INSTANCE_CONNECTION_GRACE_MS;
}

/** Options shared by every entry point that ends a revoked instance's connections. */
export interface RevokedInstanceCleanupOptions {
  /** Stops provider cleanup between accounts; closing is never interrupted. */
  signal: AbortSignal;
  /** Provider clients for one tenant; defaults to this deployment's own. */
  resolveProvider?: ManagedCleanupProvider;
  /** The current time; injectable for tests. */
  clock?: () => Date;
}

/**
 * Fill in the defaults every entry point shares.
 *
 * @param options - The caller's options.
 */
export function withDefaults(
  options: RevokedInstanceCleanupOptions
): Required<RevokedInstanceCleanupOptions> {
  return {
    signal: options.signal,
    resolveProvider: options.resolveProvider ?? productionManagedCleanupProvider,
    clock: options.clock ?? (() => new Date()),
  };
}
