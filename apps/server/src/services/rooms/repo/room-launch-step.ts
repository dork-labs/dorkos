/**
 * The launch-time step for a room turn granted a copy of the room's files.
 *
 * @module server/services/rooms/repo/room-launch-step
 */
import { isTurnInFlight } from '../../session/index.js';
import { editBaselineStore } from '../../diff/index.js';
import { runtimeRegistry } from '../../core/runtime-registry.js';
import { agentFacingName } from '../room-context.js';
import type { RoomTriggerDeps } from '../service/room-trigger-deps.js';
import { roomTurnLaunchStep, type RoomTurnLaunch, type RoomTurnPlace } from './room-turn-place.js';

/**
 * The launch-time step for a turn granted a copy of the room's files, as the
 * runner hands it to the dispatcher — or nothing for a room without files.
 *
 * Built from the dispatcher's deps because they hold the room's session bindings and its
 * worktree manager are: it must not touch the copy while another session
 * bound to this (room, agent) has a turn in flight (`roomTurnLaunchStep`).
 *
 * @param deps - The room's store, authors and worktree manager.
 * @param roomId - The room.
 * @param authorId - The agent's author id in it.
 * @param agentPath - The agent's home.
 * @param place - Where the turn was placed.
 */
export function roomLaunchStepFor(
  deps: Pick<RoomTriggerDeps, 'store' | 'authors' | 'worktrees' | 'isOwnerAuthor' | 'operatorName'>,
  roomId: string,
  authorId: string,
  agentPath: string,
  place: RoomTurnPlace
): { prepareLaunch?: (sessionId: string) => Promise<RoomTurnLaunch> } {
  const worktrees = deps.worktrees?.();
  if (!worktrees || place.worktree === null) return {};
  return {
    prepareLaunch: roomTurnLaunchStep(
      {
        // The id the binding holds, and every retired id that still resolves
        // to it: an app-resumed turn on an old id is granted the same copy.
        boundSessionIds: () => {
          const bound = deps.store.getRoomSession(roomId, authorId);
          return bound ? [bound, ...deps.store.sessionLedger.retiredIdsFor(bound)] : [];
        },
        isTurnInFlight: async (sessionId) =>
          isTurnInFlight(sessionId, await runtimeRegistry.resolveForSession(sessionId)),
        worktrees,
        // Named from the room log, never from git (spec `agent-home-desk` §6.2).
        describeCommits: (shas) => {
          const named = new Map<string, { kind: 'merge' | 'person'; who: string | null }>();
          for (const [sha, note] of deps.store.commitAnnouncements(roomId, shas)) {
            const subject = note.subjectAuthorId;
            const stored = subject === null ? null : deps.authors.getById(subject);
            // The owner by their own name, never the registry's 'You' (DOR-2458).
            const who =
              subject === null || !stored
                ? null
                : agentFacingName(deps, subject, stored.displayName);
            named.set(sha, { kind: note.kind, who });
          }
          return named;
        },
        forgetBaselines: (sessionIds, absPaths) => {
          for (const sessionId of sessionIds) editBaselineStore.forget(sessionId, absPaths);
        },
      },
      { roomId, worktree: place.worktree, agentPath, files: place.files }
    ),
  };
}
