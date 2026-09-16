/**
 * Browser-safe local connection API. These schemas deliberately have no
 * verifier, one-time code, bearer or encrypted credential reference. Private
 * server-to-server pairing responses live in `community-private-wire`.
 *
 * @module shared/community-connections
 */
import { z } from 'zod';
import { CommunityRefSchema } from './community-adapter.js';

/** A connected or pending community visible to its local install owner. */
export const CommunityConnectionDescriptorSchema = z.strictObject({
  ref: CommunityRefSchema,
  remoteCommunityId: z.string().min(1),
  label: z.string().min(1),
  pinnedOrigin: z.url(),
  connectedHumanMemberId: z.string().min(1).nullable(),
  status: z.enum(['pending', 'connected']),
  expiresAt: z.iso.datetime().nullable(),
});
/** Browser-safe connection descriptor. */
export type CommunityConnectionDescriptor = z.infer<typeof CommunityConnectionDescriptorSchema>;

/** The operator's requested deployment URL and this install's display name. */
export const CommunityConnectionStartRequestSchema = z.strictObject({
  url: z.url(),
  installName: z.string().trim().min(1).max(120),
});
/** Pairing starts with a URL opened on the remote community's own origin. */
export const CommunityConnectionStartResponseSchema = z.strictObject({
  connection: CommunityConnectionDescriptorSchema,
  approvalUrl: z.url(),
});
/** List only the authenticated local owner's connections. */
export const CommunityConnectionListResponseSchema = z.strictObject({
  connections: z.array(CommunityConnectionDescriptorSchema),
});
/** Single connection status. */
export const CommunityConnectionStatusResponseSchema = z.strictObject({
  connection: CommunityConnectionDescriptorSchema,
});
/** A poll can complete, remain pending, expire, or be cancelled. */
export const CommunityConnectionPollResponseSchema = z.strictObject({
  connection: CommunityConnectionDescriptorSchema.nullable(),
  status: z.enum(['pending', 'connected', 'expired', 'cancelled']),
});
