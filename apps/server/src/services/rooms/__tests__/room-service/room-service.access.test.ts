import { describe, it, expect, beforeEach } from 'vitest';
import type { AuthorRegistry } from '../../author-registry.js';
import type { RoomService } from '../../room-service.js';
import { createRoomHarness, roomSpec } from '../room-test-harness.js';

import { agentLookup } from './room-service.fixtures.js';

describe('RoomService — who may change a roster', () => {
  let service: RoomService;
  let authors: AuthorRegistry;
  let human: string;
  let roomId: string;
  let ana: string;

  beforeEach(() => {
    ({ service, authors, human } = createRoomHarness({ agents: agentLookup }));
    const room = service.createRoom(roomSpec('channel', 'Backend', ['/agents/ana']), human);
    roomId = room.id;
    ana = authors.resolveAgent('/agents/ana', 'Ana').id;
  });

  it('refuses an agent on the OPERATOR entry point, whatever grant it holds', () => {
    // The regression guard (DOR-1611 review). `addMember`/`removeMember` are the
    // operator surface — the HTTP routes, the community adapter, the team-room
    // hook — and they went back to `requireOperator` after a branch briefly
    // widened them for every caller. That widening made the `roomsManage` gate
    // walkable with a direct HTTP call, because the gate lives at
    // `registry.invoke` and a route never goes through it. An agent's roster
    // surface is the capability verbs, full stop.
    expect(() => service.addMember(roomId, ana, { agentPath: '/agents/bo' })).toThrow(
      expect.objectContaining({ code: 'OPERATOR_ONLY' })
    );
    expect(() => service.removeMember(roomId, ana, ana)).toThrow(
      expect.objectContaining({ code: 'OPERATOR_ONLY' })
    );
    expect(service.getRoom(roomId, human)?.members).toHaveLength(2);
  });

  it('lets a member agent add another member through the TOOL entry point', () => {
    // No longer operator-only on that path (spec `rooms-management-tools` §D7,
    // DOR-1611). Ana belongs to this room and the owner is on its roster, so the
    // roster this produces — the person plus two agents — is exactly the shape
    // the three-way rule asks for, and nothing about that rule had to move.
    const added = service.addMemberFromTool(roomId, ana, { agentPath: '/agents/bo' });

    expect(added.authorId).toBeTruthy();
    expect(service.getRoom(roomId, human)?.members).toHaveLength(3);
  });

  it('refuses a member agent that would leave two agents alone together', () => {
    // The widening stops exactly where the three-way rule starts. Ana opens a
    // room for herself — legitimate, and the owner is not on its roster — and
    // then tries to pull a colleague into it. That is the amplification shape,
    // and it is refused for an agent caller by the guard that never asked who
    // was calling in the first place.
    const own = service.createRoom(roomSpec('dm', 'Ana notes'), ana);

    expect(() => service.addMemberFromTool(own.id, ana, { agentPath: '/agents/bo' })).toThrow(
      expect.objectContaining({ code: 'OWNER_MUST_BE_PRESENT' })
    );
    expect(service.getRoom(own.id, human)?.members).toHaveLength(1);
  });

  it('refuses a member agent taking the PERSON out, in a room the shape rules would allow', () => {
    // Stronger than the three-way rule on purpose (§D7 row 4). This room holds
    // one agent, so removing the owner would leave no forbidden shape behind and
    // `requireOwnerWitnessesAgents` would permit it — the refusal is about who
    // is asking, because the person's membership is the guarantee.
    expect(() => service.removeMemberFromTool(roomId, ana, human)).toThrow(
      expect.objectContaining({ code: 'OPERATOR_ONLY' })
    );
    expect(service.getRoom(roomId, human)?.members.map((m) => m.authorId)).toContain(human);
  });

  it('refuses an agent widening a room-mate response mode', () => {
    service.addMember(roomId, human, { agentPath: '/agents/bo' });
    const bo = authors.resolveAgent('/agents/bo', 'Bo').id;

    // This is the amplification lever: `always` on a room-mate means every
    // message Ana writes gets an answer Ana can then answer.
    expect(() => service.updateMembership(roomId, ana, bo, 'always')).toThrow(
      expect.objectContaining({ code: 'OPERATOR_ONLY' })
    );
    expect(
      service.getRoom(roomId, human)?.members.find((m) => m.authorId === bo)?.responseMode
    ).toBe('engaged');
  });

  it('tells the agent whose call it is, rather than refusing blankly', () => {
    // The sentence matters as much as the code: a model that is told "only you"
    // can relay that to the person, where "OPERATOR_ONLY" alone reads as a bug.
    expect(() => service.removeMemberFromTool(roomId, ana, human)).toThrow(
      'Only you can take yourself out of a room'
    );
  });

  it('refuses an agent conscripting a second agent into a room it opens', () => {
    expect(() => service.createRoom(roomSpec('dm', 'Bo', ['/agents/bo']), ana)).toThrow(
      expect.objectContaining({ code: 'OPERATOR_ONLY' })
    );
    expect(service.listRooms(human).map((r) => r.title)).not.toContain('Bo');
  });

  it('still lets an agent open a room for itself', () => {
    const own = service.createRoom(roomSpec('dm', 'Ana notes'), ana);
    expect(own.members.map((m) => m.authorId)).toEqual([ana]);
  });

  it('lets an agent reply in a thread beside a second agent, and keeps the bound that mattered', () => {
    // The seeding gate used to cover `createThread`, because a thread was a new
    // room: a fresh roster, a fresh budget window and — the real prize — a fresh
    // `(room_id, cascade_root)` namespace the repeat rule had never seen.
    //
    // A thread reply buys none of those any more (ADR 260728-022013), so the
    // gate has nothing left to protect and replying is exactly as allowed as
    // posting. This test pins BOTH halves, because the loosening is only safe if
    // the second one holds: the reply lands in the channel's own cascade set.
    service.addMember(roomId, human, { agentPath: '/agents/bo' });
    const entry = service.post(roomId, { authorId: human, text: 'worth a thread' });

    const reply = service.post(roomId, {
      authorId: ana,
      text: 'looking',
      replyTo: entry.id,
      trigger: { root: entry.cascadeRoot, depth: 1 },
    });

    expect(reply.roomId).toBe(roomId);
    expect(reply.threadRootEntryId).toBe(entry.id);
    expect([...service.turnsByAuthorInCascade(roomId, entry.cascadeRoot).keys()].sort()).toEqual(
      [human, ana].sort()
    );
  });

  it('lets the operator do all three', () => {
    const bo = service.addMember(roomId, human, { agentPath: '/agents/bo' }).authorId;
    expect(service.updateMembership(roomId, human, bo, 'always').responseMode).toBe('always');
    service.removeMember(roomId, human, bo);
    expect(service.getRoom(roomId, human)?.members.map((m) => m.authorId)).not.toContain(bo);
  });
});

/**
 * The behaviour DOR-598 exists for: until this landed, `seesEveryRoom` and
 * `requireOperator` both granted on `kind === 'human'`, which was the same
 * question as "is the operator" only while an install minted exactly one human
 * author. Every test here fails on the old code — which is the point.
 *
 * ADR 260727-184933 D6 makes this MORE relevant, not less. The local install
 * stays single-user for good, so there is no second local account — but joining
 * a community will fill this same `authors` table with other humans, cached
 * remote members whose messages you hold. Any code reading `kind === 'human'`
 * and concluding "operator" is wrong on your own machine the moment one of them
 * lands, with no second account anywhere. `humanWhoIsNotTheOwner` below is that
 * row.
 *
 * The harness is given an `ownerUserId`, so ownership resolves through the real
 * `AuthorRegistry.isOwner` rather than a stub.
 */
describe('RoomService — a human who is not the owner is not the operator', () => {
  const OWNER_USER = 'user-dorian';
  let service: RoomService;
  let authors: AuthorRegistry;
  let owner: string;
  let priya: string;
  let ownersRoom: string;
  let sharedRoom: string;

  beforeEach(() => {
    ({
      service,
      authors,
      human: owner,
    } = createRoomHarness({
      agents: agentLookup,
      ownerUserId: OWNER_USER,
    }));
    // A human author that is not the owner — the shape a cached remote member
    // takes, and the shape `resolveCaller` would mint for an account that is not
    // the owner's.
    priya = authors.human('user-priya').id;

    ownersRoom = service.createRoom(roomSpec('dm', 'Ana', ['/agents/ana']), owner).id;
    sharedRoom = service.createRoom(roomSpec('channel', 'Backend'), owner).id;
    service.addMember(sharedRoom, owner, { authorId: priya });
  });

  it('shows her the rooms she is in and nothing else', () => {
    expect(service.listRooms(priya).map((room) => room.id)).toEqual([sharedRoom]);
  });

  it('hides the owner DM with an agent, by id as well as by listing', () => {
    // The same `ROOM_NOT_FOUND` a room that does not exist gets, so holding an
    // id proves nothing about whether one is there.
    expect(service.getRoom(ownersRoom, priya)).toBeNull();
    expect(() => service.post(ownersRoom, { authorId: priya, text: 'hello?' })).toThrow(
      expect.objectContaining({ code: 'ROOM_NOT_FOUND' })
    );
  });

  it('refuses her every roster write in a room she IS in', () => {
    expect(() => service.addMember(sharedRoom, priya, { agentPath: '/agents/bo' })).toThrow(
      expect.objectContaining({ code: 'OPERATOR_ONLY' })
    );
    expect(() => service.updateMembership(sharedRoom, priya, priya, 'always')).toThrow(
      expect.objectContaining({ code: 'OPERATOR_ONLY' })
    );
    expect(() => service.removeMember(sharedRoom, priya, owner)).toThrow(
      expect.objectContaining({ code: 'OPERATOR_ONLY' })
    );
    // Sorted: a roster's order is not part of the contract, and two authors
    // minted in the same millisecond order by ULID randomness.
    expect(
      service
        .getRoom(sharedRoom, owner)
        ?.members.map((m) => m.authorId)
        .sort()
    ).toEqual([owner, priya].sort());
  });

  it('keeps the refusal wording the install has always had', () => {
    // Deliberately NOT the owner's account name. Under D6 the only caller that
    // ever reads this is an agent, for which "you" already means the operator —
    // and putting the owner's real name into an agent-visible error string
    // would leak it into agent context for nothing.
    expect(() => service.removeMember(sharedRoom, priya, owner)).toThrow(
      'Only you can change who is in a room'
    );
  });

  it('refuses her assembling a room whose agents answer each other', () => {
    // `/api/rooms` is reachable by a member — her own rooms live behind it — so
    // without this she could have built the amplification room `addMember`
    // refuses, spending the owner's model quota inside it.
    expect(() =>
      service.createRoom(roomSpec('channel', 'Mine', ['/agents/ana', '/agents/bo']), priya)
    ).toThrow(expect.objectContaining({ code: 'OPERATOR_ONLY' }));
    expect(service.listRooms(owner).map((r) => r.title)).not.toContain('Mine');
  });

  it('lets her read and post in the room she was admitted to', () => {
    expect(service.getRoom(sharedRoom, priya)?.id).toBe(sharedRoom);
    expect(service.post(sharedRoom, { authorId: priya, text: 'hello' }).authorId).toBe(priya);
  });

  it('tells her which member she is, on every room body she can get', () => {
    expect(service.getRoom(sharedRoom, priya)?.viewerAuthorId).toBe(priya);
    expect(service.snapshot(sharedRoom, priya, 10).room.viewerAuthorId).toBe(priya);
    expect(service.getRoom(sharedRoom, owner)?.viewerAuthorId).toBe(owner);
  });

  it('changes nothing at all for an agent, in either direction', () => {
    // The predicate that replaced `kind === 'human'` is strictly NARROWER:
    // `isOwner` returns false for anything that is not a human author, so
    // `isOwnerAuthor(x)` implies `x.kind === 'human'`. An agent therefore fails
    // the old test and the new one identically, and the set of refused callers
    // grew by exactly one thing — a human who is not the owner.
    //
    // Pinned on `createRoom`, which is now the whole of what
    // `requireSeedingAllowed` guards: a careless widening here would let an
    // agent assemble a room whose members answer each other. Both answers below
    // are the pre-DOR-598 ones.
    const ana = authors.resolveAgent('/agents/ana', 'Ana').id;

    // Alone with the owner: nothing is conscripted, so it is allowed.
    expect(service.createRoom(roomSpec('dm', 'Ana notes'), ana).members).toHaveLength(1);

    // Conscripting a second agent: refused, exactly as it was before.
    expect(() => service.createRoom(roomSpec('channel', 'Pair', ['/agents/bo']), ana)).toThrow(
      expect.objectContaining({ code: 'OPERATOR_ONLY' })
    );
  });

  it('leaves the owner passing everything, unchanged', () => {
    expect(
      service
        .listRooms(owner)
        .map((room) => room.id)
        .sort()
    ).toEqual([ownersRoom, sharedRoom].sort());
    expect(service.getRoom(ownersRoom, owner)?.id).toBe(ownersRoom);
    expect(service.addMember(sharedRoom, owner, { agentPath: '/agents/bo' }).authorId).toBeTruthy();
    service.removeMember(sharedRoom, owner, priya);
    expect(service.getRoom(sharedRoom, owner)?.members.map((m) => m.authorId)).not.toContain(priya);
  });
});

describe('RoomService — an install with no accounts is unchanged', () => {
  it('treats the unbound local author as the operator, and says "you"', () => {
    // The default posture: login off, nobody registered. With no account there
    // is nobody else the operator could be, so the `'local'` sentinel is it —
    // and the refusal keeps the second-person wording it has always had.
    const { service, authors, human } = createRoomHarness({ agents: agentLookup });
    const room = service.createRoom(roomSpec('channel', 'Backend', ['/agents/ana']), human);
    const ana = authors.resolveAgent('/agents/ana', 'Ana').id;

    expect(service.getRoom(room.id, human)?.id).toBe(room.id);
    expect(service.addMember(room.id, human, { agentPath: '/agents/bo' }).authorId).toBeTruthy();
    // An agent removing the PERSON is refused with the sentence written for that
    // case (DOR-1611 §D7 row 4); the second-person wording it has always had is
    // unchanged, which is what this row is really pinning.
    expect(() => service.removeMemberFromTool(room.id, ana, human)).toThrow(
      'Only you can take yourself out of a room'
    );
  });
});

describe('RoomService — enabling login moves nothing', () => {
  it('keeps every room, membership, message and cursor across the rebind', () => {
    // The migration this phase turns on: an install runs unowned for months,
    // then somebody enables login. The `'local'` author is rebound onto the new
    // account IN PLACE, so the opaque id every row points at does not move.
    const harness = createRoomHarness({ agents: agentLookup });
    const before = harness.human;
    const room = harness.service.createRoom(
      roomSpec('channel', 'Backend', ['/agents/ana']),
      before
    );
    harness.service.post(room.id, { authorId: before, text: 'said before there were accounts' });
    const second = harness.service.post(room.id, { authorId: before, text: 'and again' });
    harness.service.setReadCursor(room.id, before, second.seq);

    const after = harness.setOwner('user-dorian');

    expect(after).toBe(before);
    const reopened = harness.service.getRoom(room.id, after);
    expect(reopened?.id).toBe(room.id);
    expect(reopened?.members.map((m) => m.authorId)).toContain(after);
    expect(reopened?.members.find((m) => m.authorId === after)?.lastReadSeq).toBe(second.seq);
    expect(
      harness.service.listEntries(room.id, after, { limit: 10 }).map((e) => e.authorId)
    ).toEqual([before, before]);
    // Still the operator, and still "You": the rebind moves the natural key, not
    // the render cache. Writing the account name here would have retroactively
    // relabelled both messages above, because there is one name column per author.
    expect(harness.service.listRooms(after).map((r) => r.id)).toEqual([room.id]);
    expect(reopened?.members.find((m) => m.authorId === after)?.author.displayName).toBe('You');
  });
});
