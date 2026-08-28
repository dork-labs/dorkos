/**
 * The vocabulary of "which directory does this turn run in?" — the rung names,
 * the answer shape, and the one log line that reports them.
 *
 * Split out of {@link module:server/services/workspace/resolve-session-cwd} so
 * that the two places a turn BEGINS can share one vocabulary without sharing an
 * import of the resolver itself. That import is guarded: the resolver may be
 * named only by the boundaries that start a turn, and
 * `__tests__/resolve-session-cwd.subagent.test.ts` fails the moment a new file
 * names it. A room turn answers its own rung (see below) and must not be added
 * to that list to borrow a type — so the type lives here instead, and the
 * resolver re-exports it, which keeps every existing importer unchanged.
 *
 * ## Where each rung is answered
 *
 * | Rung             | Answered by                                          |
 * | ---------------- | ---------------------------------------------------- |
 * | `explicit`       | `resolve-session-cwd.ts`                             |
 * | `room-worktree`  | `services/rooms/room-turn-cwd.ts`                    |
 * | `agent-home`     | `resolve-session-cwd.ts`, and the room rung's floor  |
 * | `agent-managed`  | `resolve-session-cwd.ts`                             |
 * | `default`        | `resolve-session-cwd.ts`                             |
 *
 * Two answerers rather than one is a deliberate, bounded exception, argued in
 * `room-turn-cwd.ts`'s module doc. What is NOT split is the vocabulary or the
 * log line: an operator asking "why is my agent writing there" greps one string
 * and gets every turn on the install, room or session alike.
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
