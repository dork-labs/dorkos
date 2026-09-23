/**
 * Browser-safe local connection API. These schemas deliberately have no
 * verifier, one-time code, bearer or encrypted credential reference. Private
 * server-to-server pairing responses live in `community-private-wire`.
 *
 * @module shared/community-connections
 */
import { z } from 'zod';
import { CommunityRefSchema } from './community-adapter.js';
import type {
  CommunityNavigationMoveRequest,
  CommunityNavigationState,
} from './community-navigation.js';
import type { CommunityNavigationDestination } from './config-schema.js';
import type { CommunityInstallationDestination } from './config-schema.js';
import { CommunityConnectionAccessSchema } from './community-wire.js';

/**
 * Activity state for one owner-scoped Community connection. A number is only
 * present when it came from a current authorized Community response.
 */
export const CommunityConnectionAttentionSchema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.enum(['verified', 'stale']),
    unreadCount: z.number().int().nonnegative(),
    mentionCount: z.number().int().nonnegative(),
    verifiedAt: z.iso.datetime(),
  }),
  z.strictObject({
    state: z.literal('unavailable'),
    unreadCount: z.null(),
    mentionCount: z.null(),
    verifiedAt: z.null(),
  }),
]);
/** Owner-safe aggregate activity for one Community connection. */
export type CommunityConnectionAttention = z.infer<typeof CommunityConnectionAttentionSchema>;

/** A community connection visible to its local install owner. */
export const CommunityConnectionDescriptorSchema = z
  .strictObject({
    ref: CommunityRefSchema,
    remoteCommunityId: z.string().min(1),
    label: z.string().min(1),
    pinnedOrigin: z.url(),
    connectedHumanMemberId: z.string().min(1).nullable(),
    status: z.enum(['pending', 'connected', 'reconnect-required']),
    expiresAt: z.iso.datetime().nullable(),
    access: CommunityConnectionAccessSchema.nullable(),
    attention: CommunityConnectionAttentionSchema.nullable(),
  })
  .superRefine((connection, context) => {
    if (connection.status === 'pending' && connection.access !== null) {
      context.addIssue({ code: 'custom', message: 'Pending connections cannot have access.' });
    }
    if (connection.status !== 'pending' && connection.access === null) {
      context.addIssue({ code: 'custom', message: 'Established connections require access.' });
    }
    if (connection.status === 'pending' && connection.attention !== null) {
      context.addIssue({ code: 'custom', message: 'Pending connections cannot have attention.' });
    }
    if (connection.status !== 'pending' && connection.attention === null) {
      context.addIssue({
        code: 'custom',
        message: 'Established connections require attention state.',
      });
    }
    if (
      connection.attention?.state !== 'unavailable' &&
      connection.attention !== null &&
      connection.attention.mentionCount > connection.attention.unreadCount
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Mentions must be a subset of unread activity.',
      });
    }
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

/**
 * The outcome of disconnecting this install. The local credential is always
 * removed; `remoteRevoked` is false only when the Community could not be told
 * to end this install's access, so the person can end it there themselves.
 */
export const CommunityDisconnectResponseSchema = z.strictObject({
  remoteRevoked: z.boolean(),
});

/** Inputs for connecting this install to a community. */
export type CommunityConnectionStartRequest = z.infer<typeof CommunityConnectionStartRequestSchema>;
/** Public approval URL and the pending local connection. */
export type CommunityConnectionStartResponse = z.infer<
  typeof CommunityConnectionStartResponseSchema
>;
/** The outcome of disconnecting this install from a community. */
export type CommunityDisconnectResponse = z.infer<typeof CommunityDisconnectResponseSchema>;
/** Public outcome of polling browser approval. */
export type CommunityConnectionPollResponse = z.infer<typeof CommunityConnectionPollResponseSchema>;

/** Owner-scoped community connection operations over the local server only. */
export interface CommunityConnectionTransport {
  /** List this install owner's pending, connected and reconnect-required communities. */
  listCommunityConnections(): Promise<CommunityConnectionDescriptor[]>;
  /** Begin browser approval without returning the installation's verifier or bearer. */
  startCommunityConnection(
    input: CommunityConnectionStartRequest
  ): Promise<CommunityConnectionStartResponse>;
  /** Read one owner-scoped local connection. */
  getCommunityConnection(ref: string): Promise<CommunityConnectionDescriptor>;
  /** Exchange a completed approval on the local server; return only its public outcome. */
  pollCommunityConnection(ref: string): Promise<CommunityConnectionPollResponse>;
  /** Cancel an outstanding approval and erase the pending local proof. */
  cancelCommunityConnection(ref: string): Promise<void>;
  /**
   * Disconnect this installation: end its access on the community, then discard
   * its local credentials and cached content. Resolves with whether the
   * community confirmed the access is gone.
   */
  disconnectCommunity(ref: string): Promise<CommunityDisconnectResponse>;
  /** Read and reconcile this owner's saved Community order and destinations. */
  getCommunityNavigation(): Promise<CommunityNavigationState>;
  /** Remember the last canonical route visited inside this owner's local installation. */
  rememberCommunityInstallationDestination(
    destination: CommunityInstallationDestination
  ): Promise<CommunityNavigationState>;
  /** Move one Community by one position without replacing the whole saved order. */
  moveCommunityNavigation(input: CommunityNavigationMoveRequest): Promise<CommunityNavigationState>;
  /** Remember the latest authorized room, thread and scroll anchor for one Community. */
  rememberCommunityNavigation(
    destination: CommunityNavigationDestination
  ): Promise<CommunityNavigationState>;
  /** Return a remembered destination only when the owner can still read its room. */
  resolveCommunityNavigation(ref: string): Promise<CommunityNavigationDestination | null>;
}
