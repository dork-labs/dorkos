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
      });
      return Promise.resolve({
        sessionId: request.sessionId ?? `session-${(minted += 1)}`,
        text: reply(request),
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
  /** The local human author id. */
  human: string;
}

/**
 * Wire a rooms subsystem over a fresh in-memory database.
 *
 * @param opts.agents - The agent table this install knows about.
 * @param opts.runner - The scripted runner; defaults to one that says "on it".
 * @param opts.maxAgentDepth - The cascade ceiling. Pinned to a literal on
 *   purpose — a test that read the same config the code reads could only prove
 *   the two agree, never that they agree on the right number.
 * @param opts.maxAutomaticTurnsPerHour - The posture-independent budget. Also a
 *   literal, and high enough by default that it never silently masks a cascade
 *   test — a budget refusal and a guard refusal look alike from the outside.
 */
export function createRoomHarness(opts: {
  agents: RoomAgentLookup;
  runner?: ScriptedTurnRunner;
  maxAgentDepth?: number;
  maxAutomaticTurnsPerHour?: number;
}): RoomHarness {
  const db = createTestDb();
  const authors = new AuthorRegistry(db);
  const runner = opts.runner ?? scriptedRunner();
  const maxAgentDepth = opts.maxAgentDepth ?? 3;
  const maxPerWindow = opts.maxAutomaticTurnsPerHour ?? 1_000;
  const service = new RoomService({
    store: new RoomStore(db),
    authors,
    broadcaster: new RoomBroadcaster(),
    agents: opts.agents,
    turns: runner,
    budget: new RoomTurnBudget({ maxPerWindow: () => maxPerWindow }),
    maxAgentDepth: () => maxAgentDepth,
  });
  return { db, service, authors, runner, human: authors.localHuman().id };
}
