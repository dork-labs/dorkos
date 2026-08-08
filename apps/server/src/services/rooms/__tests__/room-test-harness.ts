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
import type { Db } from '@dorkos/db';
import { BridgeStore } from '../../relay/chat-bridge/bridge-store.js';
import { ReadCursorService } from '../../core/read-cursor-service.js';
import { ReadCursorStore } from '../../core/read-cursor-store.js';
import { AuthorRegistry } from '../author-registry.js';
import type { EngagedWindow } from '../engagement.js';
import { ReactionStore } from '../reaction-store.js';
import type { RoomAgent, RoomAgentLookup } from '../room-errors.js';
import { RoomService } from '../room-service.js';
import { RoomStore } from '../room-store.js';
import { RoomBroadcaster } from '../room-stream.js';
import { RoomTurnBudget } from '../turn-budget.js';
import type { RoomTurnRequest, RoomTurnResult, RoomTurnRunner } from '../room-trigger.js';

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
  prompt: string;
  /** What the agent was told about the room — derived by the real dispatcher. */
  roomContext: RoomContextData;
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
    interrupt(request): Promise<void> {
      interrupted.push(request);
      return Promise.resolve();
    },
    run(request: RoomTurnRequest): Promise<RoomTurnResult> {
      turns.push({
        roomId: request.room.id,
        authorId: request.authorId,
        agentPath: request.agentPath,
        sessionId: request.sessionId,
        prompt: request.entry.body.text,
        roomContext: request.roomContext,
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
 * @param opts.maxAutomaticTurnsPerRoomPerHour - The per-room spend cap. Also a
 *   literal, and high enough by default that it never silently masks a cascade
 *   test — a budget refusal and a guard refusal look alike from the outside.
 * @param opts.maxAutomaticTurnsTotalPerHour - The install-wide spend cap.
 * @param opts.engagedWindow - The two engaged-window ceilings. A literal for the
 *   same reason as the ceiling above, and shipped-default-shaped so a test that
 *   does not care about the window still gets the behaviour a person would.
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
  maxAutomaticTurnsPerRoomPerHour?: number;
  maxAutomaticTurnsTotalPerHour?: number;
  engagedWindow?: EngagedWindow;
  ownerUserId?: string;
}): RoomHarness {
  const db = createTestDb();
  const agentLookup = typeof opts.agents === 'function' ? opts.agents(db) : opts.agents;
  const authors = new AuthorRegistry(db, agentLookup);
  const runner = opts.runner ?? scriptedRunner();
  const maxAgentDepth = opts.maxAgentDepth ?? 3;
  const perRoom = opts.maxAutomaticTurnsPerRoomPerHour ?? 1_000;
  const global = opts.maxAutomaticTurnsTotalPerHour ?? 100_000;
  const engagedWindow = opts.engagedWindow ?? { minutes: 10, posts: 5 };
  // Mutable so `setOwner` can drive the transition, and read per check the way
  // the live wiring reads it — an install becomes owned partway through its life.
  let ownerUserId = opts.ownerUserId ?? null;
  const store = new RoomStore(db);
  const reactions = new ReactionStore(db);
  const bridges = new BridgeStore(db);
  const readCursors = new ReadCursorService(new ReadCursorStore(db));
  const service = new RoomService({
    store,
    reactions,
    authors,
    broadcaster: new RoomBroadcaster(),
    bridges,
    agents: agentLookup,
    turns: runner,
    budget: new RoomTurnBudget({ limits: { perRoom: () => perRoom, global: () => global } }),
    maxAgentDepth: () => maxAgentDepth,
    engagedWindow: () => engagedWindow,
    isOwnerAuthor: (authorId) => authors.isOwner(authorId, ownerUserId),
    readCursors,
  });
  const human = ownerUserId === null ? authors.localHuman() : authors.bindOwner(ownerUserId);
  return {
    db,
    service,
    store,
    reactions,
    authors,
    bridges,
    readCursors,
    runner,
    human: human.id,
    setOwner(userId) {
      ownerUserId = userId;
      return authors.bindOwner(userId).id;
    },
  };
}
