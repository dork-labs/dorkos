/**
 * The guard's absence is invisible except under a cascade, so this file builds
 * one — and builds it through the code that ships.
 *
 * R1's version of this test wrote the loop by hand, because nothing was wired.
 * This one does not: every reply below is posted by {@link RoomTriggerDispatcher}
 * off a real committed entry, so a wiring mistake that leaves a hop unguarded
 * fails here rather than passing beside the thing it was meant to check. The
 * only stand-in is the turn runner, whose alternative is a model call.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { RoomEntry, RoomWithRoster } from '@dorkos/shared/room-schemas';
import { buildCascadeNotice, deriveCascade, evaluateCascade } from '../cascade-guard.js';
import type { AuthorRegistry } from '../author-registry.js';
import type { RoomService } from '../room-service.js';
import {
  agentLookupFor,
  createRoomHarness,
  scriptedRunner,
  type RecordedTurn,
  type ScriptedTurnRunner,
} from './room-test-harness.js';

/** Both agents answer everything — the worst case the guard exists for. */
const alwaysAgents = agentLookupFor({
  '/agents/ana': { name: 'ana', displayName: 'Ana', responseMode: 'always' },
  '/agents/bo': { name: 'bo', displayName: 'Bo', responseMode: 'always' },
});

/**
 * The ceiling these tests measure against, pinned to a literal rather than read
 * from config. A test that read the same value the code reads could only prove
 * the two agree; it could never prove they agree on the right number.
 */
const MAX_AGENT_DEPTH = 3;

describe('cascade guard, wired', () => {
  let service: RoomService;
  let authors: AuthorRegistry;
  let runner: ScriptedTurnRunner;
  let room: RoomWithRoster;
  let ana: string;
  let bo: string;
  let human: string;

  beforeEach(() => {
    ({ service, authors, runner, human } = createRoomHarness({
      agents: alwaysAgents,
      runner: scriptedRunner(() => 'on it'),
      maxAgentDepth: MAX_AGENT_DEPTH,
    }));

    room = service.createRoom(
      {
        kind: 'channel',
        title: 'Backend',
        members: [],
        agentPaths: ['/agents/ana', '/agents/bo'],
      },
      human
    );
    // A channel seeds `mention-only`; both agents answer everything here on
    // purpose, because that is the shape that loops.
    ana = authors.resolveAgent('/agents/ana', 'Ana').id;
    bo = authors.resolveAgent('/agents/bo', 'Bo').id;
    service.updateMembership(room.id, human, ana, 'always');
    service.updateMembership(room.id, human, bo, 'always');
  });

  /** Post as the human and wait for every turn it set off to finish. */
  async function seedAndSettle(text: string): Promise<RoomEntry> {
    const seed = service.post(room.id, { authorId: human, text });
    await service.triggersIdle();
    return seed;
  }

  /** Every entry in the room, oldest first. */
  function log(): RoomEntry[] {
    return service.listEntries(room.id, human, { limit: 200 });
  }

  it('terminates a two-agent ping-pong instead of running forever', async () => {
    await seedAndSettle('what do you two think?');

    // Both agents answered once, and then it stopped. Without the guard this
    // is the test that never returns.
    expect(runner.turns.map((t) => t.authorId).sort()).toEqual([ana, bo].sort());
    expect(log().filter((e) => e.kind === 'post' && e.authorId !== human)).toHaveLength(2);
  });

  it('fires the ancestry rule, and fires it below the depth ceiling', async () => {
    await seedAndSettle('thoughts?');

    // Nothing ever reached the ceiling: the deepest thing in the room is a
    // first reply. A pure depth counter would have permitted three more rounds
    // of model calls before refusing anything.
    expect(Math.max(...log().map((e) => e.cascadeDepth))).toBe(1);
    expect(Math.max(...log().map((e) => e.cascadeDepth))).toBeLessThan(MAX_AGENT_DEPTH);
    expect(log().some((e) => e.kind === 'notice')).toBe(true);
  });

  it('triggers each agent once per cascade, even before either has answered', async () => {
    // Both turns are in flight when the first reply lands, so the durable
    // ancestry query cannot see either of them yet. The claim is what closes
    // that window; without it each agent is triggered twice per human message.
    await seedAndSettle('thoughts?');

    const perAgent = runner.turns.filter((t) => t.authorId === ana);
    expect(perAgent).toHaveLength(1);
    expect(runner.turns).toHaveLength(2);
  });

  it('lands a durable notice in the room, in the room own voice', async () => {
    await seedAndSettle('thoughts?');

    const notices = log().filter((entry) => entry.kind === 'notice');
    expect(notices.length).toBeGreaterThan(0);
    expect(notices[0].body.notice).toBe('cascade_stopped');
    expect(notices[0].body.text).toContain('automatic-reply limit');
    expect(notices[0].body.text).not.toMatch(/error|Error|undefined|null/);
    expect(notices[0].authorId).toBe(authors.system().id);
    expect([ana, bo]).toContain(notices[0].body.subjectAuthorId);
  });

  it('says an agent stopped at most once per cascade', async () => {
    await seedAndSettle('thoughts?');

    const subjects = log()
      .filter((entry) => entry.kind === 'notice')
      .map((entry) => entry.body.subjectAuthorId);
    expect(new Set(subjects).size).toBe(subjects.length);
  });

  it('keeps the whole cascade traceable to the entry that began it', async () => {
    const seed = await seedAndSettle('thoughts?');

    expect(log().every((entry) => entry.cascadeRoot === seed.id)).toBe(true);
    expect(service.authorsInCascade(room.id, seed.id).sort()).toEqual(
      [human, ana, bo, authors.system().id].sort()
    );
  });

  it('lets a human re-engage a room the guard has stopped', async () => {
    await seedAndSettle('round one');
    const before = log().length;
    const turnsBefore = runner.turns.length;

    const second = await seedAndSettle('round two');

    // A human post always starts a fresh cascade: its own id at depth 0, which
    // is exactly what makes the room answerable again.
    expect(second.cascadeRoot).toBe(second.id);
    expect(second.cascadeDepth).toBe(0);
    expect(runner.turns.length).toBeGreaterThan(turnsBefore);
    expect(log().length).toBeGreaterThan(before + 1);
  });

  it('binds one session per agent per room and resumes it next time', async () => {
    await seedAndSettle('round one');
    const firstAna = runner.turns.find((t) => t.authorId === ana);
    expect(firstAna?.sessionId).toBeNull();

    await seedAndSettle('round two');
    const secondAna = runner.turns.filter((t) => t.authorId === ana)[1];
    expect(secondAna?.sessionId).not.toBeNull();
  });

  it('does not let an agent reset the guard by posting during its own turn', async () => {
    // The dispatcher supplies provenance for the reply IT writes — but an agent
    // can also write to the room directly while its turn is running, which is
    // what `POST /api/rooms/:id/entries` is, and that call carries none.
    //
    // Treating "no trigger argument" as "no cascade" gave every such post a
    // fresh root at depth 0, so two `always` agents that each post an update
    // re-triggered each other forever: measured at 21 entries, every one at
    // depth 0 under its own root, the guard never firing once. Only the cap
    // below stopped it, and in production nothing would have.
    const SELF_POST_CAP = 20;
    let selfPosts = 0;
    const turns: RecordedTurn[] = [];
    // Assigned once the harness exists; the runner has to be built first because
    // the harness is constructed from it.
    let postAsAgent: (roomId: string, authorId: string, text: string) => void = () => {};

    const selfPosting: ScriptedTurnRunner = {
      turns,
      run(request) {
        turns.push({
          roomId: request.room.id,
          authorId: request.authorId,
          agentPath: request.agentPath,
          sessionId: request.sessionId,
          prompt: request.entry.body.text,
        });
        if (selfPosts < SELF_POST_CAP) {
          selfPosts += 1;
          postAsAgent(request.room.id, request.authorId, `update ${selfPosts}`);
        }
        // Says nothing through the dispatcher: everything it contributes is the
        // post above, so provenance can only come from the turn it is inside.
        return Promise.resolve({ sessionId: 'session-1', text: null });
      },
    };

    const harness = createRoomHarness({
      agents: alwaysAgents,
      runner: selfPosting,
      maxAgentDepth: MAX_AGENT_DEPTH,
    });
    // The agent writing to the room ITSELF, mid-turn — the shape of an agent
    // calling `POST /api/rooms/:id/entries` while it is answering.
    postAsAgent = (roomId, authorId, text) => {
      harness.service.post(roomId, { authorId, text });
    };
    const loud = harness.service.createRoom(
      {
        kind: 'channel',
        title: 'Backend',
        members: [],
        agentPaths: ['/agents/ana', '/agents/bo'],
      },
      harness.human
    );
    const anaId = harness.authors.resolveAgent('/agents/ana', 'Ana').id;
    const boId = harness.authors.resolveAgent('/agents/bo', 'Bo').id;
    harness.service.updateMembership(loud.id, harness.human, anaId, 'always');
    harness.service.updateMembership(loud.id, harness.human, boId, 'always');

    const seed = harness.service.post(loud.id, { authorId: harness.human, text: 'kick off' });
    await harness.service.triggersIdle();

    const log = harness.service.listEntries(loud.id, harness.human, { limit: 500 });
    // The tripwire was never reached: the guard stopped this, not the cap.
    expect(selfPosts).toBeLessThan(SELF_POST_CAP);
    // One human message, one cascade — an agent's own writes join the turn they
    // were made inside rather than starting a new one.
    expect(new Set(log.map((entry) => entry.cascadeRoot))).toEqual(new Set([seed.id]));
    expect(Math.max(...log.map((entry) => entry.cascadeDepth))).toBeLessThanOrEqual(
      MAX_AGENT_DEPTH
    );
  });

  it('gives an agent posting with no turn in flight a cascade that is already spent', async () => {
    // The shell case: an agent holds its identity token (it is in every spawned
    // session's environment) and calls `POST /api/rooms/:id/entries` with
    // nothing in flight. Keying the fresh start on "no trigger argument" made
    // this a full guard bypass — 30 posts, 30 turns, 30 roots, max depth 0, not
    // one notice. Its post is durable and readable; what it must not do is buy
    // another model call.
    const spontaneous = service.post(room.id, { authorId: ana, text: 'deploy finished' });
    await service.triggersIdle();

    expect(spontaneous.cascadeRoot).toBe(spontaneous.id);
    expect(spontaneous.cascadeDepth).toBe(MAX_AGENT_DEPTH);
    expect(runner.turns).toHaveLength(0);
    // Refused visibly, not silently — that is the whole point of the notice.
    expect(log().some((entry) => entry.kind === 'notice')).toBe(true);
  });

  it('does not let an agent buy turns by posting in a loop', async () => {
    // The reviewer's attack, run against the real service and dispatcher.
    for (let i = 0; i < 30; i++) {
      service.post(room.id, { authorId: ana, text: `spam ${i}` });
      await service.triggersIdle();
    }
    expect(runner.turns).toHaveLength(0);
  });

  it('still lets the operator start a conversation the agents answer', async () => {
    // The fix must not become "nothing ever triggers". A person's post is the
    // one thing that resets the count, which is exactly what §6 grants.
    await seedAndSettle('what do you two think?');
    expect(runner.turns.map((t) => t.authorId).sort()).toEqual([ana, bo].sort());
  });

  it('stops replying entirely when the ceiling is zero', async () => {
    const zero = createRoomHarness({ agents: alwaysAgents, maxAgentDepth: 0 });
    const quiet = zero.service.createRoom(
      { kind: 'dm', title: 'Ana', members: [], agentPaths: ['/agents/ana'] },
      zero.human
    );
    zero.service.post(quiet.id, { authorId: zero.human, text: 'hello?' });
    await zero.service.triggersIdle();

    expect(zero.runner.turns).toHaveLength(0);
    const notices = zero.service
      .listEntries(quiet.id, zero.human, { limit: 20 })
      .filter((entry) => entry.kind === 'notice');
    expect(notices).toHaveLength(1);
  });
});

describe('triggering', () => {
  it('answers a DM without being mentioned, and a channel only when it is', async () => {
    const agents = agentLookupFor({
      '/agents/ana': { name: 'ana', displayName: 'Ana', responseMode: 'always' },
    });

    const dm = createRoomHarness({ agents });
    const dmRoom = dm.service.createRoom(
      { kind: 'dm', title: 'Ana', members: [], agentPaths: ['/agents/ana'] },
      dm.human
    );
    dm.service.post(dmRoom.id, { authorId: dm.human, text: 'morning' });
    await dm.service.triggersIdle();
    expect(dm.runner.turns).toHaveLength(1);

    const channel = createRoomHarness({ agents });
    const channelRoom = channel.service.createRoom(
      { kind: 'channel', title: 'Backend', members: [], agentPaths: ['/agents/ana'] },
      channel.human
    );
    channel.service.post(channelRoom.id, { authorId: channel.human, text: 'morning' });
    await channel.service.triggersIdle();
    // A channel seeds `mention-only`, so an unaddressed message triggers nobody.
    expect(channel.runner.turns).toHaveLength(0);

    channel.service.post(channelRoom.id, { authorId: channel.human, text: 'morning @ana' });
    await channel.service.triggersIdle();
    expect(channel.runner.turns).toHaveLength(1);
  });

  it('posts nothing when the agent says nothing', async () => {
    const silent = createRoomHarness({
      agents: agentLookupFor({ '/agents/ana': { name: 'ana', displayName: 'Ana' } }),
      runner: scriptedRunner(() => '   '),
    });
    const room = silent.service.createRoom(
      { kind: 'dm', title: 'Ana', members: [], agentPaths: ['/agents/ana'] },
      silent.human
    );
    silent.service.post(room.id, { authorId: silent.human, text: 'hi' });
    await silent.service.triggersIdle();

    expect(silent.runner.turns).toHaveLength(1);
    expect(silent.service.listEntries(room.id, silent.human, { limit: 20 })).toHaveLength(1);
  });

  it('keeps the room usable when a turn throws', async () => {
    const broken = createRoomHarness({
      agents: agentLookupFor({ '/agents/ana': { name: 'ana', displayName: 'Ana' } }),
      runner: {
        turns: [],
        run: () => Promise.reject(new Error('runtime exploded')),
      },
    });
    const room = broken.service.createRoom(
      { kind: 'dm', title: 'Ana', members: [], agentPaths: ['/agents/ana'] },
      broken.human
    );

    broken.service.post(room.id, { authorId: broken.human, text: 'hi' });
    await expect(broken.service.triggersIdle()).resolves.toBeUndefined();

    // The failure belongs on the agent own session stream, not in the room log
    // as a stack trace — so the room holds exactly the message that was sent.
    expect(broken.service.listEntries(room.id, broken.human, { limit: 20 })).toHaveLength(1);
    // And the next message still triggers: a thrown turn releases its claim.
    broken.service.post(room.id, { authorId: broken.human, text: 'still there?' });
    await broken.service.triggersIdle();
  });

  it('never lets a notice address anybody', async () => {
    const harness = createRoomHarness({ agents: alwaysAgents, maxAgentDepth: MAX_AGENT_DEPTH });
    const room = harness.service.createRoom(
      { kind: 'dm', title: 'Ana', members: [], agentPaths: ['/agents/ana'] },
      harness.human
    );
    harness.service.postNotice(room.id, buildCascadeNotice('Ana', 'someone'));
    await harness.service.triggersIdle();

    expect(harness.runner.turns).toHaveLength(0);
  });
});

describe('evaluateCascade', () => {
  const provenance = { root: 'E0', depth: 0, authorsInCascade: ['human'] as string[] };

  it('allows a first trigger', () => {
    expect(evaluateCascade('ana', provenance, { maxAgentDepth: 3 })).toEqual({
      allowed: true,
      depth: 1,
    });
  });

  it('refuses past the depth ceiling even when nobody repeats', () => {
    const decision = evaluateCascade(
      'fresh-agent',
      { root: 'E0', depth: 3, authorsInCascade: ['human', 'a', 'b', 'c'] },
      { maxAgentDepth: 3 }
    );
    expect(decision).toEqual({ allowed: false, depth: 4, reason: 'depth' });
  });

  it('refuses a repeat author well inside the ceiling', () => {
    expect(
      evaluateCascade(
        'ana',
        { ...provenance, authorsInCascade: ['human', 'ana'] },
        { maxAgentDepth: 3 }
      )
    ).toEqual({ allowed: false, depth: 1, reason: 'ancestry' });
  });

  it('honours a caller-supplied ceiling', () => {
    expect(evaluateCascade('ana', provenance, { maxAgentDepth: 0 }).reason).toBe('depth');
  });
});

describe('deriveCascade', () => {
  it('starts a HUMAN untriggered post fresh, at its own id and depth 0', () => {
    expect(deriveCascade('E7', { authorKind: 'human', maxAgentDepth: 3 })).toEqual({
      cascadeRoot: 'E7',
      cascadeDepth: 0,
    });
  });

  it('refuses an agent a fresh cascade, stamping it at the ceiling instead', () => {
    // The rule is who is writing, not whether a `trigger` argument was passed.
    // `POST /api/rooms/:id/entries` passes none and resolves an agent bearer to
    // that agent, so keying on call shape let any agent with a shell mint depth
    // 0 at will — 30 hops, 30 roots, max depth 0, no notice.
    expect(deriveCascade('E7', { authorKind: 'agent', maxAgentDepth: 3 })).toEqual({
      cascadeRoot: 'E7',
      cascadeDepth: 3,
    });
    // The room's own voice gets no reset either.
    expect(deriveCascade('E7', { authorKind: 'system', maxAgentDepth: 3 })).toEqual({
      cascadeRoot: 'E7',
      cascadeDepth: 3,
    });
  });

  it('inherits the trigger provenance when there is one, whoever is writing', () => {
    for (const authorKind of ['human', 'agent', 'system'] as const) {
      expect(
        deriveCascade('E7', { trigger: { root: 'E0', depth: 2 }, authorKind, maxAgentDepth: 3 })
      ).toEqual({ cascadeRoot: 'E0', cascadeDepth: 2 });
    }
  });
});
