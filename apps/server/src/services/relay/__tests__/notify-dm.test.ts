/**
 * Where a proactive agent message goes when no chat integration can carry it
 * (DOR-1209).
 *
 * The rooms half is REAL here — the real service, the real author registry, the
 * real store over an in-memory database — because every claim worth making is
 * about what lands in the log: which room, whose name on it, and what cascade
 * stamp it carries. A fake room service could only prove that this module calls
 * the methods it calls.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createRoomHarness,
  agentLookupFor,
  outcomeRunner,
  type RoomHarness,
} from '../../rooms/__tests__/room-test-harness.js';
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
  warn: ReturnType<typeof vi.fn>;
} {
  const harness = createRoomHarness({
    agents: agentLookupFor({ [ANA_PATH]: { name: 'ana' } }),
    maxAgentDepth: CEILING,
  });
  const warn = vi.fn();
  return {
    harness,
    warn,
    deps: {
      rooms: harness.service,
      authors: harness.authors,
      mesh,
      operatorAuthorId: () => harness.human,
      logger: { warn },
    },
  };
}

describe('deliverNotifyDm', () => {
  it('opens the DM with the operator and posts as the agent', () => {
    const { harness, deps } = setup();

    const outcome = deliverNotifyDm({ agentId: ANA_ID, message: 'Deploy finished.' }, deps);

    expect(outcome).toMatchObject({ ok: true });
    if (!outcome.ok) return;

    const room = harness.store.getRoom(outcome.roomId);
    expect(room?.kind).toBe('dm');
    const anaAuthorId = harness.authors.resolveAgent(ANA_PATH, 'Ana').id;
    // The roster is exactly these two — the sending agent and the person.
    expect(new Set(harness.store.listMembers(outcome.roomId).map((m) => m.authorId))).toEqual(
      new Set([anaAuthorId, harness.human])
    );
    const entries = harness.service.listEntries(outcome.roomId, harness.human, { limit: 10 });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.id).toBe(outcome.entryId);
    expect(entries[0]!.body).toMatchObject({ text: 'Deploy finished.' });
    // Written BY the agent, as an ordinary post — not a notice in the room's
    // own voice, which is what the room says when a turn could not run.
    expect(entries[0]!.authorId).toBe(anaAuthorId);
    expect(entries[0]!.kind).toBe('post');
  });

  it('inherits the cascade of a turn the agent is already running', async () => {
    // The other half of the cascade rule, and the one the ceiling test cannot
    // see: an agent that notifies from INSIDE a turn is not un-provenanced, so
    // `writePost` picks up its live claim through `activeTurnFor` and the
    // notification is bounded by the budget that turn is already spending —
    // rather than being stamped at the ceiling as if nothing had triggered it.
    let midTurn: NotifyDmOutcome | undefined;
    // A holder, because the runner has to read the deps at the moment the turn
    // runs — the only moment a claim is actually held — and the deps cannot
    // exist until the harness the runner is built into does.
    const wiring: { deps?: NotifyDmDeps } = {};
    const runner = outcomeRunner(() => {
      midTurn = deliverNotifyDm({ agentId: ANA_ID, message: 'Deploy finished.' }, wiring.deps!);
      return { text: 'on it' };
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
    // The turn's own answer, written by the dispatcher under the same claim.
    const replied = entries.find((e) => (e.body as { text?: string }).text === 'on it');
    expect(notified).toBeDefined();
    expect(replied).toBeDefined();
    // The person's message is the root, and the notification is stamped exactly
    // like the reply that turn produced — NOT at the ceiling, and not as a fresh
    // cascade of its own.
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

    // `deriveCascade` stamps an agent post with no turn behind it at the
    // ceiling: durable and readable, and anything downstream of it is refused
    // by the depth rule rather than silently costing a model turn. Pinned here
    // because it is the property that makes a notification safe to send from a
    // path no person triggered.
    const [entry] = harness.service.listEntries(outcome.roomId, harness.human, { limit: 10 });
    expect(entry!.cascadeDepth).toBe(CEILING);
    expect(entry!.cascadeRoot).toBe(entry!.id);
  });

  it('reuses the direct message the operator already has with that agent', () => {
    const { harness, deps } = setup();
    const anaAuthorId = harness.authors.resolveAgent(ANA_PATH, 'Ana').id;
    // The conversation the cockpit would have opened: same two people, opened
    // by the person rather than by the agent.
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
    const { deps, warn } = setup(meshWithAna({ getProjectPath: () => undefined }));

    const outcome = deliverNotifyDm({ agentId: ANA_ID, message: 'Nowhere to go.' }, deps);

    expect(outcome).toEqual({ ok: false, reason: 'AGENT_NOT_RESOLVABLE' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not place its sender'), {
      agentId: ANA_ID,
      hasPath: false,
      hasManifest: true,
    });
  });

  it('never throws when the MESH read itself fails', () => {
    // The mesh reads hit the `agents` table, so a concurrent write can raise
    // SQLITE_BUSY. Outside the try that throw escaped `deliverNotifyDm`
    // entirely and left `relay_notify_user` throwing instead of answering —
    // strictly worse than the silence this module exists to replace.
    const { deps, warn } = setup(
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
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('could not be delivered'),
      // No path, because the failure was before this sender was ever placed.
      expect.objectContaining({ agentId: ANA_ID, agentPath: undefined })
    );
  });

  it('never throws when the rooms domain refuses — it reports and logs instead', () => {
    const { deps, warn } = setup();
    // A refusal from the rooms domain itself: the operator's author row is not
    // one this install has, so the roster resolves nobody and `createRoom`
    // throws before anything is written.
    deps.operatorAuthorId = () => 'no-such-author';

    const outcome = deliverNotifyDm({ agentId: ANA_ID, message: 'Still trying.' }, deps);

    expect(outcome).toMatchObject({ ok: false, reason: 'DM_UNAVAILABLE' });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('could not be delivered'),
      expect.objectContaining({ agentId: ANA_ID, agentPath: ANA_PATH })
    );
  });
});
