import { REF, ROOM_ID, VERIFIED_AGENT_ACCESS, outboxItem, testRoom, snapshot } from './fixtures.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MeshCore } from '@dorkos/mesh';
import { describe, expect, it, vi } from 'vitest';
import {
  agentLookupFor,
  createRoomHarness,
  settleUntil,
} from '../../../../rooms/__tests__/room-test-harness.js';
import { CommunityAgentEnrollmentStore } from '../../agent-enrollment-store.js';
import { CommunityOutboxStore } from '../../community-outbox-store.js';
import { CommunityOutboxRuntime } from '../../community-outbox-runtime.js';
import { isCurrentLocalMeshAgent } from '../../local-agent-authority.js';
import { registerRemoteCommunityUnregisterCascade } from '../../mesh-unregister-cascade.js';
import { RemoteMirrorStore } from '../../mirror-store.js';
import { RemoteRoomSubscriptionBridge } from '../../remote-room-subscription-bridge.js';
import { RemoteRoomSubscriptionRuntime } from '../../remote-room-subscription-runtime.js';
import type { CommunityRoom } from '@dorkos/shared/community-adapter';
import type { CommunityRef } from '@dorkos/shared/community-adapter';

describe('RemoteRoomSubscriptionRuntime', () => {
  it('does not deliver persisted work after an offline manifest deletion before restart', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-community-offline-delete-'));
    const agentPath = path.join(root, 'ana');
    await fs.mkdir(agentPath, { recursive: true });
    const agents = { [agentPath]: { id: '', name: 'Ana', responseMode: 'always' as const } };
    const harness = createRoomHarness({
      agents: agentLookupFor(agents),
    });
    let initialMesh: MeshCore | undefined;
    let restartedMesh: MeshCore | undefined;
    let runtime: CommunityOutboxRuntime | undefined;
    try {
      initialMesh = new MeshCore({ db: harness.db, defaultScanRoot: root });
      const manifest = await initialMesh.registerByPath(agentPath, {
        name: 'ana',
        runtime: 'claude-code',
        namespace: 'test',
      });
      agents[agentPath].id = manifest.id;
      const agent = harness.authors.resolveAgent(agentPath, 'Ana');
      const post = vi.fn();
      const firstMirror = new RemoteMirrorStore(harness.db, harness.store, harness.authors);
      const localRoom = firstMirror.ensureRoom({
        communityRef: REF,
        remoteRoomId: ROOM_ID,
        title: 'General',
        topic: null,
        ownerAuthorId: harness.human,
        accessors: [{ authorId: agent.id, responseMode: 'always' }],
        authorizedAt: '2026-09-16T00:00:00.000Z',
      });
      const localEntry = harness.service.post(localRoom.id, {
        authorId: agent.id,
        text: 'A persisted reply must not escape after deletion.',
      });

      // Community is offline while this file disappears. Mesh deliberately
      // retains the cached row through grace and loads it on the next boot.
      await fs.rm(path.join(agentPath, '.dork', 'agent.json'));
      initialMesh.close();
      initialMesh = undefined;
      restartedMesh = new MeshCore({ db: harness.db, defaultScanRoot: root });
      await restartedMesh.reconcileOnStartup();
      expect(restartedMesh.get(manifest.id)).toBeDefined();
      await expect(isCurrentLocalMeshAgent(restartedMesh, manifest.id)).resolves.toBe(false);

      runtime = new CommunityOutboxRuntime({
        db: harness.db,
        roomStore: harness.store,
        authors: harness.authors,
        attachmentRows: harness.attachments,
        attachmentBytes: {} as never,
        adapters: () => ({ post, uploadAttachment: vi.fn() }),
        isLocalAgentCurrent: (id) => isCurrentLocalMeshAgent(restartedMesh!, id),
        now: () => Date.parse('2026-09-16T01:00:00.000Z'),
      });
      runtime.enrollments.activate({
        communityRef: REF,
        localAgentId: manifest.id,
        remoteMemberId: 'remote-ana',
        ownerAuthorId: harness.human,
      });
      runtime.mirrors.ensureRoom({
        communityRef: REF,
        remoteRoomId: ROOM_ID,
        title: 'General',
        topic: null,
        ownerAuthorId: harness.human,
        accessors: [{ authorId: agent.id, responseMode: 'always' }],
        authorizedAt: '2026-09-16T00:00:00.000Z',
      });
      harness.db.transaction((tx) =>
        runtime!.outbox.enqueue(
          outboxItem({
            id: 'offline-deleted',
            ownerAuthorId: harness.human,
            localAgentId: manifest.id,
            localEntryId: localEntry.id,
            createdAt: '2026-09-16T01:00:00.000Z',
            expiresAt: '2026-09-16T01:05:00.000Z',
            nextAttemptAt: '2026-09-16T01:00:00.000Z',
          }),
          tx
        )
      );

      runtime.start();
      await settleUntil(
        () => !runtime!.outbox.isPending('offline-deleted'),
        'the deleted manifest row is stopped by the worker authority gate'
      );
      expect(post).not.toHaveBeenCalled();
      expect(
        runtime.outbox.deliveryForOwner(REF, ROOM_ID, harness.human, 'delivery-key')
      ).toMatchObject({ state: 'stopped' });

      // A different valid manifest at the cached path cannot authorize the
      // old enrollment identity either.
      const replacementPath = path.join(root, 'replacement');
      await fs.mkdir(replacementPath, { recursive: true });
      const replacement = await restartedMesh.registerByPath(replacementPath, {
        name: 'replacement',
        runtime: 'claude-code',
        namespace: 'test',
      });
      await fs.mkdir(path.join(agentPath, '.dork'), { recursive: true });
      await fs.copyFile(
        path.join(replacementPath, '.dork', 'agent.json'),
        path.join(agentPath, '.dork', 'agent.json')
      );
      expect(replacement.id).not.toBe(manifest.id);
      await expect(isCurrentLocalMeshAgent(restartedMesh, manifest.id)).resolves.toBe(false);
    } finally {
      runtime?.stop();
      initialMesh?.close();
      restartedMesh?.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('cascades a live Mesh manifest deletion to its held post, enrollment, and native stream', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-community-mesh-unregister-'));
    const agentPath = path.join(root, 'ana');
    await fs.mkdir(agentPath, { recursive: true });
    const agents = { [agentPath]: { id: '', name: 'Ana', responseMode: 'always' as const } };
    const harness = createRoomHarness({
      agents: agentLookupFor(agents),
    });
    const mesh = new MeshCore({ db: harness.db, defaultScanRoot: root });
    let deliveryRuntime: CommunityOutboxRuntime | undefined;
    let subscriptions: RemoteRoomSubscriptionRuntime | undefined;
    try {
      const manifest = await mesh.registerByPath(agentPath, {
        name: 'ana',
        runtime: 'claude-code',
        namespace: 'test',
      });
      agents[agentPath].id = manifest.id;
      const agent = harness.authors.resolveAgent(agentPath, 'Ana');
      const localAgentId = manifest.id;
      let postSignal: AbortSignal | undefined;
      const post = vi.fn(
        (_roomId: string, _input: unknown, signal?: AbortSignal) =>
          new Promise<never>((_resolve, reject) => {
            postSignal = signal;
            signal?.addEventListener('abort', () => reject(new Error('manifest removed')), {
              once: true,
            });
          })
      );
      deliveryRuntime = new CommunityOutboxRuntime({
        db: harness.db,
        roomStore: harness.store,
        authors: harness.authors,
        attachmentRows: harness.attachments,
        attachmentBytes: {} as never,
        adapters: () => ({ post, uploadAttachment: vi.fn() }),
        isLocalAgentCurrent: (id) => isCurrentLocalMeshAgent(mesh, id),
        now: () => Date.parse('2026-09-16T01:00:00.000Z'),
      });
      const localRoom = deliveryRuntime.mirrors.ensureRoom({
        communityRef: REF,
        remoteRoomId: ROOM_ID,
        title: 'General',
        topic: null,
        ownerAuthorId: harness.human,
        accessors: [{ authorId: agent.id, responseMode: 'always' }],
        authorizedAt: '2026-09-16T00:00:00.000Z',
      });
      const localEntry = harness.service.post(localRoom.id, {
        authorId: agent.id,
        text: 'This post is held while the manifest is deleted.',
      });
      deliveryRuntime.enrollments.activate({
        communityRef: REF,
        localAgentId,
        remoteMemberId: 'remote-ana',
        ownerAuthorId: harness.human,
      });
      harness.db.transaction((tx) =>
        deliveryRuntime!.outbox.enqueue(
          outboxItem({
            id: 'held-deleted',
            ownerAuthorId: harness.human,
            localAgentId,
            localEntryId: localEntry.id,
            createdAt: '2026-09-16T01:00:00.000Z',
            expiresAt: '2026-09-16T01:05:00.000Z',
            nextAttemptAt: '2026-09-16T01:00:00.000Z',
          }),
          tx
        )
      );
      const bridge = new RemoteRoomSubscriptionBridge(
        deliveryRuntime.mirrors,
        harness.service,
        deliveryRuntime.enrollments,
        () => null,
        undefined,
        deliveryRuntime.outbox,
        deliveryRuntime
      );
      let streamAborted = false;
      const room = testRoom();
      subscriptions = new RemoteRoomSubscriptionRuntime({
        bridge,
        enrollments: deliveryRuntime.enrollments,
        resolveConnectionAccess: async () => VERIFIED_AGENT_ACCESS,
        adapters: () => ({
          listRooms: async () => [room],
          subscribeNativeRoom: (_roomId, _cursor, signal) =>
            (async function* () {
              yield snapshot(room, [], 0);
              yield { type: 'replay_complete' as const, capturedSeq: 0 };
              await new Promise<void>((resolve) =>
                signal?.addEventListener(
                  'abort',
                  () => {
                    streamAborted = true;
                    resolve();
                  },
                  { once: true }
                )
              );
            })(),
        }),
        resolveLocalAgentAuthor: () => agent.id,
        isRoomJoined: () => true,
        retryMs: 1,
      });
      // This is the production composition edge: real MeshCore fires the
      // registered callback when its actual unregister path removes a manifest.
      registerRemoteCommunityUnregisterCascade(mesh, harness.authors, subscriptions);

      deliveryRuntime.start();
      subscriptions.start();
      await vi.waitFor(() => expect(post).toHaveBeenCalledOnce());
      await settleUntil(
        () => subscriptions!.observation(REF, ROOM_ID, harness.human)?.replayComplete === true,
        'the enrolled native stream begins'
      );

      await mesh.unregister(localAgentId);
      await vi.waitFor(() => expect(postSignal?.aborted).toBe(true));
      await settleUntil(() => streamAborted, 'the deleted manifest stream aborts');
      await settleUntil(
        () => !deliveryRuntime!.outbox.isPending('held-deleted'),
        'the held delivery is stopped without a retry'
      );

      expect(
        deliveryRuntime.enrollments.findRemoteMember(REF, localAgentId, harness.human)
      ).toBeNull();
      expect(post).toHaveBeenCalledOnce();
      expect(
        deliveryRuntime.outbox.deliveryForOwner(REF, ROOM_ID, harness.human, 'delivery-key')
      ).toMatchObject({ state: 'stopped' });
    } finally {
      deliveryRuntime?.stop();
      subscriptions?.stop();
      mesh.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('does not re-open a stream from a directory refresh that began before manifest deletion', async () => {
    const harness = createRoomHarness({
      agents: agentLookupFor({ '/agents/ana': { name: 'Ana', responseMode: 'always' } }),
    });
    const agent = harness.authors.resolveAgent('/agents/ana', 'Ana');
    const localAgentId = agent.mintedForManifestId!;
    const enrollments = new CommunityAgentEnrollmentStore(harness.db);
    enrollments.activate({
      communityRef: REF,
      localAgentId,
      remoteMemberId: 'remote-ana',
      ownerAuthorId: harness.human,
    });
    const mirrors = new RemoteMirrorStore(harness.db, harness.store, harness.authors);
    const bridge = new RemoteRoomSubscriptionBridge(
      mirrors,
      harness.service,
      enrollments,
      () => agent.id
    );
    const room = testRoom();
    let releaseDirectory!: () => void;
    const directoryStarted = new Promise<void>((resolve) => {
      releaseDirectory = resolve;
    });
    let releaseRooms!: (rooms: CommunityRoom[]) => void;
    const rooms = new Promise<CommunityRoom[]>((resolve) => {
      releaseRooms = resolve;
    });
    const subscribeNativeRoom = vi.fn();
    const runtime = new RemoteRoomSubscriptionRuntime({
      bridge,
      enrollments,
      resolveConnectionAccess: async () => VERIFIED_AGENT_ACCESS,
      adapters: () => ({
        listRooms: async () => {
          releaseDirectory();
          return rooms;
        },
        subscribeNativeRoom,
      }),
      resolveLocalAgentAuthor: () => agent.id,
      isRoomJoined: () => true,
      retryMs: 1,
    });

    runtime.start();
    await directoryStarted;
    runtime.revokeUnregisteredAgent(localAgentId, agent.id);
    releaseRooms([room]);
    await settleUntil(
      () => enrollments.findRemoteMember(REF, localAgentId, harness.human) === null,
      'the manifest enrollment is revoked'
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    runtime.stop();

    expect(subscribeNativeRoom).not.toHaveBeenCalled();
    expect(mirrors.localRoomIdForOwner(REF, ROOM_ID, harness.human)).toBeNull();
  });

  it('re-checks only member-only read-only connections every five minutes, and stops once released (AC-8)', async () => {
    // Purpose: fails if a member-only connection never learns a hold ended, if it is checked
    // before five minutes, or if the new timer double-polls a connection with an enrolled agent
    // (the reconcile already re-checks those) or polls one that is not read-only.
    vi.useFakeTimers();
    try {
      const harness = createRoomHarness({ agents: agentLookupFor({}) });
      const enrollments = new CommunityAgentEnrollmentStore(harness.db);
      const memberOnly = 'remote_member_only' as CommunityRef;
      const withAgent = 'remote_with_agent' as CommunityRef;
      const stillActive = 'remote_still_active' as CommunityRef;
      enrollments.activate({
        communityRef: withAgent,
        localAgentId: 'agent-local',
        remoteMemberId: 'remote-agent',
        ownerAuthorId: 'owner',
      });
      // What this install last stored for each connection, and what the fake Community says now.
      const stored = new Map<CommunityRef, 'active' | 'archived'>([
        [memberOnly, 'archived'],
        [withAgent, 'archived'],
        [stillActive, 'active'],
      ]);
      let heldRemotely = true;
      const resolveConnectionAccess = vi.fn(async (ref: CommunityRef) => {
        stored.set(ref, heldRemotely ? 'archived' : 'active');
        return null;
      });
      const runtime = new RemoteRoomSubscriptionRuntime({
        bridge: {} as never,
        enrollments,
        adapters: vi.fn(),
        resolveConnectionAccess,
        readOnlyConnections: async () =>
          [...stored]
            .filter(([, lifecycle]) => lifecycle === 'archived')
            .map(([communityRef]) => ({ communityRef, ownerAuthorId: 'owner' })),
        resolveLocalAgentAuthor: () => null,
        // Keep the enrolled-agent reconcile out of the way so every call below is the timer's.
        isReady: () => false,
      });
      const checked = (ref: CommunityRef) =>
        resolveConnectionAccess.mock.calls.filter(([called]) => called === ref).length;
      runtime.start();

      await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
      expect(resolveConnectionAccess).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(checked(memberOnly)).toBe(1);
      expect(stored.get(memberOnly)).toBe('archived');

      // The host releases the hold; the next check stores active access.
      heldRemotely = false;
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(checked(memberOnly)).toBe(2);
      expect(stored.get(memberOnly)).toBe('active');

      // Active again, so it is not polled any more.
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      expect(checked(memberOnly)).toBe(2);
      expect(checked(withAgent)).toBe(0);
      expect(checked(stillActive)).toBe(0);
      runtime.stop();
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(resolveConnectionAccess).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves persisted grants and pending work until Mesh becomes authoritative after restart', async () => {
    const harness = createRoomHarness({
      agents: agentLookupFor({ '/agents/ana': { name: 'Ana', responseMode: 'always' } }),
    });
    const agent = harness.authors.resolveAgent('/agents/ana', 'Ana');
    const enrollments = new CommunityAgentEnrollmentStore(harness.db);
    enrollments.activate({
      communityRef: REF,
      localAgentId: 'mesh-manifest-ana',
      remoteMemberId: 'remote-ana',
      ownerAuthorId: harness.human,
    });
    const mirrors = new RemoteMirrorStore(harness.db, harness.store, harness.authors);
    const outbox = new CommunityOutboxStore(harness.db);
    const bridge = new RemoteRoomSubscriptionBridge(
      mirrors,
      harness.service,
      enrollments,
      (id) => (id === 'mesh-manifest-ana' ? agent.id : null),
      undefined,
      outbox
    );
    bridge.authorizeRoom({
      communityRef: REF,
      remoteRoomId: ROOM_ID,
      title: 'General',
      topic: null,
      ownerAuthorId: harness.human,
      accessors: [{ authorId: agent.id, responseMode: 'always' }],
      authorizedAt: '2026-09-16T00:00:00.000Z',
    });
    harness.db.transaction((tx) =>
      outbox.enqueue(
        {
          id: 'pending-restart',
          communityRef: REF,
          remoteRoomId: ROOM_ID,
          ownerAuthorId: harness.human,
          localEntryId: 'local-entry',
          localParentEntryId: null,
          localAgentId: 'mesh-manifest-ana',
          attachmentIds: '[]',
          idempotencyKey: 'restart-key',
          state: 'pending',
          createdAt: '2026-09-16T00:00:00.000Z',
          expiresAt: '2026-09-16T00:05:00.000Z',
          remoteEntryId: null,
          failure: null,
          attempts: 0,
          nextAttemptAt: '2026-09-16T00:00:00.000Z',
        },
        tx
      )
    );
    let meshReady = false;
    const runtime = new RemoteRoomSubscriptionRuntime({
      bridge,
      enrollments,
      resolveConnectionAccess: async () => VERIFIED_AGENT_ACCESS,
      adapters: () => ({
        listRooms: async () => [],
        subscribeNativeRoom: () => (async function* () {})(),
      }),
      resolveLocalAgentAuthor: (id) => (id === 'mesh-manifest-ana' ? agent.id : null),
      isReady: () => meshReady,
      retryMs: 1,
    });
    const localRoomId = mirrors.localRoomIdForOwner(REF, ROOM_ID, harness.human)!;
    runtime.start();
    expect(mirrors.isActivelyAuthorized(localRoomId, harness.human)).toBe(true);
    expect(outbox.isPending('pending-restart')).toBe(true);

    meshReady = true;
    runtime.start();
    await settleUntil(
      () => !outbox.isPending('pending-restart'),
      'the first authoritative refresh'
    );
    expect(mirrors.isActivelyAuthorized(localRoomId, harness.human)).toBe(false);
    runtime.stop();
  });
});
