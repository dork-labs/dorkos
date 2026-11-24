/**
 * room-collect: the guard judges a batch one message at a time, and a mid-turn message steers.
 * The suite's full rationale is on `room-collect.fixtures.ts`.
 */
import { describe, it, expect } from 'vitest';
import { scriptedRunner, settleUntil } from '../room-test-harness.js';

import {
  ana,
  authors,
  DEBOUNCE_MS,
  heldRunner,
  human,
  log,
  notices,
  open,
  postsBy,
  room,
  runner,
  service,
} from './room-collect.fixtures.js';

describe('a room gathers a burst into one turn', () => {
  describe('the guard judges the batch one message at a time', () => {
    it('still answers a parked question when an agent reply joins the batch behind it', async () => {
      // **The defect this exists for.** A person asks Ana something directly
      // while she is mid-turn, so it is parked. Bo then answers the room and
      // names Ana, and that reply joins the same batch. Judged as a batch — one
      // verdict, taken from the newest entry — Bo's reply is vetoed by the
      // ancestry rule and the WHOLE batch went with it: the person's question
      // was discarded, no turn ran for it, and the room said nothing about it.
      //
      // A person's message mints its own cascade root at depth 0, which every
      // rule here allows. That carve-out is the whole point of `deriveCascade`,
      // and aggregating the verdict is exactly how it gets lost.
      const held = heldRunner((request) =>
        request.authorId === ana ? 'looking' : 'no idea — @ana ran that one'
      );
      open(held, { debounceMs: DEBOUNCE_MS, maxEntries: 20 }, ['/agents/ana', '/agents/bo']);
      const bo = authors.resolveAgent('/agents/bo', 'Bo').id;

      // **The ordering is the whole scenario, so it is spelled out.** Bo's reply
      // is ALLOWED when it is collected — Ana has not spoken in that exchange
      // yet, because her turn is still running — and REFUSED when the batch
      // finally runs, because by then that very turn has posted and the
      // ancestry rule can see it. That gap between the two verdicts is exactly
      // what re-asking the guard exists for, and it is what made a batch-level
      // verdict swallow the person's question.
      service.post(room.id, { authorId: human, text: '@ana @bo what broke the build?' });
      await settleUntil(
        () => held.holdsFor(ana) === 1 && held.holdsFor(bo) === 1,
        'both agents mid-turn'
      );

      // The person asks Ana something else. Parked behind her claim, on its own
      // fresh root at depth 0.
      service.post(room.id, { authorId: human, text: '@ana can you also check the cache?' });

      // Bo answers, naming Ana. Ana has still said nothing in that exchange, so
      // the guard lets this into her batch — on top of the person's question.
      held.release(bo);
      await settleUntil(() => postsBy(bo).length === 1, 'Bo answered, naming Ana');

      // Ana's running turn now posts into that same exchange, and only then does
      // her claim release and the batch run.
      held.release(ana);
      await settleUntil(
        () => runner.turns.filter((turn) => turn.authorId === ana).length === 2,
        'the parked question to become a turn of its own'
      );

      // The person's question ran, on its own fresh root, at depth 0 — not Bo's
      // reply, which is the entry the guard actually refused.
      const steered = runner.turns.filter((turn) => turn.authorId === ana)[1];
      expect(steered.prompt).toBe('@ana can you also check the cache?');
      const asked = log().find((entry) => entry.body.text === '@ana can you also check the cache?');
      expect(asked?.cascadeRoot).toBe(asked?.id);
      expect(asked?.cascadeDepth).toBe(0);

      // Bo's refused reply is not consumed by that turn: it sits above the
      // trigger, so it is still unread and still the next turn's to read.
      expect(steered.roomContext.pending.map((entry) => entry.text)).not.toContain(
        'no idea — @ana ran that one'
      );

      // And the refusal was said out loud, once.
      const refusals = notices().filter((entry) => entry.body.notice === 'cascade_stopped');
      expect(refusals).toHaveLength(1);
      expect(refusals[0].body.subjectAuthorId).toBe(ana);
      held.release(ana);
      await service.triggersIdle();
    });

    it('counts the turn that ran while the batch waited, and refuses on the number', async () => {
      // **Why re-asking matters MORE under a counter** (ADR 260823-000217). The
      // verdict a batch was collected under is measured against a count that
      // keeps moving while it waits, so a batch judged once, at collect time,
      // would let an agent through on a number that had since been spent.
      //
      // Ana is allowed two turns here. One is behind her when the third message
      // joins her batch — so the batch is ALLOWED in — and the turn she is
      // running lands its answer, her second, before her claim releases. The
      // re-ask is the only thing standing between that and a third.
      //
      // The count moves by a TURN, which is the DOR-1434 unit: what makes it
      // tick over is Ana's second turn writing at all, not how many entries it
      // writes. A turn that posted five progress notes on the way to the same
      // answer would move it by exactly the same one.
      const held = heldRunner((request) =>
        request.authorId === ana ? 'looking' : 'no idea — @ana ran that one'
      );
      open(held, { debounceMs: DEBOUNCE_MS, maxEntries: 20 }, ['/agents/ana', '/agents/bo'], 2);
      const bo = authors.resolveAgent('/agents/bo', 'Bo').id;

      const seed = service.post(room.id, {
        authorId: human,
        text: '@ana @bo what broke the build?',
      });
      await settleUntil(
        () => held.holdsFor(ana) === 1 && held.holdsFor(bo) === 1,
        'both agents mid-turn'
      );

      // Ana's first turn answers. That is one of her two.
      held.release(ana);
      await settleUntil(() => postsBy(ana).length === 1, 'Ana answered once');

      // Bo answers and names Ana, which is her second turn — allowed, and held.
      held.release(bo);
      await settleUntil(() => held.holdsFor(ana) === 1, 'Ana mid-turn on Bo reply');

      // A third message names her while that turn is still running, so it is
      // collected behind her claim. At collect time she is at one of two.
      service.post(room.id, {
        authorId: bo,
        text: '@ana and the cache too?',
        trigger: { root: seed.cascadeRoot, depth: 1 },
      });

      // Her running turn now lands its answer — her second — and only then does
      // her claim release and the batch run.
      held.release(ana);
      await settleUntil(
        () => notices().some((entry) => entry.body.notice === 'cascade_stopped'),
        'the batch to be judged against the count it waited through'
      );

      // Two turns for Ana, not three, and the room said why.
      expect(runner.turns.filter((turn) => turn.authorId === ana)).toHaveLength(2);
      const refusals = notices().filter((entry) => entry.body.notice === 'cascade_stopped');
      expect(refusals).toHaveLength(1);
      expect(refusals[0].body.subjectAuthorId).toBe(ana);
      await service.triggersIdle();
    });

    it('lets the same batch through when the count has room left', async () => {
      // The control for the test above, and the reason it is not measuring
      // "Ana has spoken": the identical script, one higher ceiling, and the
      // parked message becomes a turn instead of a notice. Without this, a guard
      // that had regressed to refusing any repeat would pass up there.
      const held = heldRunner((request) =>
        request.authorId === ana ? 'looking' : 'no idea — @ana ran that one'
      );
      open(held, { debounceMs: DEBOUNCE_MS, maxEntries: 20 }, ['/agents/ana', '/agents/bo'], 3);
      const bo = authors.resolveAgent('/agents/bo', 'Bo').id;

      const seed = service.post(room.id, {
        authorId: human,
        text: '@ana @bo what broke the build?',
      });
      await settleUntil(
        () => held.holdsFor(ana) === 1 && held.holdsFor(bo) === 1,
        'both agents mid-turn'
      );

      held.release(ana);
      await settleUntil(() => postsBy(ana).length === 1, 'Ana answered once');
      held.release(bo);
      await settleUntil(() => held.holdsFor(ana) === 1, 'Ana mid-turn on Bo reply');
      service.post(room.id, {
        authorId: bo,
        text: '@ana and the cache too?',
        trigger: { root: seed.cascadeRoot, depth: 1 },
      });

      held.release(ana);
      await settleUntil(
        () => runner.turns.filter((turn) => turn.authorId === ana).length === 3,
        'the held batch to become a third turn for Ana'
      );
      expect(notices().filter((entry) => entry.body.notice === 'cascade_stopped')).toEqual([]);
      held.release(ana);
      await service.triggersIdle();
    });

    it('refuses the whole batch, visibly, only when every message in it is refused', async () => {
      // The other side of the rule. Nothing in this batch is a person's fresh
      // question — both entries are agent replies inside an exchange Ana has
      // already spoken in — so there is nothing left to answer and the batch is
      // refused. That refusal is on the log (I3): a batch is not a way to make a
      // refusal quiet.
      const held = heldRunner((request) =>
        request.authorId === ana ? 'looking' : 'no idea — @ana ran that one'
      );
      open(held, { debounceMs: DEBOUNCE_MS, maxEntries: 20 }, ['/agents/ana', '/agents/bo']);
      const bo = authors.resolveAgent('/agents/bo', 'Bo').id;

      service.post(room.id, { authorId: human, text: '@ana @bo what broke the build?' });
      await settleUntil(
        () => held.holdsFor(ana) === 1 && held.holdsFor(bo) === 1,
        'both agents mid-turn'
      );

      // Same ordering as the scenario above, with nothing else in the batch:
      // Bo's reply is collected while it is still allowed, and refused when the
      // batch runs because Ana's own turn has posted into that exchange by then.
      held.release(bo);
      await settleUntil(() => postsBy(bo).length === 1, 'Bo answered, naming Ana');
      held.release(ana);
      await service.triggersIdle();

      // No second turn for Ana — and the room said why.
      expect(runner.turns.filter((turn) => turn.authorId === ana)).toHaveLength(1);
      const refusals = notices().filter((entry) => entry.body.notice === 'cascade_stopped');
      expect(refusals).toHaveLength(1);
      expect(refusals[0].body.subjectAuthorId).toBe(ana);
      expect(refusals[0].body.text).toContain('automatic-reply limit');
    });
  });

  describe('a message that lands mid-turn steers rather than restarting', () => {
    it('A-03: does not cancel the running turn, and runs the held message when the claim goes', async () => {
      const held = heldRunner();
      open(held, { debounceMs: DEBOUNCE_MS, maxEntries: 20 });

      service.post(room.id, { authorId: human, text: '@ana can you check the deploy?' });
      await settleUntil(() => held.holdsFor(ana) === 1, 'Ana mid-turn');

      service.post(room.id, { authorId: human, text: '@ana and the migration?' });
      // The running turn was never interrupted, and no second turn was started
      // beside it.
      expect(held.interrupted).toEqual([]);
      expect(held.holdsFor(ana)).toBe(1);
      expect(runner.turns).toHaveLength(1);

      held.release(ana);
      await settleUntil(() => runner.turns.length === 2, 'the held message to become a turn');
      expect(runner.turns[1].prompt).toBe('@ana and the migration?');
      // Nothing was said about it: it was never refused, so there is nothing to
      // apologise for.
      expect(notices()).toHaveLength(0);
      held.release(ana);
      await service.triggersIdle();
    });

    it('marks the messages behind it as having arrived while the agent was working', async () => {
      const held = heldRunner();
      open(held, { debounceMs: DEBOUNCE_MS, maxEntries: 20 });

      service.post(room.id, { authorId: human, text: '@ana can you check the deploy?' });
      await settleUntil(() => held.holdsFor(ana) === 1, 'Ana mid-turn');

      service.post(room.id, { authorId: human, text: '@ana the logs are in the ticket' });
      service.post(room.id, { authorId: human, text: '@ana what do you think?' });
      held.release(ana);
      await settleUntil(() => runner.turns.length === 2, 'the held messages to become a turn');

      const steered = runner.turns[1];
      expect(steered.prompt).toBe('@ana what do you think?');
      // The mark rides the GATHERED message, which is where it has to be: a
      // message this turn owes an answer to and that landed while the agent was
      // working is both things at once, and the two are separate fields
      // precisely so neither has to stand in for the other.
      expect(steered.roomContext.gathered).toEqual([
        expect.objectContaining({
          text: '@ana the logs are in the ticket',
          arrivedDuringPrevTurn: true,
        }),
      ]);
      held.release(ana);
      await service.triggersIdle();
    });

    it('leaves an ordinary gathered message unmarked, so the signal means something', async () => {
      // The counter-assertion. A flag every line carries is a flag no model
      // reads: only the ones that really did land mid-turn are marked.
      open(scriptedRunner(), { debounceMs: DEBOUNCE_MS, maxEntries: 20 });

      service.post(room.id, { authorId: human, text: '@ana the build is red' });
      service.post(room.id, { authorId: human, text: '@ana can you look?' });
      await service.triggersIdle();

      expect(runner.turns[0].roomContext.gathered?.[0]).toEqual(
        expect.objectContaining({ text: '@ana the build is red' })
      );
      expect(runner.turns[0].roomContext.gathered?.[0].arrivedDuringPrevTurn).toBeUndefined();
    });

    it('never shows an agent a colleague partial text, only that it is working', async () => {
      // I1, and the reason there is no lock here. Ana is mid-turn and has said
      // nothing yet; Bo, addressed by a later message, is told she is working and
      // is told nothing about what she is writing.
      const held = heldRunner();
      open(held, { debounceMs: DEBOUNCE_MS, maxEntries: 20 }, ['/agents/ana', '/agents/bo']);
      const bo = authors.resolveAgent('/agents/bo', 'Bo').id;

      service.post(room.id, { authorId: human, text: '@ana can you check the deploy?' });
      await settleUntil(() => held.holdsFor(ana) === 1, 'Ana mid-turn');
      service.post(room.id, { authorId: human, text: '@bo anything from you?' });
      await settleUntil(
        () => runner.turns.some((turn) => turn.authorId === bo),
        'Bo handed a turn of his own'
      );

      const boTurn = runner.turns.find((turn) => turn.authorId === bo);
      expect(boTurn?.roomContext.working.map((claim) => claim.displayName)).toEqual(['Ana']);
      // A name and a start, and no way to reach anything Ana has typed.
      expect(Object.keys(boTurn?.roomContext.working[0] ?? {}).sort()).toEqual([
        'displayName',
        'handle',
        'since',
      ]);
      // Nothing Ana is writing is in the log yet either.
      expect(log().filter((entry) => entry.authorId === ana)).toHaveLength(0);
      held.release(ana);
      held.release(bo);
      await service.triggersIdle();
    });
  });
});
