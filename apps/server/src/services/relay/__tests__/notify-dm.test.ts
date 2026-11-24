/**
 * Where a proactive agent message goes when no chat integration can carry it
 * (DOR-1209). The rooms half is REAL (service, author registry, store), since
 * every claim worth making is about what lands in the log.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createRoomHarness,
  agentLookupFor,
  outcomeRunner,
  type ScriptedTurnRunner,
  type RoomHarness,
} from '../../rooms/__tests__/room-test-harness.js';
import { DirectChats } from '../../rooms/direct-chat/direct-chats.js';
import { deliverNotifyDm, type NotifyDmDeps, type NotifyDmOutcome } from '../notify-dm.js';

const ANA_PATH = '/agents/ana';
const ANA_ID = 'agent-ana';
const CEILING = 3;

/** A mesh that knows Ana and nobody else. */
function meshWithAna(overrides: Partial<NotifyDmDeps['mesh']> = {}): NotifyDmDeps['mesh'] {
  return {
    getProjectPath: (agentId) => (agentId === ANA_ID ? ANA_PATH : undefined),
    get: (agentId) => (agentId === ANA_ID ? { name: 'ana', displayName: 'Ana' } : undefined),
    ...overrides,
  };
}

/** A harness with Ana installed, plus the deps `deliverNotifyDm` takes over it. */
function setup(mesh: NotifyDmDeps['mesh'] = meshWithAna()): {
  harness: RoomHarness;
  deps: NotifyDmDeps;
} {
  const harness = createRoomHarness({
    agents: agentLookupFor({ [ANA_PATH]: { name: 'ana' } }),
    maxAgentDepth: CEILING,
  });
  return {
    harness,
    deps: {
      rooms: harness.service,
      authors: harness.authors,
      mesh,
      operatorAuthorId: () => harness.human,
      logger: { warn: vi.fn() },
    },
  };
}

describe('deliverNotifyDm', () => {
  it('A-05: opens the DM with the operator and posts as the agent', () => {
    const { harness, deps } = setup();

    const outcome = deliverNotifyDm({ agentId: ANA_ID, message: 'Deploy finished.' }, deps);

    expect(outcome).toMatchObject({ ok: true });
    if (!outcome.ok) return;

    const room = harness.store.getRoom(outcome.roomId);
    expect(room?.kind).toBe('dm');
    const anaAuthorId = harness.authors.resolveAgent(ANA_PATH, 'Ana').id;
    expect(new Set(harness.store.listMembers(outcome.roomId).map((m) => m.authorId))).toEqual(
      new Set([anaAuthorId, harness.human])
    );
    const entries = harness.service.listEntries(outcome.roomId, harness.human, { limit: 10 });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.id).toBe(outcome.entryId);
    expect(entries[0]!.body).toMatchObject({ text: 'Deploy finished.' });
    expect(entries[0]!.authorId).toBe(anaAuthorId);
    expect(entries[0]!.kind).toBe('post');
  });

  it('inherits the cascade of a turn the agent is already running', async () => {
    let midTurn: NotifyDmOutcome | undefined;
    const wiring: { deps?: NotifyDmDeps } = {};
    const runner: ScriptedTurnRunner = outcomeRunner((request) => {
      midTurn = deliverNotifyDm({ agentId: ANA_ID, message: 'Deploy finished.' }, wiring.deps!);
      runner.sayInRoom(request, 'on it');
      return { text: null };
    });
    const harness = createRoomHarness({
      agents: agentLookupFor({ [ANA_PATH]: { name: 'ana' } }),
      maxAgentDepth: CEILING,
      runner,
    });
    wiring.deps = {
      rooms: harness.service,
      authors: harness.authors,
      mesh: meshWithAna(),
      operatorAuthorId: () => harness.human,
      logger: { warn: vi.fn() },
    };

    const dm = harness.service.createRoom(
      { kind: 'dm', title: 'Ana', members: [], agentPaths: [ANA_PATH] },
      harness.human
    );
    const asked = harness.service.post(dm.id, { authorId: harness.human, text: 'ship it' });
    await harness.service.triggersIdle();

    expect(midTurn?.ok).toBe(true);
    const entries = harness.service.listEntries(dm.id, harness.human, { limit: 10 });
    const notified = entries.find((e) => e.id === (midTurn?.ok ? midTurn.entryId : ''));
    const replied = entries.find((e) => (e.body as { text?: string }).text === 'on it');
    expect(notified).toBeDefined();
    expect(replied).toBeDefined();
    expect(notified!.cascadeRoot).toBe(asked.id);
    expect(notified!.cascadeDepth).toBeLessThan(CEILING);
    expect({ root: notified!.cascadeRoot, depth: notified!.cascadeDepth }).toEqual({
      root: replied!.cascadeRoot,
      depth: replied!.cascadeDepth,
    });
  });

  it('spends the cascade at the ceiling when no turn is behind it, so the notification cannot start a conversation', () => {
    const { harness, deps } = setup();

    const outcome = deliverNotifyDm({ agentId: ANA_ID, message: 'Deploy finished.' }, deps);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const [entry] = harness.service.listEntries(outcome.roomId, harness.human, { limit: 10 });
    expect(entry!.cascadeDepth).toBe(CEILING);
    expect(entry!.cascadeRoot).toBe(entry!.id);
  });

  it('reuses the direct message the operator already has with that agent', () => {
    const { harness, deps } = setup();
    const anaAuthorId = harness.authors.resolveAgent(ANA_PATH, 'Ana').id;
    const existing = harness.service.createRoom(
      { kind: 'dm', title: 'Ana', members: [anaAuthorId], agentPaths: [] },
      harness.human
    );

    const first = deliverNotifyDm({ agentId: ANA_ID, message: 'One.' }, deps);
    const second = deliverNotifyDm({ agentId: ANA_ID, message: 'Two.' }, deps);

    expect(first.ok && first.roomId).toBe(existing.id);
    expect(second.ok && second.roomId).toBe(existing.id);
    expect(
      harness.service.listEntries(existing.id, harness.human, { limit: 10 }).map((e) => e.body)
    ).toMatchObject([{ text: 'One.' }, { text: 'Two.' }]);
  });

  it('reports AGENT_NOT_RESOLVABLE, loudly, when the mesh cannot place the sender', () => {
    const { deps } = setup(meshWithAna({ getProjectPath: () => undefined }));

    const outcome = deliverNotifyDm({ agentId: ANA_ID, message: 'Nowhere to go.' }, deps);

    expect(outcome).toEqual({ ok: false, reason: 'AGENT_NOT_RESOLVABLE' });
  });

  it('never throws when the MESH read itself fails', () => {
    const { deps } = setup(
      meshWithAna({
        getProjectPath: () => {
          throw new Error('SQLITE_BUSY: database is locked');
        },
      })
    );

    const outcome = deliverNotifyDm({ agentId: ANA_ID, message: 'Deploy finished.' }, deps);

    expect(outcome).toMatchObject({
      ok: false,
      reason: 'DM_UNAVAILABLE',
      error: expect.stringContaining('SQLITE_BUSY'),
    });
  });

  describe('the Direct chat it lands in (rule S12, DOR-2997)', () => {
    function withDirectChats() {
      const { harness, deps } = setup();
      const directChats = new DirectChats({
        store: harness.store,
        authors: harness.authors,
        rooms: harness.service,
        operator: () => harness.authors.getMany([harness.human]).get(harness.human)!,
        mintSessionId: () => 'direct-ana',
      });
      return { harness, deps: { ...deps, directChats }, directChats };
    }

    it('names the Direct chat the person reads it in, and it is the same every time', () => {
      const { deps, directChats } = withDirectChats();

      const first = deliverNotifyDm({ agentId: ANA_ID, message: 'one' }, deps);
      const second = deliverNotifyDm({ agentId: ANA_ID, message: 'two' }, deps);

      expect(first).toMatchObject({ ok: true, directChatId: 'direct-ana' });
      expect(second).toMatchObject({ ok: true, directChatId: 'direct-ana' });
      expect(directChats.ensureForAgent(ANA_PATH, 'Ana').sessionId).toBe('direct-ana');
    });

    it('records the session that wrote it, so that chat does not show it twice', () => {
      const { harness, deps } = withDirectChats();

      const outcome = deliverNotifyDm(
        { agentId: ANA_ID, message: 'from my own Direct chat', sessionId: 'direct-ana' },
        deps
      );

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      const [entry] = harness.service.listEntries(outcome.roomId, harness.human, { limit: 10 });
      expect(entry!.sessionId).toBe('direct-ana');
    });
  });
});
