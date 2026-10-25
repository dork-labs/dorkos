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
    /**
     * It accepts the `administer` pairing scope (DOR-3005): an owner or admin who ticks the consent
     * line on the approval page gives the app a separate credential that manages the space. An app
     * asks for the scope only when this is `true`; an older space would refuse the whole request.
     */
    administer: z.boolean().optional(),
  }),
});
/** What a space's server understands beyond the version 1 contract. */
export type CommunityWireSpaceFeaturesResponse = z.infer<
  typeof CommunityWireSpaceFeaturesResponseSchema
>;

/**
 * What a pairing request may ask for. `administer` (DOR-3005) is never one of a connection grant's
 * own scopes: an owner or admin who consents gets it as a separate credential, beside the grant,
 * that only the person's own app may use to manage the space. A member's approval drops it. Ask
 * for it only from a space whose features say `administer: true`.
 */
export const CommunityWirePairingScopeSchema = z.enum([
  'read',
  'post',
  'enroll-agent',
  'administer',
]);
/** One scope a pairing request may ask for. */
export type CommunityWirePairingScope = z.infer<typeof CommunityWirePairingScopeSchema>;

/**
 * Human approval acts on a pending request through their authenticated session. `administer` is
 * the owner's or admin's consent to the `administer` scope the request asked for; without it, or
 * from a member, the connection is made without that scope. Consenting takes the person's
 * current `password`: a click in a signed-in browser is not proof a person made it.
 */
export const CommunityWirePairingApproveRequestSchema = z.strictObject({
  pairingId: z.string().min(1),
  administer: z.boolean().optional(),
  password: z.string().min(1).max(128).optional(),
});
