/**
 * `engaged` as a channel behaves (room-participation spec §9).
 *
 * `engagement.test.ts` pins the predicate; this pins the thing a person would
 * actually notice — that a channel seeds `engaged`, that an agent answers a
 * follow-up nobody addressed, that it stops, and that what it is told about its
 * own window matches the rule that triggered it.
 *
 * Driven through the real {@link RoomService} and the real dispatcher, with only
 * the turn runner scripted, because the point is the wiring between three
 * modules and not any one of them.
 *
 * @module server/services/rooms/tests/engaged-mode
 */
import { describe, it, expect } from 'vitest';
import type { RoomEntry, RoomWithRoster } from '@dorkos/shared/room-schemas';
import type { RoomService } from '../room-service.js';
import type { AuthorRegistry } from '../author-registry.js';
import {
  agentLookupFor,
  createRoomHarness,
  scriptedRunner,
  type ScriptedTurnRunner,
} from './room-test-harness.js';
import type { EngagedWindow } from '../engagement.js';

const AGENTS = agentLookupFor({
  '/agents/ana': { name: 'ana' },
  '/agents/bo': { name: 'bo' },
});

interface Wired {
  service: RoomService;
  authors: AuthorRegistry;
  runner: ScriptedTurnRunner;
  human: string;
  room: RoomWithRoster;
  ana: string;
  bo: string;
}

/**
 * A channel with Ana in it, on whatever mode the caller names.
 *
 * @param opts.engagedWindow - The ceilings, when a case is about them.
 * @param opts.withBo - Put a second agent in, always-on, to generate other
 *   people's turns.
 * @param opts.quiet - Ana takes turns but never posts.
 */
function open(
  opts: { engagedWindow?: EngagedWindow; withBo?: boolean; quiet?: boolean } = {}
): Wired {
  // A quiet Ana never posts, so the only anchor a window can have is a
  // mention: what the cases about the posts ceiling need, now that an agent's
  // own reply anchors a person's conversation with it (DOR-2823).
  const runner = scriptedRunner(() => (opts.quiet ? null : 'on it'));
  const agentPaths = opts.withBo ? ['/agents/ana', '/agents/bo'] : ['/agents/ana'];
  const harness = createRoomHarness({
    agents: AGENTS,
    runner,
    ...(opts.engagedWindow ? { engagedWindow: opts.engagedWindow } : {}),
  });
  const room = harness.service.createRoom(
    { kind: 'channel', title: 'Backend', members: [], agentPaths },
    harness.human
  );
  const ana = harness.authors.resolveAgent('/agents/ana', 'ana').id;
  const bo = harness.authors.resolveAgent('/agents/bo', 'bo').id;
  if (opts.withBo) harness.service.updateMembership(room.id, harness.human, bo, 'silent');
  return {
    service: harness.service,
    authors: harness.authors,
    runner,
    human: harness.human,
    room,
    ana,
    bo,
  };
}

describe('engaged, end to end', () => {
  it('is what a channel seeds a new agent member to', () => {
    const w = open();
    expect(w.room.members.find((m) => m.authorId === w.ana)?.responseMode).toBe('engaged');
  });

  it('answers a follow-up nobody addressed, once it has been addressed', async () => {
    const w = open();
    await say(w, '@ana is the build green?');
    expect(turnsFor(w, w.ana)).toBe(1);

    // No `@` this time. Under `mention-only` this message reached nobody, which
    // is the tax the mode was changed to remove.
    await say(w, 'and the deploy?');
    expect(turnsFor(w, w.ana)).toBe(2);
  });

  it('says nothing at all until somebody addresses it', async () => {
    const w = open();
    await say(w, 'morning everyone');
    await say(w, 'anyone seen the flaky test?');
    expect(turnsFor(w, w.ana)).toBe(0);
  });

  it('stops once enough messages have gone by without it being addressed', async () => {
    const w = open({ engagedWindow: { minutes: 10, posts: 2 }, quiet: true });
    await say(w, '@ana is the build green?');
    await say(w, 'follow-up one');
    expect(turnsFor(w, w.ana)).toBe(2);

    // The third human message is the second post since the mention, so the
    // window has closed by the time it is weighed.
    await say(w, 'follow-up two');
    expect(turnsFor(w, w.ana)).toBe(2);

    // And a person can always pick it back up.
    await say(w, '@ana still there?');
    expect(turnsFor(w, w.ana)).toBe(3);
  });

  it('is never engaged when the window is turned off, which is mention-only', async () => {
    const w = open({ engagedWindow: { minutes: 0, posts: 0 } });
    await say(w, '@ana is the build green?');
    await say(w, 'and the deploy?');
    expect(turnsFor(w, w.ana)).toBe(1);
  });

  describe('what the agent is told about its own window', () => {
    it('reports when it closes, on the turn the window is what triggered it', async () => {
      const w = open();
      await say(w, '@ana is the build green?');
      await say(w, 'and the deploy?');

      const [addressed, engaged] = w.runner.turns;
      // Being mentioned IS being engaged — the mention is the window's anchor,
      // so both turns carry one rather than only the second.
      expect(addressed!.roomContext.addressing.responseMode).toBe('engaged');
      expect(addressed!.roomContext.addressing.addressedNow).toBe(true);
      expect(addressed!.roomContext.addressing.engagedUntil).not.toBeNull();
      expect(engaged!.roomContext.addressing.addressedNow).toBe(false);
      expect(engaged!.roomContext.addressing.engagedUntil).not.toBeNull();
      // And the message half counts DOWN across the two turns, because one
      // message from somebody else landed in between. A number that did not
      // move would be the configured ceiling wearing a remaining-count's name.
      expect(addressed!.roomContext.addressing.engagedPostsLeft).toBe(4);
      expect(engaged!.roomContext.addressing.engagedPostsLeft).toBe(3);
    });

    it('carries no window for a mode that has none', async () => {
      const w = open();
      w.service.updateMembership(w.room.id, w.human, w.ana, 'always');
      await say(w, 'morning');

      const [turn] = w.runner.turns;
      expect(turn!.roomContext.addressing.responseMode).toBe('always');
      // `always` answers whatever the log says, so reporting a window would
      // describe a bound nothing applies.
      expect(turn!.roomContext.addressing.engagedUntil).toBeNull();
      expect(turn!.roomContext.addressing.engagedPostsLeft).toBeNull();
    });
  });

  describe('thread scoping', () => {
    it('does not engage the channel when the agent was addressed in a thread', async () => {
      const w = open();
      const root = w.service.post(w.room.id, { authorId: w.human, text: 'deploy thread' });
      await w.service.triggersIdle();

      await say(w, '@ana can you take this?', root.id);
      expect(turnsFor(w, w.ana)).toBe(1);

      // Same room, top level, no `@`. The thread window must not reach here.
      await say(w, 'unrelated question');
      expect(turnsFor(w, w.ana)).toBe(1);

      // And the thread itself is still live.
      await say(w, 'any luck?', root.id);
      expect(turnsFor(w, w.ana)).toBe(2);
    });

    it('does not engage an open thread when the agent was addressed in the channel', async () => {
      const w = open();
      const root = w.service.post(w.room.id, { authorId: w.human, text: 'deploy thread' });
      await w.service.triggersIdle();

      await say(w, '@ana is the build green?');
      expect(turnsFor(w, w.ana)).toBe(1);

      await say(w, 'and this one?', root.id);
      expect(turnsFor(w, w.ana)).toBe(1);
    });
  });

  it('is decayed by another agent’s posts, not only by a person’s', async () => {
    // Both halves in one case, because the assertion only means something
    // against its control: the SAME conversation, with and without one post by
    // the other agent in the middle of it.
    const control = open({ engagedWindow: { minutes: 10, posts: 2 }, withBo: true });
    await say(control, '@ana is the build green?');
    await say(control, 'and the deploy?');
    // One message since the mention, and the window allows two.
    expect(turnsFor(control, control.ana)).toBe(2);

    const w = open({ engagedWindow: { minutes: 10, posts: 2 }, withBo: true });
    await say(w, '@ana is the build green?');
    // Bo is `silent`, so it is never triggered — but an agent may write to a
    // room directly, and what it writes is a turn in the conversation like
    // anybody else's.
    w.service.post(w.room.id, { authorId: w.bo, text: 'unrelated update' });
    await w.service.triggersIdle();

    const before = turnsFor(w, w.ana);
    await say(w, 'and the deploy?');
    // Two messages since the mention now, so the same follow-up reaches nobody.
    expect(turnsFor(w, w.ana)).toBe(before);
  });
});

describe('following the conversation (DOR-2823)', () => {
  /**
   * Two engaged agents, each answering in a thread on the message that asked
   * it — the shape of the real rooms, where an agent's answer to a top-level
   * question opens a thread on it.
   */
  function twoAgents(): Wired {
    const runner = scriptedRunner(() => null);
    const answer: ScriptedTurnRunner = {
      ...runner,
      run: async (request) => {
        const result = await runner.run(request);
        runner.sayInRoom(request, 'on it', {
          replyTo: request.entry.threadRootEntryId ?? request.entry.id,
        });
        return result;
      },
    };
    const harness = createRoomHarness({ agents: AGENTS, runner: answer });
    const room = harness.service.createRoom(
      { kind: 'channel', title: 'Poster', members: [], agentPaths: ['/agents/ana', '/agents/bo'] },
      harness.human
    );
    return {
      service: harness.service,
      authors: harness.authors,
      runner,
      human: harness.human,
      room,
      ana: harness.authors.resolveAgent('/agents/ana', 'ana').id,
      bo: harness.authors.resolveAgent('/agents/bo', 'bo').id,
    };
  }

  it('answers a follow-up in the thread the agent answered in, and only that agent', async () => {
    const w = twoAgents();
    const ask = await say(w, '@ana what should we work on next?');
    expect(turnsFor(w, w.ana)).toBe(1);

    // No @: the real miss, seq 48 in the poster room.
    await say(w, 'we will want to remove the signatures param', ask.id);
    expect(turnsFor(w, w.ana)).toBe(2);
    expect(turnsFor(w, w.bo)).toBe(0);
  });

  it('follows the person to the agent they named last', async () => {
    const w = twoAgents();
    await say(w, '@ana is the build green?');
    await say(w, '@bo and the deploy?');
    const before = { ana: turnsFor(w, w.ana), bo: turnsFor(w, w.bo) };

    await say(w, 'thanks, go ahead');
    expect(turnsFor(w, w.bo)).toBe(before.bo + 1);
    expect(turnsFor(w, w.ana)).toBe(before.ana);
  });

  it('does not hand an agent’s post to whoever spoke last', async () => {
    const w = twoAgents();
    // Ana spoke last, unprompted; nobody named anybody.
    w.service.post(w.room.id, { authorId: w.ana, text: 'build is green' });
    await w.service.triggersIdle();
    w.service.post(w.room.id, { authorId: w.bo, text: 'deploy is out' });
    await w.service.triggersIdle();
    // Agents talking to each other keep the mention rule, so nobody answers.
    expect(w.runner.turns).toHaveLength(0);
  });

  it('tells the agent its turn came from the conversation', async () => {
    const w = twoAgents();
    const ask = await say(w, '@ana what should we work on next?');
    await say(w, 'and after that?', ask.id);
    const last = w.runner.turns.at(-1)!;
    expect(last.authorId).toBe(w.ana);
    expect(last.roomContext.addressing.addressedNow).toBe(false);
    expect(last.roomContext.addressing.engagedUntil).not.toBeNull();
  });
});

/** Post as the person and wait out every turn it set off. */
async function say(w: Wired, text: string, replyTo?: string): Promise<RoomEntry> {
  const entry = w.service.post(w.room.id, {
    authorId: w.human,
    text,
    ...(replyTo ? { replyTo } : {}),
  });
  await w.service.triggersIdle();
  return entry;
}

/** How many turns one agent has been asked for. */
function turnsFor(w: Wired, authorId: string): number {
  return w.runner.turns.filter((turn) => turn.authorId === authorId).length;
}
