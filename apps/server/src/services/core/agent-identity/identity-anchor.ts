/**
 * Whose identity a session carries, given where it stands (DOR-2091).
 *
 * Every runtime used to answer "which agent is this?" with an exact lookup of
 * the session's working directory: `meshCore.getByPath(cwd)`. That was sound
 * while an agent only ever ran in its own folder. Since DOR-1597 a turn in a room
 * with files runs in the agent's WORKTREE — `<dorkHome>/rooms/<roomId>/worktrees/
 * <slug>` — which hosts no registered agent. So the lookup missed, no identity
 * token was minted, the in-session tools resolved nobody, and with login on every
 * room verb refused as `UNIDENTIFIED_CALLER`. With login off it was worse: the
 * same calls fell through to the operator.
 *
 * ## The rule
 *
 * A directory is anchored to an agent in exactly one of two ways, and a prefix of
 * a path is never one of them:
 *
 * 1. **It is a room working copy the worktree manager handed out**, and the
 *    anchor is the agent it was handed to. That record is written by the ONE
 *    component that creates the directory for that agent
 *    (`RoomWorktreeManager.ensureWorktree`), so it is a fact rather than an
 *    inference from the name — the name ends in a 32-bit digest of the agent's
 *    path, which is not a thing to authenticate by.
 * 2. **It is anything else**, and the anchor is the directory itself, looked up
 *    exactly, as it always was.
 *
 * A working copy nobody can vouch for — the process restarted and nothing has
 * asked for it since, two agents' names collided onto one directory, or a
 * directory that was set aside as not-a-checkout — is REFUSED. Refused is a
 * third answer, not "no agent": a session standing there is some agent's, we
 * just cannot say whose, and treating it as nobody would hand it to the operator
 * on a login-off install (the DOR-1361 lesson, on a new axis).
 *
 * ## Who the turn is for
 *
 * A room turn also knows which agent it was dispatched FOR. When that is given,
 * the anchor must be that agent or the answer is refused, whatever the directory
 * says. That is what stops a turn for agent B that ends up standing in agent A's
 * working copy — or in A's own folder, or in a default directory that happens to
 * be A's — from acting as A.
 *
 * @module services/core/agent-identity/identity-anchor
 */
import path from 'node:path';

/**
 * What the room worktree manager knows about one directory.
 *
 * Declared here and implemented in the rooms domain, so a runtime can ask this
 * question without importing a room type.
 */
export interface WorkingCopyOwnerPort {
  /**
   * Whether `dir` is a room working copy, and if so, whose.
   *
   * @param dir - An absolute directory.
   * @returns `null` when `dir` is not a room working-copy location at all;
   *   otherwise `{ owner }`, where `owner` is the agent path the manager handed
   *   this exact directory to, or `null` when it cannot vouch for one.
   */
  ownerOf(dir: string): { owner: string | null } | null;
}

/**
 * The directory whose identity a session carries.
 *
 * - `path` — look this directory up exactly; it may or may not host an agent.
 * - `refused` — the session stands where some agent works, and it cannot be
 *   established which one, or it is not the one the turn is for. Acts as nobody,
 *   and never as the operator.
 * - `none` — there is no directory to go on.
 */
export type IdentityAnchor =
  | { kind: 'path'; agentPath: string }
  | { kind: 'refused'; reason: 'unowned-working-copy' | 'not-the-turns-agent' }
  | { kind: 'none' };

let workingCopies: WorkingCopyOwnerPort | undefined;

/**
 * Register (or clear) the room worktree manager's side of the rule.
 *
 * Absent on an install whose room-repo machinery was never wired, where no
 * directory is a working copy and every directory anchors to itself.
 *
 * @param port - The manager's lookup, or `undefined` to clear it.
 */
export function setWorkingCopyOwnerPort(port: WorkingCopyOwnerPort | undefined): void {
  workingCopies = port;
}

/**
 * Anchor a session's working directory to the agent whose identity it carries.
 *
 * Synchronous and cheap — one map read — because every runtime asks it on the
 * turn path.
 *
 * @param cwd - Where the session stands, or `undefined` when nothing names it.
 * @param forAgent - The agent the turn was dispatched for, when a room turn
 *   knows it. When given, any other answer is refused.
 * @returns The anchor. Callers look `agentPath` up exactly, as they always did.
 */
export function resolveIdentityAnchor(
  cwd: string | undefined,
  forAgent?: string | undefined
): IdentityAnchor {
  // A turn that names its agent and stands NOWHERE cannot be shown to be that
  // agent's; answering `none` would read as "nobody", which a login-off install
  // hands to the operator. Only a caller with no agent to be checked against
  // may have no directory.
  if (!cwd) {
    return forAgent !== undefined
      ? { kind: 'refused', reason: 'not-the-turns-agent' }
      : { kind: 'none' };
  }

  let anchored = cwd;
  const workingCopy = safeOwnerOf(cwd);
  if (workingCopy) {
    if (workingCopy.owner === null) return { kind: 'refused', reason: 'unowned-working-copy' };
    anchored = workingCopy.owner;
  }

  if (forAgent !== undefined && !samePath(anchored, forAgent)) {
    return { kind: 'refused', reason: 'not-the-turns-agent' };
  }
  return { kind: 'path', agentPath: anchored };
}

/**
 * The anchored path when there is one to look up, else `undefined`.
 *
 * @param anchor - A resolved anchor.
 */
export function anchorPath(anchor: IdentityAnchor): string | undefined {
  return anchor.kind === 'path' ? anchor.agentPath : undefined;
}

/**
 * Ask the port, failing CLOSED: a lookup that throws cannot vouch for anybody,
 * so it answers "a working copy with no owner" rather than "not a working copy".
 *
 * @param dir - The directory to classify.
 */
function safeOwnerOf(dir: string): { owner: string | null } | null {
  if (!workingCopies) return null;
  try {
    return workingCopies.ownerOf(dir);
  } catch {
    return { owner: null };
  }
}

/**
 * Two spellings of one absolute path, compared after `path.resolve` so a
 * trailing slash is not a different agent. Never a prefix comparison.
 *
 * @param a - One path.
 * @param b - The other.
 */
function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}
