/**
 * The ambient middle state: what an agent knows happened while it was not
 * answering (room-participation spec §8, RP3).
 *
 * Before this, a room post either triggered an agent or vanished from its world,
 * and the `(member, room)` read cursor that was supposed to be the mechanism was
 * dead state — written to `0` at join and never moved. Three things make it a
 * mechanism: a floor at the seq the member joined, a per-room cap on how much
 * backlog one turn replays, and a cursor that advances **when the turn is
 * claimed**.
 *
 * **Silence stays free** (`meta/agent-etiquette.md` E7). Ambient runs no model
 * turn: a message nobody was addressed by costs nothing, and the assertion for
 * that is on the runner double rather than on a log line, because a log line
 * would not notice a turn that ran.
 *
 * Driven through the real service, the real dispatcher and the real context
 * builder, for the reason `room-context.test.ts` gives.
 */
import { describe, it, expect } from 'vitest';
import { eq, rooms } from '@dorkos/db';
import type { RoomContextData } from '@dorkos/shared/additional-context';
import {
  agentLookupFor,
  createRoomHarness,
  outcomeRunner,
  scriptedRunner,
  type RoomHarness,
} from './room-test-harness.js';

const agents = agentLookupFor({
  '/agents/ana': { name: 'ana', displayName: 'Ana', responseMode: 'mention-only' },
});

/**
 * A channel where Ana answers only when she is named — the mode that makes an
 * unread backlog possible at all, since a turn moves the cursor past the message
 * it answered.
 *
 * @param opts.withAna - Seed Ana onto the roster at creation. `false` leaves her
 *   out so a test can add her partway through the log and pin her joined floor.
 * @param opts.runner - The stand-in for the turn machinery.
 */
function openRoom(
  opts: { withAna?: boolean; runner?: RoomHarness['runner'] } = {}
): RoomHarness & { roomId: string; ana: string } {
  const harness = createRoomHarness({
    agents,
    runner: opts.runner ?? scriptedRunner(() => null),
  });
  const room = harness.service.createRoom(
    {
      kind: 'channel',
      title: 'Backend',
      members: [],
      agentPaths: opts.withAna === false ? [] : ['/agents/ana'],
    },
    harness.human
  );
  const ana = harness.authors.resolveAgent('/agents/ana', 'Ana').id;
  if (opts.withAna !== false) {
    harness.service.updateMembership(room.id, harness.human, ana, 'mention-only');
  }
  return { ...harness, roomId: room.id, ana };
}

describe('the ambient window a room turn is shown', () => {
  /** Post as the person and wait for every turn it sets off. */
  async function say(harness: RoomHarness & { roomId: string }, text: string): Promise<void> {
    harness.service.post(harness.roomId, { authorId: harness.human, text });
    await harness.service.triggersIdle();
  }

  /** The context handed to Ana's nth turn (0-based). */
  function contextAt(harness: RoomHarness, index: number): RoomContextData {
    const turn = harness.runner.turns[index];
    if (!turn) throw new Error(`Ana never took turn ${index}`);
    return turn.roomContext;
  }

  it('starts at the seq the agent joined, never before it', async () => {
    // Edge case 1 of §8.3: a member who joins a channel does not retroactively
    // read what was said before they were in the room, and an agent is a member.
    // The cursor cannot express this — it is 0 for everybody — so the floor is
    // its own column, stamped at join.
    const harness = openRoom({ withAna: false });
    for (let i = 1; i <= 40; i += 1) await say(harness, `m${i}`);

    harness.service.addMember(harness.roomId, harness.human, { agentPath: '/agents/ana' });
    harness.service.updateMembership(harness.roomId, harness.human, harness.ana, 'mention-only');
    expect(harness.store.getMember(harness.roomId, harness.ana)?.joinedSeq).toBe(40);

    for (let i = 41; i <= 49; i += 1) await say(harness, `m${i}`);
    await say(harness, '@ana where are we?');

    const pending = contextAt(harness, 0).pending.map((entry) => entry.text);
    expect(pending).toEqual(['m41', 'm42', 'm43', 'm44', 'm45', 'm46', 'm47', 'm48', 'm49']);
    expect(pending.some((text) => Number(text.slice(1)) <= 40)).toBe(false);
    expect(contextAt(harness, 0).pendingTruncated).toBe(false);
  });

  it('replays at most the room own ambientMaxEntries, and says it dropped some', async () => {
    // Without the cap the first ambient turn after RP3 ships replays every entry
    // in the room, because every agent cursor is 0. Set to 5 rather than left at
    // 30 so the assertion is about the COLUMN and not about a constant that
    // happens to agree with it.
    const harness = openRoom();
    harness.db
      .update(rooms)
      .set({ ambientMaxEntries: 5 })
      .where(eq(rooms.id, harness.roomId))
      .run();
    expect(harness.store.getMember(harness.roomId, harness.ana)?.lastReadSeq).toBe(0);

    for (let i = 1; i <= 99; i += 1) await say(harness, `m${i}`);
    await say(harness, '@ana where are we?');

    const context = contextAt(harness, 0);
    expect(context.pending).toHaveLength(5);
    expect(context.pendingTruncated).toBe(true);
    // The newest survive and the oldest are dropped: what a person just said
    // matters more than what they said ninety messages ago.
    expect(context.pending.map((entry) => entry.text)).toEqual(['m95', 'm96', 'm97', 'm98', 'm99']);
  });

  it('replays nothing at all when the cap is 0', async () => {
    // The setting a person reaches for to say "answer me, do not catch up". It
    // is the one value the obvious `slice(-cap)` gets wrong — `slice(-0)` is
    // `slice(0)`, the whole array — so a room asking for no history got one
    // entry, labelled as a truncation of many.
    const harness = openRoom();
    harness.db
      .update(rooms)
      .set({ ambientMaxEntries: 0 })
      .where(eq(rooms.id, harness.roomId))
      .run();

    await say(harness, 'one');
    await say(harness, 'two');
    await say(harness, '@ana where are we?');

    const context = contextAt(harness, 0);
    expect(context.pending).toEqual([]);
    // Still honest about it: two messages were dropped, and the turn is told.
    expect(context.pendingTruncated).toBe(true);
  });

  it('treats a negative cap as 0 rather than as no cap at all', async () => {
    // SQLite reads a negative LIMIT as UNLIMITED, so the one number that most
    // obviously means "even less than nothing" would have replayed the entire
    // window. Clamped at the read, where the value crosses into SQL.
    const harness = openRoom();
    harness.db
      .update(rooms)
      .set({ ambientMaxEntries: -5 })
      .where(eq(rooms.id, harness.roomId))
      .run();

    for (let i = 1; i <= 20; i += 1) await say(harness, `m${i}`);
    await say(harness, '@ana where are we?');

    expect(contextAt(harness, 0).pending).toEqual([]);
  });

  it('costs no turn when a message addresses nobody', async () => {
    // E7: if an agent is charged for listening, restraint becomes something the
    // product punishes. Asserted on the RUNNER — the stand-in for the model call
    // — because a log assertion would not notice a turn that ran.
    const harness = openRoom();
    await say(harness, 'just thinking out loud');
    await say(harness, 'and again');

    expect(harness.runner.turns).toHaveLength(0);
    // And the ambient entries really are there to be read, so the assertion above
    // is about a turn that did not run rather than a room that stayed empty.
    await say(harness, '@ana still there?');
    expect(contextAt(harness, 0).pending.map((entry) => entry.text)).toEqual([
      'just thinking out loud',
      'and again',
    ]);
  });

  it('does not show the same entry twice on two turns in a row', async () => {
    const harness = openRoom({ runner: outcomeRunner(() => ({ text: 'on it' })) });
    await say(harness, 'one');
    await say(harness, 'two');
    const firstTrigger = harness.service.post(harness.roomId, {
      authorId: harness.human,
      text: '@ana first?',
    });
    await harness.service.triggersIdle();
    // A turn that ANSWERS keeps its claim-time advance — the other half of the
    // refusal rewinds below, and the reason a runner must never throw once the
    // model has spoken (`room-turn-runner.test.ts` holds that end).
    expect(harness.store.getMember(harness.roomId, harness.ana)?.lastReadSeq).toBe(
      firstTrigger.seq
    );
    await say(harness, 'three');
    await say(harness, '@ana second?');

    const first = contextAt(harness, 0).pending.map((entry) => entry.text);
    const second = contextAt(harness, 1).pending.map((entry) => entry.text);
    expect(first).toEqual(['one', 'two']);
    // Not just "three is there": nothing the first turn was shown, and nothing it
    // was shown AS its trigger, comes back.
    expect(second).toEqual(['three']);
    expect(new Set([...first, ...second]).size).toBe(first.length + second.length);
  });

  it('advances the cursor when the turn is CLAIMED, so a turn that ran and failed replays nothing', async () => {
    // The discriminating half of the advance. A cursor moved when the REPLY
    // posts is indistinguishable from one moved at the claim until a turn ends
    // without a reply — and then it shows the agent the same conversation twice.
    //
    // `unanswered: 'failed'` is the outcome where the model RAN: it was handed
    // the window and then the turn broke. It read those messages, so they are
    // spent. (A runner that throws never got that far — see below.)
    const harness = openRoom({
      runner: outcomeRunner(() => ({ text: null, unanswered: 'failed' as const })),
    });
    await say(harness, 'one');
    const trigger = harness.service.post(harness.roomId, {
      authorId: harness.human,
      text: '@ana first?',
    });
    await harness.service.triggersIdle();

    // Nothing was posted on Ana's behalf, and the cursor moved anyway.
    expect(harness.store.getMember(harness.roomId, harness.ana)?.lastReadSeq).toBe(trigger.seq);
    expect(contextAt(harness, 0).pending.map((entry) => entry.text)).toEqual(['one']);

    await say(harness, '@ana second?');
    expect(contextAt(harness, 1).pending).toEqual([]);
  });

  describe('a turn refused before any model ran', () => {
    // THE LOST-DELTA CLASS. The claim advances the cursor on the promise that
    // the turn is about to be SHOWN the backlog. Two paths break that promise
    // after the claim is taken and before a model exists: the session is already
    // being written to, and the runner throwing on the way in. Neither delivered
    // a single message to anybody, so leaving the cursor forward makes the whole
    // backlog permanently invisible — and the refusal notice ("send it again
    // when Ana is free") then invites a message that lands above it.

    it('gives the backlog back when the session was busy', async () => {
      let turns = 0;
      const harness = openRoom({
        runner: outcomeRunner(() => {
          turns += 1;
          return turns === 1 ? { text: null, unanswered: 'busy' as const } : { text: 'on it' };
        }),
      });
      await say(harness, 'one');
      await say(harness, 'two');
      const refused = harness.service.post(harness.roomId, {
        authorId: harness.human,
        text: '@ana first?',
      });
      await harness.service.triggersIdle();

      // Put back exactly where it was, so the room still owes her everything.
      expect(harness.store.getMember(harness.roomId, harness.ana)?.lastReadSeq).toBe(0);
      expect(refused.seq).toBe(3);

      // And on the turn that does run, the backlog is all still there — including
      // the message she was never shown.
      await say(harness, '@ana second?');
      expect(contextAt(harness, 1).pending.map((entry) => entry.text)).toEqual([
        'one',
        'two',
        '@ana first?',
      ]);
    });

    it('gives the backlog back when the runner never started the turn', async () => {
      let turns = 0;
      const harness = openRoom({
        runner: outcomeRunner(() => {
          turns += 1;
          return turns === 1 ? { throws: new Error('the runtime is down') } : { text: 'on it' };
        }),
      });
      await say(harness, 'one');
      await say(harness, 'two');
      await say(harness, '@ana first?');

      expect(harness.store.getMember(harness.roomId, harness.ana)?.lastReadSeq).toBe(0);

      await say(harness, '@ana second?');
      expect(contextAt(harness, 1).pending.map((entry) => entry.text)).toEqual([
        'one',
        'two',
        '@ana first?',
      ]);
    });
  });
});
