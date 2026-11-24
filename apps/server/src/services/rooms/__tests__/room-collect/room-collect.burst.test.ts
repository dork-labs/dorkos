/**
 * room-collect: collecting a burst into one turn, without interrupting or dropping.
 * The suite's full rationale is on `room-collect.fixtures.ts`.
 */
import { describe, it, expect } from 'vitest';
import { formatRoomContext } from '../../../runtimes/shared/room-context-block.js';
import { scriptedRunner, settleUntil } from '../room-test-harness.js';

import {
  ana,
  authors,
  DEBOUNCE_MS,
  human,
  log,
  open,
  room,
  runner,
  service,
} from './room-collect.fixtures.js';

describe('a room gathers a burst into one turn', () => {
  describe('collect, do not interrupt or drop', () => {
    it('turns three posts inside the window into one turn carrying the other two', async () => {
      // **The gaps are the measurement, not a guess**, which is the one place a
      // sleep belongs in this suite. Three posts fired in the same tick would
      // gather under ANY window length, zero included — a sweep is a macrotask
      // whatever it is waiting for — so a test written that way could not tell a
      // working window from an absent one. Real time has to pass between them,
      // and the window is a second wide so the margin is not a race.
      open(scriptedRunner(), { debounceMs: 1_000, maxEntries: 20 });
      const typingPause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 40));

      service.post(room.id, { authorId: human, text: '@ana the build is red' });
      await typingPause();
      service.post(room.id, { authorId: human, text: '@ana it is the migration step' });
      await typingPause();
      service.post(room.id, { authorId: human, text: '@ana can you look?' });
      await service.triggersIdle();

      expect(runner.turns).toHaveLength(1);
      // The newest message is what the turn answers as its own content; the two
      // before it ride the turn as `gathered` — the rest of what this one reply
      // owes an answer to, NOT the ambient background it used to be filed under
      // (DOR-1231).
      expect(runner.turns[0].prompt).toBe('@ana can you look?');
      expect(runner.turns[0].roomContext.gathered?.map((entry) => entry.text)).toEqual([
        '@ana the build is red',
        '@ana it is the migration step',
      ]);
      // And they are in exactly one place: a message under two headings is a
      // message the model can answer twice or discount as background.
      expect(runner.turns[0].roomContext.pending).toEqual([]);
      // One answer, not three.
      expect(log().filter((entry) => entry.kind === 'post' && entry.authorId === ana)).toHaveLength(
        1
      );
    });

    it('puts all three questions in the turn input, as the thing being answered', async () => {
      // **The defect this test exists for (DOR-1231).** Measured on a live room
      // on 2026-08-15: three questions inside one gathering window produced one
      // turn — the collector working — and an answer to the third only
      // ("Wednesday."), with the other two silently dropped. Both were in the
      // turn input the whole time, under "you have not read these yet", which is
      // a heading that says background.
      //
      // Asserted on the RENDERED input, not on the data alone, because the data
      // was never the problem: this pins the whole chain the model sees — the
      // collector gathers, the dispatcher marks, the context partitions, and the
      // block says out loud that every one of them is owed an answer.
      open(scriptedRunner(), { debounceMs: 1_000, maxEntries: 20 });
      const typingPause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 40));

      service.post(room.id, { authorId: human, text: '@ana what is 2+2?' });
      await typingPause();
      service.post(room.id, { authorId: human, text: '@ana name a primary colour' });
      await typingPause();
      service.post(room.id, { authorId: human, text: '@ana what day comes after Tuesday?' });
      await service.triggersIdle();

      expect(runner.turns).toHaveLength(1);
      const turn = runner.turns[0];
      const input = formatRoomContext(turn.roomContext, { nonce: 'aaaa1111' });

      // Every one of the three reaches the model exactly once: two quoted and
      // numbered under the gathered heading, the newest as the turn's own
      // content.
      expect(turn.prompt).toBe('@ana what day comes after Tuesday?');
      const mark = input.indexOf('--- aaaa1111 SENT TO YOU IN THE SAME MOMENT ---');
      expect(mark).toBeGreaterThan(-1);
      // Numbered IN ORDER, oldest first — the ordinal has to name the right
      // line, or the count it lets a model check is a count of nothing.
      expect(input).toMatch(/\(1 of 2 · aaaa1111\)[^\n]*@ana what is 2\+2\?/);
      expect(input).toMatch(/\(2 of 2 · aaaa1111\)[^\n]*@ana name a primary colour/);
      expect(input.indexOf('(1 of 2 · aaaa1111)')).toBeGreaterThan(mark);
      expect(input).not.toContain('@ana what day comes after Tuesday?');

      // And the input SAYS all three are owed an answer, rather than leaving a
      // model to infer it from two lines it was told are context.
      expect(input).toContain(
        '2 more messages arrived here in the same moment as the one you are answering'
      );
      expect(input).toContain('this turn is your ONE reply to all of them');
      expect(input).not.toContain('The message you are answering is outside this block.');
      // Each one is attributed and clock-stamped, so a burst from two people is
      // not one voice.
      expect(input).toMatch(/\(1 of 2 · aaaa1111\) \[\d\d:\d\d\] the operator \(person/);
      expect(input).toMatch(/\(2 of 2 · aaaa1111\) \[\d\d:\d\d\] the operator \(person/);
    });

    it('keeps a gathered question the ambient cap would have dropped', async () => {
      // **The corner the first fix left open.** The gathered messages used to be
      // sliced out of the ambient page, so the room's `ambientMaxEntries` — a
      // number about BACKGROUND — silently decided whether a question the turn
      // was asked reached the model at all. With the default cap of 30, one
      // question, thirty-five other messages and a second question inside one
      // window pushed the first off the front of the page: gone from `gathered`,
      // gone from `pending`, and the block went back to telling the model the
      // only thing it was answering sat outside the fence.
      //
      // The messages between them are the room's own cap-sized chatter, so this
      // is not an exotic setup — it is one person asking twice across a busy
      // minute.
      open(scriptedRunner(), { debounceMs: 1_000, maxEntries: 20 });
      const typingPause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 40));

      service.post(room.id, { authorId: human, text: '@ana what is 2+2?' });
      for (let i = 1; i <= 35; i += 1) {
        service.post(room.id, { authorId: human, text: `chatter ${i}` });
      }
      await typingPause();
      service.post(room.id, { authorId: human, text: '@ana what day is it?' });
      await service.triggersIdle();

      const turn = runner.turns.at(-1);
      expect(turn?.prompt).toBe('@ana what day is it?');
      // The first question is still one of the messages this turn answers, and
      // the block still says so.
      expect(turn?.roomContext.gathered?.map((entry) => entry.text)).toEqual(['@ana what is 2+2?']);
      const input = formatRoomContext(turn!.roomContext, { nonce: 'aaaa1111' });
      expect(input).toMatch(/\(1 of 1 · aaaa1111\)[^\n]*@ana what is 2\+2\?/);
      expect(input).not.toContain('The message you are answering is outside this block.');
      // The background is still capped, and still says it dropped some — the fix
      // widens nothing except the set of messages that were actually asked.
      expect(turn?.roomContext.pending.length).toBeLessThanOrEqual(30);
      expect(turn?.roomContext.pendingTruncated).toBe(true);
      // And the question is in exactly one region, not two.
      expect(turn?.roomContext.pending.map((entry) => entry.text)).not.toContain(
        '@ana what is 2+2?'
      );
    });

    it('starts a second turn for a post that lands after the window closed', async () => {
      open(scriptedRunner(), { debounceMs: DEBOUNCE_MS, maxEntries: 20 });

      service.post(room.id, { authorId: human, text: '@ana the build is red' });
      await service.triggersIdle();
      service.post(room.id, { authorId: human, text: '@ana and now the cache' });
      await service.triggersIdle();

      expect(runner.turns.map((turn) => turn.prompt)).toEqual([
        '@ana the build is red',
        '@ana and now the cache',
      ]);
    });

    it('answers at the cap instead of waiting out the window', async () => {
      // A room that never goes quiet still gets replies: the cap is what stops
      // the gathering window from being a way to never answer. Messages past it
      // start the next turn rather than being dropped.
      open(scriptedRunner(), { debounceMs: 60_000, maxEntries: 3 });

      for (const text of ['one', 'two', 'three', 'four']) {
        service.post(room.id, { authorId: human, text: `@ana ${text}` });
      }
      // A minute-long window, so nothing here can be the timer expiring — the
      // cap is the only thing that can produce a turn.
      await settleUntil(() => runner.turns.length === 1, 'the cap to close the first window');

      expect(runner.turns[0].prompt).toBe('@ana three');
      expect(runner.turns[0].roomContext.gathered?.map((entry) => entry.text)).toEqual([
        '@ana one',
        '@ana two',
      ]);
      // And the fourth is not lost: it is sitting in the next window, which this
      // test deliberately never waits out.
      expect(runner.turns).toHaveLength(1);
    });

    it('covers one message per answer at a cap of one', async () => {
      // The documented floor of `collectMaxEntries`, and the boundary the cap
      // check has to run on CREATION to honour: at one, the FIRST message
      // already fills the batch. Checked only when a collection grew, this
      // setting quietly meant two messages per turn — the opposite of what it
      // says — because the batch had to be joined before it was measured.
      //
      // Both messages land in the same tick and the window is a minute wide, so
      // nothing here can be the timer closing anything: the cap is the only
      // thing that can produce a turn, and it has to produce two.
      open(scriptedRunner(), { debounceMs: 60_000, maxEntries: 1 });

      service.post(room.id, { authorId: human, text: '@ana one' });
      service.post(room.id, { authorId: human, text: '@ana two' });
      await settleUntil(() => runner.turns.length === 2, 'one turn per message');

      expect(runner.turns.map((turn) => turn.prompt)).toEqual(['@ana one', '@ana two']);
      // Each answer covers its own message and gathers nothing behind it — so
      // the field is ABSENT rather than empty, which is what tells a turn that
      // answers one message from one that gathered a burst of one.
      expect(runner.turns.every((turn) => turn.roomContext.gathered === undefined)).toBe(true);
      expect(runner.turns.every((turn) => turn.roomContext.pending.length === 0)).toBe(true);
    });

    it('settles, and loses nothing, when a burst at the cap parks more than one batch', async () => {
      // At a cap of one, three messages in a tick close three batches at once.
      // The first claims and the other two both park — onto the SAME
      // `(room, agent)` key. Parking that overwrote instead of merging dropped
      // the middle batch and the pending turn it was owed, so the room never
      // settled and one message was never anybody's trigger.
      //
      // `triggersIdle()` resolving at all is half of what this measures.
      open(scriptedRunner(), { debounceMs: 60_000, maxEntries: 1 });

      for (const text of ['one', 'two', 'three']) {
        service.post(room.id, { authorId: human, text: `@ana ${text}` });
      }
      await service.triggersIdle();

      // Two turns: the cap says an answer covers one message, and a parked batch
      // that outgrows it keeps the newest.
      expect(runner.turns.map((turn) => turn.prompt)).toEqual(['@ana one', '@ana three']);
      // And the message the cap dropped from the batch is not lost — it is
      // still unread, so it rides the very next turn's window.
      expect(runner.turns[1].roomContext.pending.map((entry) => entry.text)).toEqual(['@ana two']);
    });

    it('gathers per agent, so one burst is one turn each and neither waits for the other', async () => {
      // No arbitration (I1): two agents addressed by the same burst both answer,
      // and the collect window never orders one against the other.
      open(scriptedRunner(), { debounceMs: DEBOUNCE_MS, maxEntries: 20 }, [
        '/agents/ana',
        '/agents/bo',
      ]);
      const bo = authors.resolveAgent('/agents/bo', 'Bo').id;

      service.post(room.id, { authorId: human, text: '@ana @bo the build is red' });
      service.post(room.id, { authorId: human, text: '@ana @bo can you both look?' });
      await service.triggersIdle();

      expect(runner.turns.filter((turn) => turn.authorId === ana)).toHaveLength(1);
      expect(runner.turns.filter((turn) => turn.authorId === bo)).toHaveLength(1);
    });

    it('charges the room for the gathered turn once, not once per message', async () => {
      // The half of this that shows up on a bill. Three messages, one turn, one
      // reservation — a room that charged per message would let two people
      // talking at once burn an hour's automatic turns on one answer.
      open(scriptedRunner(), { debounceMs: DEBOUNCE_MS, maxEntries: 20 });

      for (const text of ['one', 'two', 'three']) {
        service.post(room.id, { authorId: human, text: `@ana ${text}` });
      }
      await service.triggersIdle();
      const afterBurst = runner.turns[0].roomContext.budget.automaticRepliesLeftInThisRoomThisHour;
      // `null` is the limits-off reading, and this harness counts. Narrowed
      // here rather than asserted away, so a regression that stopped counting
      // fails as itself instead of as an arithmetic error below.
      if (afterBurst === null) throw new Error('the room reported no automatic-turn count');

      service.post(room.id, { authorId: human, text: '@ana four' });
      await service.triggersIdle();

      expect(runner.turns).toHaveLength(2);
      expect(runner.turns[1].roomContext.budget.automaticRepliesLeftInThisRoomThisHour).toBe(
        afterBurst - 1
      );
    });

    it('advances the read cursor over the whole gathered window, so nothing repeats', async () => {
      open(scriptedRunner(), { debounceMs: DEBOUNCE_MS, maxEntries: 20 });

      for (const text of ['one', 'two', 'three']) {
        service.post(room.id, { authorId: human, text: `@ana ${text}` });
      }
      await service.triggersIdle();
      service.post(room.id, { authorId: human, text: '@ana four' });
      await service.triggersIdle();

      // The second turn's window starts where the first one's claim left the
      // cursor: past all three of the messages it gathered.
      expect(runner.turns[1].roomContext.pending.map((entry) => entry.text)).not.toContain(
        '@ana one'
      );
      expect(runner.turns[1].roomContext.pending.map((entry) => entry.text)).not.toContain(
        '@ana two'
      );
    });

    it('gathers the chatter an engaged agent hears, and still reports its window', async () => {
      // The engaged window is evaluated PER MESSAGE, before anything is
      // gathered, and the turn carries the reading from the message it answers.
      // Gathering must not lose that: an agent told its window is `null` by the
      // very burst that kept it engaged would have no way to tell being spoken
      // to from overhearing.
      open(scriptedRunner(), { debounceMs: DEBOUNCE_MS, maxEntries: 20 });
      // `engaged` is what a channel seeds, and what these tests otherwise
      // override away from; this is the one scenario about it.
      service.updateMembership(room.id, human, ana, 'engaged');

      service.post(room.id, { authorId: human, text: '@ana can you check the deploy?' });
      await service.triggersIdle();

      // Nobody is named now: these reach Ana only because she is inside her
      // window, and they reach her as ONE turn.
      service.post(room.id, { authorId: human, text: 'the logs are in the ticket' });
      service.post(room.id, { authorId: human, text: 'what do you think?' });
      await service.triggersIdle();

      const ambient = runner.turns.at(-1);
      expect(runner.turns).toHaveLength(2);
      expect(ambient?.prompt).toBe('what do you think?');
      expect(ambient?.roomContext.gathered?.map((entry) => entry.text)).toEqual([
        'the logs are in the ticket',
      ]);
      expect(ambient?.roomContext.addressing.responseMode).toBe('engaged');
      expect(ambient?.roomContext.addressing.engagedUntil).not.toBeNull();
      // And it knows this particular message did not name it, which is the other
      // half of "am I being spoken to".
      expect(ambient?.roomContext.addressing.addressedNow).toBe(false);
    });

    it('gathers inside a thread without reaching for the rest of the channel', async () => {
      // DOR-1207's scope, unchanged by RP8: a thread turn reads its thread. The
      // gathering is per `(room, agent)`, so a burst inside one thread must not
      // be answered with the channel's own messages in `pending`.
      open(scriptedRunner(), { debounceMs: DEBOUNCE_MS, maxEntries: 20 });
      const root = service.post(room.id, { authorId: human, text: 'the release checklist' });
      await service.triggersIdle();

      service.post(room.id, {
        authorId: human,
        text: '@ana step two looks wrong',
        replyTo: root.id,
      });
      service.post(room.id, {
        authorId: human,
        text: '@ana and step four',
        replyTo: root.id,
      });
      await service.triggersIdle();

      const threadTurn = runner.turns.at(-1);
      expect(threadTurn?.prompt).toBe('@ana and step four');
      expect(threadTurn?.roomContext.thread?.rootEntryId).toBe(root.id);
      expect(threadTurn?.roomContext.gathered?.map((entry) => entry.text)).toEqual([
        '@ana step two looks wrong',
      ]);
    });
  });
});
