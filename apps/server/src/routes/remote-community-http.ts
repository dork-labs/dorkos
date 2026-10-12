/**
 * What every `/api/communities` route shares: who is asking and about which space, the check
 * that the owner's connection is verified and allows the action, the browser-safe shapes of a
 * remote room and entry, and the refusal a failure answers with.
 *
 * @module routes/remote-community-http
 */
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  CommunityRefSchema,
  type CommunityEntry,
  type CommunityRef,
  type CommunityRoom,
} from '@dorkos/shared/community-adapter';
import type { CommunityConnectionDescriptor } from '@dorkos/shared/community-connections';
import type { ApiEnv } from '../http/api-chain.js';
import { resolveCommunityOwner } from './community-connections.js';
import {
  getRemoteCommunityOriginIdempotencyKey,
  getRemotePairingService,
} from '../services/communities/remote/state.js';
import {
  remoteAuthorOf,
  remoteOriginIdempotencyKeyOf,
  remoteRoomAccessOf,
  remoteSequenceOf,
  remoteThreadReplySeqOf,
} from '../services/communities/remote/remote-community-adapter.js';
import {
  RemoteConnectionAuthorizationError,
  RemoteConnectionNotFoundError,
} from '../services/communities/remote/connection-store.js';
import {
  communityGoneRefusal,
  communityRefusal,
  type CommunityRefusal,
  type CommunityRefusalAction,
} from './remote-community-refusal.js';

/** What a route needs before it acts: the install's owner, and the space it names. */
export interface CommunityTarget {
  /** The owner's local author id. */
  owner: string;
  /** The connection the request names. */
  ref: CommunityRef;
}

/**
 * The owner and the space a request is about, or the refusal to answer with: the owner's bars
 * first, then a ref that is not path-safe, which answers as one that names no connection.
 *
 * @param c - The request's context.
 */
export function communityTarget(c: Context<ApiEnv>): CommunityTarget | Response {
  const owner = resolveCommunityOwner(c);
  if (typeof owner !== 'string') return owner;
  const ref = CommunityRefSchema.safeParse(c.req.param('ref'));
  if (!ref.success) return c.json({ error: 'Space connection not found.' }, 404);
  return { owner, ref: ref.data };
}

/** The connection allows reading but not this action. */
class RemoteConnectionCapabilityError extends Error {
  constructor() {
    super('This space connection does not allow that action.');
    this.name = 'RemoteConnectionCapabilityError';
  }
}

/**
 * The connection's community was recorded deleted or taken down, so it has no capabilities left.
 * Answered as the gone refusal the Community itself gives, never as "not allowed": the app puts a
 * person's refused message back in their draft on exactly these codes (DOR-2575).
 */
class RemoteCommunityGoneError extends Error {
  constructor(readonly refusal: CommunityRefusal) {
    super(refusal.error);
    this.name = 'RemoteCommunityGoneError';
  }
}

/**
 * Answer a failure with the space's refusal in plain words, without exposing adapter or
 * credential state.
 *
 * @param c - The request's context.
 * @param error - What was thrown.
 * @param action - What the person tried, for a refusal worded about it.
 */
export function communityFailure(
  c: Context,
  error: unknown,
  action?: CommunityRefusalAction
): Response {
  if (error instanceof RemoteCommunityGoneError) {
    return c.json(
      { code: error.refusal.code, error: error.refusal.error },
      error.refusal.status as ContentfulStatusCode
    );
  }
  if (error instanceof RemoteConnectionCapabilityError) {
    return c.json({ code: 'COMMUNITY_ACCESS_DENIED', error: error.message }, 403);
  }
  if (error instanceof RemoteConnectionAuthorizationError) {
    return c.json(
      { code: 'COMMUNITY_RECONNECT_REQUIRED', error: 'Reconnect this space to continue.' },
      409
    );
  }
  if (error instanceof RemoteConnectionNotFoundError) {
    return c.json({ error: 'Space connection not found.' }, 404);
  }
  const refusal = communityRefusal(error, action);
  if (refusal) {
    if (refusal.retryAfterSeconds) c.header('Retry-After', String(refusal.retryAfterSeconds));
    return c.json(
      { code: refusal.code, error: refusal.error },
      refusal.status as ContentfulStatusCode
    );
  }
  return c.json({ error: 'Space unavailable.' }, 502);
}

/**
 * Refuse unless the owner's connection is verified, its community is not gone, and it grants
 * `capability`.
 *
 * @param ref - The connection.
 * @param owner - The owner's local author id.
 * @param capability - What the route is about to do.
 * @returns The connection.
 */
export async function verifiedConnection(
  ref: CommunityRef,
  owner: string,
  capability: 'read' | 'post' | 'enrollAgent' | 'stream'
) {
  const connection = await getRemotePairingService().status(ref, owner);
  if (connection.status === 'reconnect-required') throw new RemoteConnectionAuthorizationError();
  const gone = communityGoneRefusal(connection.access?.lastKnown?.lifecycle);
  if (gone) throw new RemoteCommunityGoneError(gone);
  if (!connection.access || connection.access.state !== 'verified')
    throw new Error('Space unavailable');
  if (!connection.access.effective[capability]) throw new RemoteConnectionCapabilityError();
  return connection;
}

/**
 * A remote room as the browser sees it: what this connection may do in it.
 *
 * @param room - The room the adapter read.
 * @param remoteCommunityId - The community it belongs to.
 * @param connectionAccess - The connection's verified access.
 */
export function remoteRoom(
  room: CommunityRoom,
  remoteCommunityId: string,
  connectionAccess: NonNullable<CommunityConnectionDescriptor['access']>
) {
  const roomAccess = remoteRoomAccessOf(room);
  if (!roomAccess) throw new Error('Native remote room lost visibility metadata');
  return {
    ...room,
    remoteCommunityId,
    visibility: roomAccess.visibility,
    readable:
      connectionAccess.effective.read && (roomAccess.visibility === 'public' || roomAccess.joined),
    writable: connectionAccess.effective.post && roomAccess.joined && !room.archived,
    joined: roomAccess.joined,
    stale: false,
    cacheCursor: null,
    lastRemoteSeq: 0,
    access: connectionAccess,
  };
}

/**
 * A remote entry as the browser sees it, with its author and, for the owner's own agents, the
 * key that ties it to the post that sent it.
 *
 * @param entry - The entry the adapter read.
 * @param ownerAuthorId - The owner's local author id.
 */
export function remoteEntry(entry: CommunityEntry, ownerAuthorId?: string) {
  const seq = remoteSequenceOf(entry);
  const author = remoteAuthorOf(entry);
  if (seq === undefined || !author)
    throw new Error('Native remote entry lost authoritative metadata');
  const originIdempotencyKey =
    ownerAuthorId && author.kind === 'agent'
      ? (getRemoteCommunityOriginIdempotencyKey(
          entry.community,
          entry.roomId,
          ownerAuthorId,
          entry.id
        ) ?? remoteOriginIdempotencyKeyOf(entry))
      : null;
  const threadLastReplySeq = entry.thread ? remoteThreadReplySeqOf(entry) : undefined;
  return {
    ...entry,
    remoteSeq: seq,
    authorDisplayName: author.displayName,
    authorKind: author.kind,
    ...(originIdempotencyKey ? { originIdempotencyKey } : {}),
    ...(threadLastReplySeq === undefined ? {} : { threadLastReplySeq }),
  };
}
