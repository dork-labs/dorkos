/** @vitest-environment node */
import express from 'express';
import request from '@dorkos/test-utils/supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => {
  const ref = 'remote_owner_a';
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
  const adapter = {
    postEntry: vi.fn(async () => entry),
    listEntriesWithThreadRoot: vi.fn(async () => ({ entries: [entry], nextCursor: null })),
    uploadAttachment: vi.fn(async (_room: string, input: { bytes: AsyncIterable<Uint8Array> }) => {
      const bytes: Uint8Array[] = [];
      for await (const chunk of input.bytes) bytes.push(chunk);
      return {
        id: 'attachment-a',
        name: 'report.txt',
        contentType: 'text/plain',
        byteSize: bytes.reduce((total, chunk) => total + chunk.byteLength, 0),
        checksum: 'checksum-a',
      };
    }),
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
    refreshSubscriptions: vi.fn(),
  };
  return {
    ref,
    room,
    entry,
    adapter,
    lifecycle,
  };
});

vi.mock('../community-connections.js', () => ({
  resolveCommunityOwner: () => 'owner-a',
}));
vi.mock('../../services/communities/remote/state.js', () => ({
  getRemoteCommunityAdapter: () => fixture.adapter,
  getRemoteConnectionStore: () => ({ get: async () => ({ remoteCommunityId: 'community-a' }) }),
  getRemoteCommunityOriginIdempotencyKey: (
    ref: string,
    roomId: string,
    owner: string,
    entryId: string
  ) =>
    ref === fixture.ref && roomId === 'room-a' && owner === 'owner-a' && entryId === 'agent-echo-a'
      ? 'delivery-origin-a'
      : null,
  getRemoteCommunityDeliverySnapshot: () => ({
    community: fixture.ref,
    roomId: 'room-a',
    deliveries: [
      {
        idempotencyKey: 'delivery-retry-a',
        author: { kind: 'agent', displayName: 'Build Agent' },
        text: 'working on it',
        parentEntryId: null,
        attachments: [],
        state: 'pending',
        failure: null,
        retryable: true,
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
  retryRemoteCommunityDelivery: () => 'retried',
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

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use('/api/communities', createRemoteCommunitiesRouter());
  return instance;
}

const testServer = listeningServer(app());

describe('qualified remote community writes and live projections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it('relays bounded attachment bytes without returning a remote storage URL', async () => {
    const upload = await request(testServer)
      .post(`/api/communities/${fixture.ref}/rooms/room-a/attachments`)
      .set('content-type', 'application/octet-stream')
      .set('x-file-name', 'report.txt')
      .set('x-file-size', '5')
      .set('idempotency-key', 'attachment-retry-a')
      .send(Buffer.from('hello'));
    expect(upload.status).toBe(201);
    expect(upload.body.attachment).toMatchObject({ id: 'attachment-a', byteSize: 5 });
    expect(JSON.stringify(upload.body)).not.toContain('http');

    const download = await request(testServer).get(
      `/api/communities/${fixture.ref}/rooms/room-a/attachments/attachment-a`
    );
    expect(download.status).toBe(200);
    expect(download.headers['content-disposition']).toBe('attachment');
    expect(download.text).toBe('hello');
  });

  it('streams the owner-qualified delivery replacement only after its room snapshot', async () => {
    const events = await request(testServer).get(
      `/api/communities/${fixture.ref}/rooms/room-a/events?since=cursor-before`
    );
    expect(events.status).toBe(200);
    expect(events.headers['content-type']).toContain('text/event-stream');
    expect(events.text).toContain('"type":"snapshot"');
    expect(events.text).toContain('"remoteSeq":1');
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
    const response = await request(testServer).post(
      `/api/communities/${fixture.ref}/rooms/room-a/agents/local-agent-a/halt`
    );
    expect(response.status).toBe(200);
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

  it('stops local remote-room work through the owner-qualified lifecycle without a remote request', async () => {
    const room = await request(testServer).post(
      `/api/communities/${fixture.ref}/rooms/room-a/halt`
    );
    const agent = await request(testServer).post(
      `/api/communities/${fixture.ref}/rooms/room-a/agents/local-agent-a/halt`
    );
    expect(room.status).toBe(200);
    expect(room.body).toEqual({ stopped: true });
    expect(agent.status).toBe(200);
    expect(agent.body).toEqual({ stopped: true });
    expect(fixture.adapter.postEntry).not.toHaveBeenCalled();
  });
});
