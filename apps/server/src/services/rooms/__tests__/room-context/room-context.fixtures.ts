/**
 * What an agent is actually told about the room it is answering in.
 *
 * Driven through the REAL service and the REAL dispatcher, so every assertion
 * here is about the context a live trigger produces — the roster comes from the
 * store, `working` comes from the dispatcher's own claim map, and the budget
 * numbers come from the counter that charged this very turn. Reaching for
 * `buildRoomContext` directly would prove the function composes and nothing
 * about what a message in a room causes.
 *
 * The one substitution is the runner, because the alternative is a model call.
 *
 * @module room-context/room-context.fixtures
 */

import { type Db } from '@dorkos/db';
import type { RoomContextData } from '@dorkos/shared/additional-context';
import type { ResponseMode } from '@dorkos/shared/mesh-schemas';
import type { RoomWithRoster } from '@dorkos/shared/room-schemas';
import type { AuthorRegistry } from '../../author-registry.js';
import type { AttachmentRowStore } from '../../attachments/attachment-row-store.js';
import type { RoomService } from '../../room-service.js';
import {
  agentLookupFor,
  createRoomHarness,
  scriptedRunner,
  type ScriptedTurnRunner,
} from '../room-test-harness.js';

/**
 * The ceiling these tests measure against, pinned to a literal for the same
 * reason `cascade-guard.test.ts` pins it: a test reading the value the code
 * reads could only prove the two agree, never that they agree on the right one.
 */
export const MAX_AGENT_DEPTH = 3;

/** A pinned fence nonce, so an assertion can name the real marker. */
export const FENCE_NONCE = 'bbbb2222';

/**
 * How many top-level channel entries ride a thread turn, pinned to a literal for
 * the reason {@link MAX_AGENT_DEPTH} is: reading the constant the code reads
 * could only prove the two agree, never that they agree on the right number.
 */
export const CHANNEL_TAIL_MAX = 5;

/**
 * The channel-tail marker as this turn mints it. Spelled out here rather than
 * imported for the reason above, and because the point of the assertions using
 * it is that the NONCE is in the line: a test importing the bare label could
 * pass against a marker anybody could type.
 */
export const TAIL_MARK = `--- ${FENCE_NONCE} RECENT IN THE MAIN CHANNEL ---`;

export const agents = agentLookupFor({
  '/agents/ana': { name: 'ana', displayName: 'Ana', responseMode: 'always' },
  '/agents/bo': { name: 'bo', displayName: 'Bo', responseMode: 'always' },
  '/agents/cy': { name: 'cy', displayName: 'Cy', responseMode: 'always' },
});

export let service: RoomService;
export let authors: AuthorRegistry;
export let runner: ScriptedTurnRunner;
export let room: RoomWithRoster;
export let human: string;
export let ana: string;
export let bo: string;
export let cy: string;
export let attachments: AttachmentRowStore;
export let db: Db;

/**
 * Open a channel holding `agentPaths`, every one of them answering always.
 *
 * @param opts.agentPaths - Who is in the room.
 * @param opts.runner - The stand-in for the turn machinery.
 * @param opts.perRoomBudget - The room's hourly automatic-turn cap.
 * @param opts.responseMode - How every agent in the room answers. `always` by
 *   default, which is the simplest thing to reason about — but note what it
 *   costs a test about `pending`: an `always` agent takes a turn on EVERY
 *   message, and a turn advances its read cursor to the entry it is answering
 *   (spec §8.3), so it has nothing unread by construction. A scenario that
 *   needs a backlog has to be one the agent was not woken for, which is what
 *   `mention-only` here buys.
 */
export function open(
  opts: {
    agentPaths?: string[];
    runner?: ScriptedTurnRunner;
    perRoomBudget?: number;
    responseMode?: ResponseMode;
  } = {}
): void {
  const agentPaths = opts.agentPaths ?? ['/agents/ana'];
  ({ service, authors, attachments, runner, human, db } = createRoomHarness({
    agents,
    runner: opts.runner ?? scriptedRunner(() => null),
    maxAgentDepth: MAX_AGENT_DEPTH,
    maxAutomaticTurnsPerRoomPerHour: opts.perRoomBudget,
  }));
  room = service.createRoom(
    { kind: 'channel', title: 'Backend', topic: 'shipping v1', members: [], agentPaths },
    human
  );
  // No lead: this case is about the context a turn derives, and a lead would
  // answer the unaddressed post (DOR-2823).
  service.updateRoom(room.id, human, { leadAuthorId: null });
  ana = authors.resolveAgent('/agents/ana', 'Ana').id;
  bo = authors.resolveAgent('/agents/bo', 'Bo').id;
  cy = authors.resolveAgent('/agents/cy', 'Cy').id;
  // A channel seeds `engaged`; these tests want the mode explicit.
  const mode = opts.responseMode ?? 'always';
  for (const [path, authorId] of [
    ['/agents/ana', ana],
    ['/agents/bo', bo],
    ['/agents/cy', cy],
  ] as const) {
    if (agentPaths.includes(path)) service.updateMembership(room.id, human, authorId, mode);
  }
}

/** Post as the person and wait for every turn it sets off. */
export async function say(text: string): Promise<void> {
  service.post(room.id, { authorId: human, text });
  await service.triggersIdle();
}

/** The context handed to one agent's most recent turn. */
export function contextFor(authorId: string): RoomContextData {
  const turns = runner.turns.filter((turn) => turn.authorId === authorId);
  if (turns.length === 0) throw new Error('that agent was never triggered');
  return turns[turns.length - 1].roomContext;
}
