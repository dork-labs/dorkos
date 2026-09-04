/**
 * What a room contributes to the session-cwd chain, for BOTH paths that can
 * start a turn in one room conversation.
 *
 * A room turn begins in `room-trigger.ts`, which knows its room and its agent
 * outright. The same conversation can also be resumed in the app, where
 * `POST /api/sessions/:id/messages` knows only a session id — and until DOR-1624
 * that path answered the agent's own folder while the room's turns ran in the
 * worktree, so the operator picking the conversation up saw a directory the
 * agent had not touched since it joined the room.
 *
 * The two halves a room owes the chain therefore live here, once:
 *
 * - {@link ensureRoomWorktreePath} — the seam itself, including the translation
 *   that matters: a room with no files of its own REFUSES by throwing, and the
 *   resolver has to read that as "nothing to give" rather than as a failure.
 * - {@link roomSessionPlace} — the lookup that turns a bare session id into the
 *   room and the agent label the resolver needs.
 *
 * **The resolver still knows nothing about rooms.** It takes a plain function
 * and a plain `{ roomId, agentName }`; every room type — the manager, the
 * ledger, the author rows, `RoomError` — stays on this side of the port
 * (`services/workspace/room-session-cwd.ts` declares it).
 *
 * @module server/services/rooms/repo/room-worktree-cwd
 */
import type { RoomSessionPlacePort } from '../../workspace/room-session-cwd.js';
import type { AuthorRegistry } from '../author-registry.js';
import type { RoomWorktreeManager } from './room-worktree-manager.js';
import { RoomError } from '../room-errors.js';
import type { RoomSessionLedger } from '../room-session-ledger.js';

/**
 * An agent's standing working copy of a room's repo, or `null` when that room
 * has no files of its own.
 *
 * **The `NOT_A_PROJECT_ROOM` translation is the whole point of this function
 * existing rather than being inlined twice.** A room without files is the
 * ordinary case and the manager says so by throwing; read as a failure it would
 * be reported as a degradation on every turn in every ordinary room. Anything
 * else — no git, a worktree that cannot be created, a disk error — is re-thrown
 * so the resolver can degrade it and say why.
 *
 * A missing manager answers `null` for the same reason the resolver's default
 * seam does: an install whose room-repo machinery was never bootstrapped has no
 * worktrees to give, and its room turns run where they always did.
 *
 * @param worktrees - The manager, or `null`/`undefined` where none is wired.
 * @param roomId - The room being answered.
 * @param agentPath - The agent's own directory — its identity anchor.
 * @param agentName - The agent's display name, the readable half of the slug.
 */
export async function ensureRoomWorktreePath(
  worktrees: RoomWorktreeManager | null | undefined,
  roomId: string,
  agentPath: string,
  agentName: string
): Promise<string | null> {
  if (!worktrees) return null;
  try {
    return (await worktrees.ensureWorktree(roomId, agentPath, agentName)).path;
  } catch (err) {
    if (err instanceof RoomError && err.code === 'NOT_A_PROJECT_ROOM') return null;
    throw err;
  }
}

/** The three reads {@link roomSessionPlace} needs, injected so a test needs no server. */
export interface RoomSessionPlaceDeps {
  /** `(room, agent) → session` bindings, read the way this lookup needs them. */
  bindings: Pick<RoomSessionLedger, 'bindingForSession'>;
  /** Author rows — where a room member's label and kind live. */
  authors: Pick<AuthorRegistry, 'getById'>;
  /** The worktree manager, or `null` on an install whose repo machinery is off. */
  worktrees: () => RoomWorktreeManager | null;
}

/**
 * The rooms domain's side of the room rung, as the composition root wires it.
 *
 * **The agent label comes from the author row, which is where the room-turn path
 * reads it too** (`room-trigger.ts`, `selectCandidates` → `record.displayName`).
 * That agreement is load-bearing rather than tidy: the label is the readable
 * half of the worktree's directory name, so reading it from anywhere else would
 * quietly hand the app-resumed turn a second working copy of the same room.
 *
 * A non-agent author answers `null`. A room binding always names an agent
 * member, so a human's row here means the id has been reused or the row has
 * changed hands — and inventing a worktree for a person is not the recovery.
 *
 * **A MISSING author row answers `null` too, and that one is worth saying out
 * loud rather than reading as the same case.** It is the right direction — a
 * member row that has vanished carries no label, and a working copy named from
 * a guess is a second working copy of the same room — but the session it happens
 * to is left resolving exactly as it did before this rung existed, on the
 * agent's own folder. That is this defect surviving for that session, not a
 * state that cannot occur.
 *
 * @param deps - The reads above.
 */
export function roomSessionPlace(deps: RoomSessionPlaceDeps): RoomSessionPlacePort {
  return {
    roomFor(sessionId) {
      const binding = deps.bindings.bindingForSession(sessionId);
      if (!binding) return null;
      const author = deps.authors.getById(binding.authorId);
      if (!author || author.kind !== 'agent') return null;
      return { roomId: binding.roomId, agentName: author.displayName };
    },
    ensureRoomWorktree: (roomId, agentPath, agentName) =>
      ensureRoomWorktreePath(deps.worktrees(), roomId, agentPath, agentName),
  };
}
