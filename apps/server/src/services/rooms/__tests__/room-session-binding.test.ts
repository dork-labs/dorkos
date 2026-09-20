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
import {
  agentLookupFor,
  createRoomHarness,
  outcomeRunner,
  speakingRunner,
} from './room-test-harness.js';
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
  const runner: ScriptedTurnRunner = outcomeRunner((request) => {
    // **Named mid-turn, BEFORE the turn says anything**, which is the whole
    // ordering `onSessionBound` exists for: a room binds a placeholder before
    // the claim, the runtime names the real session while the turn runs, and a
    // `post_to_room` made after that has to be stamped with the real one. A
    // fake that only returned the canonical id would report it after the body
    // had already posted.
    request.onSessionBound(CANONICAL);
    if (says !== null) runner.sayInRoom(request, says);
    return { text: says, sessionId: CANONICAL };
  });
  return runner;
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

  it('stamps a mid-turn post with the canonical session, and keeps the binding when it fails', async () => {
    // **The promise, in the shape the code now has.** The room posts nothing on
    // an agent's behalf (spec `tool-only-room-replies`), so the write that can
    // fail mid-turn is the agent's OWN tool call — and what has to be true
    // before it is that the claim already knows which session the turn is
    // really running on. `onSessionBound` is reported before the turn body runs
    // for exactly that reason; without it a mid-turn post would be stamped with
    // the placeholder the room bound before the turn started, which is an id
    // nothing ever writes to again.
    //
    // The second half is the one the comment in the code cannot fail on its
    // own: a write into the room log CAN fail (a busy database, a room archived
    // mid-turn) and the turn still ran. Losing the message is bad; losing the
    // whole conversation it came from, silently, until the next idle sweep, is
    // worse.
    const runner = renamesItsSession();
    const { harness, room, ana } = open(runner);

    await seedAndSettle(harness, room.id, 'is the build green?');

    // The post went in stamped with the id the runtime named, not the
    // placeholder — which is what says the binding was recorded first.
    const said = harness.service
      .listEntries(room.id, harness.human, { limit: 20 })
      .find((entry) => entry.authorId === ana);
    expect(said?.sessionId).toBe(CANONICAL);
    expect(boundSession(harness, room.id)).toBe(CANONICAL);

    // And again with the write refused. The turn ran on the canonical session,
    // so the room keeps knowing that however the write went.
    const second = renamesItsSession();
    const failing = open(second);
    vi.spyOn(failing.harness.service, 'postFromTool').mockImplementation(() => {
      throw new Error('the log rejected that write');
    });

    await seedAndSettle(failing.harness, failing.room.id, 'is the build green?');

    expect(second.refusals).toEqual(['the log rejected that write']);
    expect(
      failing.harness.service
        .listEntries(failing.room.id, failing.harness.human, { limit: 20 })
        .filter((entry) => entry.authorId === failing.ana && entry.kind === 'post')
    ).toEqual([]);
    expect(boundSession(failing.harness, failing.room.id)).toBe(CANONICAL);
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
