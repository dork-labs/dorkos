/**
 * Which directory one room turn runs in — the `room-worktree` rung (spec
 * `project-rooms` §3.5).
 *
 * ## Why this rung is answered here and not in the resolver
 *
 * `services/workspace/resolve-session-cwd.ts` is the one answer to "which
 * directory does this turn run in?", and this module is a deliberate, bounded
 * exception to that — argued rather than assumed, because "one resolver" is a
 * goal worth defending.
 *
 * The resolver's chain is `explicit → room-worktree → agent binding → default`.
 * A room turn genuinely belongs on rung 2. What it does not yet belong on is
 * rungs 3 and 4, and calling the resolver would hand it those too:
 *
 * - **Rung 3 boundary-validates the agent's own directory.** A room turn never
 *   has been. An agent whose home is outside `DORKOS_BOUNDARY` and outside
 *   `{dorkHome}/agents` would have its room turns silently relocated to
 *   `DEFAULT_CWD` — the shared tree every other agent also writes in, which is
 *   the DOR-500 interleaving the whole chain exists to prevent.
 * - **Rungs 3 and 4 honor a `managed` or `none` binding.** Today a room turn
 *   runs in the agent's own folder whatever its manifest says. Following the
 *   binding is defensible and is what §3.5 eventually wants; it is also a real
 *   behavior change for every repo-less room, and DOR-1597 is not where that
 *   argument gets made.
 *
 * So this module answers rung 2 and stops. Its floor is `agentPath` — the
 * agent's own directory, reported as `agent-home`, which is the same rung name
 * the resolver would give the same answer. **No new vocabulary**: the rung type
 * and the log line are shared with the resolver
 * ({@link module:server/services/workspace/session-cwd-rung}), so an operator
 * greps one string and sees every turn on the install.
 *
 * When rungs 3 and 4 are wired for rooms, this module collapses into a `room`
 * field on the resolver's request and the exception ends.
 *
 * ## Resolved at turn dispatch, not at first write
 *
 * The ideation wrote the worktree as created on the agent's first WRITE intent.
 * It cannot be: the cwd has to exist before the turn starts, because the room
 * context handed to the model names attachment paths relative to it and the
 * projector puts the files there. §3.4 already says "the first room turn that
 * resolves cwd", which is turn time, and that is what this does — a repo-enabled
 * room creates an agent's working copy on its first turn there, whether or not
 * that turn writes anything. The cost of the deviation is one `git worktree add`
 * for an agent that only ever reads; the cost of the alternative is a model
 * being told about files that are not where it is standing.
 *
 * @module server/services/rooms/repo/room-turn-cwd
 */
import { logResolvedCwd, type ResolvedCwd } from '../../workspace/session-cwd-rung.js';
import { RoomError } from '../room-errors.js';
import type { RoomWorktreeManager } from './room-worktree-manager.js';

/** What the rung needs to know about the turn it is placing. */
export interface RoomTurnCwdRequest {
  /** The room the turn answers. */
  roomId: string;
  /**
   * The agent's own directory — its IDENTITY, and the floor this rung falls to.
   *
   * Never the answer's stand-in: what comes back may be a different directory
   * entirely, and the two must not be conflated downstream. The claim map, the
   * busy ceilings and the runtime lookup all key on THIS value and none of them
   * moves (spec §5 Q6).
   */
  agentPath: string;
  /** The agent's display name — the readable half of its worktree directory. */
  agentName: string;
}

/** The seam this rung needs from the rest of the server. */
export interface RoomTurnCwdDeps {
  /**
   * The install's worktree manager, or `null` where none is wired.
   *
   * Nullable rather than throwing, because a room turn must run on an install
   * whose repo machinery was never bootstrapped — and every test that drives a
   * turn without one is exactly that install.
   */
  worktrees(): RoomWorktreeManager | null;
}

/**
 * Place one room turn: its agent's working copy of the room's repo, or the
 * agent's own directory.
 *
 * **Failure never fails the turn.** A room with no repo is the ordinary case and
 * is not a degradation — it is reported as `agent-home` with no reason, exactly
 * as the resolver reports a `none` binding. Anything else that goes wrong —
 * git missing, a worktree that cannot be created, a disk error — falls to the
 * same floor carrying a `degraded` reason, because an agent answering from its
 * own folder is enormously better than a room that stopped answering.
 *
 * @param req - The room, the agent, and the agent's name.
 * @param deps - The worktree manager seam.
 * @returns The directory the turn runs in, and the rung that chose it.
 */
export async function resolveRoomTurnCwd(
  req: RoomTurnCwdRequest,
  deps: RoomTurnCwdDeps
): Promise<ResolvedCwd> {
  const resolved = await resolve(req, deps);
  logResolvedCwd(resolved, { roomId: req.roomId });
  return resolved;
}

/** The rung itself, without the log line. */
async function resolve(req: RoomTurnCwdRequest, deps: RoomTurnCwdDeps): Promise<ResolvedCwd> {
  const manager = deps.worktrees();
  // No repo machinery on this install at all. Not a degradation: nothing was
  // asked for and nothing failed.
  if (!manager) return { cwd: req.agentPath, rung: 'agent-home' };

  try {
    const handle = await manager.ensureWorktree(req.roomId, req.agentPath, req.agentName);
    return { cwd: handle.path, rung: 'room-worktree' };
  } catch (err) {
    // The room simply has no files — today's overwhelmingly common case, and
    // the reason `hasRepo` is asked by throwing rather than by a second query.
    // Reported without a `degraded` reason, because nothing degraded.
    if (err instanceof RoomError && err.code === 'NOT_A_PROJECT_ROOM') {
      return { cwd: req.agentPath, rung: 'agent-home' };
    }
    return {
      cwd: req.agentPath,
      rung: 'agent-home',
      degraded: `could not open the room worktree: ${message(err)}`,
    };
  }
}

/** The readable half of an unknown throw, matching the resolver's own helper. */
function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
