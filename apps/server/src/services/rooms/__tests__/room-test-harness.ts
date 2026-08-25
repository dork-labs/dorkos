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
import type { RoomContextData } from '@dorkos/shared/additional-context';
import type { ProjectableAttachment } from '../room-context.js';
import type { Db } from '@dorkos/db';
import { BridgeStore } from '../../relay/chat-bridge/bridge-store.js';
import { ReadCursorService } from '../../core/read-cursor-service.js';
import { ReadCursorStore } from '../../core/read-cursor-store.js';
import { roomsSource, searchMessages, SearchIndexer } from '../../search/index.js';
import { AuthorRegistry, isOwnerRecord } from '../author-registry.js';
import type { EngagedWindow } from '../engagement.js';
import type { CollectWindow } from '../room-collect.js';
import { ReactionBudget } from '../reactions/reaction-budget.js';
import { ReactionStore } from '../reactions/reaction-store.js';
import { AttachmentRowStore } from '../attachments/attachment-row-store.js';
import type { RoomAgent, RoomAgentLookup } from '../room-errors.js';
import { RoomService } from '../room-service.js';
import { RoomStore } from '../room-store.js';
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
  agentPath: string;
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
}

/**
 * Build a runner that replies with `reply(request)` for every turn, minting a
 * session id the first time each `(room, agent)` pair answers.
 *
 * @param reply - What the agent says. Return `null` to say nothing.
 */
export function scriptedRunner(
  reply: (request: RoomTurnRequest) => string | null = () => 'on it'
): ScriptedTurnRunner {
  return outcomeRunner((request) => ({ text: reply(request) }));
}

/**
 * The same runner, for the outcomes a reply string cannot express: a session
 * that was busy, a turn that failed, an answer still on its way.
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
  let minted = 0;
  return {
    turns,
    interrupted,
    interrupt(request): Promise<boolean> {
      interrupted.push(request);
      // Nothing is being held here, so nothing was stopped — the honest answer
      // for a runner whose turns are already over by the time a halt runs.
      return Promise.resolve(false);
    },
    run(request: RoomTurnRequest): Promise<RoomTurnResult> {
      turns.push({
        roomId: request.room.id,
        authorId: request.authorId,
        agentPath: request.agentPath,
        sessionId: request.sessionId,
        prompt: request.prompt,
        roomContext: request.roomContext,
        attachmentProjection: request.attachmentProjection,
      });
      const result = outcome(request);
      if ('throws' in result) return Promise.reject(result.throws);
      const { sessionId: ranOn, ...reply } = result;
      return Promise.resolve({
        sessionId: ranOn ?? request.sessionId ?? `session-${(minted += 1)}`,
        ...reply,
      });
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
  const held = new Map<
    string,
    Array<{ request: RoomTurnRequest; finish: () => void; stop: () => void }>
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
    interrupt(request): Promise<boolean> {
      interrupted.push(request);
      // The stop reached a runtime with no turn bound to it — it stopped
      // nothing, and says so (DOR-1424, DOR-1425).
      if (interruptFindsNothing) return Promise.resolve(false);
      // A real interrupt ENDS the turn: the runtime stops, the stream closes,
      // and the collector resolves with whatever there was. A fake that only
      // recorded the call would leave the dispatcher awaiting a turn nothing can
      // finish — which is not what a halt does, and would let a halt that never
      // reached the runtime pass.
      if (!interruptEndsTurn) return Promise.resolve(true);
      let stoppedSomething = false;
      for (const [authorId, queued] of held) {
        if (queued[0]?.request.agentPath !== request.agentPath) continue;
        for (const turn of queued.splice(0)) turn.stop();
        held.delete(authorId);
        stoppedSomething = true;
      }
      return Promise.resolve(stoppedSomething);
    },
    run(request: RoomTurnRequest): Promise<RoomTurnResult> {
      turns.push({
        roomId: request.room.id,
        authorId: request.authorId,
        agentPath: request.agentPath,
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
      /** Park this turn's two endings where the test's levers can reach them. */
      const park = (finish: () => void, stop: () => void): void => {
        const queued = held.get(request.authorId) ?? [];
        queued.push({ request, finish, stop });
        held.set(request.authorId, queued);
      };
      if (answersLate) {
        // The room stopped WAITING and the turn did not stop: `run` resolves now
        // with no text, and the answer lands on `late` when the test says so.
        return Promise.resolve({
          sessionId,
          text: null,
          late: new Promise<LateRoomReply>((resolve) => {
            park(
              () => resolve({ text: 'on it', waitedMs: 1 }),
              () => resolve({ text: stoppedText, waitedMs: 1 })
            );
          }),
        });
      }
      return new Promise<RoomTurnResult>((resolve) => {
        park(
          () => resolve({ sessionId, text: 'on it' }),
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
   * Sweep the message index once, so a `searchHistory` test has something to find.
   *
   * In production a background indexer does this every few minutes; a test does
   * it explicitly, which also makes the staleness the tool documents visible
   * rather than magical — nothing posted after the last call is findable.
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
  collect?: CollectWindow;
  holdCeilingMs?: number;
  maxAttachmentsPerEntry?: number;
  ownerUserId?: string;
  budgetNow?: () => number;
  /**
   * Which rooms the operator has muted, as a live predicate (spec
   * `notification-system` task T11) — defaults to "nothing is muted", the same
   * default the live config reader degrades to. A test about mute passes its
   * own, over a `Set` it can mutate mid-test the way a real toggle would.
   */
  isRoomMuted?: (roomId: string) => boolean;
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
  const collect = opts.collect ?? { debounceMs: 0, maxEntries: 20 };
  const holdCeilingMs = opts.holdCeilingMs ?? 60 * 60_000;
  const maxAttachmentsPerEntry = opts.maxAttachmentsPerEntry ?? 10;
  const isRoomMuted = opts.isRoomMuted ?? (() => false);
  // Mutable so `setOwner` can drive the transition, and read per check the way
  // the live wiring reads it — an install becomes owned partway through its life.
  let ownerUserId = opts.ownerUserId ?? null;
  const store = new RoomStore(db);
  const reactions = new ReactionStore(db);
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
  const service = new RoomService({
    store,
    reactions,
    attachments,
    authors,
    broadcaster: new RoomBroadcaster(),
    bridges,
    agents: agentLookup,
    turns: runner,
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
    findMessages: ({ rooms: scoped, query, limit }) =>
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
      }).map((hit) => ({ roomId: hit.originKey, seq: hit.ordinal })),
    limitsFor,
    engagedWindow: () => engagedWindow,
    collect: () => collect,
    holdCeilingMs: () => holdCeilingMs,
    maxAttachmentsPerEntry: () => maxAttachmentsPerEntry,
    isOwnerAuthor: (authorId) => authors.isOwner(authorId, ownerUserId),
    isOwnerRecord: (record) => isOwnerRecord(record, ownerUserId),
    readCursors,
    isRoomMuted,
  });
  const human = ownerUserId === null ? authors.localHuman() : authors.bindOwner(ownerUserId);
  return {
    db,
    service,
    store,
    reactions,
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
