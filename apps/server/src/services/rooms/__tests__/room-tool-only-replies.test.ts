/**
 * The flip: under `rooms.toolOnlyReplies`, a turn's text is never the room's
 * message (spec `tool-only-room-replies`, acceptance criteria 1–10 and 13–14).
 *
 * Driven through the real service and the real dispatcher, like every other
 * behaviour test in this suite: only the runner stands in, because the
 * alternative is a model call. The runner reports the mode onto the claim
 * exactly as the production one does (`outcomeRunner`), so a `post_to_room` made
 * mid-turn reads the same value it would in the product — without that, a test
 * could assert the flip while the mechanism the flip depends on was never
 * exercised.
 *
 * **The mode is passed on the reply rather than read from config here.** That is
 * not a shortcut around the flag: `resolveReplyMode` in `room-turn-runner.ts` is
 * what reads the config, and it is tested there. What THIS file is about is
 * everything downstream of the answer — which is reached identically whether the
 * mode came from a flag, a runtime, or a script.
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
import { RoomError } from '../room-errors.js';
import {
  agentLookupFor,
  createRoomHarness,
  outcomeRunner,
  toolOnlyRunner,
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
   * @param mode - The reply mode to report.
   * @param posts - How many times the turn posts through the tool.
   */
  function toolPosting(
    narration: string | null,
    mode: 'text' | 'tool-only',
    posts = 1
  ): ScriptedTurnRunner {
    const build = mode === 'tool-only' ? toolOnlyRunner : outcomeRunner;
    return build((request) => {
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
      open(toolPosting('I posted the answer.', 'tool-only'));
      await seedAndSettle();

      const said = postsBy(ana);
      expect(said).toHaveLength(1);
      expect(said[0].body.text).toBe('deliberate 1');
      expect(said[0].body.text).not.toContain('I posted the answer.');
    });

    it('writes no `agent_declined`, because the room heard from it', async () => {
      open(toolPosting('I posted the answer.', 'tool-only'));
      await seedAndSettle();

      expect(notices()).toHaveLength(0);
    });
  });

  describe('AC 3 — it narrated without calling the tool', () => {
    it('lands no entry at all', async () => {
      open(toolOnlyRunner(() => ({ text: 'here is what I think' })));
      await seedAndSettle();

      expect(postsBy(ana)).toHaveLength(0);
    });
  });

  describe('AC 4 — a person asked and got nothing', () => {
    it('writes exactly one `agent_declined`, in the room’s own voice', async () => {
      open(toolOnlyRunner(() => ({ text: null })));
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
      open(toolOnlyRunner(() => ({ text: null })));

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
      open(toolOnlyRunner(() => ({ text: null })));

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
        toolOnlyRunner(() =>
          refuse ? { text: null, unanswered: 'busy' as const } : { text: null }
        )
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
      open(toolOnlyRunner(() => ({ text: null })));
      // Ambient: a person's message that does NOT name Ana. She answers because
      // her mode is `always`, which is exactly the case E7 says must stay free.
      await seedAndSettle('the deploy finished');

      expect(postsBy(ana)).toHaveLength(0);
      expect(notices()).toHaveLength(0);
    });

    it('and the claim is released, so the room shows nobody working', async () => {
      open(toolOnlyRunner(() => ({ text: null })));
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
        toolOnlyRunner((request) => {
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
        toolOnlyRunner((request) => {
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

  describe('AC 8 — the DM refusal is conditioned, not removed', () => {
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

    it('a tool-only turn may post in a DM', async () => {
      const scripted = toolOnlyRunner((request) => {
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

    it('a text-mode turn is still refused there, with the mode-conditional message', async () => {
      let refused: RoomError | undefined;
      const scripted = outcomeRunner((request) => {
        try {
          service.postFromTool(request.room.id, {
            authorId: request.authorId,
            text: 'answering in the DM',
          });
        } catch (err) {
          refused = err as RoomError;
        }
        return { text: 'the reply itself' };
      });
      const dm = openDm(scripted);
      service.post(dm.id, { authorId: human, text: 'are you there?' });
      await service.triggersIdle();

      expect(refused?.code).toBe('TOOL_POST_NOT_IN_DM');
      expect(refused?.message).toContain('being posted for you');
      // And the turn's own text is what landed, exactly as it always did.
      const said = service
        .listEntries(dm.id, human, { limit: 50 })
        .filter((entry) => entry.kind === 'post' && entry.authorId === ana);
      expect(said).toHaveLength(1);
      expect(said[0].body.text).toBe('the reply itself');
    });

    it('a post with no turn behind it is refused in a DM, whatever the flag says', () => {
      // The mode lives on the CLAIM, so a hand post with nothing in flight reads
      // `undefined` — which falls open to the refusal that shipped, rather than
      // to whatever the last turn happened to be running under.
      const dm = openDm(outcomeRunner(() => ({ text: null })));
      expect(() => service.postFromTool(dm.id, { authorId: ana, text: 'unbidden' })).toThrowError(
        /direct message/
      );
    });
  });

  describe('AC 9 — an agent’s tool post into a DM triggers nobody', () => {
    it('selects no targets, so no second turn runs', async () => {
      let turns = 0;
      const scripted = toolOnlyRunner((request) => {
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
      open(toolPosting(null, 'tool-only'));
      const seed = await seedAndSettle();

      const said = postsBy(ana);
      expect(said).toHaveLength(1);
      expect(said[0].cascadeRoot).toBe(seed.cascadeRoot);
      expect(said[0].cascadeDepth).toBe(seed.cascadeDepth + 1);
    });
  });

  describe('AC 13 — a tool post carries its answer pointer and its session', () => {
    it('fills both from the live claim', async () => {
      open(toolPosting(null, 'tool-only'));
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
        toolOnlyRunner((request) => {
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
        toolOnlyRunner((request) => {
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
        toolOnlyRunner((request) => {
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
      open(toolOnlyRunner(() => ({ text: null, late: landed })));
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
        toolOnlyRunner((request) => {
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
        toolOnlyRunner(() => ({
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

  describe('AC 1 — the `done` frame carries an outcome only in tool-only mode', () => {
    it('says `silent` when a tool-only turn had nothing to add', async () => {
      // The ephemeral half of D7: a working pill that appears and vanishes with
      // nothing to show reads as a crash, and under the flip that stops being
      // rare.
      open(toolOnlyRunner(() => ({ text: null })));
      await seedAndSettle('the deploy finished');

      expect(releases(ana).map((frame) => frame.outcome)).toEqual(['silent']);
    });

    it('says `answered` when a tool-only turn posted', async () => {
      open(toolPosting(null, 'tool-only'));
      await seedAndSettle();

      expect(releases(ana).map((frame) => frame.outcome)).toEqual(['answered']);
    });

    it('carries NO outcome in text mode — criterion 1 is about the wire too', async () => {
      // **The gate, and why it is one.** With the flag off, room behaviour is
      // byte-identical to before this feature, and a new field on every release
      // frame is not byte-identical. It would buy nothing there either: a
      // text-mode turn that finishes has posted its words or written a notice,
      // so the indicator already releases into something a reader can see.
      //
      // Asserted with `toHaveProperty` rather than against `undefined`, because
      // the claim is that the key is ABSENT from the payload — which is what a
      // client one release behind actually parses.
      open(outcomeRunner(() => ({ text: 'the build is green' })));
      await seedAndSettle();

      const done = releases(ana);
      expect(done).toHaveLength(1);
      expect(done[0]).not.toHaveProperty('outcome');
    });

    it('carries none for a text-mode turn that said nothing either', async () => {
      // The shape the gate is most likely to be dropped against: a quiet turn
      // looks like the case D7 was written for, and in text mode it is not.
      open(outcomeRunner(() => ({ text: null })));
      await seedAndSettle('the deploy finished');

      const done = releases(ana);
      expect(done).toHaveLength(1);
      expect(done[0]).not.toHaveProperty('outcome');
    });
  });

  describe('the flag-OFF path is untouched', () => {
    it('AC 1 — a text-mode turn still posts its own words', async () => {
      open(outcomeRunner(() => ({ text: 'the build is green' })));
      await seedAndSettle();

      const said = postsBy(ana);
      expect(said).toHaveLength(1);
      expect(said[0].body.text).toBe('the build is green');
      expect(notices()).toHaveLength(0);
    });

    it('an ABSENT mode behaves exactly as `text` — the fail-open direction', async () => {
      open(outcomeRunner(() => ({ text: 'the build is green' })));
      await seedAndSettle();

      expect(postsBy(ana)[0].body.text).toBe('the build is green');
    });

    it('a text-mode turn that reacted and said nothing is still quiet, with no notice', async () => {
      // The reaction mark is only READ in the tool-only path. In text mode a
      // reaction-only turn produces no entry and reads as `'quiet'`, exactly as
      // it does today.
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

      expect(postsBy(ana)).toHaveLength(0);
      expect(notices()).toHaveLength(0);
    });
  });

  describe('AC 12 — the turn holder\u2019s own tool call is refused, and the room still speaks', () => {
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
        toolOnlyRunner((request) => {
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

    it('and the same turn in TEXT mode falls back to posting its words', async () => {
      // The other half of "the same fallback, not a silent mute": with the flip
      // off — or resolved off, which is what an unwired session gets — a turn
      // whose tool call was refused still has its narration, and the narration
      // still posts. Nothing about a refused tool call can mute an agent that
      // was never going to speak through the tool.
      let elsewhere = '';
      open(
        outcomeRunner((request) => {
          try {
            service.postFromTool(elsewhere, { authorId: request.authorId, text: 'over here' });
          } catch {
            // Refused, exactly as above.
          }
          return { text: 'the build is green' };
        })
      );
      elsewhere = service.createRoom(
        { kind: 'channel', title: 'Ops2', members: [], agentPaths: [] },
        human
      ).id;
      await seedAndSettle();

      expect(postsBy(ana).map((entry) => entry.body.text)).toEqual(['the build is green']);
      expect(notices()).toHaveLength(0);
    });
  });

  describe('the welcome-back offer keeps text-as-reply, deliberately (D12)', () => {
    it('is told its words ARE the message, even with the flip on', async () => {
      // **The one turn in the product that is pinned to text mode, and being
      // told the opposite of what happens is exactly the drift this feature is
      // most exposed to.** The greeter posts an aside turn's answer itself,
      // outside `deliver` — so a resolved `'tool-only'` would hand the agent a
      // context block saying "nothing you write back this turn is posted", and
      // then post precisely what it wrote. It was reachable in one line: the
      // shared runner overwrites the context with whatever mode it resolved.
      //
      // Asserted on the CONTEXT the turn was handed rather than on the outcome,
      // because the outcome is the same either way and would not catch it.
      let asideMode: string | undefined = 'unset';
      open(
        toolOnlyRunner((request) => {
          asideMode = request.roomContext.replyMode ?? 'absent';
          return { text: 'want me to open the PR?' };
        })
      );
      const about = service.post(room.id, { authorId: human, text: 'back at my desk' });

      const offer = await service.askAside({
        roomId: room.id,
        authorId: ana,
        aboutEntryId: about.id,
        prompt: 'anything worth offering?',
      });

      expect(asideMode).toBe('text');
      expect(offer, 'the greeter is still handed the words to post').toBe(
        'want me to open the PR?'
      );
    });

    it('and an ordinary trigger in the same room is still tool-only', async () => {
      // The half that says the pin is scoped to the aside rather than to the
      // room: a pin that leaked would turn the flip off wherever a greeter had
      // ever run, silently.
      const modes: (string | undefined)[] = [];
      open(
        toolOnlyRunner((request) => {
          modes.push(request.roomContext.replyMode ?? 'absent');
          return { text: null };
        })
      );
      const about = service.post(room.id, { authorId: human, text: 'back at my desk' });
      await service.askAside({
        roomId: room.id,
        authorId: ana,
        aboutEntryId: about.id,
        prompt: 'anything worth offering?',
      });
      await seedAndSettle('@ana and now a real question');

      expect(modes).toEqual(['text', 'tool-only']);
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
