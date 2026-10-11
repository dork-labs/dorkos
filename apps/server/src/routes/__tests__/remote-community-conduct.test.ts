/** @vitest-environment node */
import express from 'express';
import request from '@dorkos/test-utils/supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';
import type { CommunityRef } from '@dorkos/shared/community-adapter';
import type { CommunityConnectionDescriptor } from '@dorkos/shared/community-connections';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => {
  const ref = 'remote_owner_a' as CommunityRef;
  const full = { read: true, post: true, enrollAgent: true, stream: true };
  const adapter = {
    getStanding: vi.fn(async () => ({
      mutedUntil: null,
      slowModeSeconds: 30,
      rules: { text: 'Be kind.', version: 3, acceptedVersion: 2 },
    })),
    acceptRules: vi.fn(async (version: number) => ({
      text: 'Be kind.',
      version,
      acceptedVersion: version,
    })),
    setDisplayName: vi.fn(async (displayName: string) => ({
      community: ref,
      memberId: 'human-a',
      kind: 'human' as const,
      displayName,
      handle: 'ada',
      role: 'member',
      ownerMemberId: null,
      joinedAt: '2026-10-01T00:00:00.000Z',
    })),
    reportEntry: vi.fn(async () => undefined),
    postEntry: vi.fn(),
  };
  return { ref, full, effective: full as typeof full, adapter };
});

vi.mock('../community-connections.js', () => ({
  resolveCommunityOwner: () => 'owner-a',
}));
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn(() => undefined) },
}));
vi.mock('../../services/rooms/index.js', () => ({ getRoomService: () => ({}) }));
vi.mock('../../services/communities/remote/state.js', () => ({
  getRemoteCommunityAdapter: () => fixture.adapter,
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
        effective: fixture.effective,
        lastKnown: {
          lifecycle: 'active',
          capabilities: fixture.effective,
          verifiedAt: '2026-10-01T00:00:00.000Z',
        },
      },
      attention: null,
    }),
  }),
}));

import { createRemoteCommunitiesRouter } from '../remote-communities.js';
import { PinnedHttpError } from '../../services/communities/remote/pinned-origin.js';

const instance = express();
instance.use(express.json());
instance.use('/api/communities', createRemoteCommunitiesRouter());
const server = listeningServer(instance);
const base = `/api/communities/${fixture.ref}`;

describe('a person’s own conduct in a space, through this computer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fixture.effective = fixture.full;
  });

  it('reads the person’s standing in one channel', async () => {
    const response = await request(server).get(`${base}/rooms/room-a/standing`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      community: fixture.ref,
      roomId: 'room-a',
      mutedUntil: null,
      slowModeSeconds: 30,
      rules: { text: 'Be kind.', version: 3, acceptedVersion: 2 },
    });
    expect(fixture.adapter.getStanding).toHaveBeenCalledWith('room-a');
  });

  it('accepts the rules in the version read, renames, and reports for the person', async () => {
    const accepted = await request(server).post(`${base}/rules/accept`).send({ version: 3 });
    expect(accepted.status).toBe(200);
    expect(accepted.body.rules).toEqual({ text: 'Be kind.', version: 3, acceptedVersion: 3 });
    expect(fixture.adapter.acceptRules).toHaveBeenCalledWith(3);

    const renamed = await request(server)
      .put(`${base}/me/display-name`)
      .send({ displayName: '  Ada L  ' });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toEqual({ community: fixture.ref, displayName: 'Ada L' });

    const reported = await request(server)
      .post(`${base}/rooms/room-a/entries/entry-a/reports`)
      .send({ reason: 'harassment', note: 'Third time today' });
    expect(reported.status).toBe(204);
    expect(reported.text).toBe('');
    expect(fixture.adapter.reportEntry).toHaveBeenCalledWith('room-a', 'entry-a', {
      reason: 'harassment',
      note: 'Third time today',
    });
  });

  it('refuses an agent on this computer every one of a person’s own acts', async () => {
    for (const response of [
      await request(server)
        .post(`${base}/rules/accept`)
        .set('x-dorkos-agent', 'agent-token')
        .send({ version: 3 }),
      await request(server)
        .put(`${base}/me/display-name`)
        .set('x-dorkos-agent', 'agent-token')
        .send({ displayName: 'Agent' }),
      await request(server)
        .post(`${base}/rooms/room-a/entries/entry-a/reports`)
        .set('x-dorkos-agent', 'agent-token')
        .send({ reason: 'spam' }),
      // An approval token marks a caller acting under someone else's say-so, never the person.
      await request(server)
        .post(`${base}/rules/accept`)
        .set('x-dorkos-approval', 'token')
        .send({ version: 3 }),
    ]) {
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('COMMUNITY_PERSON_REQUIRED');
    }
    expect(fixture.adapter.acceptRules).not.toHaveBeenCalled();
    expect(fixture.adapter.setDisplayName).not.toHaveBeenCalled();
    expect(fixture.adapter.reportEntry).not.toHaveBeenCalled();
  });

  it('refuses a malformed request before it reaches the space', async () => {
    expect((await request(server).post(`${base}/rules/accept`).send({ version: 0 })).status).toBe(
      400
    );
    expect(
      (await request(server).put(`${base}/me/display-name`).send({ displayName: 'a\u0007b' }))
        .status
    ).toBe(400);
    expect(
      (
        await request(server)
          .post(`${base}/rooms/room-a/entries/entry-a/reports`)
          .send({ reason: 'rude', note: 'x' })
      ).status
    ).toBe(400);
    expect(
      (
        await request(server)
          .post(`${base}/rooms/room-a/entries/entry-a/reports`)
          .send({ reason: 'spam', note: 'x'.repeat(1_001) })
      ).status
    ).toBe(400);
    expect(fixture.adapter.reportEntry).not.toHaveBeenCalled();
  });

  it('needs a connection that may post for every change, and only reading for standing', async () => {
    fixture.effective = { read: true, post: false, enrollAgent: false, stream: true };
    expect((await request(server).get(`${base}/rooms/room-a/standing`)).status).toBe(200);
    const refused = await request(server).post(`${base}/rules/accept`).send({ version: 3 });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('COMMUNITY_ACCESS_DENIED');
    expect(fixture.adapter.acceptRules).not.toHaveBeenCalled();
  });

  it('says what a space’s conflict means for each act', async () => {
    fixture.adapter.setDisplayName.mockRejectedValueOnce(
      new PinnedHttpError(409, 'STATE_CONFLICT')
    );
    const taken = await request(server)
      .put(`${base}/me/display-name`)
      .send({ displayName: 'Olive Owner' });
    expect(taken.status).toBe(409);
    expect(taken.body.error).toBe('That name is taken in this space. Try another.');

    fixture.adapter.acceptRules.mockRejectedValueOnce(new PinnedHttpError(409, 'STATE_CONFLICT'));
    const stale = await request(server).post(`${base}/rules/accept`).send({ version: 2 });
    expect(stale.body.error).toBe('The rules changed. Read them again first.');

    fixture.adapter.reportEntry.mockRejectedValueOnce(new PinnedHttpError(409, 'STATE_CONFLICT'));
    const own = await request(server)
      .post(`${base}/rooms/room-a/entries/entry-a/reports`)
      .send({ reason: 'spam' });
    expect(own.body.error).toBe('You can’t report this message.');
  });

  it('names each hold on a refused post, with slow mode’s wait as Retry-After', async () => {
    const post = () =>
      request(server)
        .post(`${base}/rooms/room-a/entries`)
        .send({ text: 'hello', idempotencyKey: 'key-a' });

    fixture.adapter.postEntry.mockRejectedValueOnce(
      new PinnedHttpError(429, 'COMMUNITY_SLOW_MODE', 12)
    );
    const slow = await post();
    expect(slow.status).toBe(429);
    expect(slow.body.code).toBe('COMMUNITY_SLOW_MODE');
    expect(slow.headers['retry-after']).toBe('12');

    fixture.adapter.postEntry.mockRejectedValueOnce(new PinnedHttpError(403, 'COMMUNITY_MUTED'));
    const muted = await post();
    expect(muted.body).toEqual({
      code: 'COMMUNITY_MUTED',
      error: 'You’re muted in this space for now.',
    });
    expect(muted.headers['retry-after']).toBeUndefined();

    fixture.adapter.postEntry.mockRejectedValueOnce(
      new PinnedHttpError(403, 'COMMUNITY_RULES_NOT_ACCEPTED')
    );
    expect((await post()).body.code).toBe('COMMUNITY_RULES_NOT_ACCEPTED');
  });
});
