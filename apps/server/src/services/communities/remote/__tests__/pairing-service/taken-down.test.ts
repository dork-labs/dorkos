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
import { logger } from '../../../../../lib/logger.js';
import { RemoteConnectionStore } from '../../connection-store.js';
import { RemoteCommunityPairingService } from '../../pairing-service.js';
import {
  CommunityTakenDownError,
  RemoteCommunityAdapter,
  type RemoteNativeRoomEvent,
} from '../../remote-community-adapter.js';

describe('private remote pairing with real HTTP and encrypted local storage', () => {
  // DOR-2334 part 3: a whole community its host took down (DOR-2293).
  describe('a community its host took down', () => {
    async function connectedTo(owner: string) {
      fake.approved = true;
      const store = new RemoteConnectionStore(directory);
      const revokeConnection = vi.fn(async () => undefined);
      const service = new RemoteCommunityPairingService(store, revokeConnection, undefined, {
        freshMs: 0,
      });
      const started = await service.start(owner, `${origin}/c/${remoteCommunityId}`, 'Takedown');
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
    const access = `${qualified}/me/connection-access`;
    afterEach(() => {
      fake.rejectedAuthorization = undefined;
      fake.rejectedPath = undefined;
      fake.rejectedStatus = 403;
      fake.rejectedCode = undefined;
      fake.eventsTail = '';
    });

    // Purpose: `423 COMMUNITY_TAKEN_DOWN` records `taken_down` and purges exactly this
    // connection's copies at once, even though the host can reverse it; later checks don't purge
    // again, and a failed purge is retried. It fails if a takedown reads as an archive or outage.
    it('records a takedown and purges once, retrying a failed purge', async () => {
      const { service, revokeConnection, ref } = await connectedTo('taken-owner');
      refuse(access, 423, 'COMMUNITY_TAKEN_DOWN');
      revokeConnection.mockRejectedValueOnce(new Error('purge failed'));
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

      const first = await service.status(ref, 'taken-owner');
      await service.status(ref, 'taken-owner');
      await service.status(ref, 'taken-owner');
      warn.mockRestore();

      expect(first.access).toMatchObject({
        state: 'verified',
        effective: { read: false, post: false, enrollAgent: false, stream: false },
        lastKnown: { lifecycle: 'taken_down' },
      });
      // Failed, retried and succeeded, then left alone; only ever this connection.
      expect(revokeConnection.mock.calls).toEqual([
        [ref, 'taken-owner'],
        [ref, 'taken-owner'],
      ]);
      await service.disconnect(ref, 'taken-owner');
    });

    // Purpose: a host suspension is not a takedown and purges nothing, including the
    // `503 COMMUNITY_SUSPENDED` a community that was never taken down answers.
    it('never purges on a suspension', async () => {
      const { service, revokeConnection, ref } = await connectedTo('suspended-owner');
      refuse(access, 503, 'COMMUNITY_SUSPENDED');
      const answer = await service.status(ref, 'suspended-owner');
      expect(revokeConnection).not.toHaveBeenCalled();
      expect(answer.access?.lastKnown?.lifecycle).not.toBe('taken_down');
      await service.disconnect(ref, 'suspended-owner');
    });

    // Purpose: as the real Community does it. A takedown revokes every grant; a reversal
    // suspends the community (no purge, and it no longer shows as taken down); once the host lifts
    // that, the old grant is rejected (401), so the connection needs reconnecting rather than
    // staying "taken down". Reconnecting is a new connection, which a later takedown purges
    // afresh. It fails if a reversal stays "taken down", or a reversal purges.
    it('follows a reversal to reconnecting, and purges a takedown of the new connection', async () => {
      const { service, revokeConnection, ref } = await connectedTo('reversed-owner');
      refuse(access, 423, 'COMMUNITY_TAKEN_DOWN');
      await service.status(ref, 'reversed-owner');
      expect(revokeConnection.mock.calls).toEqual([[ref, 'reversed-owner']]);

      refuse(access, 503, 'COMMUNITY_SUSPENDED');
      const suspended = await service.status(ref, 'reversed-owner');
      expect(suspended.access?.lastKnown?.lifecycle).toBe('suspended');
      expect(revokeConnection).toHaveBeenCalledTimes(1);

      // The host lifts the suspension; the grant the takedown revoked is refused.
      refuse(access, 401);
      const lifted = await service.status(ref, 'reversed-owner');
      expect(lifted.status).toBe('reconnect-required');
      expect(lifted.access?.state).toBe('reconnect-required');
      await service.disconnect(ref, 'reversed-owner');

      // Connecting again, then taken down again: that connection is purged too.
      fake.rejectedAuthorization = undefined;
      const again = await connectedTo('reversed-owner');
      expect(
        (await again.service.status(again.ref, 'reversed-owner')).access?.lastKnown
      ).toMatchObject({ lifecycle: 'active' });
      refuse(access, 423, 'COMMUNITY_TAKEN_DOWN');
      await again.service.status(again.ref, 'reversed-owner');
      expect(again.revokeConnection.mock.calls).toEqual([[again.ref, 'reversed-owner']]);
      await again.service.disconnect(again.ref, 'reversed-owner');
    });

    // Purpose (review 1): the host reverses AND lifts the takedown before this installation checks
    // again, so the first answer after "taken down" is the revoked grant's 401. The connection then
    // needs reconnecting (the app's reconnect path), not a "taken down" panel with no way back.
    it('needs reconnecting when the next answer after a takedown is a rejected grant', async () => {
      const { service, ref } = await connectedTo('lifted-owner');
      refuse(access, 423, 'COMMUNITY_TAKEN_DOWN');
      await service.status(ref, 'lifted-owner');
      refuse(access, 401);
      const lifted = await service.status(ref, 'lifted-owner');
      expect(lifted).toMatchObject({
        status: 'reconnect-required',
        access: { state: 'reconnect-required' },
      });
      await service.disconnect(ref, 'lifted-owner');
    });

    // Purpose: a takedown the host lets run becomes a deletion; the `404 NOT_FOUND` after it is
    // final, without purging again.
    it('treats a 404 after a takedown as the deletion it became', async () => {
      const { service, revokeConnection, ref } = await connectedTo('after-owner');
      refuse(access, 423, 'COMMUNITY_TAKEN_DOWN');
      await service.status(ref, 'after-owner');
      refuse(access, 404, 'NOT_FOUND');
      const after = await service.status(ref, 'after-owner');
      expect(after.access?.lastKnown?.lifecycle).toBe('deleted');
      expect(revokeConnection).toHaveBeenCalledTimes(1);
      await service.disconnect(ref, 'after-owner');
    });

    // Purpose: every route family answers `423 COMMUNITY_TAKEN_DOWN` as gone (never as an archive
    // or a stale cursor) and nudges the access check; a stream closed as `taken_down` ends as
    // access revoked.
    it('answers 423 COMMUNITY_TAKEN_DOWN as gone on every route', async () => {
      const { store, service, ref } = await connectedTo('routes-owner');
      const goneSeen = vi.fn();
      const adapter = new RemoteCommunityAdapter(
        ref,
        'routes-owner',
        store,
        undefined,
        undefined,
        goneSeen
      );
      const channel = `${qualified}/channels/${remoteRoomId}`;
      refuse(`${channel}/entries`, 423, 'COMMUNITY_TAKEN_DOWN');
      await expect(adapter.listEntries(remoteRoomId)).rejects.toBeInstanceOf(
        CommunityTakenDownError
      );
      refuse(channel, 423, 'COMMUNITY_TAKEN_DOWN');
      await expect(adapter.getRoom(remoteRoomId)).resolves.toBeNull();
      refuse(`${channel}/members`, 423, 'COMMUNITY_TAKEN_DOWN');
      await expect(adapter.listMembers(remoteRoomId)).resolves.toEqual([]);
      refuse(`${qualified}/agents/${remoteAgentId}`, 423, 'COMMUNITY_TAKEN_DOWN');
      await expect(adapter.revokeAgent(remoteAgentId)).resolves.toBeUndefined();
      refuse(`${channel}/events`, 423, 'COMMUNITY_TAKEN_DOWN');
      await expect(
        adapter.subscribeNativeRoom(remoteRoomId)[Symbol.asyncIterator]().next()
      ).rejects.toBeInstanceOf(CommunityTakenDownError);
      expect(goneSeen).toHaveBeenCalledTimes(5);
      expect(goneSeen).toHaveBeenCalledWith(ref, 'routes-owner');

      fake.rejectedAuthorization = undefined;
      fake.eventsTail = `data: ${JSON.stringify({ type: 'closed', reason: 'taken_down', cursor: 'resume-1' })}\n\n`;
      const events: RemoteNativeRoomEvent[] = [];
      for await (const event of adapter.subscribeNativeRoom(remoteRoomId)) events.push(event);
      expect(events.at(-1)).toEqual({ type: 'room_closed', reason: 'access-revoked' });
      await service.disconnect(ref, 'routes-owner');
    });
  });

  describe('a community being deleted', () => {
    async function connectedWith(owner: string) {
      fake.approved = true;
      const store = new RemoteConnectionStore(directory);
      const revokeConnection = vi.fn(async () => undefined);
      const service = new RemoteCommunityPairingService(store, revokeConnection);
      const started = await service.start(
        owner,
        `${origin}/c/${remoteCommunityId}`,
        'Deletion test'
      );
      expect((await service.poll(started.connection.ref, owner)).status).toBe('connected');
      fake.approved = false;
      return { store, service, revokeConnection, ref: started.connection.ref };
    }

    afterEach(() => {
      fake.rejectedAuthorization = undefined;
      fake.rejectedPath = undefined;
      fake.rejectedStatus = 403;
      fake.rejectedCode = undefined;
      fake.accessLifecycle = 'active';
    });

    // Purpose: `423 COMMUNITY_DELETION_PENDING` on the access check purges this owner's copies of
    // exactly this community, through the revoke path, and records the deletion. It fails if the
    // answer is treated as an outage.
    it('purges this community’s copies when the Community says it is being deleted', async () => {
      const { store, service, revokeConnection, ref } = await connectedWith('deleting-owner');
      fake.rejectedAuthorization = `Bearer ${token}`;
      fake.rejectedPath = `${qualified}/me/connection-access`;
      fake.rejectedStatus = 423;
      fake.rejectedCode = 'COMMUNITY_DELETION_PENDING';

      const deleting = await service.status(ref, 'deleting-owner');

      expect(revokeConnection.mock.calls).toEqual([[ref, 'deleting-owner']]);
      expect(deleting.access).toMatchObject({
        state: 'verified',
        effective: { read: false, post: false, enrollAgent: false, stream: false },
        lastKnown: { lifecycle: 'deletion_pending' },
      });
      // The bearer stays: a cancelled deletion answers the next check with 401.
      await expect(store.personalToken(ref, 'deleting-owner')).resolves.toBeTruthy();
      await service.disconnect(ref, 'deleting-owner');
    });

    // Purpose: nothing that is not a definite deletion purges. A hold, an outage, another 423, and
    // a bare 404 (which a missing channel also answers) all keep every copy. It fails if the
    // classifier widens to any of them.
    const pending = () => {
      fake.rejectedAuthorization = `Bearer ${token}`;
      fake.rejectedPath = `${qualified}/me/connection-access`;
      fake.rejectedStatus = 423;
      fake.rejectedCode = 'COMMUNITY_DELETION_PENDING';
    };
    const lastKnown = async (store: RemoteConnectionStore, ref: string, owner: string) =>
      (await store.list(owner)).find((row) => row.ref === ref)?.access;

    // Purpose (review 1): a purge that throws never fails the connection list, and the no-access
    // deletion state is recorded whatever the purge did. It fails if the purge runs first or
    // its error escapes.
    it('records the deletion and answers even when the purge throws', async () => {
      fake.approved = true;
      const store = new RemoteConnectionStore(directory);
      const revokeConnection = vi.fn(async () => {
        throw new Error('purge failed');
      });
      const service = new RemoteCommunityPairingService(store, revokeConnection);
      const started = await service.start(
        'throwing-owner',
        `${origin}/c/${remoteCommunityId}`,
        'x'
      );
      await service.poll(started.connection.ref, 'throwing-owner');
      fake.approved = false;
      pending();
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

      await expect(service.list('throwing-owner')).resolves.toHaveLength(1);
      await expect(service.status(started.connection.ref, 'throwing-owner')).resolves.toMatchObject(
        { access: { lastKnown: { lifecycle: 'deletion_pending' } } }
      );
      expect(await lastKnown(store, started.connection.ref, 'throwing-owner')).toMatchObject({
        state: 'verified',
        effective: { read: false, post: false, enrollAgent: false, stream: false },
        lastKnown: { lifecycle: 'deletion_pending' },
      });
      warn.mockRestore();
      await service.disconnect(started.connection.ref, 'throwing-owner');
    });

    // Purpose (review 2): while a deletion stays pending, a purge that succeeded is not repeated
    // on every check; one that failed is tried again. It fails if every check purges, or if a
    // failed purge is never retried.
    it('purges once while the deletion is pending, and retries only a failed purge', async () => {
      const { service, revokeConnection, ref } = await connectedWith('once-owner');
      pending();
      revokeConnection.mockRejectedValueOnce(new Error('purge failed'));
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      await service.status(ref, 'once-owner');
      await service.status(ref, 'once-owner');
      await service.status(ref, 'once-owner');
      await service.status(ref, 'once-owner');
      warn.mockRestore();
      // Failed, retried and succeeded, then left alone.
      expect(revokeConnection).toHaveBeenCalledTimes(2);
      await service.disconnect(ref, 'once-owner');
    });

    // Purpose (review 3): after a deletion was seen pending, the community's `404 NOT_FOUND` is
    // final: recorded as deleted, purged if it was not yet, and not shown as merely offline. It
    // fails if the 404 is treated as an outage after a pending deletion.
    it('records a finished deletion after a pending one', async () => {
      const { store, service, revokeConnection, ref } = await connectedWith('finished-owner');
      pending();
      revokeConnection.mockRejectedValueOnce(new Error('purge failed'));
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      await service.status(ref, 'finished-owner');
      fake.rejectedStatus = 404;
      fake.rejectedCode = 'NOT_FOUND';
      const finished = await service.status(ref, 'finished-owner');
      await service.status(ref, 'finished-owner');
      warn.mockRestore();

      expect(finished.access).toMatchObject({
        state: 'verified',
        effective: { read: false, post: false, enrollAgent: false, stream: false },
        lastKnown: { lifecycle: 'deleted' },
      });
      expect((await lastKnown(store, ref, 'finished-owner'))?.lastKnown?.lifecycle).toBe('deleted');
      // The failed purge was retried by the 404, then not repeated.
      expect(revokeConnection).toHaveBeenCalledTimes(2);
      await service.disconnect(ref, 'finished-owner');
    });

    // Purpose (review 3): only the Community's `404 NOT_FOUND` (with its code) finishes a pending
    // deletion. A bare 404 (an older server, a proxy) or a 5xx after a pending deletion keeps it
    // pending. It fails if any 404 after a pending deletion counts as deleted.
    it.each([
      ['a bare 404', 404, undefined],
      ['a 5xx', 503, undefined],
    ] as Array<[string, number, string | undefined]>)(
      'keeps a pending deletion pending on %s',
      async (_label, status, code) => {
        const { store, service, ref } = await connectedWith('still-pending-owner');
        pending();
        await service.status(ref, 'still-pending-owner');
        fake.rejectedStatus = status;
        fake.rejectedCode = code;
        await service.status(ref, 'still-pending-owner');
        expect((await lastKnown(store, ref, 'still-pending-owner'))?.lastKnown?.lifecycle).toBe(
          'deletion_pending'
        );
        await service.disconnect(ref, 'still-pending-owner');
      }
    );

    const notGone: Array<[string, 'hold' | number, string | undefined]> = [
      ['a host hold (read-only)', 'hold', undefined],
      ['a 5xx', 503, undefined],
      ['a suspension', 503, 'COMMUNITY_SUSPENDED'],
      ['a held write refusal', 423, 'COMMUNITY_HELD'],
      ['an archived community', 423, 'COMMUNITY_ARCHIVED'],
      ['a bare 404', 404, undefined],
      ['a 404 NOT_FOUND', 404, 'NOT_FOUND'],
    ];
    it.each(notGone)('keeps every copy on %s', async (_label, status, code) => {
      const { service, revokeConnection, ref } = await connectedWith('kept-owner');
      if (status === 'hold') fake.accessLifecycle = 'archived';
      else {
        fake.rejectedAuthorization = `Bearer ${token}`;
        fake.rejectedPath = `${qualified}/me/connection-access`;
        fake.rejectedStatus = status;
        fake.rejectedCode = code;
      }

      const answer = await service.status(ref, 'kept-owner');

      expect(revokeConnection).not.toHaveBeenCalled();
      expect(answer.status).toBe('connected');
      expect(answer.access?.lastKnown?.lifecycle).not.toBe('deletion_pending');
      await service.disconnect(ref, 'kept-owner');
    });
  });
});
