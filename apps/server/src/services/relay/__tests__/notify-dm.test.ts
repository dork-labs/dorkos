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
  type RoomHarness,
} from '../../rooms/__tests__/room-test-harness.js';
import { deliverNotifyDm, type NotifyDmDeps } from '../notify-dm.js';

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

  it('spends the cascade at the ceiling, so the notification cannot start a conversation', () => {
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
