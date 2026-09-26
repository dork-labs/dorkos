/** @vitest-environment node */
import express from 'express';
import request from '@dorkos/test-utils/supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';
import { HaltRoomResponseSchema } from '@dorkos/shared/room-schemas';
import type { CommunityConnection, CommunityRef } from '@dorkos/shared/community-adapter';
import type { CommunityConnectionDescriptor } from '@dorkos/shared/community-connections';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => {
  const ref = 'remote_owner_a' as CommunityRef;
  const room = {
    community: ref,
    roomId: 'room-a',
    kind: 'channel' as const,
    title: 'General',
    slug: null,
    topic: null,
    archived: false,
    createdAt: '2026-09-16T00:00:00.000Z',
    lastActivityAt: '2026-09-16T00:00:00.000Z',
    unreadCount: 0,
  };
  const entry = {
    community: ref,
    roomId: 'room-a',
    id: 'entry-a',
    authorId: 'human-a',
    text: 'hello from a person',
    mentions: [],
    parentEntryId: null,
    threadRootEntryId: null,
    depth: 0,
    cursor: 'cursor-a',
    createdAt: '2026-09-16T00:00:00.000Z',
    attachments: [],
  };
  const uploadedBytes: Uint8Array[][] = [];
  const capabilities = { read: true, post: true, enrollAgent: true, stream: true };
  const access = {
    state: 'verified' as const,
    effective: capabilities,
    lastKnown: {
      lifecycle: 'active' as const,
      capabilities,
      verifiedAt: '2026-09-21T00:00:00.000Z',
    },
  };
  const connectionStatus = vi.fn<() => Promise<CommunityConnectionDescriptor>>(async () => ({
    ref,
    remoteCommunityId: 'community-a',
    label: 'Community A',
    pinnedOrigin: 'https://community.example',
    connectedHumanMemberId: 'human-a',
    status: 'connected' as const,
    expiresAt: null,
    access,
    attention: {
      state: 'unavailable' as const,
      unreadCount: null,
      mentionCount: null,
      verifiedAt: null,
    },
  }));
  const adapter = {
    connect: vi.fn<() => Promise<CommunityConnection>>(async () => ({
      status: 'connected' as const,
      identity: { community: ref, memberId: 'human-a' },
    })),
    postEntry: vi.fn(async () => entry),
    listEntriesWithThreadRoot: vi.fn(async () => ({ entries: [entry], nextCursor: null })),
    uploadAttachment: vi.fn(
      async (
        _room: string,
        input: {
          name: string;
          contentType: string;
          byteSize: number;
          bytes: AsyncIterable<Uint8Array>;
        }
      ) => {
        const bytes: Uint8Array[] = [];
        for await (const chunk of input.bytes) bytes.push(chunk);
        uploadedBytes.push(bytes);
        return {
          id: 'attachment-a',
          name: input.name,
          contentType: input.contentType,
          byteSize: bytes.reduce((total, chunk) => total + chunk.byteLength, 0),
          checksum: 'checksum-a',
        };
      }
    ),
    downloadAttachment: vi.fn(async () => ({
      attachment: {
        id: 'attachment-a',
        name: 'report.txt',
        contentType: 'text/plain',
        byteSize: 5,
        checksum: 'checksum-a',
      },
      bytes: (async function* () {
        yield new TextEncoder().encode('hello');
      })(),
    })),
    subscribeRoom: vi.fn(() =>
      (async function* () {
        yield { type: 'snapshot' as const, room, entries: [entry], cursor: 'cursor-a' };
      })()
    ),
    recoverAgent: vi.fn(async () => ({
      memberId: 'remote-enrolled-a',
      displayName: 'Build Agent',
      ownerMemberId: 'human-a',
    })),
    listEnrolledAgents: vi.fn(async () => [
      {
        community: ref,
        memberId: 'remote-agent-a',
        kind: 'agent' as const,
        displayName: 'Build Agent',
        handle: 'build-agent',
        role: null,
        ownerMemberId: 'human-a',
        joinedAt: '2026-09-16T00:00:00.000Z',
      },
    ]),
    listRooms: vi.fn(async () => [room]),
    revokeAgent: vi.fn(async () => undefined),
    removeMember: vi.fn(async () => undefined),
  };
  const lifecycle = {
    haltRoom: vi.fn(async () => 1),
    haltAgent: vi.fn(async () => 1),
    haltRoomAgent: vi.fn(async () => 1),
    leaveRoom: vi.fn(async () => undefined),
    revokeEnrollment: vi.fn(async () => undefined),
    revokeConnection: vi.fn(async () => undefined),
    refreshSubscriptions: vi.fn(),
  };
  return {
    ref,
    room,
    entry,
    adapter,
    uploadedBytes,
    lifecycle,
    access,
    connectionStatus,
    retryResult: 'retried' as 'retried' | 'queued' | 'missing' | 'terminal' | 'in-flight',
    retryCalls: [] as Array<{
      communityRef: string;
      remoteRoomId: string;
      ownerAuthorId: string;
      idempotencyKey: string;
    }>,
  };
});

vi.mock('../community-connections.js', () => ({
  resolveCommunityOwner: () => 'owner-a',
}));
vi.mock('../../services/communities/remote/state.js', () => ({
  getRemoteCommunityAdapter: () => fixture.adapter,
  getRemotePairingService: () => ({
    status: fixture.connectionStatus,
  }),
  getRemoteCommunityOriginIdempotencyKey: (
    ref: string,
    roomId: string,
    owner: string,
    entryId: string
  ) =>
    ref === fixture.ref && roomId === 'room-a' && owner === 'owner-a' && entryId === 'agent-echo-a'
      ? 'delivery-origin-a'
      : null,
  getRemoteCommunityDeliverySnapshot: (community: string, roomId: string) => ({
    community,
    roomId,
    deliveries: [
      {
        idempotencyKey: 'delivery-retry-a',
        author: { kind: 'agent', displayName: 'Build Agent' },
        text: 'working on it',
        parentEntryId: null,
        attachments: [],
        state: 'pending',
        failure: null,
        retryable: fixture.retryResult !== 'in-flight' && fixture.retryResult !== 'queued',
      },
    ],
  }),
  getRemoteCommunityEnrollmentStore: () => ({
    activeForOwner: () => [
      {
        communityRef: fixture.ref,
        localAgentId: 'local-agent-a',
        remoteMemberId: 'remote-agent-a',
        ownerAuthorId: 'owner-a',
        state: 'active',
        createdAt: '2026-09-16T00:00:00.000Z',
        updatedAt: '2026-09-16T00:00:00.000Z',
      },
    ],
    findAnyRemoteMember: () => ({ remoteMemberId: 'remote-agent-a' }),
    findRemoteMember: () => ({ remoteMemberId: 'remote-agent-a' }),
  }),
  getRemoteCommunityLifecycle: () => fixture.lifecycle,
  onRemoteCommunityDeliveryChange: () => () => undefined,
  retryRemoteCommunityDelivery: (request: {
    communityRef: string;
    remoteRoomId: string;
    ownerAuthorId: string;
    idempotencyKey: string;
  }) => {
    fixture.retryCalls.push(request);
    return fixture.retryResult;
  },
  resolveRemoteCommunityLocalAgent: (localAgentId: string) =>
    localAgentId === 'mesh-manifest-a'
      ? { authorId: 'opaque-local-author-a', displayName: 'Build Agent' }
      : null,
}));
vi.mock('../../services/communities/remote/remote-community-adapter.js', () => ({
  remoteSequenceOf: () => 1,
  remoteAuthorOf: (entry: { id: string }) =>
    entry.id === 'agent-wire-a'
      ? { displayName: 'Build Agent', kind: 'agent' as const }
      : { displayName: 'Owner', kind: 'human' as const },
  remoteOriginIdempotencyKeyOf: (entry: { id: string }) =>
    entry.id === 'agent-wire-a' ? 'wire-owned-key' : undefined,
  remoteRoomAccessOf: () => ({ visibility: 'public', joined: true }),
  remoteThreadReplySeqOf: (entry: { id: string }) =>
    entry.id === 'root-with-replies' ? 9 : undefined,
}));
vi.mock('../../services/rooms/index.js', () => ({
  getRoomService: () => ({
    authorRegistry: {
      getById: (id: string) =>
        id === 'local-agent-a'
          ? { id, kind: 'agent', displayName: 'Build Agent' }
          : { id, kind: 'human', displayName: 'Owner' },
    },
  }),
}));

import { createRemoteCommunitiesRouter } from '../remote-communities.js';
import { RemoteConnectionAuthorizationError } from '../../services/communities/remote/connection-store.js';
import {
  PinnedHttpError,
  PinnedOriginError,
} from '../../services/communities/remote/pinned-origin.js';
import { CommunityRoomNotFoundError } from '@dorkos/shared/community-adapter';

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use('/api/communities', createRemoteCommunitiesRouter());
  return instance;
}

const testServer = listeningServer(app());

async function* failingRoomStream(error: Error): AsyncGenerator<never, void, unknown> {
  throw error;
}

function connectionWithAccess(
  access: CommunityConnectionDescriptor['access']
): CommunityConnectionDescriptor {
  return {
    ref: fixture.ref,
    remoteCommunityId: 'community-a',
    label: 'Community A',
    pinnedOrigin: 'https://community.example',
    connectedHumanMemberId: 'human-a',
    status: 'connected',
    expiresAt: null,
    access,
    attention: { state: 'unavailable', unreadCount: null, mentionCount: null, verifiedAt: null },
  };
}

describe('qualified remote community writes and live projections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fixture.uploadedBytes.length = 0;
    fixture.retryResult = 'retried';
    fixture.retryCalls.length = 0;
  });

  it('projects the exact verified connection access on every listed room', async () => {
    const response = await request(testServer).get(`/api/communities/${fixture.ref}/rooms`);
    expect(response.status).toBe(200);
    expect(response.body.rooms).toEqual([
      expect.objectContaining({
        roomId: 'room-a',
        readable: true,
        writable: true,
        access: fixture.access,
      }),
    ]);
  });

  it('distinguishes a rejected remote grant from an unavailable community', async () => {
    fixture.adapter.listRooms.mockRejectedValueOnce(new RemoteConnectionAuthorizationError());
    const response = await request(testServer).get(`/api/communities/${fixture.ref}/rooms`);
    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      code: 'COMMUNITY_RECONNECT_REQUIRED',
      error: 'Reconnect this community to continue.',
    });
  });

  it('keeps a temporary connection failure distinct from a rejected grant', async () => {
    fixture.connectionStatus.mockResolvedValueOnce({
      ref: fixture.ref,
      remoteCommunityId: 'community-a',
      label: 'Community A',
      pinnedOrigin: 'https://community.example',
      connectedHumanMemberId: 'human-a',
      status: 'connected',
      expiresAt: null,
      access: {
        state: 'unverified',
        effective: { read: false, post: false, enrollAgent: false, stream: false },
        lastKnown: fixture.access.lastKnown,
      },
      attention: { state: 'unavailable', unreadCount: null, mentionCount: null, verifiedAt: null },
    });
    const response = await request(testServer).get(`/api/communities/${fixture.ref}/rooms`);
    expect(response.status).toBe(502);
    expect(response.body).toEqual({ error: 'Community unavailable.' });
  });

  it('refuses a live stream when verified access is read-only', async () => {
    fixture.connectionStatus.mockResolvedValueOnce({
      ref: fixture.ref,
      remoteCommunityId: 'community-a',
      label: 'Community A',
      pinnedOrigin: 'https://community.example',
      connectedHumanMemberId: 'human-a',
      status: 'connected',
      expiresAt: null,
      access: {
        state: 'verified',
        effective: { read: true, post: false, enrollAgent: false, stream: false },
        lastKnown: {
          lifecycle: 'archived',
          capabilities: { read: true, post: false, enrollAgent: false, stream: false },
          verifiedAt: '2026-09-21T00:00:00.000Z',
        },
      },
      attention: { state: 'unavailable', unreadCount: null, mentionCount: null, verifiedAt: null },
    });
    const response = await request(testServer).get(
      `/api/communities/${fixture.ref}/rooms/room-a/events`
    );
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('COMMUNITY_ACCESS_DENIED');
    expect(fixture.adapter.subscribeRoom).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'temporarily unverified',
      status: 502,
      access: {
        state: 'unverified' as const,
        effective: { read: false, post: false, enrollAgent: false, stream: false },
        lastKnown: fixture.access.lastKnown,
      },
    },
    {
      label: 'verified archived read-only',
      status: 403,
      access: {
        state: 'verified' as const,
        effective: { read: true, post: false, enrollAgent: false, stream: false },
        lastKnown: {
          lifecycle: 'archived' as const,
          capabilities: { read: true, post: false, enrollAgent: false, stream: false },
          verifiedAt: '2026-09-21T00:00:00.000Z',
        },
      },
    },
  ])('blocks every disallowed live operation before adapter I/O when $label', async (gate) => {
    const actions = [
      () => request(testServer).post(`/api/communities/${fixture.ref}/rooms/room-a/membership`),
      () => request(testServer).delete(`/api/communities/${fixture.ref}/rooms/room-a/membership`),
      () =>
        request(testServer)
          .post(`/api/communities/${fixture.ref}/rooms/room-a/entries`)
          .send({ text: 'blocked', idempotencyKey: 'blocked-post' }),
      () =>
        request(testServer)
          .post(`/api/communities/${fixture.ref}/rooms/room-a/attachments`)
          .set('content-type', 'application/octet-stream')
          .set('x-file-name', 'blocked.txt')
          .set('x-file-content-type', 'text/plain')
          .set('x-file-size', '1')
          .set('idempotency-key', 'blocked-upload')
          .send(Buffer.from('x')),
      () =>
        request(testServer).post(
          `/api/communities/${fixture.ref}/rooms/room-a/deliveries/blocked/retry`
        ),
      () => request(testServer).get(`/api/communities/${fixture.ref}/rooms/room-a/events`),
      () => request(testServer).get(`/api/communities/${fixture.ref}/agents`),
      () =>
        request(testServer).post(`/api/communities/${fixture.ref}/agents/mesh-manifest-a/enroll`),
      () =>
        request(testServer).post(
          `/api/communities/${fixture.ref}/rooms/room-a/agents/local-agent-a/membership`
        ),
      () =>
        request(testServer).delete(
          `/api/communities/${fixture.ref}/rooms/room-a/agents/local-agent-a/membership`
        ),
    ];
    if (gate.status === 502) {
      actions.push(
        () => request(testServer).get(`/api/communities/${fixture.ref}/rooms/room-a/entries`),
        () => request(testServer).get(`/api/communities/${fixture.ref}/rooms/room-a/read-cursor`),
        () =>
          request(testServer)
            .put(`/api/communities/${fixture.ref}/rooms/room-a/read-cursor`)
            .send({ cursor: 'cursor-a' }),
        () => request(testServer).get(`/api/communities/${fixture.ref}/rooms/room-a/members`),
        () =>
          request(testServer).get(
            `/api/communities/${fixture.ref}/rooms/room-a/attachments/attachment-a`
          )
      );
    }

    for (const action of actions) {
      vi.clearAllMocks();
      fixture.retryCalls.length = 0;
      fixture.connectionStatus.mockResolvedValueOnce(connectionWithAccess(gate.access));
      const response = await action();
      expect(response.status).toBe(gate.status);
      expect(
        Object.values(fixture.adapter).some(
          (method) => vi.isMockFunction(method) && method.mock.calls.length > 0
        )
      ).toBe(false);
      expect(fixture.retryCalls).toEqual([]);
      expect(fixture.lifecycle.revokeEnrollment).not.toHaveBeenCalled();
      expect(fixture.lifecycle.leaveRoom).not.toHaveBeenCalled();
    }
  });

  it('fences a local agent enrollment during an outage without remote cleanup', async () => {
    fixture.connectionStatus.mockResolvedValueOnce(
      connectionWithAccess({
        state: 'unverified',
        effective: { read: false, post: false, enrollAgent: false, stream: false },
        lastKnown: fixture.access.lastKnown,
      })
    );
    const response = await request(testServer).delete(
      `/api/communities/${fixture.ref}/agents/local-agent-a`
    );
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ localRevoked: true, remoteRevoked: false });
    expect(fixture.lifecycle.revokeEnrollment).toHaveBeenCalledWith(
      fixture.ref,
      'local-agent-a',
      'owner-a'
    );
    expect(fixture.adapter.revokeAgent).not.toHaveBeenCalled();
  });

  it('posts only as the connected human and does not attach agent-only origin metadata', async () => {
    const response = await request(testServer)
      .post(`/api/communities/${fixture.ref}/rooms/room-a/entries`)
      .send({ text: 'hello', idempotencyKey: 'retry-a', actingMemberId: 'remote-agent-a' });
    expect(response.status).toBe(400);
    expect(fixture.adapter.postEntry).not.toHaveBeenCalled();

    const accepted = await request(testServer)
      .post(`/api/communities/${fixture.ref}/rooms/room-a/entries`)
      .send({ text: 'hello', idempotencyKey: 'retry-a' });
    expect(accepted.status).toBe(201);
    expect(fixture.adapter.postEntry).toHaveBeenLastCalledWith('room-a', {
      text: 'hello',
      idempotencyKey: 'retry-a',
    });
    expect(accepted.body.entry).toMatchObject({
      remoteSeq: 1,
      authorKind: 'human',
    });
    expect(accepted.body.entry.originIdempotencyKey).toBeUndefined();
  });

  it('relays a raw PNG envelope with an encoded Unicode filename and no remote storage URL', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const upload = await request(testServer)
      .post(`/api/communities/${fixture.ref}/rooms/room-a/attachments`)
      .set('content-type', 'application/octet-stream')
      .set('x-file-name', encodeURIComponent('sketch \uD83E\uDDEA.png'))
      .set('x-file-content-type', 'image/png')
      .set('x-file-size', String(png.byteLength))
      .set('idempotency-key', 'attachment-retry-png')
      .send(png);
    expect(upload.status).toBe(201);
    expect(upload.body.attachment).toMatchObject({
      id: 'attachment-a',
      name: 'sketch \uD83E\uDDEA.png',
      contentType: 'image/png',
      byteSize: png.byteLength,
    });
    expect(fixture.adapter.uploadAttachment).toHaveBeenLastCalledWith(
      'room-a',
      expect.objectContaining({
        name: 'sketch \uD83E\uDDEA.png',
        contentType: 'image/png',
        byteSize: png.byteLength,
      })
    );
    expect(JSON.stringify(upload.body)).not.toContain('http');

    const download = await request(testServer).get(
      `/api/communities/${fixture.ref}/rooms/room-a/attachments/attachment-a`
    );
    expect(download.status).toBe(200);
    expect(download.headers['content-disposition']).toBe('attachment');
    expect(download.text).toBe('hello');
  });

  it('rejects JSON as the outer MIME before its parsed body reaches the adapter', async () => {
    const json = Buffer.from('{"message":"this must not become an attachment body"}');
    const upload = await request(testServer)
      .post(`/api/communities/${fixture.ref}/rooms/room-a/attachments`)
      .set('content-type', 'application/json')
      .set('x-file-name', encodeURIComponent('notes.json'))
      .set('x-file-content-type', 'application/json')
      .set('x-file-size', String(json.byteLength))
      .set('idempotency-key', 'attachment-retry-wrong-envelope')
      .send(json);
    expect(upload.status).toBe(400);
    expect(fixture.adapter.uploadAttachment).not.toHaveBeenCalled();
  });

  it('keeps JSON file bytes out of the app-wide JSON parser through the raw envelope', async () => {
    const json = Buffer.from('{"message":"preserve these exact bytes"}');
    const upload = await request(testServer)
      .post(`/api/communities/${fixture.ref}/rooms/room-a/attachments`)
      .set('content-type', 'application/octet-stream')
      .set('x-file-name', encodeURIComponent('notes.json'))
      .set('x-file-content-type', 'application/json')
      .set('x-file-size', String(json.byteLength))
      .set('idempotency-key', 'attachment-retry-json')
      .send(json);
    expect(upload.status).toBe(201);
    expect(upload.body.attachment).toMatchObject({
      name: 'notes.json',
      contentType: 'application/json',
      byteSize: json.byteLength,
    });
    expect(Buffer.concat(fixture.uploadedBytes.at(-1)!.map((chunk) => Buffer.from(chunk)))).toEqual(
      json
    );
  });

  it('streams the owner-qualified delivery replacement only after its room snapshot', async () => {
    const events = await request(testServer).get(
      `/api/communities/${fixture.ref}/rooms/room-a/events?since=cursor-before`
    );
    expect(events.status).toBe(200);
    expect(events.headers['content-type']).toContain('text/event-stream');
    expect(events.text).toContain('event: snapshot\ndata: {"type":"snapshot"');
    expect(events.text).toContain('"remoteSeq":1');
    expect(events.text).toContain('event: deliveries\ndata: {');
    expect(events.text).toContain('"type":"deliveries"');
    expect(events.text.indexOf('"type":"snapshot"')).toBeLessThan(
      events.text.indexOf('"type":"deliveries"')
    );

    const agents = await request(testServer).get(`/api/communities/${fixture.ref}/agents`);
    expect(agents.status).toBe(200);
    expect(agents.body.agents).toEqual([
      expect.objectContaining({
        localAgentId: 'local-agent-a',
        remoteMemberId: 'remote-agent-a',
        active: true,
      }),
    ]);
  });

  it('closes a stream as revoked when its personal grant is authoritatively rejected', async () => {
    fixture.adapter.subscribeRoom.mockImplementationOnce(() =>
      failingRoomStream(new RemoteConnectionAuthorizationError())
    );

    const events = await request(testServer).get(
      `/api/communities/${fixture.ref}/rooms/room-a/events`
    );

    expect(events.status).toBe(200);
    expect(events.text).toContain('event: closed');
    expect(events.text).toContain('"reason":"revoked"');
  });

  it('keeps a generic stream failure classified as unavailable', async () => {
    fixture.adapter.subscribeRoom.mockImplementationOnce(() =>
      failingRoomStream(new Error('temporary outage'))
    );

    const events = await request(testServer).get(
      `/api/communities/${fixture.ref}/rooms/room-a/events`
    );

    expect(events.status).toBe(200);
    expect(events.text).toContain('event: closed');
    expect(events.text).toContain('"reason":"unavailable"');
  });

  it('projects the authenticated wire key in history and an opening snapshot before any receipt', async () => {
    const agentEntry = {
      ...fixture.entry,
      id: 'agent-wire-a',
      authorId: 'remote-agent-a',
      text: 'agent output',
    };
    fixture.adapter.listEntriesWithThreadRoot.mockResolvedValueOnce({
      entries: [agentEntry],
      nextCursor: null,
    });
    fixture.adapter.subscribeRoom.mockImplementationOnce((() =>
      (async function* () {
        yield {
          type: 'snapshot' as const,
          room: fixture.room,
          entries: [agentEntry],
          cursor: 'cursor-a',
        };
      })()) as never);

    const [history, events] = await Promise.all([
      request(testServer).get(`/api/communities/${fixture.ref}/rooms/room-a/entries`),
      request(testServer).get(`/api/communities/${fixture.ref}/rooms/room-a/events`),
    ]);
    expect(history.status).toBe(200);
    expect(history.body.entries).toEqual([
      expect.objectContaining({ id: 'agent-wire-a', originIdempotencyKey: 'wire-owned-key' }),
    ]);
    expect(events.status).toBe(200);
    expect(events.text).toContain('"id":"agent-wire-a"');
    expect(events.text).toContain('"originIdempotencyKey":"wire-owned-key"');
  });

  it('carries a root’s reply count and the newest reply it counted to the browser (DOR-2229)', async () => {
    const root = {
      ...fixture.entry,
      id: 'root-with-replies',
      thread: { replyCount: 3, lastReplyAt: '2026-09-16T00:05:00.000Z' },
    };
    fixture.adapter.listEntriesWithThreadRoot.mockResolvedValueOnce({
      entries: [root],
      nextCursor: null,
    });
    const entries = `/api/communities/${fixture.ref}/rooms/room-a/entries`;

    const history = await request(testServer).get(entries);

    expect(history.status).toBe(200);
    expect(history.body.entries[0]).toMatchObject({
      id: 'root-with-replies',
      thread: { replyCount: 3, lastReplyAt: '2026-09-16T00:05:00.000Z' },
      threadLastReplySeq: 9,
    });
    // A root with no replies carries neither.
    const quiet = await request(testServer).get(entries);
    expect(quiet.body.entries[0]).not.toHaveProperty('thread');
    expect(quiet.body.entries[0]).not.toHaveProperty('threadLastReplySeq');
  });

  it('streams an authenticated agent marker immediately without a receipt barrier', async () => {
    const agentEntry = {
      ...fixture.entry,
      id: 'agent-wire-a',
      authorId: 'remote-agent-a',
      text: 'agent output',
    };
    fixture.adapter.subscribeRoom.mockImplementationOnce((() =>
      (async function* () {
        yield {
          type: 'snapshot' as const,
          room: fixture.room,
          entries: [fixture.entry],
          cursor: 'cursor-a',
        };
        yield { type: 'entry' as const, entry: agentEntry };
      })()) as never);

    const events = await request(testServer).get(
      `/api/communities/${fixture.ref}/rooms/room-a/events`
    );
    expect(events.status).toBe(200);
    expect(events.text.match(/"id":"agent-wire-a"/g)).toHaveLength(1);
    expect(events.text).toContain('"originIdempotencyKey":"wire-owned-key"');
  });

  it('passes the agent limit through as a refusal, not an outage', async () => {
    fixture.adapter.recoverAgent.mockRejectedValueOnce(new PinnedHttpError(429, 'RATE_LIMITED'));
    const response = await request(testServer)
      .post(`/api/communities/${fixture.ref}/agents/mesh-manifest-a/enroll`)
      .send({});
    expect(response.status).toBe(429);
    expect(response.body).toEqual({
      code: 'COMMUNITY_LIMIT_REACHED',
      error: 'You’ve reached this community’s limit on active agents. Remove one to add another.',
    });
  });

  it('answers a private channel the caller has not joined exactly like a missing one', async () => {
    const entries = `/api/communities/${fixture.ref}/rooms/room-hidden/entries`;
    fixture.adapter.listEntriesWithThreadRoot.mockRejectedValueOnce(
      new CommunityRoomNotFoundError(fixture.ref, 'room-hidden')
    );
    const hidden = await request(testServer).get(entries);
    fixture.adapter.listEntriesWithThreadRoot.mockRejectedValueOnce(
      new CommunityRoomNotFoundError(fixture.ref, 'room-missing')
    );
    const missing = await request(testServer).get(
      `/api/communities/${fixture.ref}/rooms/room-missing/entries`
    );
    expect(hidden.status).toBe(404);
    expect(hidden.body).toEqual(missing.body);
    expect(hidden.body).toEqual({
      code: 'COMMUNITY_NOT_FOUND',
      error: 'That isn’t available in this community.',
    });
  });

  it('keeps 502 for a Community that failed or could not be reached', async () => {
    for (const error of [new PinnedHttpError(500), new PinnedOriginError('REMOTE_UNAVAILABLE')]) {
      fixture.adapter.postEntry.mockRejectedValueOnce(error);
      const response = await request(testServer)
        .post(`/api/communities/${fixture.ref}/rooms/room-a/entries`)
        .send({ text: 'hello', idempotencyKey: 'outage-key' });
      expect(response.status).toBe(502);
      expect(response.body).toEqual({ error: 'Community unavailable.' });
    }
  });

  it('passes a read-only community through with its own reason', async () => {
    fixture.adapter.postEntry.mockRejectedValueOnce(
      new PinnedHttpError(423, 'COMMUNITY_DELETION_PENDING')
    );
    const response = await request(testServer)
      .post(`/api/communities/${fixture.ref}/rooms/room-a/entries`)
      .send({ text: 'hello', idempotencyKey: 'read-only-key' });
    expect(response.status).toBe(423);
    expect(response.body).toEqual({
      code: 'COMMUNITY_READ_ONLY',
      error: 'This community is being deleted.',
    });
  });

  it('enrolls the browser Mesh manifest id through trusted server-side author resolution', async () => {
    const response = await request(testServer)
      .post(`/api/communities/${fixture.ref}/agents/mesh-manifest-a/enroll`)
      .send({ handle: 'build-agent' });

    expect(response.status).toBe(201);
    expect(fixture.adapter.recoverAgent).toHaveBeenCalledWith({
      agentId: 'mesh-manifest-a',
      displayName: 'Build Agent',
      handle: 'build-agent',
    });
    expect(response.body.agent).toMatchObject({
      localAgentId: 'mesh-manifest-a',
      remoteMemberId: 'remote-enrolled-a',
    });

    const unknown = await request(testServer)
      .post(`/api/communities/${fixture.ref}/agents/opaque-local-author-a/enroll`)
      .send({});
    expect(unknown.status).toBe(404);
    expect(fixture.adapter.recoverAgent).toHaveBeenCalledTimes(1);
  });

  it('projects agent room membership and returns the existing Leave JSON contract', async () => {
    const listed = await request(testServer).get(`/api/communities/${fixture.ref}/agents`);
    expect(listed.status).toBe(200);
    expect(listed.body.agents).toEqual([
      expect.objectContaining({ localAgentId: 'local-agent-a', roomIds: ['room-a'] }),
    ]);

    const left = await request(testServer).delete(
      `/api/communities/${fixture.ref}/rooms/room-a/agents/local-agent-a/membership`
    );
    expect(left.status).toBe(200);
    expect(left.body).toEqual({ localRevoked: true, remoteRevoked: true });
    expect(fixture.adapter.removeMember).toHaveBeenCalledWith('room-a', 'remote-agent-a');
    expect(fixture.lifecycle.leaveRoom).toHaveBeenCalledWith(
      fixture.ref,
      'room-a',
      'local-agent-a',
      'owner-a'
    );
  });

  it('waits for the owner-qualified local Leave fence before replying', async () => {
    let releaseFence!: () => void;
    const fenced = new Promise<void>((resolve) => {
      releaseFence = resolve;
    });
    fixture.lifecycle.leaveRoom.mockImplementationOnce(() => fenced.then(() => undefined));

    let responseSettled = false;
    const responsePromise = request(testServer)
      .delete(`/api/communities/${fixture.ref}/rooms/room-a/agents/local-agent-a/membership`)
      .then((response) => {
        responseSettled = true;
        return response;
      });

    await vi.waitFor(() => expect(fixture.adapter.removeMember).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(fixture.lifecycle.leaveRoom).toHaveBeenCalledOnce());
    expect(responseSettled).toBe(false);

    releaseFence();
    expect((await responsePromise).status).toBe(200);
  });

  it('waits for the local ejection fence before beginning remote cleanup or replying', async () => {
    let releaseFence!: () => void;
    const fenced = new Promise<void>((resolve) => {
      releaseFence = resolve;
    });
    fixture.lifecycle.revokeEnrollment.mockImplementationOnce(() => fenced.then(() => undefined));

    let responseSettled = false;
    const responsePromise = request(testServer)
      .delete(`/api/communities/${fixture.ref}/agents/local-agent-a`)
      .then((response) => {
        responseSettled = true;
        return response;
      });

    await vi.waitFor(() =>
      expect(fixture.lifecycle.revokeEnrollment).toHaveBeenCalledWith(
        fixture.ref,
        'local-agent-a',
        'owner-a'
      )
    );
    expect(fixture.adapter.revokeAgent).not.toHaveBeenCalled();
    expect(responseSettled).toBe(false);

    releaseFence();
    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(fixture.adapter.revokeAgent).toHaveBeenCalledWith('remote-agent-a');
  });

  it('halts only the requested agent in the requested qualified room', async () => {
    fixture.lifecycle.haltRoomAgent.mockResolvedValueOnce(1);
    const response = await request(testServer).post(
      `/api/communities/${fixture.ref}/rooms/room-a/agents/local-agent-a/halt`
    );
    expect(response.status).toBe(200);
    expect(HaltRoomResponseSchema.parse(response.body)).toEqual({ stopped: 1 });
    expect(fixture.lifecycle.haltRoomAgent).toHaveBeenCalledWith(
      fixture.ref,
      'room-a',
      'local-agent-a',
      'owner-a'
    );
    expect(fixture.lifecycle.haltAgent).not.toHaveBeenCalled();
  });

  it('releases only an owner-qualified pending delivery through the worker retry gate', async () => {
    const response = await request(testServer).post(
      `/api/communities/${fixture.ref}/rooms/room-a/deliveries/delivery-retry-a/retry`
    );
    expect(response.status).toBe(200);
    expect(response.body.deliveries[0]).toMatchObject({
      idempotencyKey: 'delivery-retry-a',
      state: 'pending',
      retryable: true,
    });
    const malformed = await request(testServer).post(
      `/api/communities/bad%21/rooms/room-a/deliveries/delivery-retry-a/retry`
    );
    expect(malformed.status).toBe(400);
  });

  it('treats an already in-flight or queued delivery as an idempotent accepted retry', async () => {
    fixture.retryResult = 'in-flight';
    const response = await request(testServer).post(
      `/api/communities/${fixture.ref}/rooms/room-a/deliveries/delivery-retry-a/retry`
    );
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      community: fixture.ref,
      roomId: 'room-a',
      deliveries: [
        {
          idempotencyKey: 'delivery-retry-a',
          state: 'pending',
          retryable: false,
        },
      ],
    });
    expect(fixture.retryCalls).toEqual([
      {
        communityRef: fixture.ref,
        remoteRoomId: 'room-a',
        ownerAuthorId: 'owner-a',
        idempotencyKey: 'delivery-retry-a',
      },
    ]);

    fixture.retryResult = 'queued';
    const queued = await request(testServer).post(
      `/api/communities/${fixture.ref}/rooms/room-a/deliveries/delivery-retry-a/retry`
    );
    expect(queued.status).toBe(202);
    expect(queued.body).toMatchObject({
      community: fixture.ref,
      roomId: 'room-a',
      deliveries: [{ idempotencyKey: 'delivery-retry-a', state: 'pending', retryable: false }],
    });

    fixture.retryResult = 'terminal';
    const terminal = await request(testServer).post(
      `/api/communities/${fixture.ref}/rooms/room-a/deliveries/delivery-retry-a/retry`
    );
    expect(terminal.status).toBe(409);
    expect(terminal.body).toEqual({ error: 'Delivery cannot be retried.' });
  });

  it('stops local remote-room work through the owner-qualified lifecycle without a remote request', async () => {
    fixture.lifecycle.haltRoom.mockResolvedValueOnce(2);
    fixture.lifecycle.haltRoomAgent.mockResolvedValueOnce(1);
    const room = await request(testServer).post(
      `/api/communities/${fixture.ref}/rooms/room-a/halt`
    );
    const agent = await request(testServer).post(
      `/api/communities/${fixture.ref}/rooms/room-a/agents/local-agent-a/halt`
    );
    expect(room.status).toBe(200);
    expect(HaltRoomResponseSchema.parse(room.body)).toEqual({ stopped: 2 });
    expect(agent.status).toBe(200);
    expect(HaltRoomResponseSchema.parse(agent.body)).toEqual({ stopped: 1 });
    expect(fixture.adapter.postEntry).not.toHaveBeenCalled();
  });
});
