/** @vitest-environment node */
/**
 * Direct messages with an agent in a space, through this computer (DOR-2955): the controls exist
 * only where the space holds them, the person's own come with a composer, someone's direct
 * message with this install's agent is read through that agent and only read, and the owner's
 * switch reaches the space and is remembered here.
 */
import request from '@dorkos/test-utils/supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';
import type { CommunityRef } from '@dorkos/shared/community-adapter';
import type { CommunityConnectionDescriptor } from '@dorkos/shared/community-connections';
import type { CommunityWireDirectMessage } from '@dorkos/shared/community-wire';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => {
  const ref = 'remote_owner_a' as CommunityRef;
  const full = { read: true, post: true, enrollAgent: true, stream: true };
  const adapter = {
    supportsDirectMessages: vi.fn(async () => true),
    listDirectMessages: vi.fn(async (_context?: { actingMemberId: string }) => [] as unknown[]),
    startDirectMessage: vi.fn(),
    setAgentDirectMessages: vi.fn(async (_id: string, accepts: boolean) => accepts),
    listEntriesWithThreadRoot: vi.fn(
      async (_roomId: string, _opts?: { cursor?: string; limit?: number }) =>
        ({ entries: [], nextCursor: null }) as { entries: unknown[]; nextCursor: string | null }
    ),
  };
  const enrollments = [
    { localAgentId: 'local-ana', remoteMemberId: 'remote-ana', ownerAuthorId: 'owner-a' },
    { localAgentId: 'local-cy', remoteMemberId: 'remote-cy', ownerAuthorId: 'owner-a' },
  ];
  const dmsStore = { set: vi.fn(async () => undefined), get: vi.fn(async () => []) };
  return { ref, full, adapter, enrollments, dmsStore };
});

vi.mock('../community-connections.js', () => ({ resolveCommunityOwner: () => 'owner-a' }));
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn(() => undefined) },
}));
vi.mock('../../services/rooms/index.js', () => ({ getRoomService: () => ({}) }));
vi.mock('../../services/communities/remote/dms/agent-dms-store.js', () => ({
  getAgentDmsStore: () => fixture.dmsStore,
}));
vi.mock('../../services/communities/remote/state.js', () => ({
  getRemoteCommunityAdapter: () => fixture.adapter,
  getRemoteCommunityEnrollmentStore: () => ({ activeForOwner: () => fixture.enrollments }),
  getRemotePairingService: () => ({
    status: async (): Promise<CommunityConnectionDescriptor> => ({
      ref: fixture.ref,
      remoteCommunityId: 'community-a',
      label: 'Community A',
      pinnedOrigin: 'https://community.example',
      connectedHumanMemberId: 'human-a',
      status: 'connected',
      expiresAt: null,
      access: {
        state: 'verified',
        effective: fixture.full,
        lastKnown: {
          lifecycle: 'active',
          capabilities: fixture.full,
          verifiedAt: '2026-10-01T00:00:00.000Z',
        },
      },
      attention: null,
    }),
  }),
}));

import { createRemoteCommunitiesRoutes } from '../remote-communities.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { PinnedHttpError } from '../../services/communities/remote/pinned-origin.js';
import { entry as projectEntry } from '../../services/communities/remote/adapter/remote-community-projection.js';

const server = listeningServer(
  honoGroupListener({ path: '/api/communities', routes: createRemoteCommunitiesRoutes() })
);
const base = `/api/communities/${fixture.ref}`;

/** One message in the space, as the adapter projects it. */
function spaceEntry(seq: number) {
  return projectEntry(fixture.ref, {
    id: `e-${seq}`,
    channelId: 'dm-bo-ana',
    seq,
    authorMemberId: 'human-b',
    authorDisplayName: 'Bo',
    authorKind: 'human',
    text: `message ${seq}`,
    mentions: [],
    parentEntryId: null,
    threadRootEntryId: null,
    cursor: `c-${seq}`,
    createdAt: '2026-10-16T00:00:00.000Z',
    attachments: [],
  });
}

function wireDm(id: string, member: string, agent = 'remote-ana'): CommunityWireDirectMessage {
  return {
    id,
    member: { memberId: member, displayName: member === 'human-a' ? 'Ada' : 'Bo' },
    agent: {
      memberId: agent,
      displayName: 'Ana',
      handle: 'ana',
      ownerMemberId: 'human-a',
      ownerDisplayName: 'Ada',
    },
    createdAt: '2026-10-16T00:00:00.000Z',
    unreadCount: 0,
  };
}

describe('direct messages in a space, through this computer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fixture.adapter.supportsDirectMessages.mockResolvedValue(true);
    fixture.adapter.listDirectMessages.mockResolvedValue([]);
  });

  it('says a space without them holds none, and asks it nothing more', async () => {
    // Purpose: fails if the controls show, or the space is asked, where it holds no DMs.
    fixture.adapter.supportsDirectMessages.mockResolvedValue(false);
    const response = await request(server).get(`${base}/dms`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ community: fixture.ref, available: false, dms: [] });
    expect(fixture.adapter.listDirectMessages).not.toHaveBeenCalled();
    const started = await request(server).post(`${base}/dms`).send({ agentMemberId: 'remote-x' });
    expect(started.status).toBe(404);
    expect(fixture.adapter.startDirectMessage).not.toHaveBeenCalled();
  });

  it('lists the person’s own with a composer, and their agents’ through the agent, read-only', async () => {
    fixture.adapter.listDirectMessages.mockImplementation(async (context) =>
      context
        ? [wireDm('dm-bo-ana', 'human-b'), wireDm('dm-ada-ana', 'human-a')]
        : [wireDm('dm-ada-ana', 'human-a'), wireDm('dm-ada-cy', 'human-a', 'remote-cy')]
    );
    const response = await request(server).get(`${base}/dms`);
    expect(response.status).toBe(200);
    expect(
      response.body.dms.map((dm: { roomId: string; readOnly: boolean; localAgentId?: string }) => [
        dm.roomId,
        dm.readOnly,
        dm.localAgentId ?? null,
      ])
    ).toEqual([
      ['dm-ada-ana', false, null],
      ['dm-ada-cy', false, null],
      ['dm-bo-ana', true, 'local-ana'],
    ]);
    expect(fixture.adapter.listDirectMessages).toHaveBeenCalledWith({
      actingMemberId: 'remote-ana',
    });
  });

  it('starts one, and says plainly when the agent takes none', async () => {
    fixture.adapter.startDirectMessage.mockResolvedValueOnce(
      wireDm('dm-ada-cy', 'human-a', 'remote-cy')
    );
    const ok = await request(server).post(`${base}/dms`).send({ agentMemberId: 'remote-cy' });
    expect(ok.status).toBe(200);
    expect(ok.body.dm).toMatchObject({ roomId: 'dm-ada-cy', readOnly: false });
    fixture.adapter.startDirectMessage.mockRejectedValueOnce(
      new PinnedHttpError(409, 'AGENT_NOT_TAKING_DMS')
    );
    const refused = await request(server).post(`${base}/dms`).send({ agentMemberId: 'remote-dee' });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('AGENT_NOT_TAKING_DMS');
  });

  it('sets the owner’s switch on the space and remembers it here', async () => {
    const response = await request(server)
      .put(`${base}/agents/local-ana/dms`)
      .send({ accepts: true });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ localAgentId: 'local-ana', acceptsDms: true });
    expect(fixture.adapter.setAgentDirectMessages).toHaveBeenCalledWith('remote-ana', true);
    expect(fixture.dmsStore.set).toHaveBeenCalledWith(fixture.ref, 'owner-a', 'local-ana', true);
    const stranger = await request(server)
      .put(`${base}/agents/local-not-mine/dms`)
      .send({ accepts: true });
    expect(stranger.status).toBe(404);
  });

  it('lists the rest when one agent’s direct messages can’t be read, and says so', async () => {
    fixture.adapter.listDirectMessages.mockImplementation(async (context) => {
      if (context?.actingMemberId === 'remote-cy') throw new Error('agent token refused');
      return context ? [wireDm('dm-bo-ana', 'human-b')] : [];
    });
    const response = await request(server).get(`${base}/dms`);
    expect(response.status).toBe(200);
    expect(response.body.incomplete).toBe(true);
    expect(response.body.dms.map((dm: { roomId: string }) => dm.roomId)).toEqual(['dm-bo-ana']);
  });

  it('reads one of the owner’s agents’ direct messages through that agent', async () => {
    fixture.adapter.listDirectMessages.mockResolvedValue([wireDm('dm-bo-ana', 'human-b')]);
    const response = await request(server).get(`${base}/dms/dm-bo-ana/entries?agent=local-ana`);
    expect(response.status).toBe(200);
    expect(fixture.adapter.listEntriesWithThreadRoot).toHaveBeenCalledWith('dm-bo-ana', {
      limit: 100,
      actingMemberId: 'remote-ana',
    });
    const other = await request(server).get(`${base}/dms/dm-bo-ana/entries?agent=local-nobody`);
    expect(other.status).toBe(404);
  });

  it('reads only a room that is one of that agent’s direct messages', async () => {
    fixture.adapter.listDirectMessages.mockResolvedValue([wireDm('dm-bo-ana', 'human-b')]);
    const channel = await request(server).get(`${base}/dms/general/entries?agent=local-ana`);
    expect(channel.status).toBe(404);
    expect(fixture.adapter.listEntriesWithThreadRoot).not.toHaveBeenCalled();
  });

  it('opens on the newest page of a long one, and a poll asks only for what came after', async () => {
    fixture.adapter.listDirectMessages.mockResolvedValue([wireDm('dm-bo-ana', 'human-b')]);
    // 250 entries in the space's oldest-first pages of 100.
    const all = Array.from({ length: 250 }, (_, i) => spaceEntry(i + 1));
    fixture.adapter.listEntriesWithThreadRoot.mockImplementation(
      async (_room: string, opts?: { cursor?: string }) => {
        const from = opts?.cursor ? Number(String(opts.cursor).slice('c-'.length)) : 0;
        const entries = all.slice(from, from + 100);
        return {
          entries,
          nextCursor: from + 100 < all.length ? `c-${from + 100}` : null,
        } as never;
      }
    );
    const opened = await request(server).get(`${base}/dms/dm-bo-ana/entries?agent=local-ana`);
    expect(opened.status).toBe(200);
    expect(opened.body.entries).toHaveLength(100);
    expect(opened.body.entries[0].text).toBe('message 151');
    expect(opened.body.entries.at(-1).text).toBe('message 250');

    const polled = await request(server).get(
      `${base}/dms/dm-bo-ana/entries?agent=local-ana&after=c-240`
    );
    expect(polled.body.entries.map((e: { text: string }) => e.text)).toEqual(
      Array.from({ length: 10 }, (_, i) => `message ${241 + i}`)
    );
    expect(fixture.adapter.listEntriesWithThreadRoot).toHaveBeenLastCalledWith('dm-bo-ana', {
      limit: 100,
      actingMemberId: 'remote-ana',
      cursor: 'c-240',
    });
  });
});
