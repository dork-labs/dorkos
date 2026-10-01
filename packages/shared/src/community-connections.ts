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
import {
  CommunityConnectionAccessSchema,
  CommunityWireOwnerReplacementOptionsSchema,
} from './community-wire.js';
import { CommunityAdminOwnerReplacementOpenStateSchema } from './community-admin-wire.js';

/**
 * Activity state for one owner-scoped Community connection. A number is only
 * present when it came from an authorized Community response: `verified`
 * counts answered this read, `stale` counts are the last ones the Community
 * confirmed (at `verifiedAt`) when it did not answer in time this read, and
 * `unavailable` means it has not confirmed any since the connection was last
 * readable.
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

/**
 * What the owner of a community is told, on their own DorkOS connection, about a request to
 * make someone else its owner. Only ever present for the community's owner: an admin or member
 * connection never carries it.
 *
 * `open` is a request still running: the date it can complete (`null` until the owner's notice
 * has resolved), when the link for the new owner was sent again, and only the options this owner
 * has now. `completed` is that same request, now finished: the Community stopped showing it as
 * open and says someone else became the owner after it was asked. Both carry the request's id,
 * so the app tells the owner about each once.
 */
export const CommunityConnectionOwnerNoticeSchema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('open'),
    replacementId: z.string().min(1),
    /** Where the request stands: `claimable` means it can complete at any time now. */
    requestState: CommunityAdminOwnerReplacementOpenStateSchema,
    requestedAt: z.iso.datetime(),
    /** The earliest the new owner can take over; `null` until the owner's notice resolves. */
    claimableAfter: z.iso.datetime().nullable(),
    /** When the host sent the link for the new owner again, if it did. */
    claimReissuedAt: z.iso.datetime().nullable(),
    options: CommunityWireOwnerReplacementOptionsSchema,
  }),
  z.strictObject({
    state: z.literal('completed'),
    replacementId: z.string().min(1),
    newOwnerDisplayName: z.string().min(1),
    completedAt: z.iso.datetime(),
  }),
]);
/** An owner's notice about a request to replace them, as their DorkOS connection carries it. */
export type CommunityConnectionOwnerNotice = z.infer<typeof CommunityConnectionOwnerNoticeSchema>;

/** How long a Community must keep answering "not found" before it seems to be gone: 14 days. */
export const COMMUNITY_SEEMS_GONE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

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
    /**
     * `true` when the host just confirmed that the account behind this
     * connection runs the host, so the app may offer the host's own "create a
     * community" page. Absent means no: the host did not say, is too old to
     * say, or could not be reached. It opens a page and grants nothing; that
     * page checks host authority again.
     */
    hostOperator: z.boolean().optional(),
    /**
     * When the Community first answered that this community does not exist, present only once
     * it has kept saying so for {@link COMMUNITY_SEEMS_GONE_AFTER_MS} (DOR-2334). It "seems to
     * be gone": the app offers to remove the local copy, and never removes it on its own — a
     * missing community and a misconfigured host look the same from here.
     */
    seemsGoneSince: z.iso.datetime().optional(),
    /**
     * How many of this owner's agent posts never arrived when the Community was found deleted or
     * taken down: still waiting, or failed, counted just before DorkOS removed its copy
     * (DOR-2575). Present only on a deleted, deleting or taken-down community, and only when
     * there were some; the app says so, since the rooms those posts belonged to are gone.
     */
    undeliveredAgentMessages: z.number().int().positive().optional(),
    /**
     * A request to make someone else this community's owner, present only on the owner's own
     * connection, and only from a Community answer that is recent: this read's, or one that
     * landed in the last minute or so when this read could not wait for it (DOR-2543). A
     * Community that stays slow or offline shows no notice rather than an old one.
     */
    ownerNotice: CommunityConnectionOwnerNoticeSchema.optional(),
  })
  .superRefine((connection, context) => {
    if (
      connection.hostOperator &&
      (connection.status !== 'connected' || connection.access?.state !== 'verified')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Only a verified connection can report host authority.',
      });
    }
    if (
      connection.ownerNotice &&
      (connection.status !== 'connected' || connection.access?.state !== 'verified')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Only a verified connection can carry an owner notice.',
      });
    }
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
 * One agent this install added to a Community, named as this app knows it. Only
 * agents added from this install appear.
 */
export const CommunityInstallationAgentSchema = z.strictObject({
  /** The local agent's manifest id. */
  localAgentId: z.string().min(1),
  /** The agent's name in this app, or `null` when this app no longer has the agent. */
  displayName: z.string().min(1).nullable(),
});

/**
 * What disconnecting this install would take off the Community, read from this
 * install's own records without asking the Community, so the confirmation can
 * say it even when the Community cannot be reached.
 */
export const CommunityDisconnectImpactSchema = z.strictObject({
  /** The agents this install added, which disconnecting removes from the Community. */
  agents: z.array(CommunityInstallationAgentSchema),
});

/**
 * The outcome of disconnecting this install. The local credential is always
 * removed; `remoteRevoked` is false only when the Community could not be told
 * to end this install's access, so the person can end it there themselves.
 * Disconnecting also removes the agents this install added to the Community;
 * `agentsNotRemoved` lists the ones it could not remove, which are still on
 * the Community until the person removes them there.
 */
export const CommunityDisconnectResponseSchema = z.strictObject({
  remoteRevoked: z.boolean(),
  agentsNotRemoved: z.array(CommunityInstallationAgentSchema),
});

/** Inputs for connecting this install to a community. */
export type CommunityConnectionStartRequest = z.infer<typeof CommunityConnectionStartRequestSchema>;
/** Public approval URL and the pending local connection. */
export type CommunityConnectionStartResponse = z.infer<
  typeof CommunityConnectionStartResponseSchema
>;
/** The outcome of disconnecting this install from a community. */
export type CommunityDisconnectResponse = z.infer<typeof CommunityDisconnectResponseSchema>;
/** One agent this install added to a community. */
export type CommunityInstallationAgent = z.infer<typeof CommunityInstallationAgentSchema>;
/** What disconnecting this install would take off a community. */
export type CommunityDisconnectImpact = z.infer<typeof CommunityDisconnectImpactSchema>;
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
   * Disconnect this installation: remove the agents it added to the community,
   * end its access there, then discard its local credentials and cached
   * content. Resolves with whether the community confirmed the access is gone
   * and which agents it could not remove.
   */
  disconnectCommunity(ref: string): Promise<CommunityDisconnectResponse>;
  /**
   * Read what disconnecting would take off the community: the agents this
   * installation added there. Answered from local records, so it works while
   * the community cannot be reached.
   */
  getCommunityDisconnectImpact(ref: string): Promise<CommunityDisconnectImpact>;
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

/**
 * Say how long to wait before trying a Community again, from the wait it named in `Retry-After`.
 *
 * Whole seconds under a minute, rounded-up minutes past it, and "a minute" when no usable wait
 * was given. The server's `COMMUNITY_RATE_LIMITED` text and the connect dialog both use it, so
 * the two never disagree.
 *
 * @param seconds - The wait in whole seconds, or anything else when none is known.
 * @returns A phrase to follow "Wait", such as "17 seconds" or "2 minutes".
 */
export function describeCommunityRetryWait(seconds: unknown): string {
  if (typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds < 1) return 'a minute';
  if (seconds < 60) return seconds === 1 ? '1 second' : `${seconds} seconds`;
  const minutes = Math.ceil(seconds / 60);
  return minutes === 1 ? 'a minute' : `${minutes} minutes`;
}
