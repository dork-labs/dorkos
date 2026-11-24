import { REF_A, roomInput, REF_B, nativeEntry, wired } from './fixtures.js';
import type { CommunityRef } from '@dorkos/shared/community-adapter';
import { describe, expect, it } from 'vitest';
import { authorOrigin } from '../../../../rooms/author-registry.js';
import { agentLookupFor } from '../../../../rooms/__tests__/room-test-harness.js';
import { CommunityAgentEnrollmentStore } from '../../agent-enrollment-store.js';
import { RemoteRoomSubscriptionBridge } from '../../remote-room-subscription-bridge.js';
import { RECONNECT_FRESH_MS } from '../../subscription/reconnect-timing.js';

describe('RemoteMirrorStore', () => {
  it('keeps agent enrollment qualified, owner-scoped, and fail-closed on revoke', () => {
    const { harness } = wired();
    const enrollments = new CommunityAgentEnrollmentStore(
      harness.db,
      () => '2026-09-16T00:00:00.000Z'
    );

    enrollments.activate({
      communityRef: REF_A,
      localAgentId: 'agent-local-1',
      remoteMemberId: 'agent-remote-1',
      ownerAuthorId: harness.human,
    });

    expect(enrollments.findLocalAgent(REF_A, 'agent-remote-1', harness.human)?.localAgentId).toBe(
      'agent-local-1'
    );
    expect(
      enrollments.findRemoteMember(REF_A, 'agent-local-1', harness.human)?.remoteMemberId
    ).toBe('agent-remote-1');
    expect(enrollments.findLocalAgent(REF_A, 'agent-remote-1', 'other-owner')).toBeNull();

    enrollments.revoke(REF_A, 'agent-local-1', harness.human);
    expect(enrollments.findLocalAgent(REF_A, 'agent-remote-1', harness.human)).toBeNull();
    expect(enrollments.findRemoteMember(REF_A, 'agent-local-1', harness.human)).toBeNull();
  });

  it('dispatches only fresh external-human mentions through the existing RoomService', async () => {
    const agents = agentLookupFor({ '/agents/ana': { name: 'Ana', responseMode: 'always' } });
    const { harness, mirrors } = wired(agents);
    const agent = harness.authors.resolveAgent('/agents/ana', 'Ana');
    const room = {
      ...roomInput(REF_A, 'general', harness.human),
      accessors: [{ authorId: agent.id, responseMode: 'always' as const }],
    };
    const enrollments = new CommunityAgentEnrollmentStore(harness.db);
    enrollments.activate({
      communityRef: REF_A,
      localAgentId: 'local-ana',
      remoteMemberId: 'remote-ana',
      ownerAuthorId: harness.human,
    });
    const bridge = new RemoteRoomSubscriptionBridge(
      mirrors,
      harness.service,
      enrollments,
      (localAgentId) => (localAgentId === 'local-ana' ? agent.id : null),
      () => Date.parse('2026-09-16T01:00:00.000Z')
    );
    const live = nativeEntry(REF_A, 'general', 1);
    live.entry = { ...live.entry, mentions: ['remote-ana'] };

    bridge.importLive(
      room,
      {
        ...live,
        author: { ...live.author, kind: 'human' },
        serverCreatedAt: '2026-09-16T01:00:00.000Z',
      },
      { reconnect: false, wasActiveBeforeDisconnect: false, readOnly: false }
    );
    await harness.service.triggersIdle();
    expect(harness.runner.turns).toHaveLength(1);
    const imported = harness.store.listEntriesAfter(mirrors.ensureRoom(room).id, 0)[0];
    const importedOrigin = authorOrigin(harness.authors.getById(imported!.authorId)!.naturalKey);
    expect(importedOrigin).not.toBe('local');
    expect(
      mirrors.cachedEntryForOwner(REF_A, 'general', live.entry.id, harness.human)?.mentions
    ).toEqual(['remote-ana']);

    // Snapshot and reconnect replay are cache-only even where a remote human
    // mentions an enrolled agent. A remote agent is never a local runtime.
    await bridge.consume(
      room,
      (async function* () {
        for (const frame of [
          {
            type: 'snapshot' as const,
            entries: [
              {
                ...nativeEntry(REF_A, 'general', 2),
                entry: { ...nativeEntry(REF_A, 'general', 2).entry, mentions: ['remote-ana'] },
                author: { memberId: 'remote-human', displayName: 'Remote', kind: 'human' as const },
                serverCreatedAt: '2026-09-16T01:00:00.000Z',
              },
            ],
          },
          {
            type: 'replay' as const,
            entries: [
              {
                ...nativeEntry(REF_A, 'general', 3),
                entry: { ...nativeEntry(REF_A, 'general', 3).entry, mentions: ['remote-ana'] },
                author: { memberId: 'remote-human', displayName: 'Remote', kind: 'human' as const },
                serverCreatedAt: '2026-09-16T01:00:00.000Z',
              },
            ],
          },
          {
            type: 'live' as const,
            entry: {
              ...nativeEntry(REF_A, 'general', 4),
              author: {
                memberId: 'remote-agent',
                displayName: 'Remote agent',
                kind: 'agent' as const,
              },
              serverCreatedAt: '2026-09-16T01:00:00.000Z',
            },
            reconnect: false,
            wasActiveBeforeDisconnect: false,
            readOnly: false,
          },
        ]) {
          yield frame;
        }
      })()
    );
    await harness.service.triggersIdle();
    expect(harness.runner.turns).toHaveLength(1);

    const recent = nativeEntry(REF_A, 'general', 5);
    recent.entry = { ...recent.entry, mentions: ['remote-ana'] };
    bridge.importLive(
      room,
      {
        ...recent,
        author: { ...recent.author, kind: 'human' },
        serverCreatedAt: '2026-09-16T00:59:31.000Z',
      },
      { reconnect: true, wasActiveBeforeDisconnect: true, readOnly: false }
    );
    await harness.service.triggersIdle();
    expect(harness.runner.turns).toHaveLength(2);

    // The claim is persisted: a new bridge after restart cannot replay a
    // recently eligible event, while old/revoked/read-only events never claim.
    const restarted = new RemoteRoomSubscriptionBridge(
      mirrors,
      harness.service,
      enrollments,
      (localAgentId) => (localAgentId === 'local-ana' ? agent.id : null),
      () => Date.parse('2026-09-16T01:00:00.000Z')
    );
    restarted.importLive(
      room,
      {
        ...recent,
        author: { ...recent.author, kind: 'human' },
        serverCreatedAt: '2026-09-16T00:59:31.000Z',
      },
      { reconnect: true, wasActiveBeforeDisconnect: true, readOnly: false }
    );
    const stale = nativeEntry(REF_A, 'general', 6);
    stale.entry = { ...stale.entry, mentions: ['remote-ana'] };
    restarted.importLive(
      room,
      {
        ...stale,
        author: { ...stale.author, kind: 'human' },
        // Just past the reconnect freshness window, measured from the bridge's clock above.
        serverCreatedAt: new Date(
          Date.parse('2026-09-16T01:00:00.000Z') - RECONNECT_FRESH_MS - 1_000
        ).toISOString(),
      },
      { reconnect: true, wasActiveBeforeDisconnect: true, readOnly: false }
    );
    const readOnly = nativeEntry(REF_A, 'general', 7);
    readOnly.entry = { ...readOnly.entry, mentions: ['remote-ana'] };
    restarted.importLive(
      room,
      {
        ...readOnly,
        author: { ...readOnly.author, kind: 'human' },
        serverCreatedAt: '2026-09-16T01:00:00.000Z',
      },
      { reconnect: false, wasActiveBeforeDisconnect: false, readOnly: true }
    );
    await harness.service.triggersIdle();
    expect(harness.runner.turns).toHaveLength(2);
  });

  it('mirrors but never wakes a local agent while the spaces experiment is off (DOR-2740)', async () => {
    const agents = agentLookupFor({ '/agents/ana': { name: 'Ana', responseMode: 'always' } });
    const { harness, mirrors } = wired(agents);
    const agent = harness.authors.resolveAgent('/agents/ana', 'Ana');
    const room = {
      ...roomInput(REF_A, 'general', harness.human),
      accessors: [{ authorId: agent.id, responseMode: 'always' as const }],
    };
    const enrollments = new CommunityAgentEnrollmentStore(harness.db);
    enrollments.activate({
      communityRef: REF_A,
      localAgentId: 'local-ana',
      remoteMemberId: 'remote-ana',
      ownerAuthorId: harness.human,
    });
    let spaces = false;
    const bridge = new RemoteRoomSubscriptionBridge(
      mirrors,
      harness.service,
      enrollments,
      (localAgentId) => (localAgentId === 'local-ana' ? agent.id : null),
      () => Date.parse('2026-09-16T01:00:00.000Z'),
      undefined,
      undefined,
      () => spaces
    );
    const live = (seq: number) => {
      const entry = nativeEntry(REF_A, 'general', seq);
      return {
        ...entry,
        entry: { ...entry.entry, mentions: ['remote-ana'] },
        author: { ...entry.author, kind: 'human' as const },
        serverCreatedAt: '2026-09-16T01:00:00.000Z',
      };
    };
    const opts = { reconnect: false, wasActiveBeforeDisconnect: false, readOnly: false };

    const off = live(1);
    bridge.importLive(room, off, opts);
    await harness.service.triggersIdle();
    expect(harness.runner.turns).toHaveLength(0);
    expect(mirrors.cachedEntryForOwner(REF_A, 'general', off.entry.id, harness.human)).toBeTruthy();

    spaces = true;
    bridge.importLive(room, live(2), opts);
    await harness.service.triggersIdle();
    expect(harness.runner.turns).toHaveLength(1);
  });

  // Spec `official-community-space` D5: the bridge asks `spaceReachable(ref)`, not the
  // experiment alone. Fails if the predicate stops receiving the ref (both spaces would answer
  // alike) or stops being asked (the other space would wake an agent).
  it('wakes a local agent from the official space alone while spaces are off', async () => {
    const agents = agentLookupFor({ '/agents/ana': { name: 'Ana', responseMode: 'always' } });
    const { harness, mirrors } = wired(agents);
    const agent = harness.authors.resolveAgent('/agents/ana', 'Ana');
    const enrollments = new CommunityAgentEnrollmentStore(harness.db);
    for (const communityRef of [REF_A, REF_B])
      enrollments.activate({
        communityRef,
        localAgentId: 'local-ana',
        remoteMemberId: 'remote-ana',
        ownerAuthorId: harness.human,
      });
    const asked: CommunityRef[] = [];
    const bridge = new RemoteRoomSubscriptionBridge(
      mirrors,
      harness.service,
      enrollments,
      (localAgentId) => (localAgentId === 'local-ana' ? agent.id : null),
      () => Date.parse('2026-09-16T01:00:00.000Z'),
      undefined,
      undefined,
      (ref) => {
        asked.push(ref);
        return ref === REF_A;
      }
    );
    const opts = { reconnect: false, wasActiveBeforeDisconnect: false, readOnly: false };
    const live = (ref: CommunityRef, seq: number) => {
      const entry = nativeEntry(ref, 'general', seq);
      return {
        ...entry,
        entry: { ...entry.entry, mentions: ['remote-ana'] },
        author: { ...entry.author, kind: 'human' as const },
        serverCreatedAt: '2026-09-16T01:00:00.000Z',
      };
    };
    const roomIn = (ref: CommunityRef) => ({
      ...roomInput(ref, 'general', harness.human),
      accessors: [{ authorId: agent.id, responseMode: 'always' as const }],
    });

    bridge.importLive(roomIn(REF_B), live(REF_B, 1), opts);
    await harness.service.triggersIdle();
    expect(harness.runner.turns).toHaveLength(0);

    bridge.importLive(roomIn(REF_A), live(REF_A, 1), opts);
    await harness.service.triggersIdle();
    expect(harness.runner.turns).toHaveLength(1);
    expect(asked).toEqual([REF_B, REF_A]);
  });

  it('does not refresh a stale owner mirror from a live frame before dispatching it', async () => {
    const agents = agentLookupFor({ '/agents/ana': { name: 'Ana', responseMode: 'always' } });
    const { harness, mirrors } = wired(agents);
    const agent = harness.authors.resolveAgent('/agents/ana', 'Ana');
    const room = {
      ...roomInput(REF_A, 'stale-general', harness.human),
      accessors: [{ authorId: agent.id, responseMode: 'always' as const }],
    };
    const local = mirrors.ensureRoom(room);
    const enrollments = new CommunityAgentEnrollmentStore(harness.db);
    enrollments.activate({
      communityRef: REF_A,
      localAgentId: 'local-ana',
      remoteMemberId: 'remote-ana',
      ownerAuthorId: harness.human,
    });
    const bridge = new RemoteRoomSubscriptionBridge(
      mirrors,
      harness.service,
      enrollments,
      (localAgentId) => (localAgentId === 'local-ana' ? agent.id : null)
    );
    mirrors.markStale(REF_A, harness.human);
    const live = nativeEntry(REF_A, 'stale-general', 1);
    live.entry = { ...live.entry, mentions: ['remote-ana'] };

    bridge.importLive(
      room,
      {
        ...live,
        author: { ...live.author, kind: 'human' },
        serverCreatedAt: '2026-09-16T01:00:00.000Z',
      },
      { reconnect: false, wasActiveBeforeDisconnect: false, readOnly: false }
    );
    await harness.service.triggersIdle();

    expect(harness.runner.turns).toHaveLength(0);
    expect(mirrors.isActivelyAuthorized(local.id, harness.human)).toBe(false);
  });
});
