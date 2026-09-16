/**
 * HTTP-backed CommunityAdapter for one browser-approved Community connection.
 * Credentials are resolved only from the owner-scoped encrypted connection store.
 *
 * @module server/services/communities/remote/remote-community-adapter
 */
import {
  CommunityRoomNotFoundError,
  CommunityUnsupportedError,
  StaleCommunityCursorError,
  type AdmitAgentInput,
  type AddCommunityMemberOpts,
  type CommunityAdapter,
  type CommunityAttachment,
  type CommunityCapabilities,
  type CommunityConnection,
  type CommunityCursor,
  type CommunityEntry,
  type CommunityEntryPage,
  type CommunityEntryRef,
  type CommunityMember,
  type CommunityReadContext,
  type CommunityRef,
  type CommunityRoom,
  type CommunityRoomEvent,
  type CommunityRoomListEvent,
  type CommunityInvite,
  type CreateCommunityInviteInput,
  type CreateCommunityRoomInput,
  type DownloadCommunityAttachment,
  type ListCommunityEntriesOpts,
  type PostCommunityEntryInput,
  type UpdateCommunityRoomInput,
  type UploadCommunityAttachmentInput,
} from '@dorkos/shared/community-adapter';
import {
  COMMUNITY_API_V1_ROUTES,
  CommunityWireChannelListResponseSchema,
  CommunityWireChannelResponseSchema,
  CommunityWireAgentChannelMembershipResponseSchema,
  CommunityWireAgentListResponseSchema,
  CommunityWireEntryPageSchema,
  CommunityWireEntryPostResponseSchema,
  CommunityWireEventSchema,
  CommunityWireMemberListResponseSchema,
  CommunityWireReadCursorResponseSchema,
} from '@dorkos/shared/community-wire';
import { CommunityAgentEnrollmentSecretResponseSchema } from '@dorkos/shared/community-private-wire';
import { randomUUID } from 'node:crypto';
import {
  PinnedHttpError,
  PinnedOriginError,
  parseCommunityOrigin,
  pinnedJson,
  pinnedSse,
} from './pinned-origin.js';
import { RemoteConnectionNotFoundError, RemoteConnectionStore } from './connection-store.js';
import type { CommunityAgentEnrollmentStore } from './agent-enrollment-store.js';

const capabilities: CommunityCapabilities = {
  type: 'dorkos-community',
  roomList: 'poll',
  roomListPollIntervalMs: 1_000,
  roomAddressing: 'opaque-id',
  canPost: true,
  roomAdmin: false,
  agentActing: true,
  attachments: true,
  roles: {
    supported: true,
    default: 'member',
    values: [
      { id: 'owner', label: 'Owner', administers: true, isOwner: true },
      { id: 'admin', label: 'Admin', administers: true },
      { id: 'member', label: 'Member', administers: false },
    ],
  },
  admission: 'invite',
  invite: 'none',
  agentAdmission: 'owner-vouched',
  readCursor: 'server',
  responseMode: false,
  threadDepth: 1,
  signals: 'none',
  credential: 'browser-approved',
  features: {},
};
/** The standalone server defaults to 10 MiB and may configure at most 25 MiB. */
const MAX_REMOTE_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const remoteSequences = new WeakMap<CommunityEntry, number>();
const remoteAuthorMetadata = new WeakMap<
  CommunityEntry,
  Readonly<{ displayName: string; kind: 'human' | 'agent' }>
>();
const communityUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const activeAdmissions = new Map<string, Promise<CommunityMember>>();
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

/** Read private native visibility and joined state for a projected remote room. */
export function remoteRoomAccessOf(
  projected: CommunityRoom
): Readonly<{ visibility: 'public' | 'private'; joined: boolean }> | undefined {
  return remoteRoomMetadata.get(projected);
}

/** Translate a server-authoritative room/cursor refusal into the port's safe error. */
function remoteRoomError(error: unknown, community: CommunityRef, roomId: string): unknown {
  if (!(error instanceof PinnedHttpError)) return error;
  if (error.status === 410)
    return new StaleCommunityCursorError(
      community,
      roomId,
      'the community server no longer accepts this cursor'
    );
  if (error.status === 404) return new CommunityRoomNotFoundError(community, roomId);
  return error;
}

/** Map one remote wire channel to the portable room contract. */
function room(
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
function entry(
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
    attachments: value.attachments,
  };
  remoteSequences.set(projected, value.seq);
  remoteAuthorMetadata.set(projected, {
    displayName: value.authorDisplayName,
    kind: value.authorKind,
  });
  return projected;
}

/** Private native stream events retain the server's replay watermark without widening the generic port. */
export type RemoteNativeRoomEvent =
  | (Extract<CommunityRoomEvent, { type: 'snapshot' }> & { capturedSeq: number })
  | Extract<CommunityRoomEvent, { type: 'entry' }>
  | Extract<CommunityRoomEvent, { type: 'room_closed' }>
  | { type: 'replay_complete'; capturedSeq: number };

/** Remote community connection which refuses an unowned agent before opening a socket. */
export class RemoteCommunityAdapter implements CommunityAdapter {
  readonly type = 'dorkos-community';
  private readonly rooms = new Map<string, CommunityRoom>();
  private readonly attachments = new Map<string, CommunityAttachment>();
  private readonly admittedAgents = new Map<string, CommunityMember>();

  /** Construct one adapter for one stored ref and one local owner. */
  constructor(
    readonly community: CommunityRef,
    private readonly ownerKey: string,
    private readonly store: RemoteConnectionStore,
    private readonly enrollments?: CommunityAgentEnrollmentStore
  ) {}

  getCapabilities(): CommunityCapabilities {
    return structuredClone(capabilities);
  }

  private async origin(): Promise<URL> {
    return parseCommunityOrigin((await this.store.get(this.community, this.ownerKey)).pinnedOrigin);
  }

  private async credential(context?: CommunityReadContext): Promise<string> {
    if (context?.actingMemberId)
      return this.store.agentToken(this.community, this.ownerKey, context.actingMemberId);
    return this.store.personalToken(this.community, this.ownerKey);
  }

  private async request(
    path: string,
    body?: unknown,
    context?: CommunityReadContext,
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  ): Promise<unknown> {
    return pinnedJson(await this.origin(), path, body, undefined, {
      method,
      authorization: await this.credential(context),
      maxBytes: 1024 * 1024,
      accept: method === 'DELETE' ? [200, 201, 204] : [200, 201],
    });
  }

  async connect(): Promise<CommunityConnection> {
    try {
      const descriptor = await this.store.get(this.community, this.ownerKey);
      const token = await this.credential();
      await pinnedJson(
        parseCommunityOrigin(descriptor.pinnedOrigin),
        COMMUNITY_API_V1_ROUTES.channels,
        undefined,
        undefined,
        { authorization: token }
      );
      return {
        status: 'connected',
        identity: { community: this.community, memberId: descriptor.connectedHumanMemberId! },
      };
    } catch (error) {
      if (error instanceof PinnedHttpError && (error.status === 401 || error.status === 403))
        return { status: 'unauthorized', error: 'The stored community grant was rejected.' };
      if (error instanceof PinnedOriginError) return { status: 'unreachable', error: error.code };
      return { status: 'unauthorized', error: 'The stored community grant is unavailable.' };
    }
  }

  async disconnect(): Promise<void> {
    try {
      await this.store.disconnect(this.community, this.ownerKey);
    } catch (error) {
      if (error instanceof RemoteConnectionNotFoundError) return;
      throw error;
    }
  }

  async listRooms(context?: CommunityReadContext): Promise<CommunityRoom[]> {
    const data = CommunityWireChannelListResponseSchema.parse(
      await this.request(COMMUNITY_API_V1_ROUTES.channels, undefined, context, 'GET')
    );
    const result = data.channels.map((item) => room(this.community, item));
    this.rooms.clear();
    for (const item of result) this.rooms.set(item.roomId, item);
    return result;
  }

  async getRoom(roomId: string, context?: CommunityReadContext): Promise<CommunityRoom | null> {
    if (!communityUuid.test(roomId)) return null;
    try {
      const data = CommunityWireChannelResponseSchema.parse(
        await this.request(
          `/api/v1/channels/${encodeURIComponent(roomId)}`,
          undefined,
          context,
          'GET'
        )
      );
      const result = room(this.community, data.channel);
      this.rooms.set(roomId, result);
      return result;
    } catch (error) {
      if (error instanceof PinnedHttpError && error.status === 404) return null;
      throw error;
    }
  }

  subscribeRoomList(
    signal?: AbortSignal,
    context?: CommunityReadContext
  ): AsyncIterable<CommunityRoomListEvent> {
    const listRooms = this.listRooms.bind(this);
    const community = this.community;
    // A disappearance only has meaning relative to a room the adapter has
    // already projected. Retain that bounded projection across the next poll.
    const initialKnown = new Map(this.rooms);
    return (async function* () {
      let known = initialKnown;
      while (!signal?.aborted) {
        const next = new Map((await listRooms(context)).map((item) => [item.roomId, item]));
        for (const [id, value] of next)
          yield known.has(id)
            ? { type: 'room_updated', room: value }
            : { type: 'room_added', room: value };
        for (const id of known.keys())
          if (!next.has(id)) yield { type: 'room_removed', community, roomId: id };
        known = next;
        await new Promise((resolve) => setTimeout(resolve, capabilities.roomListPollIntervalMs));
      }
    })();
  }

  async createRoom(_input: CreateCommunityRoomInput): Promise<CommunityRoom> {
    throw new CommunityUnsupportedError(this.community, 'roomAdmin', 'createRoom');
  }
  async updateRoom(_roomId: string, _patch: UpdateCommunityRoomInput): Promise<CommunityRoom> {
    throw new CommunityUnsupportedError(this.community, 'roomAdmin', 'updateRoom');
  }

  subscribeRoom(
    roomId: string,
    sinceCursor?: CommunityCursor,
    signal?: AbortSignal,
    context?: CommunityReadContext
  ): AsyncIterable<CommunityRoomEvent> {
    const native = this.subscribeNativeRoom(roomId, sinceCursor, signal, context);
    return (async function* () {
      for await (const event of native) {
        if (event.type === 'replay_complete') continue;
        yield event;
      }
    })();
  }

  /** Native subscription keeps the server-captured replay watermark private to local lifecycle code. */
  subscribeNativeRoom(
    roomId: string,
    sinceCursor?: CommunityCursor,
    signal?: AbortSignal,
    context?: CommunityReadContext
  ): AsyncIterable<RemoteNativeRoomEvent> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(roomId))
      throw new CommunityRoomNotFoundError(this.community, roomId);
    const community = this.community;
    const origin = this.origin.bind(this);
    const credential = this.credential.bind(this);
    const cancelled = new AbortController();
    const stream: AsyncGenerator<RemoteNativeRoomEvent, void, unknown> = (async function* () {
      try {
        for await (const raw of pinnedSse(
          await origin(),
          `/api/v1/channels/${encodeURIComponent(roomId)}/events`,
          await credential(context),
          sinceCursor,
          signal ? AbortSignal.any([signal, cancelled.signal]) : cancelled.signal
        )) {
          const event = CommunityWireEventSchema.parse(raw);
          if (event.type === 'snapshot') {
            const entries = event.entries.map((item) => entry(community, item));
            yield {
              type: 'snapshot',
              room: room(community, event.channel),
              entries,
              capturedSeq: event.capturedSeq,
              cursor: event.cursor as CommunityCursor,
            };
          } else if (event.type === 'entry') {
            const value = entry(community, event.entry);
            yield { type: 'entry', entry: value };
          } else if (event.type === 'replay_complete') {
            yield { type: 'replay_complete', capturedSeq: event.capturedSeq };
          } else {
            yield {
              type: 'room_closed',
              reason:
                event.reason === 'removed'
                  ? 'access-revoked'
                  : event.reason === 'archived'
                    ? 'archived'
                    : 'unknown',
            };
          }
        }
      } catch (error) {
        if (cancelled.signal.aborted || signal?.aborted) return;
        throw remoteRoomError(error, community, roomId);
      }
    })();
    return {
      [Symbol.asyncIterator](): AsyncIterator<RemoteNativeRoomEvent> {
        const iterator = stream[Symbol.asyncIterator]();
        return {
          next: (...value: [] | [unknown]) => iterator.next(...value),
          return: async () => {
            cancelled.abort();
            return iterator.return
              ? iterator.return()
              : { done: true as const, value: undefined as never };
          },
        };
      },
    };
  }

  async listEntries(
    roomId: string,
    opts: ListCommunityEntriesOpts = {}
  ): Promise<CommunityEntryPage> {
    const query = new URLSearchParams();
    if (opts.cursor) query.set('cursor', opts.cursor);
    if (opts.limit) query.set('limit', String(Math.min(opts.limit, 100)));
    if (opts.thread) query.set('thread', opts.thread);
    let data;
    try {
      data = CommunityWireEntryPageSchema.parse(
        await this.request(
          `/api/v1/channels/${encodeURIComponent(roomId)}/entries${query.size ? `?${query}` : ''}`,
          undefined,
          { actingMemberId: opts.actingMemberId },
          'GET'
        )
      );
    } catch (error) {
      throw remoteRoomError(error, this.community, roomId);
    }
    // The wire includes the root as context for a thread page. The port's
    // thread surface returns replies, whose depth is uniformly one.
    const entries = data.entries
      .filter((item) => !opts.thread || item.id !== opts.thread)
      .map((item) => entry(this.community, item));
    for (const item of entries) {
      for (const attachment of item.attachments ?? [])
        this.attachments.set(attachment.id, attachment);
    }
    return {
      entries,
      nextCursor: data.nextCursor as CommunityCursor | null,
    };
  }

  /** Post and retain the server-confirmed native entry for the qualified local API. */
  /** Read a browser thread including its authoritative root context entry. */
  async listEntriesWithThreadRoot(
    roomId: string,
    opts: ListCommunityEntriesOpts = {}
  ): Promise<CommunityEntryPage> {
    if (!opts.thread) return this.listEntries(roomId, opts);
    const query = new URLSearchParams();
    if (opts.cursor) query.set('cursor', opts.cursor);
    if (opts.limit) query.set('limit', String(Math.min(opts.limit, 100)));
    query.set('thread', opts.thread);
    const data = CommunityWireEntryPageSchema.parse(
      await this.request(
        `/api/v1/channels/${encodeURIComponent(roomId)}/entries?${query}`,
        undefined,
        { actingMemberId: opts.actingMemberId },
        'GET'
      )
    );
    return {
      entries: data.entries.map((item) => entry(this.community, item)),
      nextCursor: data.nextCursor as CommunityCursor | null,
    };
  }

  async postEntry(roomId: string, input: PostCommunityEntryInput): Promise<CommunityEntry> {
    const data = CommunityWireEntryPostResponseSchema.parse(
      await this.request(
        `/api/v1/channels/${encodeURIComponent(roomId)}/entries`,
        {
          text: input.text,
          mentions: input.mentions,
          parentEntryId: input.parentEntryId,
          idempotencyKey: input.idempotencyKey ?? randomUUID(),
          attachmentIds: input.attachmentIds,
        },
        { actingMemberId: input.actingMemberId }
      )
    );
    return entry(this.community, data.entry);
  }

  async post(roomId: string, input: PostCommunityEntryInput): Promise<CommunityEntryRef> {
    const written = await this.postEntry(roomId, input);
    return {
      community: this.community,
      roomId,
      entryId: written.id,
      cursor: written.cursor,
    };
  }

  /** Join a public room as the browser-approved human, never a nominated member. */
  async joinRoom(roomId: string): Promise<CommunityRoom> {
    const data = CommunityWireChannelResponseSchema.parse(
      await this.request(
        `/api/v1/channels/${encodeURIComponent(roomId)}/join`,
        undefined,
        undefined,
        'POST'
      )
    );
    return room(this.community, data.channel);
  }

  /** Leave a room as the browser-approved human. */
  async leaveRoom(roomId: string): Promise<CommunityRoom> {
    const data = CommunityWireChannelResponseSchema.parse(
      await this.request(
        `/api/v1/channels/${encodeURIComponent(roomId)}/leave`,
        undefined,
        undefined,
        'POST'
      )
    );
    return room(this.community, data.channel);
  }

  async uploadAttachment(
    roomId: string,
    input: UploadCommunityAttachmentInput
  ): Promise<CommunityAttachment> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of input.bytes) {
      size += chunk.byteLength;
      if (size > MAX_REMOTE_ATTACHMENT_BYTES) throw new PinnedOriginError('REMOTE_RESPONSE');
      chunks.push(Buffer.from(chunk));
    }
    const data = (await pinnedJson(
      await this.origin(),
      `/api/v1/channels/${encodeURIComponent(roomId)}/attachments`,
      undefined,
      undefined,
      {
        method: 'POST',
        authorization: await this.credential({ actingMemberId: input.actingMemberId }),
        rawBody: Buffer.concat(chunks),
        contentType: input.contentType,
        headers: {
          'x-file-name': encodeURIComponent(input.name),
          'x-file-size': String(input.byteSize),
          'idempotency-key': input.idempotencyKey,
        },
        maxBytes: 128 * 1024,
      }
    )) as { attachment: CommunityAttachment };
    return data.attachment;
  }

  async downloadAttachment(
    roomId: string,
    attachmentId: string,
    context?: CommunityReadContext
  ): Promise<DownloadCommunityAttachment> {
    const bytes = (await pinnedJson(
      await this.origin(),
      `/api/v1/attachments/${encodeURIComponent(attachmentId)}`,
      undefined,
      undefined,
      {
        method: 'GET',
        authorization: await this.credential(context),
        response: 'buffer',
        maxBytes: MAX_REMOTE_ATTACHMENT_BYTES,
      }
    )) as Buffer;
    return {
      attachment: {
        id: attachmentId,
        name: attachmentId,
        contentType: 'application/octet-stream',
        byteSize: bytes.byteLength,
        checksum: '',
      },
      bytes: (async function* () {
        yield new Uint8Array(bytes);
      })(),
    };
  }

  async listMembers(roomId: string, context?: CommunityReadContext): Promise<CommunityMember[]> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(roomId))
      return [];
    let data;
    try {
      data = CommunityWireMemberListResponseSchema.parse(
        await this.request(
          `/api/v1/channels/${encodeURIComponent(roomId)}/members`,
          undefined,
          context,
          'GET'
        )
      );
    } catch (error) {
      if (error instanceof PinnedHttpError && (error.status === 400 || error.status === 404))
        return [];
      throw error;
    }
    return data.members.map((item) => ({
      community: this.community,
      memberId: item.memberId,
      kind: item.kind,
      displayName: item.displayName,
      handle: item.handle,
      role: item.role,
      ownerMemberId: item.ownerMemberId,
      joinedAt: item.joinedAt,
    }));
  }

  /** List active remotely enrolled agents visible through this owner's personal grant. */
  async listEnrolledAgents(): Promise<CommunityMember[]> {
    const data = CommunityWireAgentListResponseSchema.parse(
      await this.request(COMMUNITY_API_V1_ROUTES.agents, undefined, undefined, 'GET')
    );
    return data.agents
      .filter((agent) => agent.active)
      .map((agent) => ({
        community: this.community,
        memberId: agent.memberId,
        kind: 'agent' as const,
        displayName: agent.displayName,
        handle: agent.handle,
        role: null,
        ownerMemberId: agent.ownerMemberId,
        joinedAt: new Date().toISOString(),
      }));
  }

  async addMember(
    roomId: string,
    memberId: string,
    _opts?: AddCommunityMemberOpts
  ): Promise<CommunityMember> {
    try {
      await this.store.agentToken(this.community, this.ownerKey, memberId);
    } catch (error) {
      if (error instanceof RemoteConnectionNotFoundError)
        throw new CommunityUnsupportedError(this.community, 'roomAdmin', 'addMember');
      throw error;
    }
    CommunityWireAgentChannelMembershipResponseSchema.parse(
      await this.request(`/api/v1/channels/${encodeURIComponent(roomId)}/agents`, {
        agentId: memberId,
      })
    );
    const member = (await this.listMembers(roomId)).find((item) => item.memberId === memberId);
    if (!member) throw new CommunityRoomNotFoundError(this.community, roomId);
    return member;
  }
  async removeMember(roomId: string, memberId: string): Promise<void> {
    try {
      await this.store.agentToken(this.community, this.ownerKey, memberId);
    } catch (error) {
      if (error instanceof RemoteConnectionNotFoundError)
        throw new CommunityUnsupportedError(this.community, 'roomAdmin', 'removeMember');
      throw error;
    }
    await this.request(
      `/api/v1/channels/${encodeURIComponent(roomId)}/agents/${encodeURIComponent(memberId)}`,
      undefined,
      undefined,
      'DELETE'
    );
  }
  async setResponseMode(_roomId: string, _memberId: string): Promise<CommunityMember> {
    throw new CommunityUnsupportedError(this.community, 'responseMode', 'setResponseMode');
  }

  private async verifiedEnrolledAgent(localAgentId: string): Promise<CommunityMember | null> {
    const binding = this.enrollments?.findRemoteMember(this.community, localAgentId, this.ownerKey);
    if (!binding) return null;
    try {
      // Fresh remote authority is required before returning a durable mapping.
      await this.request(
        COMMUNITY_API_V1_ROUTES.channels,
        undefined,
        {
          actingMemberId: binding.remoteMemberId,
        },
        'GET'
      );
      const agents = CommunityWireAgentListResponseSchema.parse(
        await this.request(COMMUNITY_API_V1_ROUTES.agents, undefined, undefined, 'GET')
      );
      const agent = agents.agents.find((item) => item.memberId === binding.remoteMemberId);
      if (!agent || !agent.active) return null;
      return {
        community: this.community,
        memberId: agent.memberId,
        kind: 'agent',
        displayName: agent.displayName,
        handle: agent.handle,
        role: null,
        ownerMemberId: agent.ownerMemberId,
        joinedAt: new Date().toISOString(),
      };
    } catch (error) {
      if (error instanceof PinnedHttpError && (error.status === 401 || error.status === 403))
        return null;
      throw error;
    }
  }

  /** Enroll once, reusing a verified durable credential after an adapter restart. */
  private async admitAgentUnshared(
    input: AdmitAgentInput & { handle?: string }
  ): Promise<CommunityMember> {
    const admitted =
      this.admittedAgents.get(input.agentId) ?? (await this.verifiedEnrolledAgent(input.agentId));
    // A durable enrollment is only reusable after the remote accepts its bearer.
    if (admitted) {
      this.admittedAgents.set(input.agentId, admitted);
      return admitted;
    }
    const data = CommunityAgentEnrollmentSecretResponseSchema.parse(
      await this.request(COMMUNITY_API_V1_ROUTES.agents, {
        localAgentId: input.agentId,
        displayName: input.displayName,
        ...(input.handle ? { handle: input.handle } : {}),
      })
    );
    await this.store.saveAgentToken(this.community, this.ownerKey, data.agent.memberId, data.token);
    this.enrollments?.activate({
      communityRef: this.community,
      localAgentId: input.agentId,
      remoteMemberId: data.agent.memberId,
      ownerAuthorId: this.ownerKey,
    });
    const member: CommunityMember = {
      community: this.community,
      memberId: data.agent.memberId,
      kind: 'agent',
      displayName: data.agent.displayName,
      handle: data.agent.handle,
      role: null,
      ownerMemberId: data.agent.ownerMemberId,
      joinedAt: new Date().toISOString(),
    };
    this.admittedAgents.set(input.agentId, member);
    return member;
  }

  /** Serialize duplicate local enrollment requests until one durable receipt exists. */
  async admitAgent(input: AdmitAgentInput): Promise<CommunityMember> {
    const key = `${this.community}:${this.ownerKey}:${input.agentId}`;
    const active = activeAdmissions.get(key);
    if (active) return active;
    const admission = this.admitAgentUnshared(input);
    activeAdmissions.set(key, admission);
    try {
      return await admission;
    } finally {
      if (activeAdmissions.get(key) === admission) activeAdmissions.delete(key);
    }
  }

  /** Recover an explicitly requested missing or rejected bearer; ordinary retries never rotate it. */
  async recoverAgent(input: AdmitAgentInput & { handle?: string }): Promise<CommunityMember> {
    const binding = this.enrollments?.findRemoteMember(
      this.community,
      input.agentId,
      this.ownerKey
    );
    let data;
    try {
      data = CommunityAgentEnrollmentSecretResponseSchema.parse(
        await this.request(
          binding
            ? `/api/v1/agents/${encodeURIComponent(binding.remoteMemberId)}/rotate`
            : '/api/v1/agents/recover',
          binding
            ? undefined
            : {
                localAgentId: input.agentId,
                displayName: input.displayName,
                ...(input.handle ? { handle: input.handle } : {}),
              },
          undefined,
          'POST'
        )
      );
    } catch (error) {
      // An inactive row is reactivated only after its authorized recovery lookup
      // says no active credential exists. Ordinary admission never rotates.
      if (!binding && error instanceof PinnedHttpError && error.status === 404)
        return this.admitAgent(input);
      throw error;
    }
    await this.store.saveAgentToken(this.community, this.ownerKey, data.agent.memberId, data.token);
    this.enrollments?.activate({
      communityRef: this.community,
      localAgentId: input.agentId,
      remoteMemberId: data.agent.memberId,
      ownerAuthorId: this.ownerKey,
    });
    const member: CommunityMember = {
      community: this.community,
      memberId: data.agent.memberId,
      kind: 'agent',
      displayName: data.agent.displayName,
      handle: data.agent.handle,
      role: null,
      ownerMemberId: data.agent.ownerMemberId,
      joinedAt: new Date().toISOString(),
    };
    this.admittedAgents.set(input.agentId, member);
    return member;
  }

  async revokeAgent(memberId: string): Promise<void> {
    const binding = this.enrollments?.findLocalAgent(this.community, memberId, this.ownerKey);
    // Stop local delivery before attempting network cleanup. A timeout therefore
    // never leaves this install able to dispatch through a stale agent grant.
    if (binding) this.enrollments?.revoke(this.community, binding.localAgentId, this.ownerKey);
    try {
      await this.store.deleteAgentToken(this.community, this.ownerKey, memberId);
    } catch (error) {
      if (!(error instanceof RemoteConnectionNotFoundError)) throw error;
    }
    for (const [localAgentId, agent] of this.admittedAgents)
      if (agent.memberId === memberId) this.admittedAgents.delete(localAgentId);
    try {
      await this.request(
        `/api/v1/agents/${encodeURIComponent(memberId)}`,
        undefined,
        undefined,
        'DELETE'
      );
    } catch (error) {
      // The local revocation above remains authoritative even if cleanup loses
      // the remote response. A confirmed remote absence is idempotent.
      if (error instanceof PinnedHttpError && error.status === 404) return;
      throw error;
    }
  }

  async getReadCursor(roomId: string): Promise<CommunityCursor | null> {
    const data = CommunityWireReadCursorResponseSchema.parse(
      await this.request(
        `/api/v1/channels/${encodeURIComponent(roomId)}/read-cursor`,
        undefined,
        undefined,
        'GET'
      )
    );
    return data.cursor as CommunityCursor | null;
  }
  async setReadCursor(roomId: string, cursor: CommunityCursor): Promise<void> {
    try {
      await this.request(
        `/api/v1/channels/${encodeURIComponent(roomId)}/read-cursor`,
        { cursor },
        undefined,
        'PUT'
      );
    } catch (error) {
      throw remoteRoomError(error, this.community, roomId);
    }
  }
  async createInvite(_input: CreateCommunityInviteInput): Promise<CommunityInvite> {
    throw new CommunityUnsupportedError(this.community, 'invite', 'createInvite');
  }
  async publishSignal(): Promise<void> {
    throw new CommunityUnsupportedError(this.community, 'signals', 'publishSignal');
  }
}
