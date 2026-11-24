import {
  fake,
  token,
  qualified,
  requests,
  revocations,
  agentRemovals,
  agentRemovalAnswers,
  directory,
  origin,
} from './fake-community.js';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../../../../../lib/logger.js';
import { RemoteConnectionStore, RemoteConnectionNotFoundError } from '../../connection-store.js';
import { EncryptedFileCredentialStore } from '../../../../core/credential-provider.js';
import { RemoteCommunityPairingService } from '../../pairing-service.js';
import { pinnedJson, PinnedHttpError } from '../../pinned-origin.js';

describe('private remote pairing with real HTTP and encrypted local storage', () => {
  // DOR-2603. Purpose: an agent this installation added must not stay active on the Community
  // after its only controller disconnects. These fail if disconnect stops removing the agents,
  // removes them after the grant that allows it is gone, touches an agent it did not add, or
  // hides one it could not remove.
  describe('disconnect removes the agents this installation added', () => {
    const scout = {
      localAgentId: 'scout-local',
      remoteMemberId: randomUUID(),
      displayName: 'Scout',
      active: true,
    };
    const echo = {
      localAgentId: 'echo-local',
      remoteMemberId: randomUUID(),
      displayName: 'Echo',
      active: true,
    };
    /** An agent removed here earlier, whose removal the Community may never have heard. */
    const relay = {
      localAgentId: 'relay-local',
      remoteMemberId: randomUUID(),
      displayName: 'Relay',
      active: false,
    };
    const view = (agent: typeof scout) => ({
      localAgentId: agent.localAgentId,
      displayName: agent.displayName,
    });

    async function connectedWith(owner: string, agents: (typeof scout)[]) {
      fake.approved = true;
      const store = new RemoteConnectionStore(directory);
      const reader = vi.fn((_ref: string, ownerKey: string) => (ownerKey === owner ? agents : []));
      const service = new RemoteCommunityPairingService(
        store,
        undefined,
        undefined,
        {},
        undefined,
        reader
      );
      const started = await service.start(owner, origin, 'Agents install');
      expect((await service.poll(started.connection.ref, owner)).status).toBe('connected');
      fake.approved = false;
      revocations.length = 0;
      agentRemovals.length = 0;
      return { store, service, reader, ref: started.connection.ref };
    }

    async function expectLocalCopyGone(store: RemoteConnectionStore, ref: string, owner: string) {
      expect(await store.list(owner)).toEqual([]);
      expect(
        await new EncryptedFileCredentialStore(directory).get(`community:${ref}:personal`)
      ).toBeNull();
    }

    afterEach(() => {
      fake.revocationAnswer = 204;
      revocations.length = 0;
      agentRemovals.length = 0;
      agentRemovalAnswers.clear();
    });

    it('removes each agent with its own bearer before revoking the grant', async () => {
      const { store, service, reader, ref } = await connectedWith('agents-owner', [scout, echo]);
      const before = requests.length;
      expect(await service.disconnect(ref, 'agents-owner')).toEqual({
        remoteRevoked: true,
        agentsNotRemoved: [],
      });
      expect(reader).toHaveBeenCalledWith(ref, 'agents-owner');
      expect(agentRemovals).toEqual(
        expect.arrayContaining([
          { memberId: scout.remoteMemberId, authorization: `Bearer ${token}` },
          { memberId: echo.remoteMemberId, authorization: `Bearer ${token}` },
        ])
      );
      expect(agentRemovals).toHaveLength(2);
      // Order: every agent removal reached the Community before the grant was revoked.
      const paths = requests.slice(before).map((request) => request.path);
      const revokedAt = paths.indexOf(`${qualified}/me/connection`);
      expect(revokedAt).toBeGreaterThan(
        paths.indexOf(`${qualified}/agents/${scout.remoteMemberId}`)
      );
      expect(revokedAt).toBeGreaterThan(
        paths.indexOf(`${qualified}/agents/${echo.remoteMemberId}`)
      );
      // Only the agents this installation added: it never lists the member's agents there.
      expect(paths.filter((path) => path === `${qualified}/agents`)).toEqual([]);
      await expectLocalCopyGone(store, ref, 'agents-owner');
    });

    it('names only the agent the Community would not remove, and still disconnects', async () => {
      const { store, service, ref } = await connectedWith('partial-owner', [scout, echo]);
      agentRemovalAnswers.set(scout.remoteMemberId, 500);
      expect(await service.disconnect(ref, 'partial-owner')).toEqual({
        remoteRevoked: true,
        agentsNotRemoved: [view(scout)],
      });
      expect(revocations).toHaveLength(1);
      await expectLocalCopyGone(store, ref, 'partial-owner');
    });

    it('names every agent when the Community cannot be reached, and still disconnects', async () => {
      const { store, service, ref } = await connectedWith('offline-owner', [scout, echo]);
      agentRemovalAnswers.set(scout.remoteMemberId, 'hang-up');
      agentRemovalAnswers.set(echo.remoteMemberId, 'hang-up');
      fake.revocationAnswer = 'hang-up';
      expect(await service.disconnect(ref, 'offline-owner')).toEqual({
        remoteRevoked: false,
        agentsNotRemoved: [view(scout), view(echo)],
      });
      // Nothing reached the Community, so the revoke is not tried only to wait out another timeout.
      expect(revocations).toEqual([]);
      await expectLocalCopyGone(store, ref, 'offline-owner');
    });

    // An agent revoked here was already removed on purpose. One enrolled before the Community
    // recorded enrolling grants is still found by its owner and local id, which another
    // installation of the same person can share, so a second removal could take that one's.
    it('never sends a removal for an agent revoked here earlier, nor names it', async () => {
      const { service, ref } = await connectedWith('earlier-owner', [scout, relay]);
      expect(await service.disconnectImpact(ref, 'earlier-owner')).toEqual({
        agents: [view(scout)],
      });
      expect(await service.disconnect(ref, 'earlier-owner')).toEqual({
        remoteRevoked: true,
        agentsNotRemoved: [],
      });
      expect(agentRemovals.map((removal) => removal.memberId)).toEqual([scout.remoteMemberId]);
    });

    it('names a fenced connection’s agents without removing them, even with a bearer', async () => {
      const fenced = [{ ...scout, active: false }];
      const { store, service, ref } = await connectedWith('fenced-bearer-owner', fenced);
      const file = join(directory, 'communities', 'remote', 'connections.json');
      const records = JSON.parse(await readFile(file, 'utf8')) as Array<{
        ref: string;
        status: string;
      }>;
      records.find((record) => record.ref === ref)!.status = 'reconnect-required';
      await writeFile(file, JSON.stringify(records));
      expect(await service.disconnect(ref, 'fenced-bearer-owner')).toEqual({
        remoteRevoked: true,
        agentsNotRemoved: [view(scout)],
      });
      expect(agentRemovals).toEqual([]);
      expect(revocations).toHaveLength(1);
      await expectLocalCopyGone(store, ref, 'fenced-bearer-owner');
    });

    // The reconnect dialog's path: a rejected grant revoked every enrollment here without telling
    // the Community, and dropped the bearer, so nothing can be removed from here.
    it('names the agents a rejected grant revoked here, since the Community still has them', async () => {
      const fenced = [
        { ...scout, active: false },
        { ...relay, active: false },
      ];
      const { store, service, ref } = await connectedWith('fenced-owner', fenced);
      await store.requireReconnect(ref, 'fenced-owner');
      expect(await service.disconnectImpact(ref, 'fenced-owner')).toEqual({
        agents: [view(scout), view(relay)],
      });
      expect(await service.disconnect(ref, 'fenced-owner')).toEqual({
        remoteRevoked: true,
        agentsNotRemoved: [view(scout), view(relay)],
      });
      expect(agentRemovals).toEqual([]);
      await expectLocalCopyGone(store, ref, 'fenced-owner');
    });

    it('says which agents disconnecting would remove without asking the Community', async () => {
      const { service, ref } = await connectedWith('impact-owner', [scout, echo]);
      const before = requests.length;
      expect(await service.disconnectImpact(ref, 'impact-owner')).toEqual({
        agents: [view(scout), view(echo)],
      });
      expect(requests.length).toBe(before);
      await service.disconnect(ref, 'impact-owner');
      await expect(service.disconnectImpact(ref, 'impact-owner')).rejects.toBeInstanceOf(
        RemoteConnectionNotFoundError
      );
    });
  });

  describe('disconnect revokes the grant on the Community', () => {
    async function connected(owner: string) {
      fake.approved = true;
      const store = new RemoteConnectionStore(directory);
      const service = new RemoteCommunityPairingService(store);
      const started = await service.start(owner, origin, 'Disconnecting install');
      expect((await service.poll(started.connection.ref, owner)).status).toBe('connected');
      fake.approved = false;
      revocations.length = 0;
      return { store, service, ref: started.connection.ref };
    }

    async function expectLocalCopyGone(store: RemoteConnectionStore, ref: string, owner: string) {
      expect(await store.list(owner)).toEqual([]);
      expect(
        await new EncryptedFileCredentialStore(directory).get(`community:${ref}:personal`)
      ).toBeNull();
    }

    afterEach(() => {
      fake.revocationAnswer = 204;
      revocations.length = 0;
    });

    // DOR-2334. Purpose: disconnecting removes everything copied through the connection, through
    // the same revoke path, before the credential goes; a failure there never keeps the
    // credential. It fails if disconnect leaves the mirrors behind.
    it('removes the mirrored copies with the connection, and completes even if that fails', async () => {
      fake.approved = true;
      const store = new RemoteConnectionStore(directory);
      const revokeConnection = vi.fn(async () => undefined);
      const service = new RemoteCommunityPairingService(store, revokeConnection);
      const started = await service.start('purging-owner', origin, 'Disconnecting install');
      expect((await service.poll(started.connection.ref, 'purging-owner')).status).toBe(
        'connected'
      );
      fake.approved = false;
      await service.disconnect(started.connection.ref, 'purging-owner');
      expect(revokeConnection.mock.calls).toEqual([[started.connection.ref, 'purging-owner']]);
      await expectLocalCopyGone(store, started.connection.ref, 'purging-owner');

      fake.approved = true;
      const failing = new RemoteCommunityPairingService(
        store,
        vi.fn(async () => {
          throw new Error('purge failed');
        })
      );
      const again = await failing.start('purging-owner', origin, 'Disconnecting install');
      expect((await failing.poll(again.connection.ref, 'purging-owner')).status).toBe('connected');
      fake.approved = false;
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      await expect(failing.disconnect(again.connection.ref, 'purging-owner')).resolves.toEqual({
        remoteRevoked: true,
        agentsNotRemoved: [],
      });
      warn.mockRestore();
      await expectLocalCopyGone(store, again.connection.ref, 'purging-owner');
    });

    it('revokes with its own bearer at the qualified path before deleting the local copy', async () => {
      const { store, service, ref } = await connected('disconnect-owner');
      expect(await service.disconnect(ref, 'disconnect-owner')).toEqual({
        remoteRevoked: true,
        agentsNotRemoved: [],
      });
      expect(revocations).toEqual([
        { path: `${qualified}/me/connection`, authorization: `Bearer ${token}` },
      ]);
      await expectLocalCopyGone(store, ref, 'disconnect-owner');
    });

    it.each([
      ['unreachable', 'hang-up' as const],
      ['failing', 500],
      ['older and without the route', 404],
      ['refusing', 403],
    ])(
      'still deletes the local copy and reports it when the Community is %s',
      async (_label, answer) => {
        const { store, service, ref } = await connected('unreachable-owner');
        fake.revocationAnswer = answer;
        expect(await service.disconnect(ref, 'unreachable-owner')).toEqual({
          remoteRevoked: false,
          agentsNotRemoved: [],
        });
        expect(revocations).toHaveLength(1);
        await expectLocalCopyGone(store, ref, 'unreachable-owner');
      }
    );

    it('keeps only the closed-enum code of a refusal, never its text', async () => {
      fake.revocationAnswer = 403;
      const error = await pinnedJson(
        new URL(origin),
        `${qualified}/me/connection`,
        undefined,
        undefined,
        { method: 'DELETE', accept: [204] }
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PinnedHttpError);
      expect(error).toMatchObject({ status: 403, remoteCode: 'UNAUTHENTICATED' });
      expect(
        JSON.stringify({ ...(error as object), message: (error as Error).message })
      ).not.toContain('untrusted remote text');
      const unknown = await pinnedJson(new URL(origin), `${qualified}/no-such-route`).catch(
        (caught: unknown) => caught
      );
      expect(unknown).toMatchObject({ status: 404, remoteCode: undefined });
    });

    it('still revokes a reconnect-required connection whose bearer is stored', async () => {
      // A grant refused for a missing scope can still be live on the Community.
      const { store, service, ref } = await connected('reconnect-owner');
      const file = join(directory, 'communities', 'remote', 'connections.json');
      const records = JSON.parse(await readFile(file, 'utf8')) as Array<{
        ref: string;
        status: string;
      }>;
      records.find((record) => record.ref === ref)!.status = 'reconnect-required';
      await writeFile(file, JSON.stringify(records));
      expect(await service.disconnect(ref, 'reconnect-owner')).toEqual({
        remoteRevoked: true,
        agentsNotRemoved: [],
      });
      expect(revocations).toEqual([
        { path: `${qualified}/me/connection`, authorization: `Bearer ${token}` },
      ]);
      await expectLocalCopyGone(store, ref, 'reconnect-owner');
    });

    it('makes no call once a rejected grant has already dropped its bearer', async () => {
      const { store, service, ref } = await connected('dropped-bearer-owner');
      await store.requireReconnect(ref, 'dropped-bearer-owner');
      expect(await service.disconnect(ref, 'dropped-bearer-owner')).toEqual({
        remoteRevoked: true,
        agentsNotRemoved: [],
      });
      expect(revocations).toEqual([]);
      await expectLocalCopyGone(store, ref, 'dropped-bearer-owner');
    });
  });
});
