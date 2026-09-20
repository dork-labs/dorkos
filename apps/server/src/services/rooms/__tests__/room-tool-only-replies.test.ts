/**
 * How a room turn is delivered: its text is never the room's message, so it
 * posts through the tool, reacts, or is silent (spec `tool-only-room-replies`,
 * acceptance criteria 1–10 and 13–14; graduated by DOR-2099).
 *
 * Driven through the real service and the real dispatcher, like every other
 * behaviour test in this suite: only the runner stands in, because the
 * alternative is a model call. A scripted turn speaks the way a real one does —
 * by calling `post_to_room` mid-flight — so a test here cannot assert a
 * behaviour while the mechanism it rests on goes unexercised.
 *
 * There was briefly a second delivery, chosen per turn by a config flag and a
 * runtime's own answer about tool capability. Both are gone; the cases that
 * measured the other side went with them, and what is left is the one path.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  RoomEntry,
  RoomEvent,
  RoomSignalEvent,
  RoomWithRoster,
} from '@dorkos/shared/room-schemas';
import type { AuthorRegistry } from '../author-registry.js';
import type { RoomService } from '../room-service.js';
import type { RoomStore } from '../room-store.js';
import type { RoomError } from '../room-errors.js';
import {
  agentLookupFor,
  createRoomHarness,
  outcomeRunner,
  type ScriptedTurnRunner,
} from './room-test-harness.js';

/** The agents these rooms are built from. */
const agents = agentLookupFor({
  '/agents/ana': { name: 'ana', displayName: 'Ana', responseMode: 'always' },
  '/agents/bo': { name: 'bo', displayName: 'Bo', responseMode: 'always' },
});

describe('a room turn that speaks only through the tool', () => {
  let service: RoomService;
  let authors: AuthorRegistry;
  let store: RoomStore;
  let runner: ScriptedTurnRunner;
  let room: RoomWithRoster;
  let ana: string;
  let human: string;
  /** Every event this room's stream carried, entries and signals alike. */
  let published: RoomEvent[];

  /**
   * Wire a channel around `scripted`, with Ana answering everything.
   *
   * @param scripted - The runner standing in for the turn machinery.
   * @param maxPostsPerTurn - The per-turn post ceiling, when a test moves it.
   */
  function open(scripted: ScriptedTurnRunner, maxPostsPerTurn?: number): void {
    ({ service, authors, store, runner, human } = createRoomHarness({
      agents,
      runner: scripted,
      ...(maxPostsPerTurn !== undefined ? { maxPostsPerTurn } : {}),
    }));
    // Recorded at the broadcaster — the one seam every entry and every signal
    // passes through, so a presence frame is observable without a subscriber
    // racing the turn. Same shape `room-presence-claims.test.ts` uses.
    published = [];
    const broadcaster = service.stream;
    const deliver = broadcaster.publish.bind(broadcaster);
    vi.spyOn(broadcaster, 'publish').mockImplementation((roomId, event) => {
      published.push(event);
      deliver(roomId, event);
    });
    room = service.createRoom(
      { kind: 'channel', title: 'Backend', members: [], agentPaths: ['/agents/ana'] },
      human
    );
    ana = authors.resolveAgent('/agents/ana', 'Ana').id;
    service.updateMembership(room.id, human, ana, 'always');
  }

  /** Post as the human and wait for every turn it set off. */
  async function seedAndSettle(text = '@ana is the build green?'): Promise<RoomEntry> {
    const seed = service.post(room.id, { authorId: human, text });
    await service.triggersIdle();
    return seed;
  }

  /** Every entry in the room, oldest first. */
  function log(): RoomEntry[] {
    return service.listEntries(room.id, human, { limit: 200 });
  }

  /** Posts by one author. */
  function postsBy(authorId: string): RoomEntry[] {
    return log().filter((entry) => entry.kind === 'post' && entry.authorId === authorId);
  }

  /** The notices — the room speaking in its own voice. */
  function notices(): RoomEntry[] {
    return log().filter((entry) => entry.kind === 'notice');
  }

  /**
   * A runner whose turn posts through the tool mid-flight and then narrates.
   *
   * The order is the production one: an agent calls `post_to_room` while it
   * works, and whatever it writes back to its session lands at the end.
   *
   * @param narration - What the turn says back to its own session, or `null`.
   * @param posts - How many times the turn posts through the tool.
   */
  function toolPosting(narration: string | null, posts = 1): ScriptedTurnRunner {
    return outcomeRunner((request) => {
      for (let i = 0; i < posts; i += 1) {
        service.postFromTool(request.room.id, {
          authorId: request.authorId,
          text: `deliberate ${i + 1}`,
        });
      }
      return { text: narration };
    });
  }

  describe('AC 2 — it posted through the tool AND narrated', () => {
    it('lands exactly one entry, and it is the tool’s text', async () => {
      open(toolPosting('I posted the answer.'));
      await seedAndSettle();

      const said = postsBy(ana);
      expect(said).toHaveLength(1);
      expect(said[0].body.text).toBe('deliberate 1');
      expect(said[0].body.text).not.toContain('I posted the answer.');
    });

    it('writes no `agent_declined`, because the room heard from it', async () => {
      open(toolPosting('I posted the answer.'));
      await seedAndSettle();

      expect(notices()).toHaveLength(0);
    });
  });

  describe('AC 3 — it narrated without calling the tool', () => {
    it('lands no entry at all', async () => {
      open(outcomeRunner(() => ({ text: 'here is what I think' })));
      await seedAndSettle();

      expect(postsBy(ana)).toHaveLength(0);
    });
  });

  describe('AC 4 — a person asked and got nothing', () => {
    it('writes exactly one `agent_declined`, in the room’s own voice', async () => {
      open(outcomeRunner(() => ({ text: null })));
      await seedAndSettle();

      expect(notices()).toHaveLength(1);
      expect(notices()[0].body.notice).toBe('agent_declined');
      expect(notices()[0].body.subjectAuthorId).toBe(ana);
      expect(notices()[0].authorId).toBe(authors.system().id);
      expect(notices()[0].body.text).toBe('Ana read this and did not reply.');
    });

    it('speaks again for a NEW question — the damping is per cascade, not forever', async () => {
      // **The bug this replaced was a notice that never expired.** Keyed on
      // `(room, agent)` with no cascade and nothing to clear it, a person who
      // asked on Tuesday, got one line, and asked something else entirely on
      // Wednesday got SILENCE — the dead air E1 and this notice exist to
      // prevent, and the inverse of `reportSilence`'s own rule that a direct
      // question is never damped.
      //
      // Every message a person types starts its own cascade, so the count is
      // bounded by their own typing: one line per question they wrote, and
      // nothing an agent does can inflate it.
      open(outcomeRunner(() => ({ text: null })));

      await seedAndSettle('@ana are you there?');
      expect(notices()).toHaveLength(1);

      await seedAndSettle('@ana different question entirely');
      expect(notices()).toHaveLength(2);

      const roots = notices().map((entry) => entry.cascadeRoot);
      expect(new Set(roots).size, 'both lines belong to the same exchange').toBe(2);
    });

    it('says it once for one question, however many times that question names it', async () => {
      // The guard the cascade key is actually for. It damps nothing reachable
      // today — one entry produces one dispatch per agent and `deliver` runs
      // once per turn — so this asserts the OUTCOME rather than the mechanism:
      // one message naming the agent three times is one exchange and earns one
      // line, whether that comes from the key or from there being one turn.
      open(outcomeRunner(() => ({ text: null })));

      await seedAndSettle('@ana @ana @ana are you there?');
      expect(notices()).toHaveLength(1);
    });

    it('is not cleared by `recovered`, which every declined turn calls on its way past', async () => {
      // The trap the first implementation fell into. `deliver` calls
      // `notices.recovered` at step 3 and `reportDeclined` at step 6 of the SAME
      // call, so a key `recovered` could clear would be cleared by the very turn
      // that set it. The declined memory is its own set for that reason, and this
      // is what would catch it being folded back into `noticedSilence`: a busy
      // refusal after a decline must still be shown, and the decline must not be
      // re-armed inside its own cascade.
      let refuse = false;
      open(
        outcomeRunner(() => (refuse ? { text: null, unanswered: 'busy' as const } : { text: null }))
      );

      await seedAndSettle('@ana are you there?');
      expect(notices().map((n) => n.body.notice)).toEqual(['agent_declined']);

      refuse = true;
      await seedAndSettle('@ana anyone home?');
      expect(notices().map((n) => n.body.notice)).toEqual(['agent_declined', 'agent_busy']);
    });
  });

  describe('AC 5 — nobody asked, and the turn produced nothing', () => {
    it('writes zero entries and zero notices', async () => {
      open(outcomeRunner(() => ({ text: null })));
      // Ambient: a person's message that does NOT name Ana. She answers because
      // her mode is `always`, which is exactly the case E7 says must stay free.
      await seedAndSettle('the deploy finished');

      expect(postsBy(ana)).toHaveLength(0);
      expect(notices()).toHaveLength(0);
    });

    it('and the claim is released, so the room shows nobody working', async () => {
      open(outcomeRunner(() => ({ text: null })));
      await seedAndSettle('the deploy finished');

      expect(service.getRoom(room.id, human)?.workingAgents ?? []).toHaveLength(0);
    });
  });

  describe('AC 6 / AC 7 — a reaction is an answer, unless it was refused', () => {
    it('a reaction-only turn writes no `agent_declined`', async () => {
      let seedId = '';
      open(
        outcomeRunner((request) => {
          service.toggleReaction(request.room.id, seedId, request.authorId, '✅');
          return { text: null };
        })
      );
      const seed = service.post(room.id, { authorId: human, text: '@ana just ack this' });
      seedId = seed.id;
      await service.triggersIdle();

      expect(notices()).toHaveLength(0);
      expect(postsBy(ana)).toHaveLength(0);
      expect(service.reactionsFor(room.id, seed.id)).toHaveLength(1);
    });

    it('a reaction the hourly budget refused does NOT buy silence', async () => {
      // The refusal throws, so the mark is never set — which is the whole reason
      // it is written after the reaction lands rather than before.
      let seedId = '';
      open(
        outcomeRunner((request) => {
          try {
            service.toggleReaction(request.room.id, seedId, request.authorId, '✅');
          } catch {
            // The budget said no. Nothing reached anybody.
          }
          return { text: null };
        })
      );
      // Spend Ana's whole hourly allowance BEFORE the turn runs, so the turn's
      // reaction is the one that is refused rather than racing the fillers.
      const filler = service.post(room.id, { authorId: human, text: 'nothing to see' });
      for (let i = 0; i < 20; i += 1) {
        service.toggleReaction(room.id, filler.id, ana, ['👀', '✅', '👍', '🎉', '🚀'][i % 5]!);
        service.toggleReaction(
          room.id,
          filler.id,
          ana,
          ['👀', '✅', '👍', '🎉', '🚀'][i % 5]!,
          false
        );
      }
      await service.triggersIdle();
      const seed = service.post(room.id, { authorId: human, text: '@ana just ack this' });
      seedId = seed.id;
      await service.triggersIdle();

      expect(service.reactionsFor(room.id, seed.id)).toHaveLength(0);
      expect(notices().filter((n) => n.body.notice === 'agent_declined')).toHaveLength(1);
    });

    it('taking a reaction BACK is not an answer either', async () => {
      // A retraction leaves the entry with nothing on it. The room shows nothing,
      // so nothing has been said.
      let seedId = '';
      let turn = 0;
      open(
        outcomeRunner((request) => {
          turn += 1;
          // First turn adds, second turn removes.
          service.toggleReaction(request.room.id, seedId, request.authorId, '✅', turn === 1);
          return { text: null };
        })
      );
      const seed = service.post(room.id, { authorId: human, text: '@ana just ack this' });
      seedId = seed.id;
      await service.triggersIdle();
      expect(notices()).toHaveLength(0);

      await seedAndSettle('@ana actually never mind');
      expect(service.reactionsFor(room.id, seed.id)).toHaveLength(0);
      expect(notices().filter((n) => n.body.notice === 'agent_declined')).toHaveLength(1);
    });
  });

  describe('AC 8 — a direct message is an ordinary room for the posting tool', () => {
    /** Open a DM between the owner and Ana. */
    function openDm(scripted: ScriptedTurnRunner): RoomWithRoster {
      ({ service, authors, store, runner, human } = createRoomHarness({
        agents,
        runner: scripted,
      }));
      ana = authors.resolveAgent('/agents/ana', 'Ana').id;
      return service.createRoom(
        { kind: 'dm', title: 'Ana', members: [], agentPaths: ['/agents/ana'] },
        human
      );
    }

    it('a turn may post in a DM', async () => {
      const scripted = outcomeRunner((request) => {
        service.postFromTool(request.room.id, {
          authorId: request.authorId,
          text: 'answering in the DM',
        });
        return { text: null };
      });
      const dm = openDm(scripted);
      service.post(dm.id, { authorId: human, text: 'are you there?' });
      await service.triggersIdle();

      const said = service
        .listEntries(dm.id, human, { limit: 50 })
        .filter((entry) => entry.kind === 'post' && entry.authorId === ana);
      expect(said).toHaveLength(1);
      expect(said[0].body.text).toBe('answering in the DM');
    });

    it('a post with no turn behind it lands in a DM too', () => {
      // **The reversal is complete, and the refusal is not conditioned on
      // anything** (spec §A2, completing D3). It used to depend on the reply
      // mode carried by the live claim, so a hand post with nothing in flight
      // read `undefined` and fell back to refusing. There is no mode to read and
      // nothing to fall back to: an agent writing into a DM it is a member of is
      // an agent saying something to the person who wrote to it.
      const dm = openDm(outcomeRunner(() => ({ text: null })));
      const entry = service.postFromTool(dm.id, { authorId: ana, text: 'unbidden' });
      expect(entry.body.text).toBe('unbidden');
    });
  });

  describe('AC 9 — an agent’s tool post into a DM triggers nobody', () => {
    it('selects no targets, so no second turn runs', async () => {
      let turns = 0;
      const scripted = outcomeRunner((request) => {
        turns += 1;
        service.postFromTool(request.room.id, {
          authorId: request.authorId,
          text: 'answering in the DM',
        });
        return { text: null };
      });
      ({ service, authors, store, runner, human } = createRoomHarness({
        agents,
        runner: scripted,
      }));
      ana = authors.resolveAgent('/agents/ana', 'Ana').id;
      const dm = service.createRoom(
        { kind: 'dm', title: 'Ana', members: [], agentPaths: ['/agents/ana'] },
        human
      );
      service.post(dm.id, { authorId: human, text: 'are you there?' });
      await service.triggersIdle();

      // One turn for the person's message, and nothing for the agent's own post:
      // outside a channel an agent addresses only whom it NAMES (ADR
      // 260814-025326), and the human is filtered by kind anyway.
      expect(turns).toBe(1);
    });
  });

  describe('AC 10 — a mid-turn tool post carries the turn’s own cascade stamp', () => {
    it('stamps the same depth the turn’s own answer would have', async () => {
      open(toolPosting(null));
      const seed = await seedAndSettle();

      const said = postsBy(ana);
      expect(said).toHaveLength(1);
      expect(said[0].cascadeRoot).toBe(seed.cascadeRoot);
      expect(said[0].cascadeDepth).toBe(seed.cascadeDepth + 1);
    });
  });

  describe('AC 13 — a tool post carries its answer pointer and its session', () => {
    it('fills both from the live claim', async () => {
      open(toolPosting(null));
      const seed = await seedAndSettle();

      const said = postsBy(ana)[0];
      expect(said.body.answersEntryId).toBe(seed.id);
      expect(said.sessionId).not.toBeNull();
      // The id the runner actually ran on, not the placeholder the room bound
      // before the turn started.
      expect(said.sessionId).toBe(store.getRoomSession(room.id, ana));
    });

    it('and a post with no turn behind it carries neither', () => {
      open(outcomeRunner(() => ({ text: null })));
      const channel = service.createRoom(
        { kind: 'channel', title: 'Ops', members: [], agentPaths: ['/agents/ana'] },
        human
      );
      const posted = service.postFromTool(channel.id, { authorId: ana, text: 'unbidden' });

      expect(posted.body.answersEntryId).toBeUndefined();
      expect(posted.sessionId).toBeNull();
    });
  });

  describe('AC 14 — the per-turn post ceiling', () => {
    it('refuses the fourth post at the shipped default', async () => {
      let refused: RoomError | undefined;
      open(
        outcomeRunner((request) => {
          for (let i = 0; i < 4; i += 1) {
            try {
              service.postFromTool(request.room.id, {
                authorId: request.authorId,
                text: `note ${i + 1}`,
              });
            } catch (err) {
              refused = err as RoomError;
            }
          }
          return { text: null };
        })
      );
      await seedAndSettle();

      expect(postsBy(ana)).toHaveLength(3);
      expect(refused?.code).toBe('TOO_MANY_POSTS_THIS_TURN');
      expect(refused?.message).toContain('Consolidate');
    });

    it('reads the CONFIGURED value, not a constant — 5 lets five through and refuses the sixth', async () => {
      // **Both halves, because either one alone is satisfiable by a bug.** That
      // five land proves the ceiling is not pinned at the default of 3; that the
      // SIXTH is refused proves there is still a ceiling at all. A case that only
      // counted the five would pass just as happily against a build that had
      // stopped counting — which is the mutation most likely to be made here,
      // since removing the check is how somebody "fixes" a refusal they did not
      // expect.
      let refusal: RoomError | undefined;
      open(
        outcomeRunner((request) => {
          for (let i = 0; i < 6; i += 1) {
            try {
              service.postFromTool(request.room.id, {
                authorId: request.authorId,
                text: `note ${i + 1}`,
              });
            } catch (err) {
              refusal = err as RoomError;
            }
          }
          return { text: null };
        }),
        5
      );
      await seedAndSettle();

      expect(postsBy(ana)).toHaveLength(5);
      expect(refusal?.code).toBe('TOO_MANY_POSTS_THIS_TURN');
      // The refusal names the configured number rather than the default, so an
      // agent reading it is told the bound it actually hit.
      expect(refusal?.message).toContain('5');
    });

    it('starts over on the next turn', async () => {
      open(
        outcomeRunner((request) => {
          for (let i = 0; i < 3; i += 1) {
            service.postFromTool(request.room.id, {
              authorId: request.authorId,
              text: `note ${i + 1}`,
            });
          }
          return { text: null };
        })
      );
      await seedAndSettle('@ana first');
      await seedAndSettle('@ana second');

      expect(postsBy(ana)).toHaveLength(6);
    });

    it('does not bound a post made with no turn behind it', () => {
      // `postsThisTurn` is `undefined` rather than zero there, and the difference
      // is deliberate: such a post already costs a turn against the cascade
      // budget on its own, so there is no per-turn ceiling to apply.
      open(
        outcomeRunner(() => ({ text: null })),
        1
      );
      const channel = service.createRoom(
        { kind: 'channel', title: 'Ops', members: [], agentPaths: ['/agents/ana'] },
        human
      );
      for (let i = 0; i < 4; i += 1) {
        service.postFromTool(channel.id, { authorId: ana, text: `unbidden ${i}` });
      }
      expect(
        service
          .listEntries(channel.id, human, { limit: 50 })
          .filter((entry) => entry.kind === 'post' && entry.authorId === ana)
      ).toHaveLength(4);
    });
  });

  describe('a LATE answer inherits both edits through `deliverLate`', () => {
    it('does not post the narration the room stopped waiting for', async () => {
      // **The regression this was written for.** `collectRoomReply` builds the
      // late shape before the mode is known and knows nothing about rooms, so
      // the mode has to be mapped onto it by the runner. Without that,
      // `deliverLate` → `deliver` read `replyMode === undefined`, took the
      // fail-open `'text'` branch, and posted the very narration the flip exists
      // to keep private — minutes after the room had moved on.
      const landed = Promise.resolve({
        text: 'here is what I think, at length',
        waitedMs: 12 * 60_000,
      });
      open(outcomeRunner(() => ({ text: null, late: landed })));
      await seedAndSettle();
      await service.triggersIdle();

      expect(postsBy(ana)).toHaveLength(0);
      expect(log().every((entry) => !entry.body.text.includes('at length'))).toBe(true);
    });

    it('lands a late tool post once, and the next turn still answers', async () => {
      // **Deliberately NOT claimed as a discriminator, and the measurement says
      // why.** The reviewed second-order failure was that a late turn which
      // tool-posted fell into the text path, hit `!said → 'quiet'`, and left
      // `spokeViaTool` standing. Both halves were checked against the drill (the
      // late mapping removed) and this case stayed green: a non-empty narration
      // still reaches `takeSpokeViaTool` at step 6 and consumes the mark, and a
      // claim is deleted at release either way, so a standing mark cannot reach
      // the next turn. That is the same conclusion `takeSpokeViaTool`'s own doc
      // reached about its clear — "removing it leaves every test green. It was
      // measured."
      //
      // What it pins is the SHAPE, which is worth pinning: a late tool post is
      // one entry, it is the tool's words, and the pair keeps working afterwards.
      // The two cases either side of it are the ones that go red.
      let turn = 0;
      open(
        outcomeRunner((request) => {
          turn += 1;
          if (turn === 1) {
            service.postFromTool(request.room.id, {
              authorId: request.authorId,
              text: 'the late answer',
            });
            return {
              text: null,
              late: Promise.resolve({ text: 'and I said so', waitedMs: 12 * 60_000 }),
            };
          }
          service.postFromTool(request.room.id, {
            authorId: request.authorId,
            text: 'the next answer',
          });
          return { text: null };
        })
      );
      await seedAndSettle('@ana first');
      await service.triggersIdle();

      await seedAndSettle('@ana second');
      await service.triggersIdle();

      expect(postsBy(ana).map((entry) => entry.body.text)).toEqual([
        'the late answer',
        'the next answer',
      ]);
      expect(notices()).toHaveLength(0);
    });

    it('writes one `agent_declined` for a late turn that produced nothing', async () => {
      open(
        outcomeRunner(() => ({
          text: null,
          late: Promise.resolve({ text: null, waitedMs: 12 * 60_000 }),
        }))
      );
      await seedAndSettle();
      await service.triggersIdle();

      expect(notices().map((entry) => entry.body.notice)).toEqual(['agent_declined']);
    });
  });

  /** The `done` presence frames this room published about one agent, in order. */
  function releases(authorId: string): RoomSignalEvent[] {
    return published
      .filter((event): event is RoomSignalEvent => event.type === 'signal')
      .filter((event) => event.authorId === authorId && event.state === 'done');
  }

  describe('AC 1 — the `done` frame says how the turn finished', () => {
    it('says `silent` when a turn had nothing to add', async () => {
      // The ephemeral half of D7: a working pill that appears and vanishes with
      // nothing to show reads as a crash, and a turn that decides nothing needs
      // saying is an ordinary outcome rather than a rare one.
      open(outcomeRunner(() => ({ text: null })));
      await seedAndSettle('the deploy finished');

      expect(releases(ana).map((frame) => frame.outcome)).toEqual(['silent']);
    });

    it('says `answered` when a turn posted', async () => {
      open(toolPosting(null));
      await seedAndSettle();

      expect(releases(ana).map((frame) => frame.outcome)).toEqual(['answered']);
    });

    it('says `answered` for a turn whose only act was a reaction', async () => {
      // A reaction puts something in front of the reader, so the indicator
      // releases into something the person can see — and the frame has to agree
      // with the notice log, which writes nothing for this turn.
      let seedId = '';
      open(
        outcomeRunner((request) => {
          service.toggleReaction(request.room.id, seedId, request.authorId, '\u2705');
          return { text: null };
        })
      );
      const seed = service.post(room.id, { authorId: human, text: '@ana just ack this' });
      seedId = seed.id;
      await service.triggersIdle();

      expect(releases(ana).map((frame) => frame.outcome)).toEqual(['answered']);
    });
  });

  describe('AC 12 — the turn holder’s own tool call is refused, and the room still speaks', () => {
    it('writes the declined line when the claim holder\u2019s only post is refused', async () => {
      // **The half of criterion 12 the route tests cannot reach.** An expired or
      // unresolvable agent token is a hard `AGENT_IDENTITY_UNVERIFIED` refusal
      // rather than a degrade, and that is correct — the alternative is posting
      // in the install owner's name. That refusal is pinned where it happens, in
      // `routes/__tests__/room-capabilities-unverified-agent.test.ts`. What is
      // NOT pinned there is what the ROOM does next: a tool-only turn whose only
      // voice was just refused produces nothing, and if that vanished the person
      // who asked would be left with a pill that appeared and went.
      //
      // **The refused caller is ANA, who holds the claim, and an earlier version
      // of this case got that wrong.** It refused a post from a second agent —
      // a stranger to the room — which fails at the membership check before any of
      // `postFromTool`'s turn-scoped ordering runs, so no mutation to the stop
      // mark, the ceiling or the mode could have touched it and the case merely
      // restated AC 4. Here the refusal reaches the agent whose turn it is: she
      // aims her one post at a channel she was never added to, spends her turn,
      // and comes back with nothing.
      let refusal: RoomError | undefined;
      let elsewhere = '';
      open(
        outcomeRunner((request) => {
          try {
            service.postFromTool(elsewhere, { authorId: request.authorId, text: 'over here' });
          } catch (err) {
            refusal = err as RoomError;
          }
          return { text: null };
        })
      );
      // A room Ana is not on the roster of. "Not a member" answers exactly as
      // "no such room", which is why the code below is `ROOM_NOT_FOUND`.
      elsewhere = service.createRoom(
        { kind: 'channel', title: 'Ops', members: [], agentPaths: [] },
        human
      ).id;
      await seedAndSettle();

      expect(refusal?.code).toBe('ROOM_NOT_FOUND');
      // Nothing landed anywhere: not in the room she aimed at, not in her own.
      expect(postsBy(ana)).toHaveLength(0);
      expect(
        service.listEntries(elsewhere, human, { limit: 50 }).filter((e) => e.kind === 'post')
      ).toHaveLength(0);
      // And the room she was asked in still said something. That is the property.
      expect(notices().map((entry) => entry.body.notice)).toEqual(['agent_declined']);
    });
  });

  describe('the welcome-back offer runs as an ordinary turn (D12, reversed)', () => {
    it('posts through the tool, and the seam hands nothing back', async () => {
      // **The reversal** (spec §A2). The greeter used to post an aside turn's
      // narration itself, which made this the one path in the product where a
      // turn's words were still the room's message — and it needed a pinned
      // reply mode to stop the agent being told the opposite of what happened.
      // One path now: the offer turn calls the tool or it says nothing.
      open(
        outcomeRunner((request) => {
          service.postFromTool(request.room.id, {
            authorId: request.authorId,
            text: 'want me to open the PR?',
          });
          return { text: 'I offered.' };
        })
      );
      const about = service.post(room.id, { authorId: human, text: 'back at my desk' });

      await expect(
        service.askAside({
          roomId: room.id,
          authorId: ana,
          aboutEntryId: about.id,
          prompt: 'anything worth offering?',
        })
      ).resolves.toBeUndefined();

      // The offer is in the room, once, and the narration is not.
      expect(postsBy(ana).map((entry) => entry.body.text)).toEqual(['want me to open the PR?']);
    });

    it('an offer that posts nothing produces nothing, and no notice', async () => {
      // The property the D12 argument rested on, kept on the other side of the
      // reversal: four of `askAside`'s outcomes are already silent by design, so
      // a fifth must not start announcing itself. Nobody asked for this turn,
      // and `agent_declined` is owed only to somebody who did.
      open(outcomeRunner(() => ({ text: 'nothing worth saying' })));
      const about = service.post(room.id, { authorId: human, text: 'back at my desk' });

      await service.askAside({
        roomId: room.id,
        authorId: ana,
        aboutEntryId: about.id,
        prompt: 'anything worth offering?',
      });

      expect(postsBy(ana)).toHaveLength(0);
      expect(notices()).toHaveLength(0);
    });

    it('cannot start a conversation with what it posts', async () => {
      // The cascade property the reversal had to preserve. An aside claim hands
      // out no provenance, so the post is stamped under its OWN root at the
      // ceiling — spent on arrival. Bo is `always` here, so a post at depth 0
      // would have woken it.
      ({ service, authors, store, runner, human } = createRoomHarness({
        agents,
        runner: outcomeRunner((request) => {
          service.postFromTool(request.room.id, {
            authorId: request.authorId,
            text: 'want me to open the PR?',
          });
          return { text: null };
        }),
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
      ana = authors.resolveAgent('/agents/ana', 'Ana').id;
      const bo = authors.resolveAgent('/agents/bo', 'Bo').id;
      service.updateMembership(room.id, human, ana, 'always');
      service.updateMembership(room.id, human, bo, 'always');
      // The greeter's own status line, posted BY Ana and un-provenanced, exactly
      // as the greeter posts it — stamped at the ceiling, so it starts nothing
      // and the only turn this test can count is the offer's own.
      const about = service.post(room.id, { authorId: ana, text: 'while you were away…' });

      await service.askAside({
        roomId: room.id,
        authorId: ana,
        aboutEntryId: about.id,
        prompt: 'anything worth offering?',
      });
      await service.triggersIdle();

      const offer = service
        .listEntries(room.id, human, { limit: 200 })
        .find((entry) => entry.body.text === 'want me to open the PR?');
      expect(offer?.cascadeRoot).toBe(offer?.id);
      // Exactly one turn ran — the offer's own — and Bo said nothing about it.
      expect(runner.turns).toHaveLength(1);
      expect(
        service.listEntries(room.id, human, { limit: 200 }).filter((e) => e.authorId === bo)
      ).toEqual([]);
    });
  });

  describe('a halted turn still drops everything, notices included', () => {
    it('writes no `agent_declined` for a turn somebody stopped', async () => {
      open(
        outcomeRunner(() => {
          service.haltRoom(room.id, human);
          return { text: null };
        })
      );
      await seedAndSettle();

      // The `halted` line is the whole story; a "did not reply" line under it
      // would be the room apologising for obeying.
      expect(notices().filter((n) => n.body.notice === 'agent_declined')).toHaveLength(0);
    });
  });

  beforeEach(() => {
    // Each test opens its own room, so there is nothing to reset here. `runner`
    // is destructured for the harness's sake and read by no case in this file.
    void runner;
  });
});
