/**
 * A wired rooms subsystem for tests, with the turn machinery replaced.
 *
 * Everything except the runner is the real thing — the real store, the real
 * author registry, the real service, and above all the real trigger dispatcher.
 * That is the point: the cascade tests must exercise the code that ships, not a
 * loop written beside it. Only {@link ScriptedTurnRunner} stands in, because the
 * alternative is a model call.
 *
 * @module server/services/rooms/__tests__/room-test-harness
 */
import { createTestDb } from '@dorkos/test-utils/db';
import { mockInterruptReceipt } from '@dorkos/test-utils';
import type { InterruptReceipt } from '@dorkos/shared/types';
import type { RoomContextData } from '@dorkos/shared/additional-context';
import type { ProjectableAttachment } from '../room-context.js';
import type { Db } from '@dorkos/db';
import { BridgeStore } from '../../relay/chat-bridge/bridge-store.js';
import { ReadCursorService } from '../../core/read-cursor-service.js';
import { ReadCursorStore } from '../../core/read-cursor-store.js';
import { indexRoomEntry, roomsSource, searchMessages, SearchIndexer } from '../../search/index.js';
import { AuthorRegistry, isOwnerRecord } from '../author-registry.js';
import { USER_CONFIG_DEFAULTS } from '@dorkos/shared/config-schema';
import type { EngagedWindow } from '../engagement.js';
import type { ResponseGateMode } from '../response-gate/routing-rules.js';
import type { CollectWindow } from '../room-collect.js';
import { ReactionBudget } from '../reactions/reaction-budget.js';
import { ReactionStore } from '../reactions/reaction-store.js';
import {
  CanvasDocumentStore,
  CanvasService,
  parseScope,
  publishSessionCanvas,
  sessionCanvasViewers,
  setCanvasService,
} from '../../canvas/index.js';
import { AttachmentRowStore } from '../attachments/attachment-row-store.js';
import type { RoomAgent, RoomAgentLookup } from '../room-errors.js';
import {
  RoomService,
  type RoomEntryIndexer,
  type RoomMessageFinder,
  type RoomMirrorAccess,
  type RoomMirrorWritePolicy,
} from '../room-service.js';
import { RoomStore } from '../room-store.js';
import type { RoomWorktreeManager } from '../repo/room-worktree-manager.js';
import { RoomBroadcaster } from '../room-stream.js';
import { resolveRoomLimits, type RoomLimitsResolver } from '../limits/room-limits.js';
import { RoomTurnBudget } from '../limits/turn-budget.js';
import type {
  LateRoomReply,
  RoomTurnRequest,
  RoomTurnResult,
  RoomTurnRunner,
  RoomTurnWaiting,
} from '../room-trigger.js';

/** How many macrotask hops a room gets to reach a state before a test gives up. */
const SETTLE_HOPS = 500;

/**
 * Wait until the room has reached the state this step is about.
 *
 * `RoomService.triggersIdle()` is the right wait when every turn will settle,
 * and the wrong one whenever a turn is being held: it never resolves until the
 * test lands that turn. So those scenarios need a different wait, and the
 * obvious one — hop the macrotask queue a fixed number of times — is how a suite
 * acquires a test that usually passes. Two hops were enough on an idle machine
 * and not enough inside a full run, where several hundred test files share one
 * event loop; the scenarios then measured a room that had not finished moving.
 *
 * Waiting on the CONDITION removes the guess in both directions: it returns as
 * soon as the room is ready, and it fails with the state it wanted rather than
 * with a confusing assertion three lines later.
 *
 * Absence is never the condition. "Ana was not triggered again" is proved by
 * waiting for the thing that happens INSTEAD — the refusal notice, or the reply
 * that carried it — which is on the log by the time the dispatch that decided it
 * returns.
 *
 * @param reached - The state being waited for.
 * @param described - What that state is, for the failure message.
 */
export async function settleUntil(reached: () => boolean, described: string): Promise<void> {
  for (let hop = 0; hop < SETTLE_HOPS; hop += 1) {
    if (reached()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`the room never reached: ${described}`);
}

/** One turn the dispatcher asked for, as the test sees it. */
export interface RecordedTurn {
  roomId: string;
  authorId: string;
  /** The agent's directory — its IDENTITY, whatever tree the turn runs in. */
  agentPath: string;
  /**
   * The directory the turn actually runs in (spec `project-rooms` §3.5).
   *
   * Equal to {@link RecordedTurn.agentPath} for every room without files of its
   * own, and recorded separately because the whole claim of the cwd rung is that
   * the two can differ — a test that read one for the other could not see it.
   */
  cwd: string;
  sessionId: string | null;
  /**
   * The words the turn was asked with. Equal to the triggering entry's text for
   * every ordinary trigger, and the whole point of the recording for the one
   * caller where it is not: the welcome-back offer (DOR-1046).
   */
  prompt: string;
  /** What the agent was told about the room — derived by the real dispatcher. */
  roomContext: RoomContextData;
  /**
   * The files that context refers to, as the dispatcher planned them.
   *
   * Recorded beside the context rather than derived from it, because the whole
   * claim under test is that the two are ONE value: a test that rebuilt the
   * plan from the rendered paths could not catch them disagreeing.
   */
  attachmentProjection: readonly ProjectableAttachment[];
}

/** A runner that answers from a script instead of a model. */
export interface ScriptedTurnRunner extends RoomTurnRunner {
  /** Every turn the dispatcher has asked for, in the order it asked. */
  readonly turns: RecordedTurn[];
  /**
   * Every turn a halt asked it to stop, in the order it asked.
   *
   * Recorded rather than stubbed away because "the halt route interrupts every
   * in-flight turn in the room" is the assertion RP8 asks for, and a no-op
   * `interrupt` would let a halt that stopped nothing pass it.
   */
  readonly interrupted: Array<{ sessionId: string; agentPath: string }>;
  /**
   * Every refusal a scripted post ran into, newest last.
   *
   * A refused `post_to_room` does not fail a turn in production — the agent is
   * handed an error and the turn ends however it ends — so {@link
   * ScriptedTurnRunner.sayInRoom} swallows one and records it here. A test about
   * a bound (the per-turn ceiling, a stopped turn) reads this rather than
   * catching a rejection the product would never raise.
   */
  readonly refusals: string[];
  /**
   * Hand this runner the service its scripted turns speak through.
   *
   * Called by {@link createRoomHarness} once the service exists. A runner asked
   * to speak before that throws rather than silently saying nothing, because a
   * silent turn is a legitimate outcome here and a wiring mistake that looked
   * like one would pass.
   *
   * @param service - The live room service.
   */
  speaksThrough(service: RoomService): void;
  /**
   * Say something in the room this turn was triggered from, the way an agent
   * does: through the real `post_to_room` capability, mid-turn.
   *
   * **This is the only way a scripted turn puts anything in the room**, because
   * it is the only way a real one does. A turn's own words are never posted for
   * it, so a fake that returned text and expected the room to publish it would
   * be testing a path the product does not have.
   *
   * @param request - The turn being taken.
   * @param text - What to say.
   * @param opts.replyTo - The thread to answer inside. Defaults to the thread
   *   the triggering entry is in, which is what a well-behaved agent does and
   *   what the room used to do on the agent's behalf.
   */
  sayInRoom(request: RoomTurnRequest, text: string, opts?: { replyTo?: string }): void;
}

/**
 * Build a runner that says `reply(request)` in the room for every turn, minting
 * a session id the first time each `(room, agent)` pair answers.
 *
 * The string is POSTED through the tool and also narrated back to the turn's own
 * session, which is what a well-behaved agent does: the room gets the message,
 * and the session transcript records that the agent wrote it.
 *
 * @param reply - What the agent says. Return `null` for a turn that says
 *   nothing — which is silence, and earns the `agent_declined` notice when a
 *   person had asked.
 */
export function scriptedRunner(
  reply: (request: RoomTurnRequest) => string | null = () => 'on it'
): ScriptedTurnRunner {
  const runner: ScriptedTurnRunner = outcomeRunner((request) => {
    const said = reply(request);
    // Blank counts as nothing, exactly as `null` does: an agent with nothing to
    // say does not call the tool with nothing in it. Several suites say "this
    // turn produced nothing" by returning whitespace, and a fake that posted it
    // would put a blank message in a room the product never would.
    if (said !== null && said.trim() !== '') runner.sayInRoom(request, said);
    return { text: said };
  });
  return runner;
}

/**
 * {@link outcomeRunner} that also SAYS its `text` in the room, through the tool.
 *
 * The middle case between the two above, and it exists because a scenario often
 * needs both halves: a turn that answers in one branch and reports `busy` or
 * `failed` in another. {@link scriptedRunner} cannot express the refusal;
 * {@link outcomeRunner} does not speak. This does both, and the rule is the one
 * a real agent follows — a non-blank answer is posted, and a turn that was
 * refused says nothing.
 *
 * A LATE answer is not posted here: it lands after this function has returned,
 * so a scenario about a late turn calls {@link ScriptedTurnRunner.sayInRoom}
 * itself at the moment it means the words to arrive.
 *
 * @param outcome - The whole turn result; see {@link outcomeRunner}.
 */
export function speakingRunner(
  outcome: (
    request: RoomTurnRequest
  ) => (Omit<RoomTurnResult, 'sessionId'> & { sessionId?: string }) | { throws: Error }
): ScriptedTurnRunner {
  const runner: ScriptedTurnRunner = outcomeRunner((request) => {
    const result = outcome(request);
    if ('throws' in result) return result;
    const said = result.text?.trim();
    if (said !== undefined && said !== '' && result.unanswered === undefined) {
      runner.sayInRoom(request, result.text!);
    }
    return result;
  });
  return runner;
}

/**
 * The same runner, for the outcomes a reply string cannot express: a session
 * that was busy, a turn that failed, an answer still on its way, or a turn that
 * posts more than once.
 *
 * Kept separate from {@link scriptedRunner} so the common case stays a
 * one-liner, and shared with it so both mint sessions the same way.
 *
 * **`sessionId` is optional, and returning one is not cosmetic.** A runtime may
 * answer on a DIFFERENT session than the one it was asked with — Claude Code
 * assigns its own canonical id on the first turn and writes the transcript
 * under it. Every fake here used to echo the requested id back, so no test
 * could see the difference between the two; supply one to model a runtime that
 * renames the session out from under the room.
 *
 * @param outcome - The whole turn result; `sessionId` defaults to the requested one.
 * @param outcome.throws - Throw instead of returning, for the runtime-is-down path.
 */
export function outcomeRunner(
  outcome: (
    request: RoomTurnRequest
  ) => (Omit<RoomTurnResult, 'sessionId'> & { sessionId?: string }) | { throws: Error }
): ScriptedTurnRunner {
  const turns: RecordedTurn[] = [];
  const interrupted: Array<{ sessionId: string; agentPath: string }> = [];
  const voice = roomVoice();
  let minted = 0;
  return {
    turns,
    interrupted,
    ...voice,
    interrupt(request): Promise<InterruptReceipt> {
      interrupted.push(request);
      // Nothing is being held here, so nothing was stopped — the honest answer
      // for a runner whose turns are already over by the time a halt runs.
      return Promise.resolve(mockInterruptReceipt('not-running'));
    },
    run(request: RoomTurnRequest): Promise<RoomTurnResult> {
      const sessionId = request.sessionId ?? `session-${(minted += 1)}`;
      // **Reported BEFORE the body runs, exactly as the production runner
      // reports it** (spec `tool-only-room-replies` §D8). A scripted turn that
      // posts through the tool does it from inside `outcome`, and by then the
      // claim has to already carry the session id, which is what stamps the
      // entry. Reporting after would let a test assert a post while the
      // mechanism that provenances it was never exercised.
      request.onSessionBound(sessionId);
      turns.push({
        roomId: request.room.id,
        authorId: request.authorId,
        agentPath: request.agentPath,
        cwd: request.cwd,
        sessionId: request.sessionId,
        prompt: request.prompt,
        roomContext: request.roomContext,
        attachmentProjection: request.attachmentProjection,
      });
      const result = outcome(request);
      if ('throws' in result) return Promise.reject(result.throws);
      const { sessionId: ranOn, ...reply } = result;
      return Promise.resolve({ sessionId: ranOn ?? sessionId, ...reply });
    },
  };
}

/**
 * The voice every scripted runner here speaks with — the real posting
 * capability, bound once the harness has a service to speak through.
 *
 * Shared between {@link outcomeRunner} and {@link gatedRunner} rather than
 * written twice, because "how a fake turn says something in a room" is exactly
 * the thing two copies of would drift on. **Exported for the hand-rolled runners
 * a few suites build inline**: spread it into one and `createRoomHarness` binds
 * it like any other, which is cheaper than making every such runner reimplement
 * a seam it mostly does not use.
 *
 * @returns The three members {@link ScriptedTurnRunner} requires for speaking.
 */
export function roomVoice(): Pick<ScriptedTurnRunner, 'refusals' | 'speaksThrough' | 'sayInRoom'> {
  const refusals: string[] = [];
  let service: RoomService | undefined;
  return {
    refusals,
    speaksThrough(bound) {
      service = bound;
    },
    sayInRoom(request, text, opts = {}) {
      if (service === undefined) {
        throw new Error(
          'this runner was asked to speak before it was handed a service; ' +
            'build it through createRoomHarness, or call speaksThrough() yourself'
        );
      }
      try {
        service.postFromTool(request.room.id, {
          authorId: request.authorId,
          text,
          // Answer where you were asked. The room used to do this on the agent's
          // behalf on the text path; a tool post carries whatever the caller
          // passes, so a well-behaved agent passes the thread it is in.
          ...((opts.replyTo ?? request.entry.threadRootEntryId)
            ? { replyTo: opts.replyTo ?? request.entry.threadRootEntryId! }
            : {}),
        });
      } catch (err) {
        // Swallowed on purpose — see {@link ScriptedTurnRunner.refusals}.
        refusals.push(err instanceof Error ? err.message : String(err));
      }
    },
  };
}

/** A runner whose turns only finish when the test says so. */
export interface GatedRunner extends ScriptedTurnRunner {
  /** How many turns are being held for one agent right now. */
  holdsFor(authorId: string): number;
  /** Let one agent's oldest held turn answer now. */
  release(authorId: string): void;
  /** Let every held turn, for every agent, answer now. */
  releaseAll(): void;
  /**
   * Make one agent's oldest held turn report that it has stopped for a person.
   *
   * The turn keeps running — that is the whole state being modelled. A turn
   * parked on an approval is not over; it is producing nothing until somebody
   * acts, which is why the report rides a callback rather than the result.
   */
  waitOnPerson(authorId: string, waiting: RoomTurnWaiting): void;
}

/**
 * Build a runner that holds every turn open until released.
 *
 * Holding is what makes any of this observable: a turn that answered would take
 * and release its claim inside one `await`, and every state in between — parked
 * on a person, blocking another room, interruptible — is a state the test never
 * gets to look at.
 *
 * @param opts.interruptEndsTurn - Whether an interrupt finishes the turn it
 *   stops. `true` is the ordinary runtime: the query aborts, the stream closes,
 *   and the turn settles a moment later. `false` is the runtime that does not
 *   come back — a hung subprocess, a lost socket — which is the case a halt's
 *   own claim release exists for, and the only runtime a test can use to prove
 *   the release went through the seam at all.
 * @param opts.interruptedTurnStillAnswers - Whether the turn an interrupt ends
 *   comes back WITH what the model had already produced. That is what a real
 *   runtime does when the interrupt loses its race with a model that had all but
 *   finished (DOR-1232, measured 2026-08-15) — `interrupt` is delivered, and the
 *   stream closes a moment later carrying the complete answer.
 * @param opts.answersLate - Whether every turn outruns the room's WAIT: `run`
 *   returns at once with `{ text: null, late }`, the way the real runner reports
 *   the deadline passing, and the answer arrives on the `late` promise whenever
 *   the test lands it. It is the only way to reach `deliverLate`, which is a
 *   whole delivery path with its own claim release — and the one a Stop pressed
 *   during the late window has to reach.
 * @param opts.interruptFindsNothing - Whether the stop lands on NOTHING: the
 *   runtime has no turn to aim it at, so `interrupt` answers `false` and the
 *   held turn keeps running. That is the boot window (DOR-1424) — a Stop
 *   pressed before the agent's process has bound its turn — and the only shape
 *   in which the room can honestly say it could not reach the agent (DOR-1425).
 */
export function gatedRunner({
  interruptEndsTurn = true,
  interruptedTurnStillAnswers = false,
  answersLate = false,
  interruptFindsNothing = false,
} = {}): GatedRunner {
  const turns: ScriptedTurnRunner['turns'] = [];
  const interrupted: ScriptedTurnRunner['interrupted'] = [];
  const voice = roomVoice();
  const held = new Map<
    string,
    Array<{ request: RoomTurnRequest; finish: () => void; stop: () => void; stopped?: boolean }>
  >();
  /** The oldest held turn for one agent, or a failure naming what was wanted. */
  const oldest = (authorId: string, verb: string) => {
    const turn = held.get(authorId)?.[0];
    if (!turn) throw new Error(`no turn is being held for ${authorId}, so it cannot ${verb}`);
    return turn;
  };
  return {
    turns,
    interrupted,
    ...voice,
    interrupt(request): Promise<InterruptReceipt> {
      interrupted.push(request);
      // The stop reached a runtime with no turn bound to it — it stopped
      // nothing, and says so (DOR-1424, DOR-1425).
      if (interruptFindsNothing) return Promise.resolve(mockInterruptReceipt('not-running'));
      // A real interrupt ENDS the turn: the runtime stops, the stream closes,
      // and the collector resolves with whatever there was. A fake that only
      // recorded the call would leave the dispatcher awaiting a turn nothing can
      // finish — which is not what a halt does, and would let a halt that never
      // reached the runtime pass.
      if (!interruptEndsTurn) {
        // **The turn does not settle, and it does not speak again either.** This
        // models the runtime that will not come back promptly: the interrupt was
        // delivered, so whatever the turn produces from here reaches its own
        // session and nothing else. A fake whose stopped turn still called the
        // posting tool would put a halted turn's words in the room.
        for (const [, queued] of held) {
          for (const turn of queued) {
            if (turn.request.agentPath === request.agentPath) turn.stopped = true;
          }
        }
        return Promise.resolve(mockInterruptReceipt('acked'));
      }
      let stoppedSomething = false;
      for (const [authorId, queued] of held) {
        if (queued[0]?.request.agentPath !== request.agentPath) continue;
        for (const turn of queued.splice(0)) turn.stop();
        held.delete(authorId);
        stoppedSomething = true;
      }
      return Promise.resolve(mockInterruptReceipt(stoppedSomething ? 'acked' : 'not-running'));
    },
    run(request: RoomTurnRequest): Promise<RoomTurnResult> {
      turns.push({
        roomId: request.room.id,
        authorId: request.authorId,
        agentPath: request.agentPath,
        cwd: request.cwd,
        sessionId: request.sessionId,
        prompt: request.entry.body.text,
        roomContext: request.roomContext,
        attachmentProjection: request.attachmentProjection,
      });
      const sessionId = request.sessionId ?? 'session-1';
      // What a stopped turn hands back. Nothing, for a runtime that dropped what
      // it was saying — but `interruptedTurnStillAnswers` models the one that
      // measurably does not: the interrupt is delivered and the stream still
      // closes with the whole answer in it. The room has to throw that away
      // either way (DOR-1232), which is what makes the second shape worth having
      // a fake for.
      const stoppedText = interruptedTurnStillAnswers ? 'on it' : null;
      /**
       * This turn's own record, so a stop that reaches it while it is parked is
       * still readable once `release` has taken it out of the queue.
       */
      const mine: {
        request: RoomTurnRequest;
        finish: () => void;
        stop: () => void;
        stopped: boolean;
      } = { request, finish: () => {}, stop: () => {}, stopped: false };
      /** Park this turn's two endings where the test's levers can reach them. */
      const park = (finish: () => void, stop: () => void): void => {
        mine.finish = finish;
        mine.stop = stop;
        const queued = held.get(request.authorId) ?? [];
        queued.push(mine);
        held.set(request.authorId, queued);
      };
      // **A released turn SPEAKS, and a stopped one does not try to.** The room
      // posts nothing on a turn's behalf, so a held turn that only resolved with
      // text would release into silence and every test that waits for an answer
      // would wait for ever. A stopped turn deliberately does not call the tool:
      // `stoppedText` models the runtime that closes its stream with the whole
      // answer in it after an interrupt was delivered (DOR-1232), and what the
      // room must do with that is nothing.
      /** Say "on it" in the room, unless a stop has already reached this turn. */
      const speak = (): void => {
        if (mine.stopped) return;
        voice.sayInRoom(request, 'on it');
      };
      if (answersLate) {
        // The room stopped WAITING and the turn did not stop: `run` resolves now
        // with no text, and the answer lands on `late` when the test says so.
        return Promise.resolve({
          sessionId,
          text: null,
          late: new Promise<LateRoomReply>((resolve) => {
            park(
              () => {
                speak();
                resolve({ text: 'on it', waitedMs: 1 });
              },
              () => resolve({ text: stoppedText, waitedMs: 1 })
            );
          }),
        });
      }
      return new Promise<RoomTurnResult>((resolve) => {
        park(
          () => {
            speak();
            resolve({ sessionId, text: 'on it' });
          },
          () => resolve({ sessionId, text: stoppedText })
        );
      });
    },
    holdsFor(authorId) {
      return held.get(authorId)?.length ?? 0;
    },
    release(authorId) {
      held.get(authorId)?.shift()?.finish();
    },
    releaseAll() {
      // Snapshot the values first: finishing a turn can put the next one in
      // behind it, and iterating the live map would then answer a turn this call
      // never saw.
      for (const queued of [...held.values()]) {
        for (const turn of queued.splice(0)) turn.finish();
      }
    },
    waitOnPerson(authorId, waiting) {
      oldest(authorId, 'wait on a person').request.onWaiting(waiting);
    },
  };
}

/**
 * An agent lookup over a fixed table, filled in with render defaults.
 *
 * `id` defaults to the directory itself. It stands for the occupant's manifest
 * ULID, and the only thing anything does with it is compare it against an author
 * row's generation stamp — so what matters in a fake is that it is stable per
 * directory and distinct between directories, which the key already is. A test
 * about a directory CHANGING HANDS overrides it, and pairs that with a real
 * `agents` row so the registry derives the same value.
 */
export function agentLookupFor(
  table: Record<string, Partial<RoomAgent> & { name: string }>
): RoomAgentLookup {
  return {
    byPath: (agentPath) => {
      const agent = table[agentPath];
      if (!agent) return null;
      return {
        id: agentPath,
        displayName: agent.name,
        responseMode: 'always',
        emoji: null,
        color: null,
        ...agent,
      };
    },
  };
}

/** A wired subsystem plus the handles a test needs to drive it. */
export interface RoomHarness {
  db: Db;
  service: RoomService;
  store: RoomStore;
  reactions: ReactionStore;
  /** The attachment ROW store — what an attachment test seeds through. */
  attachments: AttachmentRowStore;
  authors: AuthorRegistry;
  /** The bridge identity/ref store — what a bridged-room test reads back against. */
  bridges: BridgeStore;
  /**
   * Where the PEOPLE in these rooms have read up to — the user-side cursor a
   * test reads back against, as distinct from `room_members.last_read_seq`,
   * which is what the ambient loop has shown an agent.
   */
  readCursors: ReadCursorService;
  /** The canvas rows, for a test that seeds or reads them directly. */
  canvasDocuments: CanvasDocumentStore;
  /** The live stream, so a test can subscribe and read the frames a room fans out. */
  broadcaster: RoomBroadcaster;
  runner: ScriptedTurnRunner;
  /** The owner's human author id — the `'local'` sentinel, or the bound account. */
  human: string;
  /**
   * Give this install an owner account, the way enabling login does.
   *
   * The live wiring reads ownership per check rather than capturing it, so this
   * is what lets a test drive the transition an install actually makes: rooms
   * and messages first, an account afterwards.
   *
   * @param userId - The owner's account id.
   * @returns The owner's author id, which does not change.
   */
  setOwner(userId: string): string;
  /**
   * Sweep the message index once.
   *
   * Rarely needed now: this harness wires the real write-through, so anything
   * posted THROUGH the service is already indexed when `post` returns, exactly
   * as it is in production (message-search spec Amendment 6). What still needs a
   * sweep is anything written around the service — rows inserted straight into
   * `room_entries` by a fixture, or a room whose entries predate the index — and
   * that is what this is for.
   */
  indexMessages(): Promise<void>;
}

/**
 * Wire a rooms subsystem over a fresh in-memory database.
 *
 * @param opts.agents - The agent table this install knows about. Pass a FUNCTION
 *   to build the lookup from the harness's own database — that is how a test
 *   about ghosts or a directory changing hands drives the reader that ships
 *   (`createAgentLookup`), so the handle seam and the author registry agree
 *   about which agent occupies a directory instead of agreeing by fixture.
 * @param opts.runner - The scripted runner; defaults to one that says "on it".
 * @param opts.maxAgentDepth - The cascade ceiling. Pinned to a literal on
 *   purpose — a test that read the same config the code reads could only prove
 *   the two agree, never that they agree on the right number.
 *
 *   **Every limit option here is the CONFIG rung of the ladder** (DOR-1429).
 *   The harness resolves limits through the real `resolveRoomLimits` over the
 *   real rooms table, so a test that writes an override onto a room — through
 *   `service.updateRoom` or `store.updateRoom` — beats whatever it passed here,
 *   exactly as a person setting one would.
 * @param opts.maxTurnsPerAgentPerCascade - How many automatic turns ONE agent
 *   may run inside one cascade. Defaults to **1**, which is the shape every
 *   scenario in this suite was written against and is still a real setting a
 *   person can choose: at 1 the repeat rule fires on an agent's second turn, so
 *   a two-agent ping-pong stops at the first repeat and a refusal is one message
 *   away in any test that wants one. A test ABOUT the counter pins its own N.
 * @param opts.turnLimitsEnabled - Whether automatic-reply limits apply at all,
 *   INSTALL-WIDE. Defaults to `true`, the shipped posture. A test that passes
 *   `false` is testing the unlimited path, where neither the guard nor either
 *   hourly cap is asked. A room that turns its OWN limits off is a different
 *   test: it still spends against the install's hourly total.
 *   Pass a FUNCTION to move it mid-test, the way the live config reader does —
 *   that is how a test proves an unlimited stretch left the hourly window
 *   unspent, by turning limits back on and finding the allowance intact.
 * @param opts.maxAutomaticTurnsPerRoomPerHour - The per-room spend cap. Also a
 *   literal, and high enough by default that it never silently masks a cascade
 *   test — a budget refusal and a guard refusal look alike from the outside.
 * @param opts.maxAutomaticTurnsTotalPerHour - The install-wide spend cap.
 * @param opts.budgetNow - The budget's own clock, so a test can roll the hourly
 *   window without sleeping for an hour. Only the BUDGET reads it; everything
 *   else in the room still runs on the wall clock, which is what a test about
 *   spending across a window boundary wants.
 * @param opts.engagedWindow - The two engaged-window ceilings. A literal for the
 *   same reason as the ceiling above, and shipped-default-shaped so a test that
 *   does not care about the window still gets the behaviour a person would.
 * @param opts.collect - The collect window (RP8). Defaults to a debounce of
 *   **zero**, which is the same gathering path the product runs and not a way
 *   round it: a collection still opens, still closes on its own macrotask, and
 *   still becomes exactly one turn. What zero removes is the WAIT, so a suite
 *   that is not about the window does not spend half a second per message
 *   proving a timer works. A test that IS about the window pins a real one.
 * @param opts.holdCeilingMs - How long a message waits on an agent busy in
 *   ANOTHER room before this room gives up on it and writes the one
 *   `held-too-long` line. Defaults to the shipped hour, so a test that is not
 *   about the bound never trips it; a test that IS about it pins a short one.
 * @param opts.maxAttachmentsPerEntry - How many files one message may carry.
 * @param opts.maxPostsPerTurn - How many messages one turn may post into a room.
 *   A literal for the same reason the ceilings above are: a test that read the
 *   same config the code reads could only prove the two agree.
 * @param opts.ownerUserId - The account that owns this install, when the test is
 *   about one. Omitted means "no accounts", which is the default posture and the
 *   one where the `'local'` author is the owner. Resolved through the real
 *   {@link AuthorRegistry.isOwner} rather than a stub, so a test proves the
 *   predicate that ships.
 */
export function createRoomHarness(opts: {
  agents: RoomAgentLookup | ((db: Db) => RoomAgentLookup);
  runner?: ScriptedTurnRunner;
  maxAgentDepth?: number;
  maxTurnsPerAgentPerCascade?: number;
  turnLimitsEnabled?: boolean | (() => boolean);
  maxAutomaticTurnsPerRoomPerHour?: number;
  maxAutomaticTurnsTotalPerHour?: number;
  engagedWindow?: EngagedWindow;
  /**
   * `rooms.responseGate`. Defaults to the SHIPPED value, so a test that says
   * nothing measures what an install does — a harness pinned to `'off'` would
   * make every room test a test of a configuration nobody runs.
   */
  responseGate?: ResponseGateMode;
  collect?: CollectWindow;
  holdCeilingMs?: number;
  maxAttachmentsPerEntry?: number;
  /** How many messages one agent may post into a room inside one turn. */
  maxPostsPerTurn?: number;
  /**
   * How many times one agent may change a room's canvas inside one turn.
   *
   * A FUNCTION as well as a number, because the shipped wiring reads it per
   * operation: a test that has to prove "moving it in Settings binds the very
   * next change" needs to move it mid-test, and a captured number could only
   * ever prove the code agrees with itself.
   */
  maxCanvasOpsPerTurn?: number | (() => number);
  /**
   * The clock the canvas judges an edit lock against.
   *
   * Defaults to the real one. A test about the lock's lazy TTL passes its own,
   * so the 45-second rule is measured rather than waited out.
   */
  canvasNow?: () => number;
  /**
   * The room's own shared checkout, for the canvas reader rule (§8.1).
   *
   * Defaults to "this install has no repo machinery", which is the state every
   * other test in this suite runs in.
   */
  roomRepoPath?: (roomId: string) => string | null;
  ownerUserId?: string;
  budgetNow?: () => number;
  /**
   * Which rooms the operator has muted, as a live predicate (spec
   * `notification-system` task T11) — defaults to "nothing is muted", the same
   * default the live config reader degrades to. A test about mute passes its
   * own, over a `Set` it can mutate mid-test the way a real toggle would.
   */
  isRoomMuted?: (roomId: string) => boolean;
  /**
   * The message-index write-through, for the one test that needs it to FAIL.
   *
   * Defaults to the real one over this harness's own database. A test proving
   * that a broken index cannot break a room post passes a function that throws
   * — which is the only way to drive that guard, since the shipped
   * implementation is the thing that promises never to throw.
   */
  indexEntry?: RoomEntryIndexer;
  /**
   * The message-index READER, for the tests that need to know whether it was
   * asked at all.
   *
   * Defaults to the real one over this harness's own database — which is what
   * every scope test wants, since a fake finder would make the scope rules a
   * test of the fake. A test that asserts a query was SHORT-CIRCUITED passes a
   * spy instead: "returns nothing" and "never asked" are different claims, and
   * an empty result cannot tell them apart.
   */
  findMessages?: RoomMessageFinder;
  /**
   * The install's room-worktree manager, for the project-room tests.
   *
   * Absent — the default — is an install with no repo machinery, where every
   * turn runs in the agent's own directory exactly as it did before the cwd rung
   * existed. That default is what keeps every other test in this suite a test of
   * the behavior it was written for.
   */
  worktrees?: () => RoomWorktreeManager | null;
  /** Persisted remote-cache authorization, for RoomService integration tests. */
  mirrorAccess?: RoomMirrorAccess;
  /** Trusted remote-mirror delivery policy, for real writer transaction tests. */
  mirrorWrites?: RoomMirrorWritePolicy;
}): RoomHarness {
  const db = createTestDb();
  const agentLookup = typeof opts.agents === 'function' ? opts.agents(db) : opts.agents;
  const authors = new AuthorRegistry(db, agentLookup);
  const runner = opts.runner ?? scriptedRunner();
  const maxAgentDepth = opts.maxAgentDepth ?? 3;
  const maxTurnsPerAgentPerCascade = opts.maxTurnsPerAgentPerCascade ?? 1;
  const limitsOption = opts.turnLimitsEnabled ?? true;
  const turnLimitsEnabled: () => boolean =
    typeof limitsOption === 'function' ? limitsOption : () => limitsOption;
  const perRoom = opts.maxAutomaticTurnsPerRoomPerHour ?? 1_000;
  const global = opts.maxAutomaticTurnsTotalPerHour ?? 100_000;
  const engagedWindow = opts.engagedWindow ?? { minutes: 10, posts: 5 };
  const responseGate = opts.responseGate ?? USER_CONFIG_DEFAULTS.rooms.responseGate;
  const collect = opts.collect ?? { debounceMs: 0, maxEntries: 20 };
  const holdCeilingMs = opts.holdCeilingMs ?? 60 * 60_000;
  const maxAttachmentsPerEntry = opts.maxAttachmentsPerEntry ?? 10;
  const isRoomMuted = opts.isRoomMuted ?? (() => false);
  // Mutable so `setOwner` can drive the transition, and read per check the way
  // the live wiring reads it — an install becomes owned partway through its life.
  let ownerUserId = opts.ownerUserId ?? null;
  const store = new RoomStore(db);
  const reactions = new ReactionStore(db);
  const canvasDocuments = new CanvasDocumentStore(db);
  const attachments = new AttachmentRowStore(db);
  const bridges = new BridgeStore(db);
  const readCursors = new ReadCursorService(new ReadCursorStore(db));
  // The REAL ladder over the REAL rooms table, with this harness's options
  // standing in for the config rung — composed exactly as `createRoomSubsystem`
  // composes it. A stub resolver here would make every per-room-override test a
  // test of the stub, and the whole point of an override is that the store rung
  // beats the config rung.
  const limitsFor: RoomLimitsResolver = (roomId) =>
    resolveRoomLimits(store.getRoom(roomId), {
      turnLimitsEnabled: turnLimitsEnabled(),
      maxAgentDepth,
      maxTurnsPerAgentPerCascade,
      maxAutomaticTurnsPerRoomPerHour: perRoom,
    });
  const broadcaster = new RoomBroadcaster();
  // The REAL writer, composed the way `createRoomSubsystem` composes it, so the
  // room suites exercise the shared service rather than a stand-in.
  const canvas = new CanvasService({
    documents: canvasDocuments,
    channels: {
      publish: (scope, frame) => {
        const parsed = parseScope(scope);
        if (parsed.kind === 'room') broadcaster.publish(parsed.id, frame);
        else if (parsed.kind === 'session') publishSessionCanvas(parsed.id, frame);
      },
      viewers: (scope) => {
        const parsed = parseScope(scope);
        if (parsed.kind === 'room') return broadcaster.subscriberCount(parsed.id);
        if (parsed.kind === 'session') return sessionCanvasViewers(parsed.id);
        return 0;
      },
    },
    displayNameFor: (authorId) => authors.getById(authorId)?.displayName ?? 'Somebody',
    ...(opts.canvasNow ? { now: opts.canvasNow } : {}),
  });
  setCanvasService(canvas);
  const service = new RoomService({
    store,
    ...(opts.mirrorAccess ? { mirrorAccess: opts.mirrorAccess } : {}),
    ...(opts.mirrorWrites ? { mirrorWrites: opts.mirrorWrites } : {}),
    reactions,
    canvasDocuments,
    canvas,
    attachments,
    authors,
    broadcaster,
    bridges,
    agents: agentLookup,
    turns: runner,
    ...(opts.worktrees ? { worktrees: opts.worktrees } : {}),
    budget: new RoomTurnBudget({
      db,
      // Wired like production: the per-room ceiling comes through the ladder so
      // a room's own override binds it, and the global one never does — a room
      // opts out of its own bounds, not out of the install's wallet.
      limits: {
        perRoom: (roomId) => {
          const limits = limitsFor(roomId);
          return limits.turnLimitsEnabled ? limits.maxAutoTurnsPerHour : null;
        },
        global: () => (turnLimitsEnabled() ? global : null),
      },
      ...(opts.budgetNow && { now: opts.budgetNow }),
    }),
    // The real budget over the real reaction rows, on the same clock the turn
    // budget takes — so a test can roll an hour without sleeping for one. The
    // ceiling is deliberately NOT overridable here: a reaction test that set its
    // own would only ever prove the code agrees with itself.
    reactionBudget: new ReactionBudget({
      db,
      ...(opts.budgetNow && { now: opts.budgetNow }),
    }),
    // The REAL index reader over the REAL index, composed exactly as
    // `createRoomSubsystem` composes it. A fake finder here would make every
    // `search_room_history` test a test of the fake — including the scope rules,
    // which are the half worth proving. `indexMessages()` below is what puts rows
    // in front of it.
    findMessages:
      opts.findMessages ??
      (({ rooms: scoped, query, limit }) =>
        searchMessages(db, {
          scopes: [
            {
              sourceId: roomsSource.id,
              visibility: 'containers',
              containers: scoped.map((room) => ({
                originKey: room.roomId,
                afterOrdinal: room.afterSeq,
              })),
            },
          ],
          query,
          limit,
        }).map((hit) => ({ roomId: hit.originKey, seq: hit.ordinal }))),
    // The REAL write-through too, for the same reason: it is what puts a posted
    // entry in front of the finder above without anybody sweeping, and a no-op
    // here would make every `search_history` test silently depend on the
    // explicit `indexMessages()` that production does not have.
    indexEntry: opts.indexEntry ?? (({ roomId, seq }) => indexRoomEntry(db, roomId, seq)),
    limitsFor,
    engagedWindow: () => engagedWindow,
    responseGate: () => responseGate,
    collect: () => collect,
    holdCeilingMs: () => holdCeilingMs,
    maxAttachmentsPerEntry: () => maxAttachmentsPerEntry,
    maxPostsPerTurn: () => opts.maxPostsPerTurn ?? 3,
    maxCanvasOpsPerTurn: () => {
      const option = opts.maxCanvasOpsPerTurn;
      if (typeof option === 'function') return option();
      return option ?? 3;
    },
    // No repo machinery by default, which is an install where no room has a
    // shared tree — so every file document on a canvas belongs to whoever opened
    // it, and §8.1's reader rule is exercised in its narrow form.
    roomRepoPath: opts.roomRepoPath ?? (() => null),
    ...(opts.canvasNow ? { canvasNow: opts.canvasNow } : {}),
    isOwnerAuthor: (authorId) => authors.isOwner(authorId, ownerUserId),
    isOwnerRecord: (record) => isOwnerRecord(record, ownerUserId),
    isOwnerVoice: (authorId) => authors.isOwnerVoice(authorId, ownerUserId),
    readCursors,
    isRoomMuted,
  });
  // **The runner's voice, bound now that there is something to speak through.**
  // A scripted turn says what it says by calling the real posting capability,
  // exactly as an agent does, so it needs the service — which is built here,
  // after the runner (`turns: runner` above is why the order cannot flip).
  runner.speaksThrough(service);
  const human = ownerUserId === null ? authors.localHuman() : authors.bindOwner(ownerUserId);
  return {
    db,
    service,
    store,
    reactions,
    canvasDocuments,
    broadcaster,
    attachments,
    authors,
    bridges,
    readCursors,
    runner,
    human: human.id,
    setOwner(userId) {
      ownerUserId = userId;
      return authors.bindOwner(userId).id;
    },
    async indexMessages() {
      await new SearchIndexer(db, [roomsSource]).sweep();
    },
  };
}
