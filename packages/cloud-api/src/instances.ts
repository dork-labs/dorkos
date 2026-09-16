import { z } from 'zod';

import { IdSchema, TimestampSchema, pageOf } from './primitives.js';

/** One machine registered against an account or organization. */
export const InstanceSchema = z
  .object({
    id: IdSchema,
    orgId: IdSchema.nullable().describe('The organization this instance is linked to, or null.'),
    displayName: z.string().describe('The name a person gave this machine.'),
    appVersion: z.string().describe('The DorkOS version the instance last reported.'),
    platform: z.string().describe('The operating system the instance last reported.'),
    firstSeenAt: TimestampSchema,
    lastSeenAt: TimestampSchema,
    revokedAt: TimestampSchema.nullable().describe('When this instance was revoked, or null.'),
  })
  .describe('One machine registered against an account or organization.');

/** One machine registered against an account or organization. */
export type Instance = z.infer<typeof InstanceSchema>;

/** `POST /v1/instances/heartbeat` — an instance reporting that it is alive. */
export const InstanceHeartbeatRequestSchema = z
  .object({
    instanceId: IdSchema,
    appVersion: z.string(),
    platform: z.string(),
    displayName: z.string().optional(),
  })
  .describe('An instance reporting that it is alive and what it is running.');

/** The acknowledgement of a heartbeat. */
export const InstanceHeartbeatResponseSchema = z
  .object({
    acknowledgedAt: TimestampSchema,
    nextHeartbeatAfterMs: z
      .number()
      .int()
      .positive()
      .describe('How long the instance should wait before its next heartbeat.'),
    revoked: z
      .boolean()
      .describe(
        'True when this instance has been revoked and should stop and clear its credentials.'
      ),
  })
  .describe('The acknowledgement of a heartbeat, carrying the next interval and any revocation.');

/**
 * `POST /v1/instances/revoke` — cut a machine off.
 *
 * Revoking an instance also revokes that instance's tunnel credential, so a
 * revoked machine cannot keep serving on an address this service issued. Same
 * request, same response: the extra effect is behaviour, not a new field.
 */
export const InstanceRevokeRequestSchema = z
  .object({
    instanceId: IdSchema,
  })
  .describe(
    'Cut a machine off. Also revokes that instance`s tunnel credential, so it cannot keep serving on an issued address.'
  );

/** The result of a revocation. */
export const InstanceRevokeResponseSchema = z
  .object({
    revokedAt: TimestampSchema,
  })
  .describe('When the revocation took effect.');

/** `POST /v1/instances/{instanceId}/org` — move an instance to another organization. */
export const InstanceRelinkRequestSchema = z
  .object({
    orgId: IdSchema.nullable().describe('The organization to link to, or null to unlink.'),
  })
  .describe('Move an instance to another organization, or detach it from all of them.');

/** `GET /v1/instances` — the caller`s registered machines. */
export const InstanceListResponseSchema = pageOf(
  InstanceSchema,
  'A page of the machines the caller can see.'
);
