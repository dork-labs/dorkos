/**
 * An author that no longer speaks for its directory releases its claims
 * (ADR 260801-003051).
 *
 * Nothing ever deletes an `authors` row, so a relocated agent — or one the
 * reconciler's orphan sweep dropped — leaves a row behind that is still in every
 * roster it joined. `claimNames` is first-claimant-wins over that roster, so a
 * GHOST ahead of a live agent with the same display name took the name and the
 * live agent became unreachable by mention. That was verified by execution
 * during review, not reasoned about, and it is the first test here.
 *
 * The whole file drives the reader that ships (`createAgentLookup`) over real
 * `agents` rows, because the mechanism's entire content is "does this directory
 * hold this agent" and a fixture that answers that question by hand would only
 * prove the fixture.
 */
import { describe, it, expect } from 'vitest';
import { agents, roomMembers, eq, and, type Db } from '@dorkos/db';
import type { AuthorRef, RoomWithRoster } from '@dorkos/shared/room-schemas';
import { createAgentLookup } from '../index.js';
import { createRoomHarness, settleUntil, type RoomHarness } from './room-test-harness.js';

const ANA_PATH = '/agents/ana';
const BO_PATH = '/agents/bo';

/** Register an agent row the way the mesh registry does. */
function registerAgent(
  db: Db,
  input: { id: string; projectPath: string; name: string; status?: 'active' | 'unreachable' }
): void {
  const now = new Date().toISOString();
  db.insert(agents)
    .values({
      id: input.id,
      name: input.name,
      runtime: 'claude-code',
      projectPath: input.projectPath,
      registeredAt: now,
      updatedAt: now,
      ...(input.status ? { status: input.status } : {}),
    })
    .run();
}

/** A harness whose agent lookup is the shipped one, over its own database. */
function liveHarness(): RoomHarness {
  return createRoomHarness({ agents: (db) => createAgentLookup(db) });
}

/** Open a channel holding the given agent directories, and hand back its roster. */
function channelWith(harness: RoomHarness, agentPaths: string[]): RoomWithRoster {
  const room = harness.service.createRoom(
    { kind: 'channel', slug: 'general', title: '#general', members: [], agentPaths },
    harness.human
  );
  return harness.service.getRoom(room.id, harness.human)!;
}

/**
 * Force a member to the front of the roster.
 *
 * Membership order is `(joinedAt, authorId)` and a roster seeded in one
 * transaction ties on `joinedAt`, so which agent wins a contested name would
 * otherwise be decided by a ULID and differ run to run — and the defect this
 * file is about hides on half of those runs.
 */
function putFirst(harness: RoomHarness, roomId: string, authorId: string): void {
  harness.db
    .update(roomMembers)
    .set({ joinedAt: '2000-01-01T00:00:00.000Z' })
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.authorId, authorId)))
    .run();
}

/**
 * Make a member answer every message here.
 *
 * A channel seeds agents at `engaged`, so an un-addressed message selects
 * nobody — and a ghost cannot be addressed, because releasing its handle is
 * precisely what the mechanism does. `always` is what makes the DISPATCH
 * refusal reachable at all, and it is an ordinary setting a person can choose.
 */
function answerAlways(harness: RoomHarness, roomId: string, authorId: string): void {
  harness.db
    .update(roomMembers)
    .set({ responseMode: 'always' })
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.authorId, authorId)))
    .run();
}

/** The roster row for the member with this author id. */
function memberById(room: RoomWithRoster, authorId: string): AuthorRef {
  const member = room.members.find((m) => m.author.id === authorId);
  if (!member) throw new Error(`No member ${authorId}`);
  return member.author;
}

/** Every notice code the room has written, oldest first. */
function noticeCodes(harness: RoomHarness, roomId: string): string[] {
  return harness.service
    .listEntries(roomId, harness.human, { limit: 100 })
    .filter((entry) => entry.kind === 'notice')
    .map((entry) => entry.body.notice ?? '')
    .reverse();
}

// ---------------------------------------------------------------------------
// §5.7 — the review's executed scenario, as a regression
// ---------------------------------------------------------------------------

describe('a ghost author claims nothing', () => {
  it('lets the live agent have the contested name, even with the ghost first in the roster', async () => {
    const harness = liveHarness();
    // Two agents that render identically — the shape that makes first-claimant
    // ordering observable at all.
    registerAgent(harness.db, { id: 'ULID_ANA', projectPath: ANA_PATH, name: 'helper' });
    registerAgent(harness.db, { id: 'ULID_BO', projectPath: BO_PATH, name: 'helper' });
    const seeded = channelWith(harness, [ANA_PATH, BO_PATH]);
    expect(seeded.members.filter((m) => m.author.kind === 'agent')).toHaveLength(2);

    // Ana becomes a ghost: her agent row is gone, her author row is not.
    const anaAuthor = harness.authors.resolveAgent(ANA_PATH, 'helper');
    harness.db.delete(agents).where(eq(agents.projectPath, ANA_PATH)).run();
    putFirst(harness, seeded.id, anaAuthor.id);

    const room = harness.service.getRoom(seeded.id, harness.human)!;
    const boAuthor = harness.authors.resolveAgent(BO_PATH, 'helper');

    // The ghost is still IN the roster — membership is a fact about the room —
    // and is offered no handle at all.
    expect(memberById(room, anaAuthor.id).mentionHandle).toBeUndefined();
    // The live agent gets the name, despite being second in line for it.
    expect(memberById(room, boAuthor.id).mentionHandle).toBe('helper');

    // And the name resolves to the live agent through the real write path.
    const entry = harness.service.post(room.id, { authorId: harness.human, text: '@helper hi' });
    expect(entry.mentions).toEqual([boAuthor.id]);

    await harness.service.triggersIdle();
    // Only the live agent ran a turn.
    expect(harness.runner.turns.map((turn) => turn.agentPath)).toEqual([BO_PATH]);
  });

  it('refuses to dispatch to a ghost, visibly, in the room the person is reading', async () => {
    const harness = liveHarness();
    registerAgent(harness.db, { id: 'ULID_ANA', projectPath: ANA_PATH, name: 'ana' });
    const seeded = channelWith(harness, [ANA_PATH]);
    const anaAuthor = harness.authors.resolveAgent(ANA_PATH, 'ana');
    answerAlways(harness, seeded.id, anaAuthor.id);

    harness.db.delete(agents).where(eq(agents.projectPath, ANA_PATH)).run();

    harness.service.post(seeded.id, { authorId: harness.human, text: 'anyone about?' });
    await settleUntil(
      () => noticeCodes(harness, seeded.id).includes('agent_gone'),
      'the room said the agent is gone'
    );

    // No turn was attempted, and the room said why — in its own words, not as a
    // `turn_failed` pointing at a session that does not exist.
    expect(harness.runner.turns).toHaveLength(0);
    expect(noticeCodes(harness, seeded.id)).toContain('agent_gone');
    expect(noticeCodes(harness, seeded.id)).not.toContain('turn_failed');
  });

  it('leaves an UNREACHABLE agent its name — a closed laptop is not a ghost', async () => {
    const harness = liveHarness();
    registerAgent(harness.db, {
      id: 'ULID_ANA',
      projectPath: ANA_PATH,
      name: 'ana',
      status: 'unreachable',
    });
    const seeded = channelWith(harness, [ANA_PATH]);
    const anaAuthor = harness.authors.resolveAgent(ANA_PATH, 'ana');

    // The row exists, so the author still speaks for the directory. Losing a
    // name mid-conversation because a machine went to sleep is the failure this
    // narrowness prevents.
    expect(
      memberById(harness.service.getRoom(seeded.id, harness.human)!, anaAuthor.id).mentionHandle
    ).toBe('ana');
    const entry = harness.service.post(seeded.id, { authorId: harness.human, text: '@ana hi' });
    expect(entry.mentions).toEqual([anaAuthor.id]);

    await harness.service.triggersIdle();
    expect(harness.runner.turns.map((turn) => turn.agentPath)).toEqual([ANA_PATH]);
  });
});

// ---------------------------------------------------------------------------
// §5.11 — the stale-stamp scenario
// ---------------------------------------------------------------------------

describe('an author minted for a previous occupant is not the agent living there now', () => {
  it('claims nothing while the new agent has not yet posted, and hands over once it has', async () => {
    // The state "an active row implies a matching stamp" is false in: agent B is
    // registered at agent A's old directory but has never posted, so nothing has
    // called `resolve` and no retirement decision has run. The roster is read
    // through `getMany`, which does not resolve — so without the stamp
    // comparison at the handle seam, A's author claims B's `@handle`.
    const harness = liveHarness();
    registerAgent(harness.db, { id: 'ULID_ANA', projectPath: ANA_PATH, name: 'ana' });
    const seeded = channelWith(harness, [ANA_PATH]);
    const anaAuthor = harness.authors.resolveAgent(ANA_PATH, 'ana');
    expect(anaAuthor.mintedForManifestId).toBe('ULID_ANA');
    answerAlways(harness, seeded.id, anaAuthor.id);

    // The directory is re-inited: a different agent lives there now. A's author
    // row is untouched — still active, still stamped for A.
    harness.db.delete(agents).where(eq(agents.projectPath, ANA_PATH)).run();
    registerAgent(harness.db, { id: 'ULID_BO', projectPath: ANA_PATH, name: 'ana' });

    const stale = harness.service.getRoom(seeded.id, harness.human)!;
    expect(memberById(stale, anaAuthor.id).mentionHandle).toBeUndefined();
    expect(
      harness.service.post(stale.id, { authorId: harness.human, text: '@ana hello' }).mentions
    ).toEqual([]);
    await settleUntil(
      () => noticeCodes(harness, seeded.id).includes('agent_gone'),
      'the room refused the stale member'
    );
    expect(harness.runner.turns).toHaveLength(0);

    // The operator re-invites the agent that actually lives there. Resolving it
    // retires A's row and mints B's, and B is the only addressable one.
    const bo = harness.service.addMember(seeded.id, harness.human, { agentPath: ANA_PATH });
    expect(bo.author.id).not.toBe(anaAuthor.id);

    const settled = harness.service.getRoom(seeded.id, harness.human)!;
    expect(memberById(settled, anaAuthor.id).mentionHandle).toBeUndefined();
    expect(memberById(settled, bo.author.id).mentionHandle).toBe('ana');
    expect(
      harness.service.post(settled.id, { authorId: harness.human, text: '@ana hello again' })
        .mentions
    ).toEqual([bo.author.id]);

    await harness.service.triggersIdle();
    expect(harness.runner.turns.map((turn) => turn.agentPath)).toEqual([ANA_PATH]);
  });
});
