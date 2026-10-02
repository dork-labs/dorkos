import { z } from 'zod';
import type { EgressBinding } from '../settings.js';
import { sameBinding, type AuthorityObservation, type InventoryObservation } from './authority.js';
import { BrokerError } from './errors.js';
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const authority = z
  .object({
    binding: z
      .object({ ownerId: id, workspaceId: id, browserId: id, browserGeneration: integer })
      .strict(),
    ownerExists: z.literal(true),
    retainedRun: z.literal(true),
    grantsCurrent: z.literal(true),
    custodyKnown: z.literal(true),
    runtimePolicyKnown: z.literal(true),
    runtimeIdentity: z.string().min(1).max(128),
    authorizationEpoch: integer,
    policyRevision: integer,
    inventoryRevision: integer,
    monotonicNow: integer,
    utcNow: integer,
    utcExpiresAt: integer,
  })
  .strict();
const inventory = z
  .object({
    revision: integer,
    publicAuthoritiesKnown: z.literal(true),
    localCoverageComplete: z.boolean(),
    validUntil: integer,
    protectedEndpoints: z
      .array(
        z
          .object({
            address: z.enum(['127.0.0.1', '::1']),
            port: z.number().int().min(1).max(65535),
          })
          .strict()
      )
      .max(256),
    declaredInstances: z.array(id).max(64),
    coveredInstances: z.array(id).max(64),
  })
  .strict();
/** Snapshot fixed current-authority fields; malformed producer output grants nothing. */
export function authoritySnapshot(
  raw: unknown,
  context: EgressBinding,
  now: number
): AuthorityObservation {
  const parsed = authority.safeParse(raw);
  if (
    !parsed.success ||
    !sameBinding(parsed.data.binding, context) ||
    parsed.data.monotonicNow > now ||
    parsed.data.utcExpiresAt <= parsed.data.utcNow
  )
    throw new BrokerError('AUTHORITY_REFUSED');
  return Object.freeze({ ...parsed.data, binding: Object.freeze(parsed.data.binding) });
}
/** Only a trusted producer establishes completeness; the schema cannot create that evidence. */
export function inventorySnapshot(raw: unknown, now: number): InventoryObservation {
  const parsed = inventory.safeParse(raw);
  if (
    !parsed.success ||
    parsed.data.validUntil <= now ||
    parsed.data.declaredInstances.some((id) => !parsed.data.coveredInstances.includes(id))
  )
    throw new BrokerError('AUTHORITY_REFUSED');
  const i = parsed.data;
  return Object.freeze({
    ...i,
    declaredInstances: Object.freeze(i.declaredInstances),
    coveredInstances: Object.freeze(i.coveredInstances),
    protectedEndpoints: Object.freeze(i.protectedEndpoints.map((e) => Object.freeze(e))),
  });
}
