/**
 * Connecting a space, letting its members wake your agents, and adding a
 * channel they answer in without a mention each wait for the owner to confirm
 * it's them (DOR-4355). Narrowing who wakes them, or where, stays immediate.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCommunityConnectionsRoutes } from '../community-connections.js';
import { createRoomSubsystem, setRoomService } from '../../services/rooms/index.js';
import { CommunityAttentionCache } from '../../services/communities/remote/community-attention-cache.js';
import { CommunityOwnerNoticeCache } from '../../services/communities/remote/community-owner-notice-cache.js';
import type { RemoteCommunityPairingService } from '../../services/communities/remote/pairing-service.js';
import type { CommunityNavigationPreferenceService } from '../../services/communities/community-navigation-preferences.js';
import type { CommunityOwnerNoticeAnnouncer } from '../../services/notifications/emitters/community-owner-replacement.js';
import type { RemoteWakePolicy } from '../../services/communities/remote/wake/wake-policy.js';
import { AnswerInChangedError } from '../../services/communities/remote/wake/answer-in-store.js';
import { resetHeldStepUpsForTests } from '../../services/core/auth/step-up/step-up-holds.js';
import { frontDoorStepUpHarness } from './front-door-step-up-harness.js';

const DESCRIPTOR = {
  ref: 'northwind',
  remoteCommunityId: 'northwind-space',
  label: 'Northwind',
  pinnedOrigin: 'https://northwind.example.test',
  connectedHumanMemberId: null,
  status: 'pending',
  expiresAt: null,
  access: null,
  attention: null,
};

describe('who can reach and wake your agents in a space waits for the owner', () => {
  const wake = { from: 'me' as 'me' | 'members', answerIn: [] as string[] };
  const policy = {
    get: vi.fn(async () => wake.from),
    set: vi.fn(async (_ref: unknown, _owner: unknown, value: 'me' | 'members') => {
      wake.from = value;
    }),
    getAnswerIn: vi.fn(async () => [...wake.answerIn]),
    setAnswerIn: vi.fn(
      async (
        _ref: unknown,
        _owner: unknown,
        channels: readonly string[],
        expect?: (current: readonly string[]) => boolean
      ) => {
        // As the store does inside its lock (Security S5 on DOR-4355 M3).
        if (expect && !expect(wake.answerIn)) throw new AnswerInChangedError();
        wake.answerIn = [...channels];
      }
    ),
  };
  const pairing = {
    start: vi.fn(async () => ({
      connection: DESCRIPTOR,
      approvalUrl: 'https://northwind.example.test/approve',
    })),
  };
  const owner = frontDoorStepUpHarness(() => {
    setRoomService(createRoomSubsystem({ db: owner.db() }).service);
    return [
      {
        path: '/api/community-connections',
        routes: createCommunityConnectionsRoutes(
          pairing as unknown as RemoteCommunityPairingService,
          {} as unknown as CommunityNavigationPreferenceService,
          new CommunityAttentionCache(),
          new CommunityOwnerNoticeCache(),
          { announce: vi.fn() } as unknown as CommunityOwnerNoticeAnnouncer,
          policy as unknown as Pick<RemoteWakePolicy, 'get' | 'set' | 'getAnswerIn' | 'setAnswerIn'>
        ),
      },
    ];
  });
  beforeEach(() => {
    resetHeldStepUpsForTests();
    wake.from = 'me';
    wake.answerIn = [];
    pairing.start.mockClear();
    policy.set.mockClear();
    policy.setAnswerIn.mockClear();
  });

  it.each(['direct', 'own-tunnel', 'managed'] as const)(
    'holds connecting a space from %s until the owner confirms it',
    async (via) => {
      const held = await owner
        .call('post', '/api/community-connections', via)
        .send({ url: 'https://northwind.example.test', installName: 'Northwind desk' });
      expect(held.status).toBe(428);
      expect(pairing.start).not.toHaveBeenCalled();
      expect((await owner.confirm(held.body.heldActionId, via, true)).body.code).toBe(
        'not-your-action'
      );
      expect(pairing.start).not.toHaveBeenCalled();
      expect((await owner.confirm(held.body.heldActionId, via)).body).toMatchObject({
        ok: true,
        status: 201,
        result: { approvalUrl: 'https://northwind.example.test/approve' },
      });
      expect(pairing.start).toHaveBeenCalledOnce();
    }
  );

  it('keeps connecting from Wi-Fi refused, with nothing held', async () => {
    const res = await owner
      .call('post', '/api/community-connections', 'wifi')
      .send({ url: 'https://northwind.example.test', installName: 'Northwind desk' });
    expect(res.status).toBe(403);
    expect(res.body.heldActionId).toBeUndefined();
    expect(pairing.start).not.toHaveBeenCalled();
  });

  it('holds letting members wake your agents until the owner confirms it', async () => {
    const url = '/api/community-connections/northwind/wake-agents-from';
    const held = await owner.call('put', url, 'own-tunnel').send({ wakeAgentsFrom: 'members' });
    expect(held.status).toBe(428);
    expect(wake.from).toBe('me');
    expect((await owner.confirm(held.body.heldActionId, 'own-tunnel', true)).body.code).toBe(
      'not-your-action'
    );
    expect(wake.from).toBe('me');
    expect((await owner.confirm(held.body.heldActionId, 'own-tunnel')).body).toMatchObject({
      ok: true,
      status: 200,
      result: { wakeAgentsFrom: 'members' },
    });
    expect(wake.from).toBe('members');

    // Back to only you is immediate.
    const narrowed = await owner.call('put', url, 'own-tunnel').send({ wakeAgentsFrom: 'me' });
    expect(narrowed.status).toBe(200);
    expect(narrowed.body.heldActionId).toBeUndefined();
    expect(wake.from).toBe('me');
  });

  it('holds adding a channel your agents answer in until the owner confirms it', async () => {
    const url = '/api/community-connections/northwind/answer-in';
    const held = await owner.call('put', url, 'managed').send({ answerIn: ['#Help'] });
    expect(held.status).toBe(428);
    expect(wake.answerIn).toEqual([]);
    expect((await owner.confirm(held.body.heldActionId, 'managed', true)).body.code).toBe(
      'not-your-action'
    );
    expect(policy.setAnswerIn).not.toHaveBeenCalled();
    expect((await owner.confirm(held.body.heldActionId, 'managed')).body).toMatchObject({
      ok: true,
      status: 200,
      result: { answerIn: ['help'] },
    });
    expect(wake.answerIn).toEqual(['help']);

    // Taking a channel away is immediate.
    const narrowed = await owner.call('put', url, 'managed').send({ answerIn: [] });
    expect(narrowed.status).toBe(200);
    expect(narrowed.body.heldActionId).toBeUndefined();
    expect(wake.answerIn).toEqual([]);
  });

  // Security S5 on DOR-4355 M3: a save read as adding nothing must still add nothing when it lands.
  it('answers 409 for a free save judged before the person took a channel away', async () => {
    const url = '/api/community-connections/northwind/answer-in';
    // Read before the person's removal landed: #help was still listed.
    policy.getAnswerIn.mockResolvedValueOnce(['help']);
    const res = await owner.call('put', url, 'own-tunnel').send({ answerIn: ['#Help'] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ANSWER_IN_CHANGED');
    expect(wake.answerIn).toEqual([]);
  });
});
