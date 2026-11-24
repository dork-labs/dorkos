import {
  REF,
  ROOM_ID,
  VERIFIED_AGENT_ACCESS,
  entry,
  live,
  outboxItem,
  testRoom,
  snapshot,
} from './fixtures.js';
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
