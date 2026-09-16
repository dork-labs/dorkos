/**
 * One-time credential delivery schemas for server-to-server calls. Do not
 * import this subpath into the community browser, local client or Transport.
 * Responses must use `Cache-Control: no-store` and never enter logs or errors.
 *
 * @module shared/community-private-wire
 */
import { z } from 'zod';
import { CommunityWireAgentSchema, CommunityWireGrantSchema } from './community-wire.js';

/** A verifier-bound poll result consumed only by the requesting local server. */
export const CommunityPairingPollPrivateResponseSchema = z.strictObject({
  status: z.enum(['pending', 'approved', 'expired', 'cancelled', 'redeemed']),
  code: z.string().min(1).optional(),
});
/** One-time personal bearer delivered directly to the local credential store. */
export const CommunityPairingExchangeSecretResponseSchema = z.strictObject({
  token: z.string().min(1),
  grant: CommunityWireGrantSchema,
});
/** One-time agent bearer delivered directly to the local credential store. */
export const CommunityAgentEnrollmentSecretResponseSchema = z.strictObject({
  token: z.string().min(1),
  agent: CommunityWireAgentSchema,
});
