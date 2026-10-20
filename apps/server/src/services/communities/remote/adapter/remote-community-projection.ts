/**
 * Project the Community wire's channels and entries onto the portable `CommunityAdapter` DTOs for
 * {@link RemoteCommunityAdapter}, keeping the Community's own metadata (sequence, author, origin
 * key, the newest counted reply, a room's visibility) beside each DTO in weak maps rather than on
 * it, so the portable shape never widens.
 *
 * @module services/communities/remote/adapter/remote-community-projection
 */
import type {
  CommunityAttachment,
  CommunityCursor,
  CommunityEntry,
  CommunityMember,
  CommunityRef,
  CommunityRoom,
} from '@dorkos/shared/community-adapter';
import type { CommunityWireAgent, CommunityWireMember } from '@dorkos/shared/community-wire';
import type { RemoteCommunityMember } from '@dorkos/shared/community-views';

const remoteSequences = new WeakMap<CommunityEntry, number>();
const remoteAuthorMetadata = new WeakMap<
  CommunityEntry,
  Readonly<{ displayName: string; kind: 'human' | 'agent' }>
>();
const remoteOriginIdempotencyKeys = new WeakMap<CommunityEntry, string>();
const remoteThreadReplySeqs = new WeakMap<CommunityEntry, number>();
const remoteRoomMetadata = new WeakMap<
  CommunityRoom,
  Readonly<{ visibility: 'public' | 'private'; joined: boolean }>
>();

/**
 * Read the authoritative Community-server sequence retained for a native projected entry.
 *
 * This is adapter-private metadata for the local cache importer. It deliberately
 * does not widen the portable {@link CommunityEntry} DTO, decode an opaque cursor,
 * or retain entries after their consumers release them.
 *
 * @param projected - An entry returned by this native remote adapter.
 * @returns The server sequence, or `undefined` for an entry not projected here.
 * @internal
 */
export function remoteSequenceOf(projected: CommunityEntry): number | undefined {
  return remoteSequences.get(projected);
}

/** Read immutable server-supplied author metadata retained for native cache import. */
export function remoteAuthorOf(
  projected: CommunityEntry
): Readonly<{ displayName: string; kind: 'human' | 'agent' }> | undefined {
  return remoteAuthorMetadata.get(projected);
}

/** Read an owner-authorized native agent-post correlation key retained outside the portable DTO. */
export function remoteOriginIdempotencyKeyOf(projected: CommunityEntry): string | undefined {
  return remoteOriginIdempotencyKeys.get(projected);
}

/**
 * Read the server sequence of the newest reply a projected root's `thread`
 * summary counted. A reply seen later with a higher sequence is not in that
 * count, which is how a reader adds live replies without counting one twice.
 *
 * @param projected - A thread root returned by {@link RemoteCommunityAdapter.listEntriesWithThreadRoot}.
 * @returns The sequence, or `undefined` when the root carries no summary.
 * @internal
 */
export function remoteThreadReplySeqOf(projected: CommunityEntry): number | undefined {
  return remoteThreadReplySeqs.get(projected);
}

/** Read private native visibility and joined state for a projected remote room. */
export function remoteRoomAccessOf(
  projected: CommunityRoom
): Readonly<{ visibility: 'public' | 'private'; joined: boolean }> | undefined {
  return remoteRoomMetadata.get(projected);
}

/**
 * Remember the server sequence of the newest reply a root's `thread` summary counted.
 *
 * @param root - The projected thread root.
 * @param seq - The newest counted reply's sequence.
 */
export function rememberThreadReplySeq(root: CommunityEntry, seq: number): void {
  remoteThreadReplySeqs.set(root, seq);
}

/** Map one remote wire channel to the portable room contract. */
export function room(
  community: CommunityRef,
  value: {
    id: string;
    name: string;
    description: string | null;
    archived: boolean;
    createdAt: string;
    unreadCount: number;
    visibility: 'public' | 'private';
    joined: boolean;
  }
): CommunityRoom {
  const projected: CommunityRoom = {
    community,
    roomId: value.id,
    kind: 'channel',
    title: value.name,
    slug: null,
    topic: value.description,
    archived: value.archived,
    createdAt: value.createdAt,
    lastActivityAt: value.createdAt,
    unreadCount: value.unreadCount,
  };
  remoteRoomMetadata.set(projected, { visibility: value.visibility, joined: value.joined });
  return projected;
}

/** Map a server entry while preserving the distinct history and resume cursors. */
export function entry(
  community: CommunityRef,
  value: {
    id: string;
    channelId: string;
    seq: number;
    authorMemberId: string;
    authorDisplayName: string;
    authorKind: 'human' | 'agent';
    text: string;
    mentions: string[];
    parentEntryId: string | null;
    threadRootEntryId: string | null;
    cursor: string;
    createdAt: string;
    attachments: Array<{
      id: string;
      name: string;
      contentType: string;
      byteSize: number;
      checksum: string;
    }>;
    originIdempotencyKey?: string;
  }
): CommunityEntry {
  const projected: CommunityEntry = {
    community,
    roomId: value.channelId,
    id: value.id,
    authorId: value.authorMemberId,
    text: value.text,
    mentions: value.mentions,
    parentEntryId: value.parentEntryId,
    threadRootEntryId: value.threadRootEntryId,
    depth: value.parentEntryId ? 1 : 0,
    cursor: value.cursor as CommunityCursor,
    createdAt: value.createdAt,
    attachments: value.attachments.map(portableAttachment),
  };
  remoteSequences.set(projected, value.seq);
  remoteAuthorMetadata.set(projected, {
    displayName: value.authorDisplayName,
    kind: value.authorKind,
  });
  if (value.originIdempotencyKey)
    remoteOriginIdempotencyKeys.set(projected, value.originIdempotencyKey);
  return projected;
}

/** Remove Community-wire-only attachment metadata before returning the portable adapter DTO. */
export function portableAttachment(value: {
  id: string;
  name: string;
  contentType: string;
  byteSize: number;
  checksum: string;
}): CommunityAttachment {
  return {
    id: value.id,
    name: value.name,
    contentType: value.contentType,
    byteSize: value.byteSize,
    checksum: value.checksum,
  };
}

/**
 * Project one enrolled agent onto the portable member shape. An agent is in no room yet when it
 * is enrolled, so it has no role, and `joinedAt` is when this app read it.
 *
 * @param community - The local connection ref.
 * @param agent - The agent as the Community answered it.
 */
export function agentMember(
  community: CommunityRef,
  agent: Pick<CommunityWireAgent, 'memberId' | 'displayName' | 'handle' | 'ownerMemberId'>
): CommunityMember {
  return {
    community,
    memberId: agent.memberId,
    kind: 'agent',
    displayName: agent.displayName,
    handle: agent.handle,
    role: null,
    ownerMemberId: agent.ownerMemberId,
    joinedAt: new Date().toISOString(),
  };
}

/**
 * Project one channel roster row. An agent's availability is kept only when the space sent it,
 * which it does only when asked (DOR-2878), so a row from an older space has none.
 *
 * @param community - The local connection ref.
 * @param item - The row as the Community answered it.
 */
export function rosterMember(
  community: CommunityRef,
  item: CommunityWireMember
): RemoteCommunityMember {
  return {
    community,
    memberId: item.memberId,
    kind: item.kind,
    displayName: item.displayName,
    handle: item.handle,
    role: item.role,
    ownerMemberId: item.ownerMemberId,
    joinedAt: item.joinedAt,
    ...(item.availability
      ? { availability: item.availability, lastSeenAt: item.lastSeenAt, runsOn: item.runsOn }
      : {}),
  };
}
