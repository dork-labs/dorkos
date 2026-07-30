/**
 * A room agent keeps its memory: the binding follows the real session.
 *
 * The defect this file pins. `room_sessions` is written BEFORE the first turn,
 * from a UUID the room mints itself, because two posts arriving before the
 * first reply must resolve to one session (`room-trigger.ts`). Claude Code then
 * assigns its own canonical id on that first turn and files the transcript
 * under it. Nothing wrote that id back, so the room stayed bound to an id no
 * transcript will ever exist under.
 *
 * It hid for a whole idle window at a time. While the live session is in
 * memory the runtime resolves either id to the same conversation, so resume
 * works and everything looks right; once the 30-minute idle sweep evicts it (or
 * the server restarts), the next turn probes for a transcript under the bound
 * id, finds none, and starts the agent over from nothing — no error, no notice,
 * just an agent that has forgotten the room. Then it happens again.
 *
 * Every fake in the room suites used to echo the requested session id straight
 * back, which is why none of them could see this. `outcomeRunner` now takes a
 * `sessionId`, and these tests are the ones that supply a different one.
 *
 * Only Claude Code renames a session this way. Codex, OpenCode and test-mode
 * all return `undefined` from `getInternalSessionId`, so their ids never move
 * and the last test here pins that they stay untouched.
 */
import { describe, it, expect, vi } from 'vitest';
import { eq, roomSessions } from '@dorkos/db';
import type { RoomEntry, RoomWithRoster } from '@dorkos/shared/room-schemas';
import { RoomStore } from '../room-store.js';
import { agentLookupFor, createRoomHarness, outcomeRunner } from './room-test-harness.js';
import type { RoomHarness, ScriptedTurnRunner } from './room-test-harness.js';

/** The id Claude Code hands back once it has named the session itself. */
const CANONICAL = 'sdk-canonical-9f3c';

const oneAgent = agentLookupFor({
  '/agents/ana': { name: 'ana', displayName: 'Ana', responseMode: 'always' },
});

/** A room with Ana in it, answering through `runner`. */
function open(runner: ScriptedTurnRunner): {
  harness: RoomHarness;
  room: RoomWithRoster;
  ana: string;
} {
  const harness = createRoomHarness({ agents: oneAgent, runner });
  const room = harness.service.createRoom(
    { kind: 'channel', title: 'Backend', members: [], agentPaths: ['/agents/ana'] },
    harness.human
  );
  const ana = harness.authors.resolveAgent('/agents/ana', 'Ana').id;
  harness.service.updateMembership(room.id, harness.human, ana, 'always');
  return { harness, room, ana };
}

/**
 * A runner that answers on the runtime's own id rather than the room's, the way
 * Claude Code does: the first turn is asked with the room's placeholder and
 * answers on {@link CANONICAL}; every turn after that is asked with — and
 * answers on — the canonical id, because it is stable once assigned.
 *
 * @param says - What the agent says each turn. `null` is an agent staying quiet.
 */
function renamesItsSession(says: string | null = 'on it'): ScriptedTurnRunner {
  return outcomeRunner(() => ({ text: says, sessionId: CANONICAL }));
}

/** Post as the human and wait for every turn it sets off. */
async function seedAndSettle(
  harness: RoomHarness,
  roomId: string,
  text: string
): Promise<RoomEntry> {
  const seed = harness.service.post(roomId, { authorId: harness.human, text });
  await harness.service.triggersIdle();
  return seed;
}

/** What `room_sessions` says this agent answers in this room with. */
function boundSession(harness: RoomHarness, roomId: string): string | null {
  const row = harness.db.select().from(roomSessions).where(eq(roomSessions.roomId, roomId)).get();
  return row?.sessionId ?? null;
}

describe('the room binding follows the session the turn ran on', () => {
  it('moves the binding onto the runtime canonical id', async () => {
    const runner = renamesItsSession();
    const { harness, room } = open(runner);

    await seedAndSettle(harness, room.id, 'is the build green?');

    // The turn was ASKED with the room's own placeholder — that part is by
    // design, and is what resolves a race between two simultaneous posts.
    expect(runner.turns[0].sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(runner.turns[0].sessionId).not.toBe(CANONICAL);
    // What must not survive the turn is that placeholder as the binding.
    expect(boundSession(harness, room.id)).toBe(CANONICAL);
  });

  it('resumes the canonical session on the next message, rather than starting over', async () => {
    const runner = renamesItsSession();
    const { harness, room } = open(runner);

    await seedAndSettle(harness, room.id, 'is the build green?');
    await seedAndSettle(harness, room.id, 'and the deploy?');

    expect(runner.turns).toHaveLength(2);
    // The whole point: the second turn runs on the id the transcript is under,
    // so an evicted session resumes instead of waking up with no memory.
    expect(runner.turns[1].sessionId).toBe(CANONICAL);
    expect(boundSession(harness, room.id)).toBe(CANONICAL);
  });

  it('rebinds a turn the agent chose to stay quiet on', async () => {
    // A silent first turn is still a real session with a real transcript. Left
    // unbound, the room would forget the one exchange it had before it even
    // said anything — the failure would just be invisible for one more message.
    const runner = renamesItsSession(null);
    const { harness, room } = open(runner);

    await seedAndSettle(harness, room.id, 'is the build green?');

    expect(boundSession(harness, room.id)).toBe(CANONICAL);
  });

  it('leaves the binding alone for a runtime that keeps the id it was given', async () => {
    // Codex, OpenCode and test-mode never rename a session, so nothing about
    // their behaviour may change — down to not writing the row at all.
    const runner = outcomeRunner(() => ({ text: 'on it' }));
    const { harness, room } = open(runner);
    const rebind = vi.spyOn(harness.store, 'rebindRoomSession');

    await seedAndSettle(harness, room.id, 'is the build green?');
    const bound = boundSession(harness, room.id);
    await seedAndSettle(harness, room.id, 'and the deploy?');

    expect(rebind).not.toHaveBeenCalled();
    expect(boundSession(harness, room.id)).toBe(bound);
    expect(runner.turns[1].sessionId).toBe(bound);
  });

  it('records the session before it posts, so a failed post cannot cost the room its memory', async () => {
    // The ordering is a promise the code makes in a comment, and a comment
    // cannot fail. Moving the rebind below `deliver` left every other room test
    // green, because in every one of them the post succeeds — so this is the
    // only place the order is actually pinned.
    //
    // It is not a hypothetical order to get wrong: a write into the room log can
    // fail (a busy database, a room archived mid-turn), and the turn still ran.
    // Losing the answer is bad; losing the whole conversation the answer came
    // from, silently, until the next idle sweep, is worse.
    const runner = renamesItsSession();
    const { harness, room, ana } = open(runner);
    const order: string[] = [];
    vi.spyOn(harness.store, 'rebindRoomSession').mockImplementation((...args) => {
      order.push('rebind');
      return RoomStore.prototype.rebindRoomSession.apply(harness.store, args);
    });
    const post = harness.service.post.bind(harness.service);
    vi.spyOn(harness.service, 'post').mockImplementation((roomId, input) => {
      // Only the agent's reply fails; the human's message has to land, or there
      // is no turn to order anything against.
      if (input.authorId !== ana) return post(roomId, input);
      order.push('post');
      throw new Error('the log rejected that write');
    });

    await seedAndSettle(harness, room.id, 'is the build green?');

    expect(order).toEqual(['rebind', 'post']);
    expect(boundSession(harness, room.id)).toBe(CANONICAL);
  });

  it('does not rebind when the session was too busy to run a turn', async () => {
    // A refused turn ran on nothing. Writing a binding from it would be writing
    // a guess.
    const runner = outcomeRunner(() => ({ text: null, unanswered: 'busy' as const }));
    const { harness, room } = open(runner);
    const rebind = vi.spyOn(harness.store, 'rebindRoomSession');

    await seedAndSettle(harness, room.id, 'is the build green?');

    expect(rebind).not.toHaveBeenCalled();
  });
});
