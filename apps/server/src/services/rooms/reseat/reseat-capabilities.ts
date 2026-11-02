/**
 * The by-hand half of re-seating (Re-seat P0): `rooms.reseat` moves an agent's
 * seat in a room or DM to another Claude account, and `rooms.reseat_options`
 * lists where it could go. The automatic move needs neither; these are for a
 * person who wants to move an agent before it runs out, or to a particular
 * account.
 *
 * **People only, for now** (Security Must 5). A tool that lets an agent spend
 * another account widens what agents can do, so it waits for Dorian's own yes.
 * The single check is `mayReseatByHand`, asked by `RoomTurnControl.reseatAgent`;
 * this file only tells it whether the calling turn is marked.
 *
 * @module services/rooms/reseat/reseat-capabilities
 */
import { z } from 'zod';
import { defineCapability, type CapabilityHandlerContext } from '../../core/capabilities/index.js';
import { marksHold } from '../../core/turn-power/turn-marks.js';
import { marksOf } from '../../core/turn-power/turn-levels.js';
import type { AuthorRecord } from '../author-registry.js';
import { callerAuthor } from '../service/room-caller-author.js';
import {
  answeringAsync,
  isOwnerCaller,
  requireRoomDeps,
} from '../service/room-capability-answers.js';

const roomIdField = z
  .string()
  .describe('The room or DM, by its id — not its #name. You must be able to see it.');
const agentIdField = z
  .string()
  .describe('The agent member whose seat moves, by its author id from the room’s roster.');

/** Whether the calling turn read words from outside the owner's circle. */
function callingTurnMarked(context: CapabilityHandlerContext): boolean {
  return marksHold(marksOf(context.sessionId, context.identity?.agentPath));
}

/** The by-hand re-seat verbs, appended to the rooms domain. */
export const reseatCapabilities = [
  defineCapability({
    id: 'rooms.reseat_options',
    title: 'See where an agent could move',
    description:
      'List the Claude accounts an agent in a room or DM could move to, best first, with the ' +
      'account it runs on now. Each says whether it can take the agent now and why not. ' +
      'DorkOS credits are never listed: only a person picks them, in the chat itself.',
    tier: 'observe',
    area: null,
    areaNote: 'a read of where an agent could move; the move itself is in Rooms',
    input: z.object({ roomId: roomIdField, agentId: agentIdField }),
    output: z.unknown(),
    surfaces: {
      mcp: {
        toolName: 'reseat_room_agent_options',
        // External only while moving is people-only: an agent's own tool list
        // carries no verb it cannot use. In-session joins with the agent switch.
        servers: ['external'],
      },
      http: { method: 'get', path: '/api/rooms/{roomId}/members/{agentId}/reseat-options' },
    },
    invoke: (deps, input, context) => {
      const rooms = requireRoomDeps(deps);
      let caller: AuthorRecord | undefined;
      return answeringAsync(
        () => {
          caller = callerAuthor(rooms, context);
          return rooms.reseatOptions(input.roomId, input.agentId, caller.id);
        },
        () => isOwnerCaller(caller)
      );
    },
  }),
  defineCapability({
    id: 'rooms.reseat',
    title: 'Move an agent to another account',
    description:
      'Move an agent’s seat in a room or DM to another Claude account, so it keeps answering ' +
      'there. Its next turn starts fresh on that account, with a summary of where it was, the ' +
      'same power and the same marks. Name an account from the options, or leave it ' +
      'out for the one with the most usage left. The room gets one line saying so. ' +
      'Only a person may move an agent for now.',
    tier: 'act',
    area: 'rooms',
    // Not the agent's id: a card shows one resolved subject, the room, and an
    // author id would read as a string of letters.
    approvalDisplayFields: ['roomId', 'account'],
    approvalSubject: { field: 'roomId', kind: 'room' },
    input: z.object({
      roomId: roomIdField,
      agentId: agentIdField,
      account: z
        .string()
        .optional()
        .describe('The account to move to, by id from the options. Left out: the best one.'),
    }),
    output: z.unknown(),
    surfaces: {
      mcp: {
        toolName: 'reseat_room_agent',
        servers: ['external'],
        // Not idempotent: each call starts another fresh session.
        annotations: { idempotentHint: false },
      },
      http: { method: 'post', path: '/api/rooms/{roomId}/members/{agentId}/reseat' },
    },
    invoke: (deps, input, context) => {
      const rooms = requireRoomDeps(deps);
      let caller: AuthorRecord | undefined;
      return answeringAsync(
        async () => {
          caller = callerAuthor(rooms, context);
          const moved = await rooms.reseatAgent(input.roomId, input.agentId, caller.id, {
            ...(input.account !== undefined ? { accountId: input.account } : {}),
            markedTurn: callingTurnMarked(context),
          });
          return { moved: true, ...moved };
        },
        () => isOwnerCaller(caller)
      );
    },
  }),
];
