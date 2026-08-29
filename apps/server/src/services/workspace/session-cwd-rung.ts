/**
 * The vocabulary of "which directory does this turn run in?" — the rung names,
 * the answer shape, and the one log line that reports them.
 *
 * A plain sibling split out of {@link module:server/services/workspace/resolve-session-cwd}
 * to keep that file focused on the chain rather than on its types. **Every rung
 * is answered by the resolver** — there is one resolver, one precedence chain,
 * and one log line for every turn on the install, session or room alike. The
 * `room-worktree` rung is reached when a caller names a `room` on the request
 * and is resolved through an injected worktree-ensure seam, so the resolver
 * imports nothing from the rooms domain (see `resolveSessionCwd`).
 *
 * ## The rungs, in precedence order
 *
 * | Rung             | Reached when                                              |
 * | ---------------- | --------------------------------------------------------- |
 * | `explicit`       | the caller already resolved a `cwd`                       |
 * | `room-worktree`  | the request names a `room` and that room has files        |
 * | `agent-home`     | an agent was named — its own folder, or a room's floor    |
 * | `agent-managed`  | an agent's manifest asks for a provisioned checkout       |
 * | `default`        | nobody had a better answer                                |
 *
 * The types live here rather than beside the chain so this vocabulary and the
 * `[cwd] resolved` line are one greppable thing: an operator asking "why is my
 * agent writing there" finds every turn, room or session, on one string.
 *
 * @module server/services/workspace/session-cwd-rung
 */
import { logger } from '../../lib/logger.js';

/**
 * Which rung of the precedence chain answered.
 *
 * The order of the union IS the precedence order, first match wins:
 *
 * 1. **`explicit`** — the caller named a `cwd`. Nothing else is consulted.
 * 2. **`room-worktree`** — a room turn in a repo-enabled room, running in that
 *    agent's standing working copy of the room's repo (spec `project-rooms`
 *    §3.5).
 * 3. **`agent-home` / `agent-managed`** — an agent was named, and its manifest
 *    says where it works.
 * 4. **`default`** — nobody had a better answer, so `DEFAULT_CWD`.
 */
export type SessionCwdRung =
  'explicit' | 'room-worktree' | 'agent-home' | 'agent-managed' | 'default';

/** Where a turn runs, and why. */
export interface ResolvedCwd {
  /** The absolute working directory the runtime should be given. */
  cwd: string;
  /** Which rung answered — see {@link SessionCwdRung}. */
  rung: SessionCwdRung;
  /** The workspace id, when a `managed` binding provisioned or reused one. */
  workspaceId?: string;
  /** Why a lower rung answered than the binding asked for. Absent when none did. */
  degraded?: string;
}

/** What the log line says about the turn beyond its directory. */
export interface ResolvedCwdContext {
  /** The session the turn runs on, when the caller knows it. */
  sessionId?: string | null;
  /** The room that triggered the turn, for a room turn. */
  roomId?: string;
}

/**
 * Report one turn's directory decision — one line, naming the rung.
 *
 * Without it, "why is my agent writing there" is unanswerable, and a precedence
 * chain that cannot be interrogated is worse than the one-rung chain it
 * replaced. Written through one function so a room turn and a session turn are
 * greppable as one thing rather than two dialects of the same event.
 *
 * @param resolved - The answer being reported.
 * @param context - What else identifies the turn.
 */
export function logResolvedCwd(resolved: ResolvedCwd, context: ResolvedCwdContext = {}): void {
  logger.info('[cwd] resolved', {
    rung: resolved.rung,
    cwd: resolved.cwd,
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    ...(context.roomId ? { roomId: context.roomId } : {}),
    ...(resolved.workspaceId ? { workspaceId: resolved.workspaceId } : {}),
    ...(resolved.degraded ? { degraded: resolved.degraded } : {}),
  });
}
