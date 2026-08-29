/**
 * What a post tells its writer about who it reached (DOR-786).
 *
 * The room has always decided this synchronously — who a message addresses, and
 * which of them the cascade guard stops — and has always kept the answer to
 * itself, leaving the person who typed it watching a room that never moves.
 * `RoomService.post` now hands the decision back, and `POST /api/rooms/:id/entries`
 * puts it on the 202.
 *
 * Three properties are what these tests are for, and each is about honesty
 * rather than about plumbing:
 *
 * 1. **The summary and the room's own notices are the same decision.** Every
 *    skipped agent here is checked against the notice the room wrote for it, so
 *    the field cannot drift into being a second, quieter story.
 * 2. **It reports only what the write itself decided.** The turn budget is
 *    charged when the collect window closes, which is after this response exists,
 *    so nothing here may claim it.
 * 3. **`triggered` is what the room ASKED FOR, and the room can still refuse.**
 *    A batch is judged again when it runs, so an agent named on the 202 can be
 *    stopped a moment later — and when that happens the room has to SAY so. The
 *    `promises the room has to be able to withdraw` block is that half, and it is
 *    the one an earlier revision of this field got wrong.
 *
 * Driven through the real service and the real dispatcher; only the runner
 * stands in, for the reason `room-silence.test.ts` gives.
 */
import { describe, it, expect } from 'vitest';
import { agents, eq } from '@dorkos/db';
import type { RoomEntry } from '@dorkos/shared/room-schemas';
import { createAgentLookup } from '../index.js';
import {
  agentLookupFor,
  createRoomHarness,
  gatedRunner,
  outcomeRunner,
  scriptedRunner,
  settleUntil,
  type RoomHarness,
} from './room-test-harness.js';

const ANA_PATH = '/agents/ana';
const BO_PATH = '/agents/bo';

/**
 * The ceiling these tests measure against, pinned to a literal for the reason
 * `cascade-guard.test.ts` pins it: a test that read the value the code reads
 * could only ever prove the two agree.
 */
const MAX_AGENT_DEPTH = 3;

const twoAgents = agentLookupFor({
  [ANA_PATH]: { name: 'ana', displayName: 'Ana' },
  [BO_PATH]: { name: 'bo', displayName: 'Bo' },
});

/**
 * A room holding Ana and Bo, both answering everything.
 *
 * `always` rather than the channel's `engaged` default so that who is triggered
 * is a property of the message and never of an engagement window that could have
 * closed — the same steadying `ghost-authors.test.ts` makes for the same reason.
 *
 * @param opts - Harness overrides, chiefly the two cascade ceilings.
 * @returns The harness, the room id, and both agents' author ids.
 */
function openRoom(opts: Parameters<typeof createRoomHarness>[0] = { agents: twoAgents }): {
  harness: RoomHarness;
  roomId: string;
  ana: string;
  bo: string;
} {
  const harness = createRoomHarness(opts);
  const room = harness.service.createRoom(
    { kind: 'channel', title: 'Backend', members: [], agentPaths: [ANA_PATH, BO_PATH] },
    harness.human
  );
  const ana = harness.authors.resolveAgent(ANA_PATH, 'Ana').id;
  const bo = harness.authors.resolveAgent(BO_PATH, 'Bo').id;
  for (const authorId of [ana, bo]) {
    harness.service.updateMembership(room.id, harness.human, authorId, 'always');
  }
  return { harness, roomId: room.id, ana, bo };
}

/** Every notice the room has written, oldest first. */
function notices(harness: RoomHarness, roomId: string): RoomEntry[] {
  return harness.service
    .listEntries(roomId, harness.human, { limit: 100 })
    .filter((entry) => entry.kind === 'notice');
}

describe('what a post says about who it reached', () => {
  it('names every agent a turn is now owed from', async () => {
    const { harness, roomId, ana, bo } = openRoom({
      agents: twoAgents,
      runner: outcomeRunner(() => ({ text: 'on it' })),
    });

    const posted = harness.service.post(roomId, {
      authorId: harness.human,
      text: 'is the build green?',
    });

    // Author refs, not bare ids: the composer draws a name, and looking one up
    // from an id would mean a second read of a roster the server already held.
    expect(posted.dispatch?.triggered.map((author) => author.id).sort()).toEqual([ana, bo].sort());
    expect(posted.dispatch?.triggered.map((author) => author.displayName).sort()).toEqual([
      'Ana',
      'Bo',
    ]);
    expect(posted.dispatch?.skipped).toEqual([]);

    // And the claim is true: both really did take a turn.
    await harness.service.triggersIdle();
    expect(harness.runner.turns.map((turn) => turn.authorId).sort()).toEqual([ana, bo].sort());
  });

  it('says nobody was asked when the message addressed nobody', () => {
    const { harness, roomId, ana, bo } = openRoom();
    // Back to the channel default: `engaged` with no window open selects nobody
    // for an un-addressed post, which is the ordinary quiet case.
    for (const authorId of [ana, bo]) {
      harness.service.updateMembership(roomId, harness.human, authorId, 'mention-only');
    }

    const posted = harness.service.post(roomId, { authorId: harness.human, text: 'morning all' });

    // `[]` and not absent. Absent would mean "this source cannot say", which is
    // a different answer and the one a client must not read as silence.
    expect(posted.dispatch).toEqual({ triggered: [], skipped: [] });
  });

  it('says nothing about a post that could not be dispatched from at all', () => {
    // The one case that is NOT "nobody": dispatching threw, the entry is
    // committed and published regardless, and nothing knows who it reached. The
    // route drops the fields rather than reporting an empty room, because a
    // client reads an absent field as "this source cannot say".
    const { harness, roomId } = openRoom();
    const dispatcher = harness.service as unknown as {
      triggers: { dispatch: () => never };
    };
    dispatcher.triggers.dispatch = () => {
      throw new Error('SQLITE_BUSY');
    };

    const posted = harness.service.post(roomId, { authorId: harness.human, text: 'still here' });

    expect(posted.dispatch).toBeNull();
    // And the message itself landed. Losing the replies to a post is bad and
    // visible in the room; losing the post is worse and looks broken.
    expect(
      harness.service.listEntries(roomId, harness.human, { limit: 10 }).at(-1)?.body.text
    ).toBe('still here');
  });

  it('reports the agent that has already taken its turns in this exchange', async () => {
    const { harness, roomId, ana, bo } = openRoom({
      agents: twoAgents,
      maxAgentDepth: MAX_AGENT_DEPTH,
      maxTurnsPerAgentPerCascade: 1,
      // Bo says nothing, so the only entry in the cascade besides the seed is
      // Ana's — which is what makes her the one the repeat rule counts.
      runner: outcomeRunner((request) =>
        request.authorId === ana ? { text: 'green' } : { text: null }
      ),
    });

    const seed = harness.service.post(roomId, { authorId: harness.human, text: '@ana build?' });
    await settleUntil(
      () =>
        harness.service
          .listEntries(roomId, harness.human, { limit: 50 })
          .some((entry) => entry.authorId === ana && entry.kind === 'post'),
      'Ana answered'
    );
    await harness.service.triggersIdle();

    // Bo replies INSIDE that exchange — the shape a real agent reply has, with
    // the turn's own cascade carried explicitly. Ana has spent her one turn in
    // it, so she is the one the repeat rule stops.
    const reply = harness.service.post(roomId, {
      authorId: bo,
      text: 'what does @ana think?',
      trigger: { root: seed.cascadeRoot, depth: 1, dispatchId: 'dispatch-bo' },
    });

    expect(reply.dispatch?.skipped).toEqual([{ authorId: ana, reason: 'repeat' }]);
    expect(reply.dispatch?.triggered).toEqual([]);
    // The same decision the room wrote down, rather than a second story about it.
    // One code covers both cascade rules; the subject is what says who. The
    // reason lives in the summary, which is the finer answer of the two.
    expect(notices(harness, roomId).at(-1)?.body.notice).toBe('cascade_stopped');
    expect(notices(harness, roomId).at(-1)?.body.subjectAuthorId).toBe(ana);
  });

  it('reports the exchange that has run as deep as the room allows', () => {
    const { harness, roomId, ana, bo } = openRoom({
      agents: twoAgents,
      maxAgentDepth: MAX_AGENT_DEPTH,
      // High enough that the repeat rule cannot be what fires: this test is
      // about the OTHER ceiling, and a shared refusal would prove neither.
      maxTurnsPerAgentPerCascade: 99,
      runner: scriptedRunner(),
    });

    const seed = harness.service.post(roomId, { authorId: harness.human, text: 'kick it off' });
    const reply = harness.service.post(roomId, {
      authorId: bo,
      text: 'still going, @ana?',
      trigger: { root: seed.cascadeRoot, depth: MAX_AGENT_DEPTH, dispatchId: 'dispatch-bo' },
    });

    expect(reply.dispatch?.skipped).toEqual([{ authorId: ana, reason: 'depth' }]);
    expect(notices(harness, roomId).at(-1)?.body.notice).toBe('cascade_stopped');
    expect(notices(harness, roomId).at(-1)?.body.subjectAuthorId).toBe(ana);
  });

  it('reports an agent whose directory no longer holds it', async () => {
    // The shipped lookup over real `agents` rows, like `ghost-authors.test.ts`:
    // the whole content of this refusal is "does this directory hold this
    // agent", and a fixture answering that by hand would only prove the fixture.
    const harness = createRoomHarness({ agents: (db) => createAgentLookup(db) });
    const now = new Date().toISOString();
    harness.db
      .insert(agents)
      .values({
        id: 'ULID_ANA',
        name: 'ana',
        runtime: 'claude-code',
        projectPath: ANA_PATH,
        registeredAt: now,
        updatedAt: now,
      })
      .run();
    const room = harness.service.createRoom(
      { kind: 'channel', title: 'Backend', members: [], agentPaths: [ANA_PATH] },
      harness.human
    );
    const ana = harness.authors.resolveAgent(ANA_PATH, 'ana').id;
    harness.service.updateMembership(room.id, harness.human, ana, 'always');
    harness.db.delete(agents).where(eq(agents.projectPath, ANA_PATH)).run();

    const posted = harness.service.post(room.id, {
      authorId: harness.human,
      text: 'anyone about?',
    });

    expect(posted.dispatch?.triggered).toEqual([]);
    expect(posted.dispatch?.skipped).toEqual([{ authorId: ana, reason: 'gone' }]);
    await settleUntil(
      () => notices(harness, room.id).some((entry) => entry.body.notice === 'agent_gone'),
      'the room said the agent is gone'
    );
    // One row, one notice. A member that is both a named mention and a selected
    // target is one thing that went wrong, not two.
    expect(posted.dispatch?.skipped).toHaveLength(1);
  });

  it('reports a named ghost ONCE, as gone, even when the guard also stopped it', async () => {
    // The intersection `withGone` is written around: an author reached from both
    // directions at once. Ana is a ghost — her `agents` row is deleted, so she is
    // `namedUnreachable` — AND `always`, so she is a selected target — AND the
    // exchange is at its depth ceiling, so the guard refuses her too.
    //
    // One row, and it says `gone`. That is the deeper fact (an agent that is not
    // there cannot answer whatever the guard thought) and it is the one the room
    // itself writes down. Two rows, or a row saying `depth`, would put the 202
    // and the log at odds about what went wrong.
    const harness = createRoomHarness({ agents: (db) => createAgentLookup(db) });
    const now = new Date().toISOString();
    for (const [id, projectPath, name] of [
      ['ULID_ANA', ANA_PATH, 'ana'],
      ['ULID_BO', BO_PATH, 'bo'],
    ] as const) {
      harness.db
        .insert(agents)
        .values({
          id,
          name,
          runtime: 'claude-code',
          projectPath,
          registeredAt: now,
          updatedAt: now,
        })
        .run();
    }
    const room = harness.service.createRoom(
      { kind: 'channel', title: 'Backend', members: [], agentPaths: [ANA_PATH, BO_PATH] },
      harness.human
    );
    const ana = harness.authors.resolveAgent(ANA_PATH, 'ana');
    const bo = harness.authors.resolveAgent(BO_PATH, 'bo');
    harness.service.updateMembership(room.id, harness.human, ana.id, 'always');
    // Read BEFORE the row is deleted: a ghost is offered no handle, which is the
    // mechanism itself — but the name still resolves through the unreachable
    // half of the roster, which is what puts her in `namedUnreachable`.
    const anaHandle = ana.handle!;
    harness.db.delete(agents).where(eq(agents.projectPath, ANA_PATH)).run();

    const seed = harness.service.post(room.id, { authorId: harness.human, text: 'kick it off' });
    const reply = harness.service.post(room.id, {
      authorId: bo.id,
      text: `still going, @${anaHandle}?`,
      trigger: { root: seed.cascadeRoot, depth: MAX_AGENT_DEPTH, dispatchId: 'dispatch-bo' },
    });

    expect(reply.dispatch?.skipped).toEqual([{ authorId: ana.id, reason: 'gone' }]);
    await settleUntil(
      () => notices(harness, room.id).some((entry) => entry.body.notice === 'agent_gone'),
      'the room said the agent is gone'
    );
    // And exactly one line about her, not one per rule she tripped.
    const aboutAna = notices(harness, room.id).filter(
      (entry) => entry.body.subjectAuthorId === ana.id
    );
    expect(aboutAna.map((entry) => entry.body.notice)).toEqual(['agent_gone']);
  });

  describe('promises the room has to be able to withdraw', () => {
    it('re-checks the limits when the batch runs, and SAYS so when it refuses', async () => {
      // **The 202 names agents the room can still turn away**, and this is the
      // ordinary path to it rather than an exotic one. Ana is mid-turn, so Bo's
      // reply is gathered rather than run; by the time that batch comes round,
      // Ana's own answer has landed in the cascade and spent her one turn in it,
      // and `chooseTrigger` re-asks the guard and refuses her.
      //
      // Both halves are pinned together on purpose. The field said "triggered:
      // Ana" and that was TRUE — the room asked her. What must never happen is
      // the field being the last word: the refusal has to reach the reader as a
      // notice, or a person is left watching a room that accepted their message
      // and then quietly did nothing.
      const runner = gatedRunner();
      const { harness, roomId, ana, bo } = openRoom({
        agents: twoAgents,
        maxAgentDepth: MAX_AGENT_DEPTH,
        maxTurnsPerAgentPerCascade: 1,
        runner,
      });
      // `mention-only` so who runs is a property of the MESSAGE rather than of an
      // engagement window — the same steadying `room-silence.test.ts` makes. With
      // the room's `always` default both agents answer everything and a scenario
      // about one agent's ceiling would measure two.
      for (const authorId of [ana, bo]) {
        harness.service.updateMembership(roomId, harness.human, authorId, 'mention-only');
      }

      const seed = harness.service.post(roomId, { authorId: harness.human, text: '@ana build?' });
      expect(seed.dispatch?.triggered.map((author) => author.id)).toEqual([ana]);
      await settleUntil(() => runner.holdsFor(ana) === 1, 'Ana to take her turn');

      // Bo replies inside that same exchange while Ana is still working. Ana has
      // spent nothing yet, so the guard allows her here — and says so on the 202.
      const reply = harness.service.post(roomId, {
        authorId: bo,
        text: 'what does @ana think?',
        trigger: { root: seed.cascadeRoot, depth: 1, dispatchId: 'dispatch-bo' },
      });
      expect(reply.dispatch?.triggered.map((author) => author.id)).toEqual([ana]);
      expect(reply.dispatch?.skipped).toEqual([]);

      // Ana finishes. Her answer carries her dispatch id into the cascade, so
      // her count reaches the cap — and the batch waiting behind her is judged
      // against that.
      runner.releaseAll();
      await harness.service.triggersIdle();

      // The room said what it did. This assertion is the whole point of the
      // test: the accept-time answer was superseded, and the reader can see it.
      const aboutAna = notices(harness, roomId).filter(
        (entry) => entry.body.subjectAuthorId === ana
      );
      expect(aboutAna.map((entry) => entry.body.notice)).toContain('cascade_stopped');
      // And she really did not answer Bo — one turn, the one she was already in.
      expect(runner.turns.filter((turn) => turn.authorId === ana)).toHaveLength(1);
    });

    it('says an agent left the room, rather than dropping the turn it promised', async () => {
      // The other way a promise is withdrawn, and until DOR-786 it was withdrawn
      // in silence: the batch is dropped when it comes round, which wrote a log
      // line and nothing else. From inside the room, a message the product had
      // ACCEPTED — and answered with `triggered: [Ana]` — simply never got a
      // reply.
      const runner = gatedRunner();
      const { harness, roomId, ana, bo } = openRoom({ agents: twoAgents, runner });
      // `mention-only` so who runs is a property of the MESSAGE rather than of an
      // engagement window — the same steadying `room-silence.test.ts` makes. With
      // the room's `always` default both agents answer everything and a scenario
      // about one agent's ceiling would measure two.
      for (const authorId of [ana, bo]) {
        harness.service.updateMembership(roomId, harness.human, authorId, 'mention-only');
      }

      harness.service.post(roomId, { authorId: harness.human, text: '@bo start something' });
      await settleUntil(() => runner.holdsFor(bo) === 1, 'Bo to take a turn');

      // Ana is asked while Bo works. Her agent shares no checkout with Bo, so
      // what parks her batch is the collect window, not a hold — either way the
      // turn is owed and not yet running when she is taken out of the room.
      const posted = harness.service.post(roomId, {
        authorId: harness.human,
        text: '@ana can you look too?',
      });
      expect(posted.dispatch?.triggered.map((author) => author.id)).toEqual([ana]);

      harness.service.removeMember(roomId, harness.human, ana);
      runner.releaseAll();
      await harness.service.triggersIdle();

      const aboutAna = notices(harness, roomId).filter(
        (entry) => entry.body.subjectAuthorId === ana
      );
      expect(aboutAna.map((entry) => entry.body.notice)).toContain('agent_left');
      // Its own code, not `agent_gone`: the agent is fine and still registered,
      // it is only not in this room any more, so the remedy is different.
      expect(aboutAna.map((entry) => entry.body.notice)).not.toContain('agent_gone');
      expect(runner.turns.filter((turn) => turn.authorId === ana)).toHaveLength(0);
    });
  });

  it('never reports a budget refusal, because the budget has not been asked yet', async () => {
    // The bound this whole field lives inside. A room with no automatic turns
    // left still ACCEPTS the message and still triggers selection — the spend is
    // charged when the collect window closes, which is a macrotask after this
    // response was built. Reporting it here would be a guess, and the honest
    // answer is that the agent was asked and the room's own notice says what
    // happened next.
    const { harness, roomId, ana, bo } = openRoom({
      agents: twoAgents,
      maxAutomaticTurnsPerRoomPerHour: 0,
      runner: outcomeRunner(() => ({ text: 'on it' })),
    });

    const posted = harness.service.post(roomId, { authorId: harness.human, text: 'anyone free?' });

    expect(posted.dispatch?.triggered.map((author) => author.id).sort()).toEqual([ana, bo].sort());
    expect(posted.dispatch?.skipped).toEqual([]);

    await harness.service.triggersIdle();
    // Nothing ran, and the room said why — on the log, where a refusal that
    // happens after the 202 belongs.
    expect(harness.runner.turns).toHaveLength(0);
    expect(notices(harness, roomId).map((entry) => entry.body.notice)).toContain('budget_reached');
  });
});
