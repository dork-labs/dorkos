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
  it('starts an untriggered post fresh, at its own id and depth 0', () => {
    expect(deriveCascade('E7')).toEqual({ cascadeRoot: 'E7', cascadeDepth: 0 });
  });

  it('inherits the trigger provenance when there is one', () => {
    expect(deriveCascade('E7', { root: 'E0', depth: 2 })).toEqual({
      cascadeRoot: 'E0',
      cascadeDepth: 2,
    });
  });
});
