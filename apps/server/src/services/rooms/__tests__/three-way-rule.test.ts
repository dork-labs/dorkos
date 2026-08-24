/**
 * The three-way rule, and the DM hardening that had to ship with it
 * (ADR 260814-025326, DOR-1208).
 *
 * One sentence holds the whole file: **a room that holds two or more agents
 * holds the person too.** Agents may open rooms with each other — that is the
 * coordination this product exists for — and the price is that the conversation
 * is never invisible. Three verbs can break that shape and all three are pinned
 * here: creating a room, adding a member, and removing one.
 *
 * The second half is what relaxing the first half exposed. A DM needs no `@`,
 * so every member on the DM's own `always` seed answers everything — which is
 * right for one person and one agent, and turns into a pile-on the moment a
 * second agent is in the room. Those cases drive the REAL dispatcher, because
 * the claim is about how many turns a message actually costs.
 *
 * @module server/services/rooms/tests/three-way-rule
 */
import { describe, it, expect } from 'vitest';
import { eq, rooms, type Db } from '@dorkos/db';
import { CreateRoomRequestSchema } from '@dorkos/shared/room-schemas';
import type { AuthorKind, RoomKind } from '@dorkos/shared/room-schemas';
import { selectTriggerTargets, type TriggerSelection } from '../addressing.js';

/** The author ids out of a selection — these cases are about WHO, not why. */
const ids = (selections: readonly TriggerSelection[]): string[] =>
  selections.map((selection) => selection.authorId);
import { agentLookupFor, createRoomHarness, scriptedRunner } from './room-test-harness.js';

const AGENTS = agentLookupFor({
  '/agents/ana': { name: 'ana' },
  '/agents/bo': { name: 'bo' },
});

/**
 * The install this file is about: an owner, two agents, and nothing else.
 *
 * @param opts.ownerUserId - Give the install an owner account, for the one case
 *   about a second PERSON. Omitted means the default posture, no accounts.
 * @param opts.reply - What each agent says when it is asked, keyed on its
 *   directory. The default names the agent, so a log reads as who said what.
 */
function open(opts: { ownerUserId?: string; reply?: (agentPath: string) => string } = {}) {
  const runner = scriptedRunner((request) =>
    opts.reply ? opts.reply(request.agentPath) : `${request.agentPath} answered`
  );
  const harness = createRoomHarness({
    agents: AGENTS,
    runner,
    ...(opts.ownerUserId ? { ownerUserId: opts.ownerUserId } : {}),
  });
  return {
    ...harness,
    ana: harness.authors.resolveAgent('/agents/ana', 'Ana').id,
    bo: harness.authors.resolveAgent('/agents/bo', 'Bo').id,
  };
}

describe('the three-way rule — an agent may open a room with an agent, with you in it', () => {
  it('lets an agent open a room with a colleague when the owner is on the roster', () => {
    const { service, human, ana, bo } = open();
    const room = service.createRoom(
      { kind: 'channel', title: 'Pair', members: [human], agentPaths: ['/agents/bo'] },
      ana
    );
    expect(room.members.map((member) => member.authorId).sort()).toEqual([ana, bo, human].sort());
  });

  it('refuses the same room without the owner on it', () => {
    const { service, ana } = open();
    expect(() =>
      service.createRoom(
        { kind: 'channel', title: 'Pair', members: [], agentPaths: ['/agents/bo'] },
        ana
      )
    ).toThrow(expect.objectContaining({ code: 'OPERATOR_ONLY' }));
  });

  it('holds in a DM as well as a channel — the rule is about the roster, not the kind', () => {
    const { service, human, ana } = open();
    expect(() =>
      service.createRoom(
        { kind: 'dm', title: 'Pair', members: [], agentPaths: ['/agents/bo'] },
        ana
      )
    ).toThrow(expect.objectContaining({ code: 'OPERATOR_ONLY' }));
    expect(
      service.createRoom(
        { kind: 'dm', title: 'Pair', members: [human], agentPaths: ['/agents/bo'] },
        ana
      ).members
    ).toHaveLength(3);
  });

  it('still lets an agent open a room for itself alone', () => {
    const { service, ana } = open();
    expect(
      service.createRoom({ kind: 'dm', title: 'Ana notes', members: [], agentPaths: [] }, ana)
        .members
    ).toHaveLength(1);
  });

  it('does NOT hand the same escape to a second person', () => {
    // A member account is not an agent doing the job it was installed to do —
    // she would be spending the owner's model quota with the server process's
    // filesystem access. The owner being in the room makes that visible, not
    // consented, so this stays exactly as narrow as it was.
    const harness = open({ ownerUserId: 'user-dorian' });
    const priya = harness.authors.human('user-priya').id;
    expect(() =>
      harness.service.createRoom(
        { kind: 'channel', title: 'Hers', members: [harness.human], agentPaths: ['/agents/ana'] },
        priya
      )
    ).toThrow(expect.objectContaining({ code: 'OPERATOR_ONLY' }));
  });
});

describe('the three-way rule — the shape survives a membership change', () => {
  it('refuses a second agent added to a room the owner is not in', () => {
    // The add-then-remove bypass, from the add side: an agent opens a room for
    // itself (legitimate, and the owner is not in it), and the second agent
    // arrives afterwards. Refused even though the caller is the owner — the
    // refusal is about the room's shape, not about who asked.
    const { service, human, ana } = open();
    const solo = service.createRoom(
      { kind: 'channel', title: 'Scratch', members: [], agentPaths: [] },
      ana
    );
    expect(() => service.addMember(solo.id, human, { agentPath: '/agents/bo' })).toThrow(
      expect.objectContaining({ code: 'OWNER_MUST_BE_PRESENT' })
    );
    expect(service.getRoom(solo.id, human)?.members).toHaveLength(1);
  });

  it('allows it once the owner joins that room', () => {
    const { service, human, ana, bo } = open();
    const solo = service.createRoom(
      { kind: 'channel', title: 'Scratch', members: [], agentPaths: [] },
      ana
    );
    service.addMember(solo.id, human, { authorId: human });
    expect(service.addMember(solo.id, human, { agentPath: '/agents/bo' }).authorId).toBe(bo);
    expect(
      service
        .getRoom(solo.id, human)
        ?.members.map((m) => m.authorId)
        .sort()
    ).toEqual([ana, bo, human].sort());
  });

  it('does not refuse re-adding an agent that is already the room’s only one', () => {
    // A no-op one call down (`onConflictDoNothing`). Counting the candidate
    // twice would make an idempotent call fail, which is why the prospective
    // roster is a union rather than an append.
    const { service, human, ana } = open();
    const solo = service.createRoom(
      { kind: 'channel', title: 'Scratch', members: [], agentPaths: [] },
      ana
    );
    expect(service.addMember(solo.id, human, { agentPath: '/agents/ana' }).authorId).toBe(ana);
  });

  it('refuses taking the owner out of a room two agents share', () => {
    // The other half of the bypass. Without this, the create gate is theatre:
    // the price is paid at creation and taken back one call later.
    const { service, human, ana } = open();
    const room = service.createRoom(
      { kind: 'channel', title: 'Pair', members: [human], agentPaths: ['/agents/bo'] },
      ana
    );
    expect(() => service.removeMember(room.id, human, human)).toThrow(
      expect.objectContaining({ code: 'OWNER_MUST_BE_PRESENT' })
    );
    expect(service.getRoom(room.id, human)?.members.map((m) => m.authorId)).toContain(human);
  });

  it('leaves the way out open — one agent out, and the person may go', () => {
    const { service, human, ana, bo } = open();
    const room = service.createRoom(
      { kind: 'channel', title: 'Pair', members: [human], agentPaths: ['/agents/bo'] },
      ana
    );
    service.removeMember(room.id, human, bo);
    service.removeMember(room.id, human, human);
    expect(service.getRoom(room.id, human)?.members.map((m) => m.authorId)).toEqual([ana]);
  });

  it('never gets in the way of a room with one agent in it', () => {
    const { service, human, ana } = open();
    const room = service.createRoom(
      { kind: 'channel', title: 'Solo', members: [], agentPaths: ['/agents/ana'] },
      human
    );
    service.removeMember(room.id, human, human);
    expect(service.getRoom(room.id, human)?.members.map((m) => m.authorId)).toEqual([ana]);
  });

  it('lets an agent re-open a group DM the owner archived — accepted, and pinned', () => {
    // A consequence of the relaxation rather than a goal of it, recorded in the
    // ADR: `createRoom`'s DM branch matches on the exact member set and
    // un-archives what it matched, and `updateRoom` has no operator gate
    // (DOR-608's known hole, which cannot close without breaking that path).
    // Before DOR-1208 an agent could only reach its own two-party DMs this way.
    // Accepted because the room comes back whole — same id, same history, same
    // roster, owner on it — and archive is the reversible "put it away"
    // (spec §12.4). Pinned so that if somebody later decides it is NOT
    // acceptable, they change this test deliberately rather than discovering it.
    const { service, human, ana } = open();
    const dm = service.createRoom(
      { kind: 'dm', title: 'Pair', members: [human], agentPaths: ['/agents/bo'] },
      ana
    );
    service.updateRoom(dm.id, human, { archived: true });

    const reopened = service.createRoom(
      { kind: 'dm', title: 'Pair', members: [human], agentPaths: ['/agents/bo'] },
      ana
    );
    expect(reopened.id).toBe(dm.id);
    expect(reopened.created).toBe(false);
    expect(reopened.archived).toBe(false);
  });
});

describe('a DM never widens under a membership change', () => {
  it('costs one turn per agent when a person writes, and nothing more', async () => {
    // Before DOR-1208 this exact sequence cost four turns and posted two
    // apology notices: every member of a DM is seeded `always`, so Ana's answer
    // triggered Bo and Bo's answer triggered Ana until the cascade guard stopped
    // it. Nobody had changed a setting; adding a member had changed the reach.
    const { service, human, runner } = open();
    const dm = service.createRoom(
      { kind: 'dm', title: 'Ana', members: [], agentPaths: ['/agents/ana'] },
      human
    );
    service.addMember(dm.id, human, { agentPath: '/agents/bo' });

    service.post(dm.id, { authorId: human, text: 'hello' });
    await service.triggersIdle();

    expect(runner.turns.map((turn) => turn.agentPath).sort()).toEqual([
      '/agents/ana',
      '/agents/bo',
    ]);
    const log = service.listEntries(dm.id, human, { limit: 50 });
    expect(log.filter((entry) => entry.kind === 'notice')).toEqual([]);
    expect(log.map((entry) => entry.body.text)).toEqual([
      'hello',
      '/agents/ana answered',
      '/agents/bo answered',
    ]);
  });

  it('keeps every member on the seed the addition did not change', () => {
    // The reach changed, not the policy — which is exactly why a policy check
    // could not have caught it. The modes are identical before and after.
    const { service, human } = open();
    const dm = service.createRoom(
      { kind: 'dm', title: 'Ana', members: [], agentPaths: ['/agents/ana'] },
      human
    );
    service.addMember(dm.id, human, { agentPath: '/agents/bo' });
    expect(service.getRoom(dm.id, human)?.members.map((member) => member.responseMode)).toEqual([
      'always',
      'always',
      'always',
    ]);
  });

  it('still lets one agent reach another in a DM by naming it', async () => {
    // Restraint, not a wall. `@bo` is an address, and an address is answered
    // wherever it is written — including by an agent, in a DM. Bo is on
    // `mention-only` so the person's own message reaches Ana alone, which is
    // what leaves Ana's reply as the only thing that could have summoned Bo.
    const { service, human, bo, runner } = open({
      reply: (agentPath) => (agentPath === '/agents/ana' ? '@bo can you take this one?' : 'on it'),
    });
    const dm = service.createRoom(
      { kind: 'dm', title: 'Pair', members: [], agentPaths: ['/agents/ana', '/agents/bo'] },
      human
    );
    service.updateMembership(dm.id, human, bo, 'mention-only');

    service.post(dm.id, { authorId: human, text: 'who can take the migration?' });
    await service.triggersIdle();

    expect(runner.turns.map((turn) => turn.agentPath)).toEqual(['/agents/ana', '/agents/bo']);
  });
});

describe('the addressing matrix a DM member addition must not move', () => {
  const always = {
    authorId: 'bo',
    kind: 'agent',
    responseMode: 'always',
    isEngaged: false,
  } as const;

  /** One unaddressed post, from whoever wrote it, in whatever kind of room. */
  function reach(roomKind: RoomKind, authorKind: AuthorKind): string[] {
    return selectTriggerTargets({
      roomKind,
      authorKind,
      entry: { authorId: 'ana', mentions: [] },
      members: [always],
    }).map((selection) => selection.authorId);
  }

  it('leaves a channel exactly as it was — an agent still reaches an always room-mate', () => {
    expect(reach('channel', 'agent')).toEqual(['bo']);
    expect(reach('channel', 'human')).toEqual(['bo']);
  });

  it('keeps a DM answering the person, and stops it answering the other agent', () => {
    expect(reach('dm', 'human')).toEqual(['bo']);
    expect(reach('dm', 'agent')).toEqual([]);
  });

  it('reaches a named member in a DM whatever wrote the message', () => {
    expect(
      ids(
        selectTriggerTargets({
          roomKind: 'dm',
          authorKind: 'agent',
          entry: { authorId: 'ana', mentions: ['bo'] },
          members: [always],
        })
      )
    ).toEqual(['bo']);
  });

  it('treats a room that is neither kind as the restrained one', () => {
    // `as never` forces past the compile-time union to reach the branch a
    // corrupt row would take. The whole point of writing the test
    // `!== 'channel'` rather than `=== 'dm'` is that this answers `[]`.
    expect(reach('huddle' as never, 'agent')).toEqual([]);
    expect(reach('huddle' as never, 'human')).toEqual(['bo']);
  });

  it('never hands an unknown kind MORE than either known kind', () => {
    // The other side of "fails closed", and why this is spelled per branch
    // rather than as "unknown means DM": `direct-only` answers everything in a
    // real DM, and an unknown kind does not inherit that.
    const directOnly = {
      authorId: 'bo',
      kind: 'agent',
      responseMode: 'direct-only',
      isEngaged: false,
    } as const;
    const entry = { authorId: 'dorian', mentions: [] };
    expect(
      ids(
        selectTriggerTargets({ roomKind: 'dm', authorKind: 'human', entry, members: [directOnly] })
      )
    ).toEqual(['bo']);
    expect(
      ids(
        selectTriggerTargets({
          roomKind: 'huddle' as never,
          authorKind: 'human',
          entry,
          members: [directOnly],
        })
      )
    ).toEqual([]);
  });
});

describe('an unrecognized room kind fails closed', () => {
  /** Corrupt one room's `kind` the only way it can be corrupted: in storage. */
  function bogusKind(db: Db, roomId: string): void {
    db.update(rooms).set({ kind: 'huddle' }).where(eq(rooms.id, roomId)).run();
  }

  it('is impossible to ask for — the request schema is a closed set', () => {
    // So the storage cases below are the ONLY way an unknown kind exists: a
    // hand-edited database, or a column that gains a value before the code that
    // reads it does. `toRoom` narrows that column with an unchecked cast
    // (`room-rows.ts`), which is a claim about callers, not about storage.
    expect(CreateRoomRequestSchema.safeParse({ kind: 'huddle', title: 'Huddle' }).success).toBe(
      false
    );
    expect(CreateRoomRequestSchema.safeParse({ kind: 'dm', title: 'Ana' }).success).toBe(true);
  });

  it('spends no more turns than the DM it is being read as, end to end', async () => {
    // The wiring, not the predicate: the dispatcher reads `room.kind` off the
    // stored row, so this is the case that would go red if the restraint were
    // written `=== 'dm'` — a corrupt row would then be read as a channel, and
    // the two `always` members would answer each other the way a DM used to.
    const { service, db, human, runner } = open();
    const room = service.createRoom(
      { kind: 'dm', title: 'Pair', members: [], agentPaths: ['/agents/ana', '/agents/bo'] },
      human
    );
    bogusKind(db, room.id);

    service.post(room.id, { authorId: human, text: 'hello' });
    await service.triggersIdle();

    expect(runner.turns).toHaveLength(2);
    expect(
      service.listEntries(room.id, human, { limit: 50 }).filter((entry) => entry.kind === 'notice')
    ).toEqual([]);
  });

  it('seeds a new member off the DM branch, not the channel one', () => {
    const { service, db, human } = open();
    const room = service.createRoom(
      { kind: 'channel', title: 'Odd', members: [], agentPaths: [] },
      human
    );
    bogusKind(db, room.id);
    // `engaged` is the CHANNEL seed. An unknown kind gets the manifest default
    // a DM gets, which is bounded by the addressing case above: the person's
    // messages reach everybody, an agent's reach only who it names.
    expect(service.addMember(room.id, human, { agentPath: '/agents/ana' }).responseMode).toBe(
      'always'
    );
  });
});
