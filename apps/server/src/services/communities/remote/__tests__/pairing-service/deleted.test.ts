import {
  fake,
  token,
  remoteCommunityId,
  remoteAgentId,
  remoteRoomId,
  qualified,
  directory,
  origin,
} from './fake-community.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CommunityRoomNotFoundError,
  StaleCommunityCursorError,
} from '@dorkos/shared/community-adapter';
import { COMMUNITY_SEEMS_GONE_AFTER_MS } from '@dorkos/shared/community-connections';
import { RemoteConnectionStore } from '../../connection-store.js';
import { RemoteCommunityPairingService } from '../../pairing-service.js';
import {
  CommunityDeletedError,
  RemoteCommunityAdapter,
  type RemoteNativeRoomEvent,
} from '../../remote-community-adapter.js';
import { logger } from '../../../../../lib/logger.js';

describe('private remote pairing with real HTTP and encrypted local storage', () => {
  // DOR-2334. What the access check treats as "the community is gone", which purges every copy
  // this installation made of it, and what it must not.
  // DOR-2334 part 2: the Community's `410 COMMUNITY_DELETED`, and a community that only ever
  // answers "not found".
  describe('a community that was deleted', () => {
    const clock = { now: Date.parse('2026-09-29T00:00:00.000Z') };
    async function connectedAt(owner: string) {
      fake.approved = true;
      const store = new RemoteConnectionStore(directory);
      const revokeConnection = vi.fn(async () => undefined);
      const service = new RemoteCommunityPairingService(store, revokeConnection, undefined, {
        now: () => clock.now,
        freshMs: 0,
      });
      const started = await service.start(owner, `${origin}/c/${remoteCommunityId}`, 'Deleted');
      expect((await service.poll(started.connection.ref, owner)).status).toBe('connected');
      fake.approved = false;
      return { store, service, revokeConnection, ref: started.connection.ref };
    }
    const refuse = (path: string, status: number, code?: string) => {
      fake.rejectedAuthorization = `Bearer ${token}`;
      fake.rejectedPath = path;
      fake.rejectedStatus = status;
      fake.rejectedCode = code;
    };

    afterEach(() => {
      fake.rejectedAuthorization = undefined;
      fake.rejectedPath = undefined;
      fake.rejectedStatus = 403;
      fake.rejectedCode = undefined;
      fake.eventsTail = '';
      clock.now = Date.parse('2026-09-29T00:00:00.000Z');
    });

    // Purpose: `410 COMMUNITY_DELETED` on the access check is a definite deletion, even never
    // having seen it pending: recorded as `deleted`, and the copies purged. It fails if a 410 is
    // read as a stale cursor or an outage.
    it('records the deletion and purges on 410 COMMUNITY_DELETED', async () => {
      const { service, revokeConnection, ref } = await connectedAt('gone-owner');
      refuse(`${qualified}/me/connection-access`, 410, 'COMMUNITY_DELETED');

      const answer = await service.status(ref, 'gone-owner');

      expect(revokeConnection.mock.calls).toEqual([[ref, 'gone-owner']]);
      expect(answer.access).toMatchObject({
        state: 'verified',
        effective: { read: false, post: false, enrollAgent: false, stream: false },
        lastKnown: { lifecycle: 'deleted' },
      });
      await service.disconnect(ref, 'gone-owner');
    });

    // Purpose (DOR-2575): what the community's agents never delivered is counted BEFORE the purge,
    // which stops those posts and removes their rooms, and the count outlives it: a later check,
    // when the posts are already stopped and would count none, keeps the first answer. The
    // person's removal forgets it. It fails if the count is taken after the purge, recounted on a
    // later check, dropped from the descriptor, or left behind after removal.
    it('counts undelivered agent posts before the purge and keeps that count', async () => {
      fake.approved = true;
      const store = new RemoteConnectionStore(directory);
      let waiting = 3;
      const order: string[] = [];
      const countUndelivered = vi.fn(() => {
        order.push('count');
        return waiting;
      });
      const revokeConnection = vi.fn(async () => {
        order.push('purge');
        waiting = 0;
      });
      const service = new RemoteCommunityPairingService(
        store,
        revokeConnection,
        undefined,
        { now: () => clock.now, freshMs: 0 },
        countUndelivered
      );
      // The count is kept before the gone lifecycle is saved, so a crash between them keeps it.
      const record = store.recordUndeliveredWhenGone.bind(store);
      vi.spyOn(store, 'recordUndeliveredWhenGone').mockImplementation(async (...args) => {
        order.push('keep count');
        return record(...args);
      });
      const updateAccess = store.updateAccess.bind(store);
      vi.spyOn(store, 'updateAccess').mockImplementation(async (...args) => {
        if (args[2].lastKnown?.lifecycle === 'deleted') order.push('save gone');
        return updateAccess(...args);
      });
      const started = await service.start(
        'undelivered-owner',
        `${origin}/c/${remoteCommunityId}`,
        'Deleted'
      );
      const ref = started.connection.ref;
      expect((await service.poll(ref, 'undelivered-owner')).status).toBe('connected');
      fake.approved = false;
      expect((await service.status(ref, 'undelivered-owner')).undeliveredAgentMessages).toBe(
        undefined
      );

      refuse(`${qualified}/me/connection-access`, 410, 'COMMUNITY_DELETED');
      expect((await service.status(ref, 'undelivered-owner')).undeliveredAgentMessages).toBe(3);
      expect(order).toEqual(['count', 'keep count', 'save gone', 'purge']);
      expect(countUndelivered).toHaveBeenCalledWith(ref, 'undelivered-owner');

      // Checked again (a new server start would be the same): the posts are stopped by now.
      expect((await service.status(ref, 'undelivered-owner')).undeliveredAgentMessages).toBe(3);
      expect((await service.list('undelivered-owner'))[0]?.undeliveredAgentMessages).toBe(3);
      expect(countUndelivered).toHaveBeenCalledOnce();

      await service.disconnect(ref, 'undelivered-owner');
      expect(await store.undeliveredWhenGone(ref, 'undelivered-owner')).toBe(0);
    });

    // Purpose (DOR-2575): a community that answers as live again (a reversed takedown the person
    // reconnected to) no longer reports what once went undelivered. It fails if the old count
    // lingers onto a working community.
    it('forgets the undelivered count once the community answers as live', async () => {
      const { store, service, ref } = await connectedAt('live-again-owner');
      await store.recordUndeliveredWhenGone(ref, 'live-again-owner', 2);
      const answer = await service.status(ref, 'live-again-owner');
      expect(answer.access?.state).toBe('verified');
      expect(answer.undeliveredAgentMessages).toBeUndefined();
      expect(await store.undeliveredWhenGone(ref, 'live-again-owner')).toBe(0);
      await service.disconnect(ref, 'live-again-owner');
    });

    // Purpose (DOR-2575): a count that cannot be taken never holds up the purge.
    it('still purges when the undelivered count fails', async () => {
      fake.approved = true;
      const store = new RemoteConnectionStore(directory);
      const revokeConnection = vi.fn(async () => undefined);
      const service = new RemoteCommunityPairingService(
        store,
        revokeConnection,
        undefined,
        { now: () => clock.now, freshMs: 0 },
        () => {
          throw new Error('database closed');
        }
      );
      const started = await service.start(
        'count-fails-owner',
        `${origin}/c/${remoteCommunityId}`,
        'Deleted'
      );
      const ref = started.connection.ref;
      expect((await service.poll(ref, 'count-fails-owner')).status).toBe('connected');
      fake.approved = false;
      refuse(`${qualified}/me/connection-access`, 410, 'COMMUNITY_DELETED');
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const answer = await service.status(ref, 'count-fails-owner');
      warn.mockRestore();
      expect(revokeConnection).toHaveBeenCalledOnce();
      expect(answer.access?.lastKnown?.lifecycle).toBe('deleted');
      expect(answer.undeliveredAgentMessages).toBeUndefined();
      await service.disconnect(ref, 'count-fails-owner');
    });

    // Purpose: a 410 without that code (a stale cursor, an older route) is not a deletion.
    it('does not treat a 410 without the code as a deletion', async () => {
      const { service, revokeConnection, ref } = await connectedAt('stale-owner');
      refuse(`${qualified}/me/connection-access`, 410);
      const answer = await service.status(ref, 'stale-owner');
      expect(revokeConnection).not.toHaveBeenCalled();
      expect(answer.access?.lastKnown?.lifecycle).not.toBe('deleted');
      await service.disconnect(ref, 'stale-owner');
    });

    // Purpose (operator's rule: never delete on a guess): a community that only answers
    // `404 NOT_FOUND` is never purged. After 14 days of it, and not before, it "seems to be gone";
    // any answer from a community that exists resets the count. It fails if the prompt appears
    // early, if a 404 purges, or if the first-seen date is not kept.
    it('says a community seems to be gone only after 14 days of not found, and never purges', async () => {
      const { service, revokeConnection, ref } = await connectedAt('missing-owner');
      refuse(`${qualified}/me/connection-access`, 404, 'NOT_FOUND');
      const firstSeen = new Date(clock.now).toISOString();

      expect((await service.status(ref, 'missing-owner')).seemsGoneSince).toBeUndefined();
      clock.now += COMMUNITY_SEEMS_GONE_AFTER_MS - 1;
      expect((await service.status(ref, 'missing-owner')).seemsGoneSince).toBeUndefined();
      clock.now += 1;
      expect((await service.status(ref, 'missing-owner')).seemsGoneSince).toBe(firstSeen);
      expect((await service.list('missing-owner'))[0]?.seemsGoneSince).toBe(firstSeen);
      expect(revokeConnection).not.toHaveBeenCalled();

      // The Community answers again: the count starts over.
      fake.rejectedAuthorization = undefined;
      expect((await service.status(ref, 'missing-owner')).seemsGoneSince).toBeUndefined();
      refuse(`${qualified}/me/connection-access`, 404, 'NOT_FOUND');
      clock.now += COMMUNITY_SEEMS_GONE_AFTER_MS - 1;
      expect((await service.status(ref, 'missing-owner')).seemsGoneSince).toBeUndefined();
      expect(revokeConnection).not.toHaveBeenCalled();
      await service.disconnect(ref, 'missing-owner');
    });

    // Purpose (review 2): a rejected grant (401) is an answer from a community that exists, so it
    // resets the count — the connection then only needs reconnecting, and its check never runs
    // again, so a count left behind would offer "Remove local copy" for a live community. So do
    // other definite answers (a hold's 423). It fails if a 401 leaves the date in place.
    it.each([
      ['a rejected grant', 401, undefined],
      ['a hold', 423, 'COMMUNITY_HELD'],
    ] as Array<[string, number, string | undefined]>)(
      'starts the count over on %s',
      async (_label, status, code) => {
        const { store, service, ref } = await connectedAt('answered-owner');
        refuse(`${qualified}/me/connection-access`, 404, 'NOT_FOUND');
        await service.status(ref, 'answered-owner');
        expect(await store.notFoundSince(ref, 'answered-owner')).not.toBeNull();
        refuse(`${qualified}/me/connection-access`, status, code);
        await service.status(ref, 'answered-owner');
        expect(await store.notFoundSince(ref, 'answered-owner')).toBeNull();
        await service.disconnect(ref, 'answered-owner');
      }
    );

    // Purpose (review 3): once the deletion is recorded, another request answering
    // `410 COMMUNITY_DELETED` does not ask the Community again. It fails if every such request
    // re-runs the access check.
    it('stops nudging the access check once the deletion is recorded', async () => {
      const { service, revokeConnection, ref } = await connectedAt('nudged-owner');
      refuse(`${qualified}/me/connection-access`, 410, 'COMMUNITY_DELETED');
      const before = fake.accessRequests;
      await service.communityGoneSeen(ref, 'nudged-owner');
      expect(fake.accessRequests).toBe(before + 1);
      await service.communityGoneSeen(ref, 'nudged-owner');
      await service.communityGoneSeen(ref, 'nudged-owner');
      expect(fake.accessRequests).toBe(before + 1);
      expect(revokeConnection).toHaveBeenCalledOnce();
      await service.disconnect(ref, 'nudged-owner');
    });

    // Purpose: an outage between the 404s does not reset the count (it proves nothing), and the
    // explicit removal purges exactly that connection.
    it('keeps counting through an outage, and removes exactly that connection on request', async () => {
      const { store, service, revokeConnection, ref } = await connectedAt('outage-owner');
      refuse(`${qualified}/me/connection-access`, 404, 'NOT_FOUND');
      await service.status(ref, 'outage-owner');
      clock.now += COMMUNITY_SEEMS_GONE_AFTER_MS / 2;
      refuse(`${qualified}/me/connection-access`, 503);
      await service.status(ref, 'outage-owner');
      clock.now += COMMUNITY_SEEMS_GONE_AFTER_MS / 2;
      refuse(`${qualified}/me/connection-access`, 404, 'NOT_FOUND');
      expect((await service.status(ref, 'outage-owner')).seemsGoneSince).toBeDefined();

      // "Remove local copy" is the disconnect, which purges through the revoke path.
      await service.disconnect(ref, 'outage-owner');
      expect(revokeConnection.mock.calls).toEqual([[ref, 'outage-owner']]);
      expect(await store.list('outage-owner')).toEqual([]);
      expect(await store.notFoundSince(ref, 'outage-owner')).toBeNull();
    });

    // Purpose: every route family answers `410 COMMUNITY_DELETED` as "gone", never as a stale
    // cursor, and each nudges the access check: history, the room read, the roster, agent
    // removal, and a stream refused at open. A stream the Community closes as `deleted` ends as
    // access revoked. It fails if any of them still maps the 410 to a stale cursor or throws.
    it('answers 410 COMMUNITY_DELETED as gone on every route', async () => {
      const { store, service, ref } = await connectedAt('routes-owner');
      const deletedSeen = vi.fn();
      const adapter = new RemoteCommunityAdapter(
        ref,
        'routes-owner',
        store,
        undefined,
        undefined,
        deletedSeen
      );
      const channel = `${qualified}/channels/${remoteRoomId}`;

      refuse(`${channel}/entries`, 410, 'COMMUNITY_DELETED');
      const history = await adapter.listEntries(remoteRoomId).catch((error: unknown) => error);
      expect(history).toBeInstanceOf(CommunityDeletedError);
      expect(history).toBeInstanceOf(CommunityRoomNotFoundError);
      expect(history).not.toBeInstanceOf(StaleCommunityCursorError);

      refuse(channel, 410, 'COMMUNITY_DELETED');
      await expect(adapter.getRoom(remoteRoomId)).resolves.toBeNull();
      refuse(`${channel}/members`, 410, 'COMMUNITY_DELETED');
      await expect(adapter.listMembers(remoteRoomId)).resolves.toEqual([]);
      refuse(`${qualified}/agents/${remoteAgentId}`, 410, 'COMMUNITY_DELETED');
      await expect(adapter.revokeAgent(remoteAgentId)).resolves.toBeUndefined();

      refuse(`${channel}/events`, 410, 'COMMUNITY_DELETED');
      const stream = adapter.subscribeNativeRoom(remoteRoomId)[Symbol.asyncIterator]();
      await expect(stream.next()).rejects.toBeInstanceOf(CommunityDeletedError);

      expect(deletedSeen).toHaveBeenCalledTimes(5);
      expect(deletedSeen).toHaveBeenCalledWith(ref, 'routes-owner');

      // A stale cursor without the code still reads as one.
      refuse(`${channel}/entries`, 410);
      await expect(adapter.listEntries(remoteRoomId)).rejects.toBeInstanceOf(
        StaleCommunityCursorError
      );
      expect(deletedSeen).toHaveBeenCalledTimes(5);

      fake.rejectedAuthorization = undefined;
      fake.eventsTail = `data: ${JSON.stringify({ type: 'closed', reason: 'deleted', cursor: 'resume-1' })}\n\n`;
      const events: RemoteNativeRoomEvent[] = [];
      for await (const event of adapter.subscribeNativeRoom(remoteRoomId)) events.push(event);
      expect(events.at(-1)).toEqual({ type: 'room_closed', reason: 'access-revoked' });
      await service.disconnect(ref, 'routes-owner');
    });
  });
});
