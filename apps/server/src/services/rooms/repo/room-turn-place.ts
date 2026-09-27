/**
 * Where a room turn stands, and which of the room's folders it may reach
 * (spec `agent-home-desk` §5.1).
 *
 * A room turn stands in the agent's HOME — always (invariant I4). A room with
 * files of its own gives the agent a private working copy of them, and the turn
 * reaches that copy, and the room's shared tree, through per-turn folder grants
 * on the runtime port (ADR 260926-180223). Nothing here moves the turn: the
 * working directory is the agent's own folder, so its persona, rules, memory
 * and skills are the ones it has everywhere else, and it can change its own code
 * in the same turn it works on the room's files.
 *
 * ## The grants, and why the `.git` one is narrow
 *
 * | Folder                                  | Access  | Why                                        |
 * | --------------------------------------- | ------- | ------------------------------------------ |
 * | `<room>/worktrees/<slug>`               | `write` | the agent's own copy                       |
 * | `<room>/repo`                           | `read`  | reading `main` and everybody's files       |
 * | `<room>/repo/.git/objects`              | `write` | a commit in the copy writes its objects    |
 * | `<room>/repo/.git/refs/heads/room`      | `write` | …moves its `room/<slug>` branch            |
 * | `<room>/repo/.git/logs/refs/heads/room` | `write` | …and that branch's reflog                  |
 * | `<room>/repo/.git/worktrees/<slug>`     | `write` | …and the copy's own index, `HEAD` and logs |
 *
 * The spec's first cut granted all of `repo/.git`. That also hands every agent
 * the room's SHARED `hooks/`, `config` and `info/` — which run for the other
 * agents' commits and could name commands git executes — so a file tool or a
 * sandboxed shell in one agent's turn could plant code another agent's commit
 * would run. The grant is therefore exactly what a commit and a `git merge
 * main` in a linked worktree write (measured against real git with everything
 * else in `.git` made read-only, `__tests__/room-turn-place.test.ts`), and no
 * more. The server's own git never reads config an agent can write, for the
 * reasons `room-repo-git.ts` gives — and when a shell that is not sandboxed
 * writes a program into `repo/.git/config` anyway, the server refuses the room
 * (`ROOM_REPO_CONFIG_UNSAFE`) rather than run it. What stays true for every runtime (§5.2): a
 * shell that is not sandboxed can write anywhere its permission mode allows,
 * this folder included.
 *
 * **What the narrow grant still allows, stated rather than hidden.** A folder
 * grant cannot be narrower than a folder, and two of these folders are shared:
 *
 * - `objects/` is every agent's and `main`'s object store. Git does not re-hash
 *   a loose object when it reads it, so an agent that overwrites one — a blob
 *   `main` already points at — changes what `main` holds without a commit, a
 *   merge or a room entry.
 * - `refs/heads/room/` and its reflog folder hold every agent's branch, so one
 *   agent can move or delete another's `room/<slug>` branch and its reflog.
 *
 * Neither runs code; both are tampering with shared content by an agent the
 * room already trusts to write its files. Closing them needs a per-agent object
 * store (objects imported into the room's only after hash verification) and
 * per-agent refs, which is follow-up work, not a grant.
 *
 * Every grant is computed here from the room's layout, never from anything a
 * room or an agent wrote — the admin folder's name is the worktree's own
 * folder name, not the path in its agent-writable `.git` file.
 *
 * @module server/services/rooms/repo/room-turn-place
 */
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import type { AgentRuntime, DirectoryGrant } from '@dorkos/shared/agent-runtime';
import type { RoomContextFiles } from '@dorkos/shared/additional-context';
import { isSameOrInside, realPathOf } from '@dorkos/shared/directory-grants';
import { logger } from '../../../lib/logger.js';
import type { RoomSessionPlacePort } from '../../workspace/room-session-place.js';
import { logResolvedCwd } from '../../workspace/session-cwd-rung.js';
import type { AuthorRegistry } from '../author-registry.js';
import { RoomError } from '../room-errors.js';
import type { RoomSessionLedger } from '../session-bindings/room-session-ledger.js';
import type { RoomWorktreeManager } from './room-worktree-manager.js';

/** Where one room turn stands, and what it may reach. */
export interface RoomTurnPlace {
  /** Always the agent's home (invariant I4). */
  cwd: string;
  /** Exactly the folders this turn may reach; empty for a room with no files. */
  additionalDirectories: DirectoryGrant[];
  /** The agent's copy of the room's files, or `null` when the room has none. */
  worktree: string | null;
  /** What the context block's files section says, or `null` when it says nothing. */
  files: RoomContextFiles | null;
}

/**
 * The grants a project-room turn carries, as the table in the module doc says.
 *
 * Realpath-resolved (a grant spelled through a symlink would not match what a
 * backend compares), and any folder that is the turn's own directory or inside
 * it is dropped: the turn already reaches it, and the validator refuses such a
 * grant. That happens only when the data folder sits inside the agent's home —
 * a DorkOS dev checkout, where the data folder is under the `dorkos` agent's
 * repo.
 *
 * @param worktree - The agent's copy of the room's files.
 * @param repo - The room's shared checkout, `<room>/repo`.
 * @param cwd - The turn's directory, the agent's home.
 * @returns The grants, in a stable order.
 */
export function roomTurnGrants(worktree: string, repo: string, cwd: string): DirectoryGrant[] {
  const gitDir = path.join(repo, '.git');
  const candidates: DirectoryGrant[] = [
    { path: worktree, access: 'write' },
    { path: repo, access: 'read' },
    { path: path.join(gitDir, 'objects'), access: 'write' },
    { path: path.join(gitDir, 'refs', 'heads', 'room'), access: 'write' },
    { path: path.join(gitDir, 'logs', 'refs', 'heads', 'room'), access: 'write' },
    { path: path.join(gitDir, 'worktrees', path.basename(worktree)), access: 'write' },
  ];
  const home = realPathOf(path.resolve(cwd));
  const grants: DirectoryGrant[] = [];
  for (const candidate of candidates) {
    const resolved = realPathOf(candidate.path);
    if (isSameOrInside(resolved, home) || isSameOrInside(home, resolved)) continue;
    grants.push({ path: resolved, access: candidate.access });
  }
  return grants;
}

/**
 * Place one room turn: at home, with the room's folders granted when it has
 * files of its own.
 *
 * **Never throws, and degrades to "no files".** A room with no files is the
 * ordinary case (`NOT_A_PROJECT_ROOM`). Anything else — no git, a worktree that
 * cannot be made, a disk error — is logged and the turn runs at home with no
 * files section and no grants: an agent that cannot reach the room's files is
 * told nothing about them, which is honest, where failing the turn would cost a
 * person their answer over a folder.
 *
 * @param worktrees - The manager, or `null`/`undefined` where none is wired.
 * @param roomId - The room being answered.
 * @param agentPath - The agent's home — its identity and its desk.
 * @param agentName - The agent's display name, the readable half of its copy's
 *   folder name.
 */
export async function resolveRoomTurnPlace(
  worktrees: RoomWorktreeManager | null | undefined,
  roomId: string,
  agentPath: string,
  agentName: string
): Promise<RoomTurnPlace> {
  // The same `[cwd] resolved` line every other turn boundary writes, so an
  // operator asking "where did that agent work" finds room turns too.
  logResolvedCwd({ cwd: agentPath, rung: 'agent-home' }, { sessionId: null, roomId });
  const atHome: RoomTurnPlace = {
    cwd: agentPath,
    additionalDirectories: [],
    worktree: null,
    files: null,
  };
  if (!worktrees) return atHome;
  let handle: Awaited<ReturnType<RoomWorktreeManager['ensureWorktree']>>;
  try {
    handle = await worktrees.ensureWorktree(roomId, agentPath, agentName);
  } catch (err) {
    if (err instanceof RoomError && err.code === 'NOT_A_PROJECT_ROOM') return atHome;
    logger.warn(
      '[rooms] could not open this agent’s copy of the room’s files; answering without it',
      {
        roomId,
        error: err instanceof Error ? err.message : String(err),
      }
    );
    return atHome;
  }
  // A commit in the copy writes its branch's reflog here, and a sandboxed shell
  // may not create folders beside the ones it is granted — so the server, which
  // owns `repo/.git`, makes sure the granted folder is there first.
  await fs
    .mkdir(path.join(handle.repo, '.git', 'logs', 'refs', 'heads', 'room'), { recursive: true })
    .catch(() => undefined);
  const files = await worktrees.turnFilesContext(roomId, agentPath, agentName, handle.path);
  return {
    cwd: agentPath,
    additionalDirectories: existsSync(handle.path)
      ? roomTurnGrants(handle.path, handle.repo, agentPath)
      : [],
    worktree: handle.path,
    files,
  };
}

/**
 * Whether a bound session was created standing in the agent's copy of a room's
 * files — which every room turn did before spec `agent-home-desk` — as its
 * runtime reports the session's directory.
 *
 * Asked only of a runtime that cannot move a session to a new folder (OpenCode,
 * §8.1). Never throws: a session its runtime cannot describe is carried on, as
 * before.
 *
 * @param runtime - The runtime the session is bound to.
 * @param sessionId - The bound session.
 * @param request - The turn: its agent's home and its copy of the room's files.
 */
export async function sessionStandsInRoomCopy(
  runtime: Pick<AgentRuntime, 'getSession' | 'getSessionCwd'>,
  sessionId: string,
  request: { agentPath: string; worktree: string | null }
): Promise<boolean> {
  try {
    const cwd =
      runtime.getSessionCwd?.(sessionId) ??
      (await runtime.getSession(request.agentPath, sessionId))?.cwd;
    if (typeof cwd !== 'string' || cwd === '') return false;
    const where = path.resolve(cwd);
    if (request.worktree !== null && where === path.resolve(request.worktree)) return true;
    // A copy under an older folder name (the agent was renamed since) is still
    // a room's copy: `<dorkHome>/rooms/<room>/worktrees/<name>`.
    return /[\\/]rooms[\\/][^\\/]+[\\/]worktrees[\\/][^\\/]+$/.test(where);
  } catch {
    return false;
  }
}

/** What {@link roomTurnLaunchStep} needs, injected so a test needs no server. */
export interface RoomTurnLaunchDeps {
  /** Every session `room_sessions` holds for this (room, agent). */
  boundSessionIds(): readonly string[];
  /**
   * Whether a turn is running on that session right now, by every authority
   * that knows (`isTurnInFlight` in the message dispatcher).
   */
  isTurnInFlight(sessionId: string): Promise<boolean>;
  /** The worktree manager's legacy clean-up. */
  worktrees: Pick<RoomWorktreeManager, 'retireLegacyPlumbing'>;
}

/**
 * The work a room turn does when it LAUNCHES — never when it is placed or
 * queued (spec `agent-home-desk` §5.9, §6.1). The dispatcher calls the returned
 * function with the session the turn is launching on, under that session's
 * write lock, so no other turn on it is running.
 *
 * **Nothing touches the agent's copy while another session bound to this
 * (room, agent) has a turn in flight.** That turn was granted the same copy and
 * may be writing in it. The check is made before any git call; a busy answer
 * skips this launch's step entirely, and the next launch asks again.
 *
 * Today the step retires what DorkOS used to write into the copy; spec task T5
 * adds the turn-start refresh here.
 *
 * @param deps - The reads above.
 * @param turn - The room, the agent's copy of its files, and the agent's home.
 * @returns The launch step, which resolves to what to merge into the turn.
 */
export function roomTurnLaunchStep(
  deps: RoomTurnLaunchDeps,
  turn: { roomId: string; worktree: string; agentPath: string }
): (sessionId: string) => Promise<Record<string, never>> {
  return async (sessionId) => {
    for (const bound of deps.boundSessionIds()) {
      if (bound === sessionId) continue;
      if (await deps.isTurnInFlight(bound)) {
        logger.debug(
          '[rooms] another session of this agent in this room is running; not touching its copy',
          {
            roomId: turn.roomId,
          }
        );
        return {};
      }
    }
    await deps.worktrees.retireLegacyPlumbing(turn.roomId, turn.worktree, turn.agentPath);
    return {};
  };
}

/** The reads {@link roomSessionPlace} needs, injected so a test needs no server. */
export interface RoomSessionPlaceDeps {
  /** `(room, agent) → session` bindings, read the way this lookup needs them. */
  bindings: Pick<RoomSessionLedger, 'bindingForSession'>;
  /** Author rows — where a room member's label and kind live. */
  authors: Pick<AuthorRegistry, 'getById'>;
  /** The worktree manager, or `null` on an install whose repo machinery is off. */
  worktrees: () => RoomWorktreeManager | null;
  /** The runtime a session is bound to, to tell a session that cannot move home. */
  sessionRuntime?: (
    sessionId: string
  ) => Promise<Pick<AgentRuntime, 'type' | 'getSession' | 'getSessionCwd'>>;
}

/**
 * The rooms domain's side of an app-resumed room session (DOR-1624, spec
 * `agent-home-desk` §5.7), as the composition root wires it.
 *
 * **The agent label comes from the author row, which is where the room-turn path
 * reads it too** (`room-trigger.ts`, `selectCandidates` → `record.displayName`).
 * The label is the readable half of the copy's folder name, so reading it from
 * anywhere else would hand the app-resumed turn a second copy of the room's
 * files — and grant it that one.
 *
 * A non-agent author, or a missing author row, answers `null`: a room binding
 * always names an agent member, and inventing a copy for a guess is not the
 * recovery. That session is then an ordinary session.
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
      return {
        roomId: binding.roomId,
        agentName: author.displayName,
        // An agent author's natural key IS its home — the same identity the
        // room-turn path dispatches with (`selectCandidates`).
        agentPath: author.naturalKey,
      };
    },
    async placeTurn(roomId, agentPath, agentName, sessionId) {
      const place = await resolveRoomTurnPlace(deps.worktrees(), roomId, agentPath, agentName);
      // An OpenCode session created standing in the copy cannot be moved home
      // (§8.1). The caller refuses its turn: no turn stands in a room's files.
      if (sessionId !== undefined && place.worktree !== null && deps.sessionRuntime) {
        const runtime = await deps.sessionRuntime(sessionId).catch(() => null);
        if (
          runtime?.type === 'opencode' &&
          (await sessionStandsInRoomCopy(runtime, sessionId, {
            agentPath,
            worktree: place.worktree,
          }))
        ) {
          return {
            cwd: place.worktree,
            additionalDirectories: [],
            worktree: place.worktree,
            standsInCopy: true,
          };
        }
      }
      return {
        cwd: place.cwd,
        additionalDirectories: place.additionalDirectories,
        worktree: place.worktree,
      };
    },
  };
}
