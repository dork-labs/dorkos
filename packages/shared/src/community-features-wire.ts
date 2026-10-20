/**
 * What a space's server understands beyond the version 1 contract. Re-exported whole by
 * `community-wire.ts`, so callers import it from there like the rest of the wire.
 *
 * @module shared/community-features-wire
 */
import { z } from 'zod';

/**
 * What this space's server understands beyond the version 1 contract, read with
 * `GET /api/v1/features` (tenant-qualified too; no credential needed). An app asks beside its
 * connection-access check and acts on a feature only when it is `true`; a space from before
 * this read answers 404, which means none. A separate read rather than a field on a response an
 * app already parses, because those are strict: an installed app would reject the whole answer.
 *
 * Not strict, so a later space can add a feature without breaking apps built now.
 */
export const CommunityWireSpaceFeaturesResponseSchema = z.object({
  features: z.object({
    /** It records `POST /api/v1/agents/availability` and shows agents as available or offline. */
    agentAvailability: z.boolean().optional(),
    /** It holds direct messages with an agent: `GET`/`POST /api/v1/dms` (DOR-2955). */
    agentDms: z.boolean().optional(),
  }),
});
/** What a space's server understands beyond the version 1 contract. */
export type CommunityWireSpaceFeaturesResponse = z.infer<
  typeof CommunityWireSpaceFeaturesResponseSchema
>;
