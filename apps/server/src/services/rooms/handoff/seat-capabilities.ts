/**
 * The verbs about an agent's seat in a room: moving it (`reseat-capabilities.ts`), and reading how
 * a hand-off to it went (DOR-3778).
 *
 * @module server/services/rooms/handoff/seat-capabilities
 */
import { z } from 'zod';
import { defineCapability } from '../../core/capabilities/index.js';
import type { AuthorRecord } from '../author-registry.js';
import { reseatCapabilities } from '../reseat/reseat-capabilities.js';
import { callerAuthor } from '../service/room-caller-author.js';
import { answering, isOwnerCaller, requireRoomDeps } from '../service/room-capability-answers.js';

/** Read how a hand-off went, by the id `post_to_room` gave back. */
const handoffStatusCapability = defineCapability({
  id: 'rooms.handoff_status',
  title: 'Check a hand-off',
  description:
    'See how a post you handed to your room chat went, by the handoffId your post came back ' +
    'with: pending and why, posted with its entry, or declined with the reason. It reads only, ' +
    'and only your own hand-offs.',
  tier: 'observe',
  area: null,
  areaNote: 'reading',
  input: z.object({
    handoffId: z.string().describe('The handoffId your post came back with.'),
  }),
  output: z.unknown(),
  surfaces: {
    mcp: {
      toolName: 'room_handoff_status',
      // A hand-off only ever comes from a verified in-session chat: the external server has no
      // seat to compare, and posts as written.
      servers: ['in-session'],
      annotations: { idempotentHint: true },
    },
  },
  invoke: async (deps, input, context) => {
    const rooms = requireRoomDeps(deps);
    let caller: AuthorRecord | undefined;
    return answering(
      () => {
        caller = callerAuthor(rooms, context);
        return rooms.handoffs.outcomes.read(input.handoffId, caller.id);
      },
      () => isOwnerCaller(caller)
    );
  },
});

/** Every seat verb, appended to the rooms domain. */
export const seatCapabilities = [...reseatCapabilities, handoffStatusCapability];
