/**
 * Owner-scoped remote community views served by the local DorkOS API.
 * Credentials and local mirror IDs never cross this boundary. Native sequence
 * metadata orders cached history without interpreting opaque resume cursors.
 * @module shared/community-views
 */
import { z } from 'zod';
import type { HaltRoomResponse } from './room-schemas.js';
import {
  CommunityWireEntryPostRequestSchema,
  CommunityWireHandleSchema,
} from './community-wire.js';
import {
  CommunityAttachmentSchema,
  CommunityCursorSchema,
  CommunityEntrySchema,
  CommunityMemberSchema,
  CommunityRefSchema,
  CommunityRoomSchema,
  RoomAddressSchema,
} from './community-adapter.js';

const id = z.string().min(1);
const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const attachment = CommunityAttachmentSchema.strict();

/** Current permission and cache state for one qualified remote room. */
export const RemoteCommunityRoomSchema = CommunityRoomSchema.extend({
  remoteCommunityId: id,
  visibility: z.enum(['public', 'private']),
  readable: z.boolean(),
  writable: z.boolean(),
  joined: z.boolean(),
  stale: z.boolean(),
  cacheCursor: CommunityCursorSchema.nullable(),
  lastRemoteSeq: sequence,
})
  .strict()
  .refine(
    (room) => !room.writable || (room.readable && room.joined && !room.stale && !room.archived),
    {
      message: 'Writing requires current joined membership in a readable, active room',
    }
  );
/** Current permissions, public room details and owner-only cache state. */
export type RemoteCommunityRoom = z.infer<typeof RemoteCommunityRoomSchema>;

/** A server-confirmed entry, including immutable author and native order metadata. */
export const RemoteCommunityEntrySchema = CommunityEntrySchema.extend({
  remoteSeq: sequence.min(1),
  authorDisplayName: z.string().min(1),
  authorKind: z.enum(['human', 'agent']),
  attachments: z.array(attachment).max(8),
}).strict();
/** Confirmed history; pending local output is a separate delivery state. */
export type RemoteCommunityEntry = z.infer<typeof RemoteCommunityEntrySchema>;

/** Discovery response for one configured community. */
export const RemoteCommunityRoomsResponseSchema = z
  .strictObject({
    community: CommunityRefSchema,
    rooms: z.array(RemoteCommunityRoomSchema),
    stale: z.boolean(),
  })
  .refine(
    (result) =>
      result.rooms.every(
        (room) => room.community === result.community && room.stale === result.stale
      ),
    { message: 'Rooms must belong to the requested community and freshness state' }
  );
/** Community-qualified discovery and freshness state. */
export type RemoteCommunityRoomsResponse = z.infer<typeof RemoteCommunityRoomsResponseSchema>;
/** One authorized remote room, without local runtime or administration fields. */
export const RemoteCommunityRoomResponseSchema = z.strictObject({
  room: RemoteCommunityRoomSchema,
});
/** Opaque history paging, optionally scoped to one top-level thread. */
export const RemoteCommunityHistoryQuerySchema = z.strictObject({
  cursor: CommunityCursorSchema.optional(),
  limit: z.number().int().min(1).max(100).optional(),
  threadRootId: id.optional(),
});
/** Options for history; sequence numbers are not accepted as resume tokens. */
export type RemoteCommunityHistoryQuery = z.infer<typeof RemoteCommunityHistoryQuerySchema>;
/** Authorized history in authoritative order; only nextCursor declares exhaustion. */
export const RemoteCommunityHistoryResponseSchema = RoomAddressSchema.extend({
  entries: z.array(RemoteCommunityEntrySchema).max(100),
  nextCursor: CommunityCursorSchema.nullable(),
  lastRemoteSeq: sequence,
  stale: z.boolean(),
})
  .strict()
  .refine((page) => validEntries(page.entries, page.community, page.roomId, page.lastRemoteSeq), {
    message: 'History must be qualified and ordered by unique remote sequence',
  });
/** One bounded page of confirmed remote history. */
export type RemoteCommunityHistoryResponse = z.infer<typeof RemoteCommunityHistoryResponseSchema>;
/** A browser post always acts as the connected human, never a selected remote identity. */
export const RemoteCommunityPostRequestSchema = CommunityWireEntryPostRequestSchema;
/** A stable retry key is generated once per user post. */
export type RemoteCommunityPostRequest = z.infer<typeof RemoteCommunityPostRequestSchema>;
/** Only a remote receipt yields a confirmed post. */
export const RemoteCommunityPostResponseSchema = z.strictObject({
  entry: RemoteCommunityEntrySchema,
});
/** The authorized room roster, including each agent's human owner. */
export const RemoteCommunityMembersResponseSchema = RoomAddressSchema.extend({
  members: z.array(CommunityMemberSchema.strict()),
  stale: z.boolean(),
})
  .strict()
  .refine((page) => page.members.every((member) => member.community === page.community), {
    message: 'Roster must belong to this community',
  });
/** Authoritative roster or explicitly stale owner cache. */
export type RemoteCommunityMembersResponse = z.infer<typeof RemoteCommunityMembersResponseSchema>;
/** Current human's read position; no arbitrary member can be selected. */
export const RemoteCommunityReadCursorSchema = z.strictObject({
  cursor: CommunityCursorSchema.nullable(),
  unreadCount: z.number().int().nonnegative(),
});
/** Read position and unread count supplied by the community. */
export type RemoteCommunityReadCursor = z.infer<typeof RemoteCommunityReadCursorSchema>;

/** Public enrollment identity, backed by an existing trusted local agent manifest. */
export const RemoteCommunityEnrollmentSchema = z.strictObject({
  community: CommunityRefSchema,
  localAgentId: id,
  remoteMemberId: id,
  displayName: z.string().min(1),
  ownerMemberId: id,
  ownerDisplayName: z.string().min(1),
  roomIds: z.array(id),
  active: z.boolean(),
});
/** Enrollment details without bearer, filesystem path or local runtime settings. */
export type RemoteCommunityEnrollment = z.infer<typeof RemoteCommunityEnrollmentSchema>;
/** Optional community handle; display name and local authority come from the local manifest. */
export const RemoteCommunityEnrollRequestSchema = z.strictObject({
  handle: CommunityWireHandleSchema.optional(),
});
/** A person may resolve a community handle collision without supplying runtime authority. */
export type RemoteCommunityEnrollRequest = z.infer<typeof RemoteCommunityEnrollRequestSchema>;
/** Owner-scoped enrollment listing. */
export const RemoteCommunityEnrollmentsResponseSchema = z
  .strictObject({
    community: CommunityRefSchema,
    agents: z.array(RemoteCommunityEnrollmentSchema),
  })
  .refine((result) => result.agents.every((agent) => agent.community === result.community), {
    message: 'Enrollments must belong to this community',
  });
/** Fresh usable identity after enrollment or explicit credential recovery. */
export const RemoteCommunityEnrollmentResponseSchema = z.strictObject({
  agent: RemoteCommunityEnrollmentSchema,
});
/** Local revocation succeeds independently of best-effort remote cleanup. */
export const RemoteCommunityEjectionResponseSchema = z.strictObject({
  localRevoked: z.literal(true),
  remoteRevoked: z.boolean(),
});
/** Honest result when the remote service may be unreachable. */
export type RemoteCommunityEjectionResponse = z.infer<typeof RemoteCommunityEjectionResponseSchema>;

/** A bounded upload returns only authorized attachment metadata. */
export const RemoteCommunityAttachmentResponseSchema = z.strictObject({ attachment });
/** The local API emits one validated payload per SSE event. */
export const RemoteCommunityEventSchema = z
  .discriminatedUnion('type', [
    z.strictObject({
      type: z.literal('snapshot'),
      room: RemoteCommunityRoomSchema,
      entries: z.array(RemoteCommunityEntrySchema).max(100),
      cursor: CommunityCursorSchema.nullable(),
      lastRemoteSeq: sequence,
      stale: z.boolean(),
    }),
    z.strictObject({ type: z.literal('entry'), entry: RemoteCommunityEntrySchema }),
    RoomAddressSchema.extend({
      type: z.literal('closed'),
      reason: z.enum(['removed', 'revoked', 'unavailable']),
    }).strict(),
  ])
  .refine(
    (event) =>
      event.type !== 'snapshot' ||
      (event.stale === event.room.stale &&
        validEntries(event.entries, event.room.community, event.room.roomId, event.lastRemoteSeq)),
    { message: 'Snapshot must contain ordered entries for its room and freshness state' }
  );
/** Snapshot, committed entry or explicit end of authorized live access. */
export type RemoteCommunityEvent = z.infer<typeof RemoteCommunityEventSchema>;

/** Local-server-only operations; each room address always includes its connection ref. */
export interface RemoteCommunityTransport {
  /** Discover visible rooms for one connection, including explicit stale cache state. */
  listRemoteCommunityRooms(ref: string): Promise<RemoteCommunityRoomsResponse>;
  /** Read permissions and metadata for one qualified room. */
  getRemoteCommunityRoom(ref: string, roomId: string): Promise<RemoteCommunityRoom>;
  /** Read one bounded history page, optionally for a top-level thread. */
  listRemoteCommunityEntries(
    ref: string,
    roomId: string,
    query?: RemoteCommunityHistoryQuery
  ): Promise<RemoteCommunityHistoryResponse>;
  /** Post as the connected human; return only after remote confirmation. */
  postRemoteCommunityEntry(
    ref: string,
    roomId: string,
    input: RemoteCommunityPostRequest
  ): Promise<RemoteCommunityEntry>;
  /** Deliver validated events until abort, closure or error; callers own reconnect policy. */
  subscribeRemoteCommunityRoom(
    ref: string,
    roomId: string,
    onEvent: (event: RemoteCommunityEvent) => void,
    options?: { since?: string; signal?: AbortSignal }
  ): Promise<void>;
  /** Read the roster with explicit freshness, including agent ownership. */
  listRemoteCommunityMembers(ref: string, roomId: string): Promise<RemoteCommunityMembersResponse>;
  /** Join as the connected human; the browser cannot nominate another identity. */
  joinRemoteCommunityRoom(ref: string, roomId: string): Promise<RemoteCommunityRoom>;
  /** Leave as the connected human, then discard access to protected history. */
  leaveRemoteCommunityRoom(ref: string, roomId: string): Promise<void>;
  /** Read the connected human's position. */
  getRemoteCommunityReadCursor(ref: string, roomId: string): Promise<RemoteCommunityReadCursor>;
  /** Advance the connected human's position using an opaque entry cursor. */
  setRemoteCommunityReadCursor(
    ref: string,
    roomId: string,
    cursor: string
  ): Promise<RemoteCommunityReadCursor>;
  /** List this install owner's trusted local-agent enrollments. */
  listRemoteCommunityAgents(ref: string): Promise<RemoteCommunityEnrollment[]>;
  /** Enroll an existing local agent; the server resolves its manifest and stores credentials privately. */
  enrollRemoteCommunityAgent(
    ref: string,
    localAgentId: string,
    input?: RemoteCommunityEnrollRequest
  ): Promise<RemoteCommunityEnrollment>;
  /** Stop local participation first, then report whether remote cleanup was confirmed. */
  ejectRemoteCommunityAgent(
    ref: string,
    localAgentId: string
  ): Promise<RemoteCommunityEjectionResponse>;
  /** Join a room as an owned, actively enrolled local agent. */
  joinRemoteCommunityAgentRoom(ref: string, roomId: string, localAgentId: string): Promise<void>;
  /** Stop the owned agent's room participation before attempting remote cleanup. */
  leaveRemoteCommunityAgentRoom(
    ref: string,
    roomId: string,
    localAgentId: string
  ): Promise<RemoteCommunityEjectionResponse>;
  /** Stop this owner's local work in a remote room, including while disconnected. */
  haltRemoteCommunityRoom(ref: string, roomId: string): Promise<HaltRoomResponse>;
  /** Stop one owned local agent without requiring remote community access. */
  haltRemoteCommunityAgent(
    ref: string,
    roomId: string,
    localAgentId: string
  ): Promise<HaltRoomResponse>;
  /** Upload bounded bytes through the local server, with a stable retry key. */
  uploadRemoteCommunityAttachment(
    ref: string,
    roomId: string,
    file: File,
    idempotencyKey: string
  ): Promise<z.infer<typeof CommunityAttachmentSchema>>;
  /** Download authorized bytes through the local server; no remote storage URL reaches the browser. */
  downloadRemoteCommunityAttachment(
    ref: string,
    roomId: string,
    attachmentId: string
  ): Promise<Blob>;
}

/** Reject mixed scopes, duplicate IDs and non-authoritative order at the DTO boundary. */
function validEntries(
  entries: RemoteCommunityEntry[],
  community: string,
  roomId: string,
  watermark: number
): boolean {
  const ids = new Set<string>();
  let previous = 0;
  for (const entry of entries) {
    if (
      entry.community !== community ||
      entry.roomId !== roomId ||
      ids.has(entry.id) ||
      entry.remoteSeq <= previous ||
      entry.remoteSeq > watermark
    )
      return false;
    ids.add(entry.id);
    previous = entry.remoteSeq;
  }
  return true;
}
