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
import {
  ensureTeamRoom,
  joinTeamRoom,
  watchDefaultAgent,
  TEAM_ROOM_WELL_KNOWN,
  type TeamAgent,
  type TeamRoomDeps,
} from '../ensure-team-room.js';
import { agentLookupFor, createRoomHarness, type RoomHarness } from './room-test-harness.js';

const DORKBOT = '/agents/dorkbot';
const NOVA = '/agents/nova';
const ACE = '/agents/ace';

const agents = agentLookupFor({
  [DORKBOT]: { name: 'dorkbot', displayName: 'DorkBot', responseMode: 'always' },
  [NOVA]: { name: 'nova', displayName: 'Nova', responseMode: 'always' },
  [ACE]: { name: 'ace', displayName: 'Ace', responseMode: 'always' },
});

/** The registry rows behind the directories above. */
const REGISTERED: Record<string, TeamAgent> = {
  [DORKBOT]: { name: 'dorkbot', path: DORKBOT },
  [NOVA]: { name: 'nova', path: NOVA },
  [ACE]: { name: 'ace', path: ACE },
};

/**
 * A harness plus the deps the boot hook takes, over a fixed agent table.
 *
 * @param registered - The agent directories this install's registry knows.
 * @param defaultAgentName - `config.agents.defaultAgent`. Mutable through
 *   `setDefaultAgent` so a test can drive the settings change.
 */
function install(
  registered: readonly string[] = [DORKBOT],
  defaultAgentName: string | null = 'dorkbot'
): RoomHarness & { deps: TeamRoomDeps; setDefaultAgent: (name: string | null) => void } {
  const harness = createRoomHarness({ agents });
  let configured = defaultAgentName;
  return {
    ...harness,
    setDefaultAgent: (name) => {
      configured = name;
    },
    deps: {
      service: harness.service,
      operatorAuthorId: () => harness.human,
      agents: () => registered.map((path) => REGISTERED[path]!),
      defaultAgentName: () => configured,
    },
  };
}

/** Who the room records as holding the fallback seat. */
function seatOf(harness: RoomHarness): string | null {
  return teamRoom(harness).fallbackSeatAuthorId ?? null;
}

/** One agent's response mode in #team, read back through the service. */
function modeOf(harness: RoomHarness, agentPath: string, displayName: string): string | undefined {
  const authorId = harness.authors.resolveAgent(agentPath, displayName).id;
  return harness.service
    .getRoom(teamRoom(harness).id, harness.human)
    ?.members.find((m) => m.authorId === authorId)?.responseMode;
}

/** The one room carrying the well-known key, read straight from the table. */
function teamRoom(harness: RoomHarness) {
  const room = harness.store.findByWellKnown(TEAM_ROOM_WELL_KNOWN);
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
    expect(room.wellKnown).toBe(TEAM_ROOM_WELL_KNOWN);
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

  it('seats you and DorkBot, and gives an agent that is not the default the channel default', () => {
    const harness = install([DORKBOT, NOVA], 'dorkbot');

    ensureTeamRoom(harness.deps);

    const room = harness.service.getRoom(teamRoom(harness).id, harness.human);
    const dorkbot = harness.authors.resolveAgent(DORKBOT, 'DorkBot').id;
    expect(room?.members.map((m) => m.authorId)).toEqual(
      expect.arrayContaining([harness.human, dorkbot])
    );
    expect(modeOf(harness, NOVA, 'Nova')).toBe('engaged');
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
    const winner = ensureTeamRoom({ ...harness.deps, agents: () => [REGISTERED[DORKBOT]!] });

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
    const deps: TeamRoomDeps = {
      service: dark.service,
      operatorAuthorId: () => dark.human,
      agents: () => [REGISTERED[DORKBOT]!, REGISTERED[NOVA]!],
      defaultAgentName: () => 'dorkbot',
    };
    ensureTeamRoom({ ...deps, agents: () => [REGISTERED[DORKBOT]!] });
    const room = dark.store.findByWellKnown(TEAM_ROOM_WELL_KNOWN)!;
    const gone = dark.authors.resolveAgent(NOVA, 'Nova').id;
    dark.service.addMember(room.id, dark.human, { authorId: gone });

    ensureTeamRoom(deps);

    expect(dark.store.getMember(room.id, gone)).not.toBeNull();
  });
});

describe('the default agent holds the always membership', () => {
  it('promotes the agent the setting names and leaves everybody else engaged', () => {
    const harness = install([DORKBOT, NOVA], 'nova');

    ensureTeamRoom(harness.deps);

    expect(modeOf(harness, NOVA, 'Nova')).toBe('always');
    expect(modeOf(harness, DORKBOT, 'DorkBot')).toBe('engaged');
  });

  it('falls back to DorkBot when the setting names nobody registered here', () => {
    // A default agent can be renamed, unregistered, or left behind on another
    // machine. Reading the value literally would leave #team with nobody
    // answering, which is a room that silently swallows what you type.
    const harness = install([DORKBOT, NOVA], 'someone-who-left');

    ensureTeamRoom(harness.deps);

    expect(modeOf(harness, DORKBOT, 'DorkBot')).toBe('always');
    expect(modeOf(harness, NOVA, 'Nova')).toBe('engaged');
  });

  it('falls back to DorkBot when there is no setting at all', () => {
    const harness = install([DORKBOT, NOVA], null);

    ensureTeamRoom(harness.deps);

    expect(modeOf(harness, DORKBOT, 'DorkBot')).toBe('always');
  });

  it('moves the mode when the setting changes, without a restart', () => {
    const harness = install([DORKBOT, NOVA], 'dorkbot');
    ensureTeamRoom(harness.deps);
    const changes = new Set<(change: { sections: readonly string[] }) => void>();
    watchDefaultAgent(harness.deps, {
      onChange: (listener) => {
        changes.add(listener);
        return () => changes.delete(listener);
      },
    });

    harness.setDefaultAgent('nova');
    for (const listener of changes) listener({ sections: ['agents'] });

    expect(modeOf(harness, NOVA, 'Nova')).toBe('always');
    // The old default DROPS BACK — the assertion that matters, because a
    // promotion that forgot to demote leaves two agents answering every
    // unaddressed post, which is the pile-on the channel default exists to stop.
    expect(modeOf(harness, DORKBOT, 'DorkBot')).toBe('engaged');
  });

  it('ignores a settings write that did not touch the agents section', () => {
    const harness = install([DORKBOT, NOVA], 'dorkbot');
    ensureTeamRoom(harness.deps);
    let notify = (_change: { sections: readonly string[] }) => {};
    watchDefaultAgent(harness.deps, {
      onChange: (listener) => {
        notify = listener;
        return () => {};
      },
    });
    harness.setDefaultAgent('nova');

    notify({ sections: ['runtimes'] });

    expect(modeOf(harness, DORKBOT, 'DorkBot')).toBe('always');
    expect(modeOf(harness, NOVA, 'Nova')).toBe('engaged');
  });

  it('stops listening once the subscription is dropped', () => {
    const harness = install([DORKBOT, NOVA], 'dorkbot');
    ensureTeamRoom(harness.deps);
    let notify: ((change: { sections: readonly string[] }) => void) | null = null;
    const stop = watchDefaultAgent(harness.deps, {
      onChange: (listener) => {
        notify = listener;
        return () => {
          notify = null;
        };
      },
    });

    stop();

    expect(notify).toBeNull();
  });

  it('reconciles at boot too, for a setting that changed while the server was off', () => {
    const harness = install([DORKBOT, NOVA], 'dorkbot');
    ensureTeamRoom(harness.deps);
    expect(modeOf(harness, DORKBOT, 'DorkBot')).toBe('always');

    harness.setDefaultAgent('nova');
    ensureTeamRoom(harness.deps);

    expect(modeOf(harness, NOVA, 'Nova')).toBe('always');
    expect(modeOf(harness, DORKBOT, 'DorkBot')).toBe('engaged');
  });

  it('leaves the seat alone when the registry cannot name a default agent', () => {
    // A boot whose mesh failed to start lists NO agents. Demoting on that
    // evidence would leave #team silently swallowing what a person types until
    // the next healthy boot, which is far worse than one boot's stale seat — so
    // "cannot say" is not "there is no default".
    const harness = install([DORKBOT, NOVA], 'dorkbot');
    ensureTeamRoom(harness.deps);
    expect(modeOf(harness, DORKBOT, 'DorkBot')).toBe('always');

    ensureTeamRoom({ ...harness.deps, agents: () => [] });

    expect(modeOf(harness, DORKBOT, 'DorkBot')).toBe('always');
    expect(seatOf(harness)).toBe(harness.authors.resolveAgent(DORKBOT, 'DorkBot').id);
  });

  it('leaves the seat alone when reading the registry throws', () => {
    const harness = install([DORKBOT, NOVA], 'dorkbot');
    ensureTeamRoom(harness.deps);

    expect(() =>
      ensureTeamRoom({
        ...harness.deps,
        agents: () => {
          throw new Error('the mesh is down');
        },
      })
    ).not.toThrow();

    expect(modeOf(harness, DORKBOT, 'DorkBot')).toBe('always');
  });

  it('records who holds the seat, so the next boot knows what it owns', () => {
    const harness = install([DORKBOT, NOVA], 'nova');

    ensureTeamRoom(harness.deps);

    expect(seatOf(harness)).toBe(harness.authors.resolveAgent(NOVA, 'Nova').id);
  });

  describe('an always a person set themselves', () => {
    /** Boot, then set Nova to "Everything" from the room's member menu. */
    function withPersonsAlways(): RoomHarness & {
      deps: TeamRoomDeps;
      setDefaultAgent: (name: string | null) => void;
    } {
      const harness = install([DORKBOT, NOVA], 'dorkbot');
      ensureTeamRoom(harness.deps);
      const nova = harness.authors.resolveAgent(NOVA, 'Nova').id;
      harness.service.updateMembership(teamRoom(harness).id, harness.human, nova, 'always');
      return harness;
    }

    it('survives a reconcile that changes nothing', () => {
      const harness = withPersonsAlways();

      ensureTeamRoom(harness.deps);

      expect(modeOf(harness, NOVA, 'Nova')).toBe('always');
    });

    it('survives the seat moving to somebody else', () => {
      // The reconcile demotes the member it recorded as the seat and nobody
      // else, so a person's own choice is not collateral.
      const harness = withPersonsAlways();
      harness.setDefaultAgent('ace');
      ensureTeamRoom({ ...harness.deps, agents: () => [REGISTERED[DORKBOT]!, REGISTERED[ACE]!] });

      expect(modeOf(harness, NOVA, 'Nova')).toBe('always');
      expect(modeOf(harness, DORKBOT, 'DorkBot')).toBe('engaged');
    });

    it('is never mistaken for the seat', () => {
      const harness = withPersonsAlways();

      expect(seatOf(harness)).toBe(harness.authors.resolveAgent(DORKBOT, 'DorkBot').id);
    });
  });

  it('leaves a mode a person chose that is neither of the two it owns', () => {
    // The reconcile moves a membership between `always` and the channel default
    // and nowhere else. An agent someone deliberately silenced in #team stays
    // silenced when the default moves.
    const harness = install([DORKBOT, NOVA], 'dorkbot');
    ensureTeamRoom(harness.deps);
    const nova = harness.authors.resolveAgent(NOVA, 'Nova').id;
    harness.service.updateMembership(teamRoom(harness).id, harness.human, nova, 'silent');

    harness.setDefaultAgent('someone-who-left');
    ensureTeamRoom(harness.deps);

    expect(modeOf(harness, NOVA, 'Nova')).toBe('silent');
  });

  it('reaches no room but #team', () => {
    const harness = install([DORKBOT, NOVA], 'dorkbot');
    ensureTeamRoom(harness.deps);
    const dorkbot = harness.authors.resolveAgent(DORKBOT, 'DorkBot').id;
    const ordinary = harness.service.createRoom(
      { kind: 'channel', title: 'Backend', members: [], agentPaths: [DORKBOT] },
      harness.human
    );

    harness.setDefaultAgent('nova');
    ensureTeamRoom(harness.deps);

    expect(
      harness.service
        .getRoom(ordinary.id, harness.human)
        ?.members.find((m) => m.authorId === dorkbot)?.responseMode
    ).toBe('engaged');
  });

  it('seats a default agent that was not on the roster yet', () => {
    // The registry can learn about an agent after the roster was last built —
    // the setting resolving is the moment it becomes seatable.
    const harness = install([DORKBOT], 'dorkbot');
    ensureTeamRoom(harness.deps);

    ensureTeamRoom({
      ...harness.deps,
      agents: () => [REGISTERED[NOVA]!],
      defaultAgentName: () => 'nova',
    });

    expect(modeOf(harness, NOVA, 'Nova')).toBe('always');
  });

  it('costs nothing on an install with no agents at all', () => {
    const harness = install([], 'dorkbot');

    expect(() => ensureTeamRoom(harness.deps)).not.toThrow();

    const room = harness.service.getRoom(teamRoom(harness).id, harness.human);
    expect(room?.members.map((m) => m.authorId)).toEqual([harness.human]);
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
