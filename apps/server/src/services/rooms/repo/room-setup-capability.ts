/**
 * `set_up_room_files`: a member agent gives its room files of its own (DOR-3468).
 *
 * Dorian's call: an agent sets this up without asking. It sits in the Rooms
 * permission area like merging, so the agent's own level decides. It opens only
 * the setup: merging someone else's copy and repairing the shared copy stay
 * owner-only, and `rooms.repo.enabled` stays a person's switch. Who asked comes
 * from the verified identity, and the input carries no author to name instead.
 *
 * @module server/services/rooms/repo/room-setup-capability
 */
import { z } from 'zod';
import { sanitizeIdentity } from '@dorkos/shared/untrusted-text';
import { defineCapability } from '../../core/capabilities/index.js';
import type { AuthorRecord } from '../author-registry.js';
import {
  answeringAsync,
  isOwnerCaller,
  requireRoomDeps,
} from '../service/room-capability-answers.js';
import { callerAuthor } from '../service/room-caller-author.js';
import type { RoomService } from '../room-service.js';

/**
 * Tell a room it has files now, as a system line naming whoever set them up.
 *
 * One function for the route and the tool, so both say the same thing. The name
 * is sanitized because an agent's display name is text it can choose.
 *
 * @param rooms - The rooms service.
 * @param roomId - The room that just got files.
 * @param displayName - Who set them up.
 */
export function announceFilesSetUp(
  rooms: Pick<RoomService, 'postNotice'>,
  roomId: string,
  displayName: string
): void {
  rooms.postNotice(roomId, {
    text: `${sanitizeIdentity(displayName) ?? 'Someone'} set up files for this room.`,
    notice: 'files_set_up',
  });
}

/** The capability itself, listed beside the other repo verbs in `roomsDomain`. */
export const setUpRoomFilesCapability = defineCapability({
  id: 'rooms.set_up_files',
  title: 'Set up the room’s files',
  description:
    'Give a room you are a member of files of its own: a shared copy, a `ROOM.md` everyone ' +
    'can read and edit, and a private working copy for each agent from its next turn. ' +
    'No one needs to approve it. ' +
    'The room gets one line saying you set them up, so you do not need to announce it. ' +
    'Asking again is safe: a room that already has files stays as it is. ' +
    'It is refused, with the reason, if room files are switched off on this install or the ' +
    'room is archived.',
  tier: 'act',
  area: 'rooms',
  approvalDisplayFields: ['roomId'],
  approvalSubject: { field: 'roomId', kind: 'room' },
  input: z.object({
    roomId: z
      .string()
      .describe(
        'The room to give files to, by its id — not its #name. You must be a member of it.'
      ),
  }),
  output: z.unknown(),
  surfaces: {
    mcp: {
      toolName: 'set_up_room_files',
      servers: ['in-session', 'external'],
      annotations: { idempotentHint: true },
    },
  },
  invoke: async (deps, input, context) => {
    const rooms = requireRoomDeps(deps);
    const repos = deps.roomDeps?.repos;
    if (!repos) {
      throw new Error('Rooms files capability invoked without a repo service in the registry.');
    }
    let caller: AuthorRecord | undefined;
    const result = await answeringAsync(
      () => {
        caller = callerAuthor(rooms, context);
        return repos.enable(input.roomId, caller.id);
      },
      () => isOwnerCaller(caller)
    );
    if (result.created && caller) {
      announceFilesSetUp(rooms, input.roomId, caller.displayName);
    }
    return { created: result.created, defaultBranch: result.repo.defaultBranch };
  },
});
