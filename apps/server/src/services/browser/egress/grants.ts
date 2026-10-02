import { randomBytes } from 'node:crypto';
import type { CanonicalDestination } from './destination.js';
import type { EgressBinding } from './settings.js';
import { EgressPolicyError } from './errors.js';

const MAX_LOCAL_GRANT_MS = 5 * 60 * 1000;
/** An in-memory issuance handle; copied/serialized objects cannot restore its authority. */
export interface LocalDestinationGrant {
  readonly id: string;
}
interface GrantRecord {
  binding: Readonly<EgressBinding>;
  destination: CanonicalDestination;
  issuedAt: number;
  expiresAt: number;
}

/** Private short-lived exact grants; issuer receives context already authenticated by the server. */
export function localGrants(now: () => number) {
  const issued = new WeakMap<LocalDestinationGrant, GrantRecord>();
  const time = () => {
    let value: number;
    try {
      value = now();
    } catch {
      throw new EgressPolicyError('GRANT_REFUSED');
    }
    if (!Number.isSafeInteger(value) || value < 0) throw new EgressPolicyError('GRANT_REFUSED');
    return value;
  };
  return {
    issue(
      context: Readonly<EgressBinding>,
      destination: CanonicalDestination,
      expiresAt: number
    ): LocalDestinationGrant {
      const issuedAt = time();
      if (
        !Number.isSafeInteger(expiresAt) ||
        expiresAt <= issuedAt ||
        expiresAt - issuedAt > MAX_LOCAL_GRANT_MS
      )
        throw new EgressPolicyError('GRANT_REFUSED');
      const handle = Object.freeze({ id: randomBytes(16).toString('base64url') });
      issued.set(handle, { binding: context, destination, issuedAt, expiresAt });
      return handle;
    },
    validate(
      handle: LocalDestinationGrant | undefined,
      context: Readonly<EgressBinding>,
      destination: CanonicalDestination
    ): number {
      const grant = handle && issued.get(handle);
      const current = time();
      if (
        !grant ||
        current < grant.issuedAt ||
        current >= grant.expiresAt ||
        grant.destination.origin !== destination.origin ||
        (Object.keys(grant.binding) as (keyof EgressBinding)[]).some(
          (key) => grant.binding[key] !== context[key]
        )
      )
        throw new EgressPolicyError('GRANT_REFUSED');
      return grant.expiresAt;
    },
    revoke(handle: LocalDestinationGrant): void {
      issued.delete(handle);
    },
  };
}
