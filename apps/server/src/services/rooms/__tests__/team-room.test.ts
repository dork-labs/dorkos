/**
 * #team — the one room every install has, and the only one it cannot lose
 * (team-room-home spec D3.1).
 *
 * Three claims, and each one is a different way the room could go missing: a
 * restart could open a second one, an agent could rename or archive the one
 * that is there, and a newly created agent could end up outside it. Driven
 * through the real service and the real store, because the hook's whole value
 * is that it is idempotent against the database that ships.
 *
 * **Muting #team is deliberately not tested here, because it is not this
 * domain's behaviour.** A mute is a reference in `ui.sidebar.muted` — the
 * person's own sidebar preference — and it never reaches the room service, the
 * store or the guard below. That is exactly why the system-room guard can
 * refuse an archive without also taking away the quiet. Where it IS tested:
 * `apps/client/src/layers/features/dashboard-sidebar/__tests__/RoomRowMenuItems.test.tsx`
 * (the menu item and its toggle) over the `muteItem` / `unmuteItem` prefs
 * helpers. A copy here could only re-assert a Zod shape, which is a tautology
 * and not a test.
 */
import { describe, it, expect, vi } from 'vitest';
import { RoomError } from '../room-errors.js';
import { ensureTeamRoom, joinTeamRoom, TEAM_ROOM_KEY } from '../ensure-team-room.js';
import { agentLookupFor, createRoomHarness, type RoomHarness } from './room-test-harness.js';

const DORKBOT = '/agents/dorkbot';
const NOVA = '/agents/nova';

const agents = agentLookupFor({
  [DORKBOT]: { name: 'dorkbot', displayName: 'DorkBot', responseMode: 'always' },
  [NOVA]: { name: 'nova', displayName: 'Nova', responseMode: 'always' },
});

/** A harness plus the deps the boot hook takes, over a fixed agent table. */
function install(registered: readonly string[] = [DORKBOT]): RoomHarness & {
  deps: Parameters<typeof ensureTeamRoom>[0];
} {
  const harness = createRoomHarness({ agents });
  return {
    ...harness,
    deps: {
      service: harness.service,
      operatorAuthorId: () => harness.human,
      agentPaths: () => registered,
    },
  };
}

/** The one room carrying the well-known key, read straight from the table. */
function teamRoom(harness: RoomHarness) {
  const room = harness.store.findByWellKnown(TEAM_ROOM_KEY);
  if (!room) throw new Error('there is no team room');
  return room;
}

/** Every channel on the install, so a second #team cannot hide behind the first. */
function channels(harness: RoomHarness) {
  return harness.store.listRooms({ includeArchived: true }).filter((r) => r.kind === 'channel');
}

describe('opening #team', () => {
  it('opens exactly one room however many times it runs', () => {
    const harness = install();

    const opened = ensureTeamRoom(harness.deps);
    const second = ensureTeamRoom(harness.deps);
    const third = ensureTeamRoom(harness.deps);

    expect(channels(harness)).toHaveLength(1);
    const room = teamRoom(harness);
    expect(room.slug).toBe('team');
    expect(room.wellKnown).toBe(TEAM_ROOM_KEY);
    // Every call ANSWERS with the room, which is a stronger claim than "one row
    // exists": a hook that found nothing and was refused by the unique index
    // would also leave one row, and would silently stop backfilling the roster.
    expect([opened?.id, second?.id, third?.id]).toEqual([room.id, room.id, room.id]);
  });

  it('does not duplicate a membership on a second boot', () => {
    const harness = install();

    ensureTeamRoom(harness.deps);
    const first = harness.service.getRoom(teamRoom(harness).id, harness.human)?.members ?? [];
    ensureTeamRoom(harness.deps);
    const second = harness.service.getRoom(teamRoom(harness).id, harness.human)?.members ?? [];

    expect(second.map((m) => m.authorId).sort()).toEqual(first.map((m) => m.authorId).sort());
  });

  it('seats you and DorkBot, and gives an agent the channel default', () => {
    const harness = install();

    ensureTeamRoom(harness.deps);

    const room = harness.service.getRoom(teamRoom(harness).id, harness.human);
    const dorkbot = harness.authors.resolveAgent(DORKBOT, 'DorkBot').id;
    expect(room?.members.map((m) => m.authorId)).toEqual(
      expect.arrayContaining([harness.human, dorkbot])
    );
    expect(room?.members.find((m) => m.authorId === dorkbot)?.responseMode).toBe('engaged');
  });

  it('leaves a renamed or re-topiced room exactly as the person left it', () => {
    const harness = install();
    ensureTeamRoom(harness.deps);
    const opened = teamRoom(harness);
    harness.service.updateRoom(opened.id, harness.human, { title: 'Crew', topic: 'ours' });

    // The key is what finds it, not the slug the rename just moved.
    expect(ensureTeamRoom(harness.deps)?.id).toBe(opened.id);

    expect(channels(harness)).toHaveLength(1);
    const after = teamRoom(harness);
    expect(after.id).toBe(opened.id);
    expect(after.title).toBe('Crew');
    expect(after.slug).toBe('crew');
    expect(after.topic).toBe('ours');
  });

  it('finds an archived #team again instead of opening a second one', () => {
    const harness = install();
    ensureTeamRoom(harness.deps);
    const opened = teamRoom(harness);
    harness.service.updateRoom(opened.id, harness.human, { archived: true });

    // An archive releases the slug; it does not release the key.
    expect(ensureTeamRoom(harness.deps)?.id).toBe(opened.id);

    expect(channels(harness)).toHaveLength(1);
    expect(teamRoom(harness).id).toBe(opened.id);
  });

  it('takes the next free name rather than adopting a #team somebody already made', () => {
    const harness = install();
    const mine = harness.service.createRoom(
      { kind: 'channel', title: '#team', members: [], agentPaths: [] },
      harness.human
    );

    ensureTeamRoom(harness.deps);

    expect(mine.wellKnown ?? null).toBeNull();
    expect(harness.store.getRoom(mine.id)?.title).toBe('#team');
    expect(teamRoom(harness).slug).toBe('team-2');
  });

  it('leaves an ARCHIVED #team its name to come back to', () => {
    // Archiving releases a slug, so the naive "is a LIVE channel holding this?"
    // question says #team is free and the system room takes it — and the
    // person's own channel can then never be un-archived, because the way back
    // is the slug that was quietly given away. De-collision has to see the
    // rooms that are put away, not only the ones on screen.
    const harness = install();
    const mine = harness.service.createRoom(
      { kind: 'channel', title: '#team', members: [], agentPaths: [] },
      harness.human
    );
    harness.service.updateRoom(mine.id, harness.human, { archived: true });

    ensureTeamRoom(harness.deps);

    expect(teamRoom(harness).slug).toBe('team-2');
    const back = harness.service.updateRoom(mine.id, harness.human, { archived: false });
    expect(back.slug).toBe('team');
  });

  it('adopts the row a concurrent boot won the race to write', () => {
    // Find-then-insert is not atomic across processes: two boots (a cockpit and
    // a CLI, say) can both read "no team room" and both try to write one. The
    // unique key makes exactly one of them win, and the loser must ADOPT that
    // room — a loser that gave up would leave the install booted with no home
    // room and, worse, no agents seated in the one that exists.
    const harness = install([DORKBOT, NOVA]);
    const winner = ensureTeamRoom({ ...harness.deps, agentPaths: () => [DORKBOT] });

    // The loser's read happens BEFORE the winner's insert lands, which is the
    // only way this race is reachable at all. Its own insert then hits the key.
    const real = harness.store.findByWellKnown.bind(harness.store);
    let reads = 0;
    vi.spyOn(harness.store, 'findByWellKnown').mockImplementation((key) =>
      (reads += 1) === 1 ? null : real(key)
    );

    const loser = ensureTeamRoom(harness.deps);

    vi.restoreAllMocks();
    expect(channels(harness)).toHaveLength(1);
    expect(loser?.id).toBe(winner?.id);
    // And it finished the job it was booted for.
    const nova = harness.authors.resolveAgent(NOVA, 'Nova').id;
    expect(harness.store.getMember(teamRoom(harness).id, nova)).not.toBeNull();
  });
});

describe('a newly created agent', () => {
  it('is in #team by the time creation answers', () => {
    const harness = install();
    ensureTeamRoom(harness.deps);

    joinTeamRoom(harness.deps, NOVA);

    const nova = harness.authors.resolveAgent(NOVA, 'Nova').id;
    const member = harness.service
      .getRoom(teamRoom(harness).id, harness.human)
      ?.members.find((m) => m.authorId === nova);
    expect(member?.responseMode).toBe('engaged');
  });

  it('opens the room first when the boot hook never got to run', () => {
    const harness = install();

    joinTeamRoom(harness.deps, NOVA);

    const nova = harness.authors.resolveAgent(NOVA, 'Nova').id;
    expect(harness.store.getMember(teamRoom(harness).id, nova)).not.toBeNull();
  });

  it('costs nothing when the agent is not registered here', () => {
    const harness = install();
    ensureTeamRoom(harness.deps);
    const before = harness.service.getRoom(teamRoom(harness).id, harness.human)?.members.length;

    expect(() => joinTeamRoom(harness.deps, '/agents/nobody')).not.toThrow();

    expect(harness.service.getRoom(teamRoom(harness).id, harness.human)?.members.length).toBe(
      before
    );
  });

  it('keeps its seat when it is unregistered — history is not evicted with the agent', () => {
    // Nothing removes a membership on unregister, and this pins that: the agent
    // goes dark (its lookup stops answering) and its row, its cursor and its
    // messages stay exactly where they were.
    const dark = createRoomHarness({ agents: agentLookupFor({ [DORKBOT]: { name: 'dorkbot' } }) });
    const deps = {
      service: dark.service,
      operatorAuthorId: () => dark.human,
      agentPaths: () => [DORKBOT, NOVA],
    };
    ensureTeamRoom({ ...deps, agentPaths: () => [DORKBOT] });
    const room = dark.store.findByWellKnown(TEAM_ROOM_KEY)!;
    const gone = dark.authors.resolveAgent(NOVA, 'Nova').id;
    dark.service.addMember(room.id, dark.human, { authorId: gone });

    ensureTeamRoom(deps);

    expect(dark.store.getMember(room.id, gone)).not.toBeNull();
  });
});

describe('#team is a system room', () => {
  /** Open #team and hand back the agent author id that lives in it. */
  function seated(): { harness: RoomHarness; roomId: string; agent: string } {
    const harness = install();
    ensureTeamRoom(harness.deps);
    return {
      harness,
      roomId: teamRoom(harness).id,
      agent: harness.authors.resolveAgent(DORKBOT, 'DorkBot').id,
    };
  }

  it('refuses a rename from an agent', () => {
    const { harness, roomId, agent } = seated();

    expect(() => harness.service.updateRoom(roomId, agent, { title: 'Ops' })).toThrow(
      expect.objectContaining({ code: 'SYSTEM_ROOM' })
    );
    expect(harness.store.getRoom(roomId)?.slug).toBe('team');
  });

  it('refuses an archive from an agent', () => {
    const { harness, roomId, agent } = seated();

    expect(() => harness.service.updateRoom(roomId, agent, { archived: true })).toThrow(RoomError);
    expect(harness.store.getRoom(roomId)?.archived).toBe(false);
  });

  it('lets an agent still describe the room it lives in', () => {
    const { harness, roomId, agent } = seated();

    harness.service.updateRoom(roomId, agent, { topic: 'shipping the cockpit' });

    expect(harness.store.getRoom(roomId)?.topic).toBe('shipping the cockpit');
  });

  it('lets the owner rename and archive it', () => {
    const { harness, roomId } = seated();

    harness.service.updateRoom(roomId, harness.human, { title: 'Crew' });
    harness.service.updateRoom(roomId, harness.human, { archived: true });

    expect(harness.store.getRoom(roomId)?.archived).toBe(true);
  });

  it('leaves an ordinary room exactly as writable as it was', () => {
    const harness = install();
    ensureTeamRoom(harness.deps);
    const dorkbot = harness.authors.resolveAgent(DORKBOT, 'DorkBot').id;
    const ordinary = harness.service.createRoom(
      { kind: 'channel', title: 'Backend', members: [dorkbot], agentPaths: [] },
      harness.human
    );

    const renamed = harness.service.updateRoom(ordinary.id, dorkbot, { title: 'Backend two' });

    expect(renamed.slug).toBe('backend-two');
  });

  it('leaves the DM un-archive path alone — the reason the blanket gate is refused', () => {
    // DOR-608's trap: an agent re-opening its own archived direct message is a
    // legitimate `updateRoom({ archived: false })` from a non-owner. A DM has no
    // well-known key, so the system-room guard cannot reach it.
    const harness = install();
    const dm = harness.service.createRoom(
      { kind: 'dm', title: 'Nova', members: [], agentPaths: [NOVA] },
      harness.human
    );
    const nova = harness.authors.resolveAgent(NOVA, 'Nova').id;
    harness.service.updateRoom(dm.id, nova, { archived: true });

    const reopened = harness.service.createRoom(
      { kind: 'dm', title: 'Nova', members: [harness.human], agentPaths: [NOVA] },
      nova
    );

    expect(reopened.id).toBe(dm.id);
    expect(reopened.archived).toBe(false);
  });
});
