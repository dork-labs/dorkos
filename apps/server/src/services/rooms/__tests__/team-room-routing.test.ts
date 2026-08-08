/**
 * Typing in #team without addressing anybody reaches your default agent
 * (team-room-home spec D3.4).
 *
 * There is no routing layer under this and there must never be one: the whole
 * mechanism is that the default agent's #team membership is `always` and
 * everybody else's is the channel default. So the tests here drive the REAL
 * service, the REAL trigger dispatcher and the REAL boot hook, with only the
 * turn runner scripted — a fake that re-implemented dispatch could not tell the
 * difference between the membership doing this and a special case doing it.
 *
 * Assertions are on the runner double, never on a log line: "exactly one turn,
 * on that agent" is a claim about what the server asked a runtime to do.
 *
 * @module server/services/rooms/tests/team-room-routing
 */
import { describe, it, expect } from 'vitest';
import type { RoomEntry } from '@dorkos/shared/room-schemas';
import { ensureTeamRoom, TEAM_ROOM_KEY, type TeamRoomDeps } from '../ensure-team-room.js';
import {
  agentLookupFor,
  createRoomHarness,
  scriptedRunner,
  type RoomHarness,
  type ScriptedTurnRunner,
} from './room-test-harness.js';

const DORKBOT = '/agents/dorkbot';
const NOVA = '/agents/nova';
const ACE = '/agents/ace';

const AGENTS = agentLookupFor({
  [DORKBOT]: { name: 'dorkbot' },
  [NOVA]: { name: 'nova' },
  [ACE]: { name: 'ace' },
});

/** The registry rows behind those directories. */
const REGISTERED = [
  { name: 'dorkbot', path: DORKBOT },
  { name: 'nova', path: NOVA },
  { name: 'ace', path: ACE },
];

interface Wired extends RoomHarness {
  runner: ScriptedTurnRunner;
  deps: TeamRoomDeps;
  roomId: string;
  dorkbot: string;
  nova: string;
  ace: string;
  /** Change `config.agents.defaultAgent`, the way the Settings route does. */
  setDefaultAgent: (name: string) => void;
}

/**
 * An install booted the way `index.ts` boots one: #team opened, every agent
 * seated, the default agent's membership reconciled.
 *
 * @param opts.reply - What an agent says when it takes a turn. `null` is an
 *   agent that ran a turn and chose to say nothing, which is the way to isolate
 *   "who did this post address" from "who did the ANSWER go on to address".
 * @param opts.defaultAgent - `config.agents.defaultAgent` at boot.
 * @param opts.engagedWindow - The two ceilings, when a case is about the window
 *   the default agent's own mention opens.
 */
function boot(
  opts: {
    reply?: string | null;
    defaultAgent?: string;
    engagedWindow?: { minutes: number; posts: number };
  } = {}
): Wired {
  const runner = scriptedRunner(() => (opts.reply === undefined ? 'on it' : opts.reply));
  const harness = createRoomHarness({
    agents: AGENTS,
    runner,
    ...(opts.engagedWindow ? { engagedWindow: opts.engagedWindow } : {}),
  });
  let configured = opts.defaultAgent ?? 'dorkbot';
  const deps: TeamRoomDeps = {
    service: harness.service,
    operatorAuthorId: () => harness.human,
    agents: () => REGISTERED,
    defaultAgentName: () => configured,
  };
  const room = ensureTeamRoom(deps);
  if (!room) throw new Error('there is no team room');
  return {
    ...harness,
    runner,
    deps,
    roomId: room.id,
    dorkbot: harness.authors.resolveAgent(DORKBOT, 'dorkbot').id,
    nova: harness.authors.resolveAgent(NOVA, 'nova').id,
    ace: harness.authors.resolveAgent(ACE, 'ace').id,
    setDefaultAgent: (name) => {
      configured = name;
    },
  };
}

describe('an unaddressed post in #team', () => {
  it('reaches the default agent, exactly once', async () => {
    const w = boot();

    await say(w, 'what is on for today?');

    expect(turnsFor(w, w.dorkbot)).toBe(1);
  });

  it('reaches nobody else — the rest of your team is not listening', async () => {
    const w = boot();

    await say(w, 'what is on for today?');

    expect(turnsFor(w, w.nova)).toBe(0);
    expect(turnsFor(w, w.ace)).toBe(0);
  });

  it('still reaches nobody in an ordinary room', async () => {
    // The E7 guarantee is not weakened globally. #team answers because of ONE
    // membership on ONE room, so a channel you opened yourself is exactly as
    // quiet as it was.
    const w = boot();
    const backend = w.service.createRoom(
      { kind: 'channel', title: 'Backend', members: [], agentPaths: [DORKBOT, NOVA] },
      w.human
    );

    w.service.post(backend.id, { authorId: w.human, text: 'what is on for today?' });
    await w.service.triggersIdle();

    expect(w.runner.turns.filter((turn) => turn.roomId === backend.id)).toHaveLength(0);
  });

  it('keeps reaching the default agent on the next message', async () => {
    const w = boot();

    await say(w, 'what is on for today?');
    await say(w, 'and tomorrow?');

    expect(turnsFor(w, w.dorkbot)).toBe(2);
  });
});

/**
 * Addressing somebody stands the default agent down.
 *
 * The design record for this room is explicit (`design-decisions.md` §4):
 * "unaddressed posts are handled by the default agent; @mentioned agents
 * respond; **other agents do not consume the message (no token burn, no
 * pile-on)**". For a post that named Nova, the default agent is an other agent —
 * so a turn it took anyway would be exactly the burn that sentence forbids, and
 * leaving it to the model's judgment would not help, because the cost is paid
 * before the model has an opinion.
 *
 * `always` alone cannot express that, so the seat is filtered by a second rule
 * after addressing (`standDownFallbackSeat`). The runner says nothing in most of
 * these cases, which keeps them about who the POST addressed rather than about
 * who the answers went on to address.
 */
describe('addressing somebody in #team', () => {
  it('reaches the agent you named, and the default agent stands down', async () => {
    // The runner SPEAKS, which is the whole point: an agent that answers writes
    // an entry nobody addressed, and an `always` seat would catch that one
    // cascade hop later. A probe with a silent runner cannot see it, and this
    // one shipped broken behind exactly that gap.
    const w = boot();

    await say(w, '@nova can you take the deploy?');

    expect(turnsFor(w, w.nova)).toBe(1);
    expect(turnsFor(w, w.dorkbot)).toBe(0);
    expect(turnsFor(w, w.ace)).toBe(0);
    // And Nova's answer really did land — otherwise the claim above is vacuous.
    expect(bodies(w)).toContain('on it');
  });

  it('still leaves the default agent out after the answer lands', async () => {
    const w = boot();
    await say(w, '@nova can you take the deploy?');
    const answered = bodies(w).filter((text) => text === 'on it').length;

    // Nothing more should happen, but drive one more settle so a late hop has
    // somewhere to show up.
    await w.service.triggersIdle();

    expect(bodies(w).filter((text) => text === 'on it')).toHaveLength(answered);
    expect(turnsFor(w, w.dorkbot)).toBe(0);
  });

  it('does not answer an agent posting into the room out of turn', async () => {
    // TWO mechanisms refuse this now, and the redundancy is deliberate. The
    // cascade guard already did: an agent's un-provenanced post synthesizes a
    // cascade at the ceiling, so it triggers nobody, and that is what kept this
    // quiet before. But that is a ceiling doing incidental work — it would stop
    // applying the moment the post carried real provenance — so the seat also
    // declines it on the merits: an agent's own update is a conversation
    // underway, not a question aimed at the room. The reply-driven cases above
    // are what prove the second mechanism carries its own weight.
    const w = boot();

    w.service.post(w.roomId, { authorId: w.nova, text: 'deploy finished, all green' });
    await w.service.triggersIdle();

    expect(turnsFor(w, w.dorkbot)).toBe(0);
  });

  it('fans out to two agents when you name two, and still leaves the default out', async () => {
    const w = boot({ reply: null });

    await say(w, '@nova and @ace, can one of you take the deploy?');

    expect(turnsFor(w, w.nova)).toBe(1);
    expect(turnsFor(w, w.ace)).toBe(1);
    expect(turnsFor(w, w.dorkbot)).toBe(0);
  });

  it('reaches the default agent when you name it alongside somebody else', async () => {
    const w = boot({ reply: null });

    await say(w, '@nova and @dorkbot, can you two sort the deploy out?');

    expect(turnsFor(w, w.nova)).toBe(1);
    expect(turnsFor(w, w.dorkbot)).toBe(1);
  });

  it('reaches the default agent on its own when you name only it', async () => {
    const w = boot({ reply: null });

    await say(w, '@dorkbot what is on for today?');

    expect(turnsFor(w, w.dorkbot)).toBe(1);
    expect(turnsFor(w, w.nova)).toBe(0);
  });

  it('follows a colleague’s reply while you are mid-conversation with it', async () => {
    // The engaged escape covers the agent-authored rule too: you addressed
    // DorkBot by name, so Nova's answer is part of the conversation it is
    // already in and it is not shut out of its own thread.
    const w = boot();
    await say(w, '@dorkbot and @nova, can you two sort the deploy out?');
    const before = turnsFor(w, w.dorkbot);

    expect(before).toBeGreaterThanOrEqual(1);
    expect(turnsFor(w, w.nova)).toBeGreaterThanOrEqual(1);
  });

  it('keeps a default agent you are mid-conversation with in the room', async () => {
    // Addressing it by name opens its engaged window, which is this codebase's
    // definition of "we are talking" (`engagement.ts` anchors on a mention). It
    // then answers the next post as ITSELF rather than as the fallback, so
    // handing one task to Nova does not dismiss it from a conversation you
    // started. A default agent that had only ever been catching unaddressed
    // posts has no window and does stand down — the case above.
    const w = boot({ reply: null });
    await say(w, '@dorkbot how did last night go?');
    expect(turnsFor(w, w.dorkbot)).toBe(1);

    await say(w, '@nova can you take the deploy?');

    expect(turnsFor(w, w.nova)).toBe(1);
    expect(turnsFor(w, w.dorkbot)).toBe(2);
  });

  it('stands the default agent down again once that window has closed', async () => {
    const w = boot({ reply: null, engagedWindow: { minutes: 10, posts: 1 } });
    await say(w, '@dorkbot how did last night go?');
    await say(w, 'thanks');

    await say(w, '@nova can you take the deploy?');

    expect(turnsFor(w, w.nova)).toBe(1);
    // One turn for the mention, one for the follow-up inside the window, and
    // nothing for the post that went to Nova.
    expect(turnsFor(w, w.dorkbot)).toBe(2);
  });

  it('leaves the default agent answering when the name reached nobody', async () => {
    // `@ghost` resolves to no member, so nothing was addressed and the question
    // would otherwise fall into silence.
    const w = boot({ reply: null });

    await say(w, '@ghost are you there?');

    expect(turnsFor(w, w.dorkbot)).toBe(1);
  });

  it('never tells the default agent it is inside a window its mode does not have', async () => {
    // The seat's engaged window is computed only to decide the stand-down, and
    // `roomContext.addressing` promises `null` for every mode but `engaged`
    // (`room-context.ts`) — reporting one here would describe a bound `always`
    // does not apply, and the agent would read a countdown that governs nothing.
    const w = boot({ reply: null });
    await say(w, '@dorkbot how did last night go?');

    await say(w, 'and today?');

    const [, second] = w.runner.turns;
    expect(second?.roomContext.addressing.responseMode).toBe('always');
    expect(second?.roomContext.addressing.engagedUntil).toBeNull();
    expect(second?.roomContext.addressing.engagedPostsLeft).toBeNull();
  });

  it('reaches nobody at all when you name only an agent you silenced', async () => {
    const w = boot({ reply: null });
    w.service.updateMembership(w.roomId, w.human, w.nova, 'silent');

    await say(w, '@nova can you take the deploy?');

    expect(w.runner.turns).toHaveLength(0);
  });
});

describe('an always a person set themselves in #team', () => {
  it('answers everything, while only the seat DorkOS owns stands down', async () => {
    // Two memberships, both `always`, and the ONLY difference between them is
    // which one the room records as its seat. Nova was set to "Everything" from
    // the room's member menu and that choice must keep meaning always: she
    // answers a post that named Ace, and she would answer Ace's reply too. The
    // seat answers neither. A rule that read the MODE instead of the seat could
    // not tell these two apart, and would have quietly overruled the person.
    const w = boot();
    w.service.updateMembership(w.roomId, w.human, w.nova, 'always');

    await say(w, '@ace can you take the deploy?');

    expect(turnsFor(w, w.ace)).toBe(1);
    expect(turnsFor(w, w.nova)).toBe(1);
    expect(turnsFor(w, w.dorkbot)).toBe(0);
  });
});

describe('the stand-down is scoped to the room that has a fallback seat', () => {
  it('leaves an always member in an ordinary room answering everything', async () => {
    // `always` still means `always`: the generic mode did not change meaning,
    // only #team layers a second rule on top of it.
    const w = boot({ reply: null });
    const backend = w.service.createRoom(
      { kind: 'channel', title: 'Backend', members: [], agentPaths: [DORKBOT, NOVA] },
      w.human
    );
    w.service.updateMembership(backend.id, w.human, w.dorkbot, 'always');

    w.service.post(backend.id, { authorId: w.human, text: '@nova can you take the deploy?' });
    await w.service.triggersIdle();

    const here = w.runner.turns.filter((turn) => turn.roomId === backend.id);
    expect(here.filter((turn) => turn.authorId === w.nova)).toHaveLength(1);
    expect(here.filter((turn) => turn.authorId === w.dorkbot)).toHaveLength(1);
  });

  it('leaves a DM with the default agent exactly as it was', async () => {
    const w = boot({ reply: null });
    const dm = w.service.createRoom(
      { kind: 'dm', title: 'DorkBot', members: [], agentPaths: [DORKBOT] },
      w.human
    );

    w.service.post(dm.id, { authorId: w.human, text: 'what is on for today?' });
    await w.service.triggersIdle();

    expect(w.runner.turns.filter((turn) => turn.roomId === dm.id)).toHaveLength(1);
  });
});

describe('changing the default agent', () => {
  it('moves who answers, and the old default goes quiet', async () => {
    const w = boot();
    await say(w, 'what is on for today?');
    expect(turnsFor(w, w.dorkbot)).toBe(1);

    w.setDefaultAgent('nova');
    ensureTeamRoom(w.deps);

    await say(w, 'and tomorrow?');
    // The second unaddressed post is the whole assertion: Nova answers it, and
    // DorkBot's count has not moved off the one turn it took while it was the
    // default.
    expect(turnsFor(w, w.nova)).toBe(1);
    expect(turnsFor(w, w.dorkbot)).toBe(1);
  });

  it('is the setting, not the room key, that decides — #team is otherwise ordinary', async () => {
    const w = boot({ defaultAgent: 'ace' });

    await say(w, 'what is on for today?');

    expect(turnsFor(w, w.ace)).toBe(1);
    expect(turnsFor(w, w.dorkbot)).toBe(0);
    expect(w.store.findByWellKnown(TEAM_ROOM_KEY)?.id).toBe(w.roomId);
  });
});

/** Post as the person into #team and wait out every turn it set off. */
async function say(w: Wired, text: string): Promise<RoomEntry> {
  const entry = w.service.post(w.roomId, { authorId: w.human, text });
  await w.service.triggersIdle();
  return entry;
}

/** Every message body in the room, oldest first. */
function bodies(w: Wired): string[] {
  return w.service.listEntries(w.roomId, w.human, { limit: 100 }).map((entry) => entry.body.text);
}

/** How many turns one agent has been asked for. */
function turnsFor(w: Wired, authorId: string): number {
  return w.runner.turns.filter((turn) => turn.authorId === authorId).length;
}
