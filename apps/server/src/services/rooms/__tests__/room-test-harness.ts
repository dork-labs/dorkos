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
import { AuthorRegistry } from '../author-registry.js';
import type { RoomAgent, RoomAgentLookup } from '../room-errors.js';
import { RoomService } from '../room-service.js';
import { RoomStore } from '../room-store.js';
import { RoomBroadcaster } from '../room-stream.js';
import { RoomTurnBudget } from '../turn-budget.js';
import type { RoomTurnRequest, RoomTurnResult, RoomTurnRunner } from '../room-trigger.js';

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
 * @param outcome - The whole turn result, minus the session id.
 * @param outcome.throws - Throw instead of returning, for the runtime-is-down path.
 */
export function outcomeRunner(
  outcome: (request: RoomTurnRequest) => Omit<RoomTurnResult, 'sessionId'> | { throws: Error }
): ScriptedTurnRunner {
  const turns: RecordedTurn[] = [];
  let minted = 0;
  return {
    turns,
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
      return Promise.resolve({
        sessionId: request.sessionId ?? `session-${(minted += 1)}`,
        ...result,
      });
    },
  };
}

/** An agent lookup over a fixed table, filled in with render defaults. */
export function agentLookupFor(
  table: Record<string, Partial<RoomAgent> & { name: string }>
): RoomAgentLookup {
  return {
    byPath: (agentPath) => {
      const agent = table[agentPath];
      if (!agent) return null;
      return {
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
  authors: AuthorRegistry;
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
 * @param opts.agents - The agent table this install knows about.
 * @param opts.runner - The scripted runner; defaults to one that says "on it".
 * @param opts.maxAgentDepth - The cascade ceiling. Pinned to a literal on
 *   purpose — a test that read the same config the code reads could only prove
 *   the two agree, never that they agree on the right number.
 * @param opts.maxAutomaticTurnsPerRoomPerHour - The per-room spend cap. Also a
 *   literal, and high enough by default that it never silently masks a cascade
 *   test — a budget refusal and a guard refusal look alike from the outside.
 * @param opts.maxAutomaticTurnsTotalPerHour - The install-wide spend cap.
 * @param opts.ownerUserId - The account that owns this install, when the test is
 *   about one. Omitted means "no accounts", which is the default posture and the
 *   one where the `'local'` author is the owner. Resolved through the real
 *   {@link AuthorRegistry.isOwner} rather than a stub, so a test proves the
 *   predicate that ships.
 */
export function createRoomHarness(opts: {
  agents: RoomAgentLookup;
  runner?: ScriptedTurnRunner;
  maxAgentDepth?: number;
  maxAutomaticTurnsPerRoomPerHour?: number;
  maxAutomaticTurnsTotalPerHour?: number;
  ownerUserId?: string;
}): RoomHarness {
  const db = createTestDb();
  const authors = new AuthorRegistry(db);
  const runner = opts.runner ?? scriptedRunner();
  const maxAgentDepth = opts.maxAgentDepth ?? 3;
  const perRoom = opts.maxAutomaticTurnsPerRoomPerHour ?? 1_000;
  const global = opts.maxAutomaticTurnsTotalPerHour ?? 100_000;
  // Mutable so `setOwner` can drive the transition, and read per check the way
  // the live wiring reads it — an install becomes owned partway through its life.
  let ownerUserId = opts.ownerUserId ?? null;
  const service = new RoomService({
    store: new RoomStore(db),
    authors,
    broadcaster: new RoomBroadcaster(),
    agents: opts.agents,
    turns: runner,
    budget: new RoomTurnBudget({ limits: { perRoom: () => perRoom, global: () => global } }),
    maxAgentDepth: () => maxAgentDepth,
    isOwnerAuthor: (authorId) => authors.isOwner(authorId, ownerUserId),
  });
  const human = ownerUserId === null ? authors.localHuman() : authors.bindOwner(ownerUserId);
  return {
    db,
    service,
    authors,
    runner,
    human: human.id,
    setOwner(userId) {
      ownerUserId = userId;
      return authors.bindOwner(userId).id;
    },
  };
}
