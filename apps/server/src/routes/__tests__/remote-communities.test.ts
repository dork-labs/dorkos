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
  };
  return { ref, room, entry, adapter };
});

vi.mock('../community-connections.js', () => ({
  resolveCommunityOwner: () => 'owner-a',
}));
vi.mock('../../services/communities/remote/state.js', () => ({
  getRemoteCommunityAdapter: () => fixture.adapter,
  getRemoteConnectionStore: () => ({ get: async () => ({ remoteCommunityId: 'community-a' }) }),
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
    findAnyRemoteMember: () => null,
    findRemoteMember: () => null,
  }),
  getRemoteCommunityLifecycle: () => ({
    haltRoom: vi.fn(async () => 1),
    haltAgent: vi.fn(async () => 1),
  }),
}));
vi.mock('../../services/communities/remote/remote-community-adapter.js', () => ({
  remoteSequenceOf: () => 1,
  remoteAuthorOf: () => ({ displayName: 'Owner', kind: 'human' }),
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

  it('posts only as the connected human and returns a strict remote receipt', async () => {
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
    expect(accepted.body.entry).toMatchObject({ remoteSeq: 1, authorKind: 'human' });
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

  it('streams only validated remote events and lists owner-scoped active enrollments', async () => {
    const events = await request(testServer).get(
      `/api/communities/${fixture.ref}/rooms/room-a/events?since=cursor-before`
    );
    expect(events.status).toBe(200);
    expect(events.headers['content-type']).toContain('text/event-stream');
    expect(events.text).toContain('"type":"snapshot"');
    expect(events.text).toContain('"remoteSeq":1');

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
