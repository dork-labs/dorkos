/**
 * Where a session's directory-scoped reads look when the caller did not say.
 *
 * Every per-session read used to require the caller to already know the
 * session's project directory and pass it as `?cwd=`. DOR-1322 lifted that for
 * `GET /:id/messages`; DOR-1444 found the rest of the family still carrying the
 * old blind `cwd || DEFAULT_CWD` fallback — including the durable event stream,
 * which is the one a SECOND window opens when it joins a conversation already
 * in flight. On a server whose default project directory sits outside the
 * configured boundary, that fallback is not merely the wrong directory: the
 * stream's boundary check refuses it, the window never binds, and the running
 * turn is invisible to it (observed live 2026-08-23).
 *
 * ## The boundary is the caller's job, and it is not optional
 *
 * These resolvers deliberately do NOT check the boundary themselves — they take
 * no `res` and cannot answer a request. Every caller MUST judge the directory
 * they get back before reading anything with it, because a directory resolved
 * from the runtime's live binding is one the CALLER never named, and
 * `assertBoundary(undefined)` passes. Skipping that check inverts the boundary:
 * a request that omits `?cwd=` would read a session that the same request with
 * an explicit `?cwd=` is refused for. DOR-1322 shipped with exactly that gap on
 * `/:id/messages` and it was closed with DOR-1444.
 *
 * That the binding was itself boundary-checked when the session launched is not
 * a safe assumption to build on: `routes/tasks.ts` creates sessions with no
 * boundary call at all, so a scheduled task can bind a session to a directory
 * outside it.
 *
 * ## Two resolvers
 *
 * The two halves of the family can afford different answers to "I could not
 * place this session":
 *
 * - {@link resolveSessionCwdOrNull} — for a read that can honestly answer 404
 *   (`/:id`, `/:id/messages`). It verifies before trusting the default.
 * - {@link resolveSessionCwdOrDefault} — for a read that must not fail
 *   (`/:id/events`, `/:id/tasks`). The durable stream has to be openable for
 *   ANY well-formed session id, including one that does not exist server-side
 *   yet, so it degrades to the default directory rather than refusing.
 *
 * ## Not the whole family yet
 *
 * `PATCH /:id` (rename) and `POST /:id/fork` still take the blind
 * `?cwd= || DEFAULT_CWD` path. They are writes rather than reads, so the
 * failure mode differs — a rename with no `?cwd=` addresses a session that is
 * not in the default directory and simply finds nothing to rename — and they
 * were left alone rather than converted untested. Converting them means giving
 * them the same post-resolution boundary check as the reads.
 *
 * @module services/session/resolve-read-cwd
 *
 * Named `resolve-read-cwd` (not `resolve-session-cwd`) deliberately: the
 * workspace resolver of that name owns the ONE-RESOLUTION-PER-TURN binding and
 * guards its import graph by basename
 * (`services/workspace/__tests__/resolve-session-cwd.subagent.test.ts`). This
 * module answers a different question — which directory a READ route should
 * consult — and must stay clear of that guard's match.
 */
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import { DEFAULT_CWD } from '../../lib/resolve-root.js';

/**
 * Whether the caller NAMED a directory.
 *
 * The single predicate for that question, because the routes and the resolvers
 * both branch on it and a disagreement between them would be invisible: a
 * caller passing `?cwd=` raw (Express gives `''` for a bare `?cwd`) would skip
 * the resolved-directory boundary check on one side while falling through to
 * the default on the other. An empty string names nothing.
 *
 * @param cwdParam - The caller-supplied `?cwd=`, unnormalized.
 */
export function callerNamedCwd(cwdParam: string | undefined): cwdParam is string {
  return cwdParam !== undefined && cwdParam !== '';
}

/**
 * The session's own working directory from whatever LIVE binding the runtime
 * already holds — the one answer that is both cheap and authoritative.
 *
 * Alias-aware: a client-facing request UUID is translated to the canonical id
 * before the lookup, the same translation every other per-session read does
 * (DOR-463). `getSessionCwd` is optional on the runtime contract and is
 * required never to throw, so this is safe on any graceful-degradation path.
 */
function liveSessionCwd(runtime: AgentRuntime, sessionId: string): string | undefined {
  if (runtime.getSessionCwd === undefined) return undefined;
  return runtime.getSessionCwd(runtime.getInternalSessionId(sessionId) ?? sessionId);
}

/**
 * Resolve the project directory for a session read that CAN answer 404.
 *
 * An explicit `?cwd=` always wins. Otherwise, the verify-before-trust ladder
 * below applies ONLY to a runtime that implements `getSessionCwd` — today, only
 * claude-code, because its storage is the one that is genuinely KEYED BY
 * DIRECTORY: a JSONL transcript lives under a slug derived from cwd, so
 * guessing the wrong directory silently reads back empty (the original DOR-1322
 * bug). For such a runtime: try its live binding first, then fall back to the
 * server's default project directory, but — unlike the old unconditional
 * fallback — verify the session actually lives there before trusting it.
 *
 * A runtime that does NOT implement `getSessionCwd` trusts the default project
 * directory outright, exactly like the pre-DOR-1322 code, with no verification
 * step. This is not a gap reopened: every shipped runtime in that category
 * answers `getMessageHistory` independent of the directory argument, so passing
 * the "wrong" one cannot reproduce the silent-empty bug this function exists to
 * prevent. Codex's reads are keyed purely by session id (`registry.get(id)`,
 * the directory parameter is unused). OpenCode's directory-scoped read falls
 * back to a durable, id-keyed EventLog read on failure. Test-mode's
 * `getMessageHistory` reads the same id-keyed EventLog directly and never
 * consults its registry at all — which is also why `getSession` cannot stand in
 * as a verification probe for it: test-mode's `getSession` reflects the SEPARATE
 * in-memory registry (session "known" to the runtime's own bookkeeping), not the
 * durable store `getMessageHistory` actually reads, so a session with zero
 * registry presence can still have real message history. Gating a
 * verified-fallback on `getSession` for THIS class of runtime does not add
 * safety — it produces false negatives on exactly the reads that used to work
 * (found via the review round on PR #1191: `sessions-kickoff-filter.test.ts`,
 * `sessions-multi-runtime.test.ts`).
 *
 * The caller must still boundary-check the result — see the module note.
 *
 * @param runtime - The resolved runtime for this session.
 * @param sessionId - The CLIENT-FACING session id; translated internally.
 * @param cwdParam - The caller-supplied `?cwd=`, if any.
 * @returns The resolved directory, or `null` when none could be confirmed.
 */
export async function resolveSessionCwdOrNull(
  runtime: AgentRuntime,
  sessionId: string,
  cwdParam: string | undefined
): Promise<string | null> {
  if (callerNamedCwd(cwdParam)) return cwdParam;

  if (runtime.getSessionCwd === undefined) return DEFAULT_CWD;

  const liveCwd = liveSessionCwd(runtime, sessionId);
  if (liveCwd) return liveCwd;

  // Guarded: getSession is a graceful-degradation probe here, not a trusted
  // read — a runtime whose lookup throws for reasons unrelated to "session
  // not found" (e.g. an uninitialized boundary) must still fall through to
  // the honest 404 below rather than 500 on a path whose whole job is to
  // degrade gracefully. Its own null case (session genuinely absent at
  // DEFAULT_CWD) already means the same thing, so both collapse to `null` here.
  try {
    // A successful read here guarantees `readTranscript`/`getMessageHistory`
    // will find the SAME file — both key off the identical
    // (DEFAULT_CWD, internal id) pair via the runtime's own transcript lookup —
    // so returning the bare `DEFAULT_CWD` string (not `found.cwd`) is safe.
    // This branch is only reached for a runtime that implements
    // `getSessionCwd` (claude-code today), whose `getSession` genuinely does
    // reflect directory-scoped disk presence — unlike test-mode's, gated out
    // above.
    const found = await runtime.getSession(
      DEFAULT_CWD,
      runtime.getInternalSessionId(sessionId) ?? sessionId
    );
    return found ? DEFAULT_CWD : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the project directory for a session read that must NOT fail — the
 * durable event stream and the task read beside it.
 *
 * Same first two rungs as {@link resolveSessionCwdOrNull} (explicit `?cwd=`,
 * then the runtime's live binding) and then it stops: the verification probe is
 * pointless here, because an unverifiable session lands on the default
 * directory either way. What the live-binding rung buys is the case DOR-1444
 * was filed for — a window joining a conversation that is running RIGHT NOW,
 * where the runtime certainly holds a binding — so the stream is checked
 * against, and hydrates from, the session's real directory instead of a default
 * that may not even be inside the boundary.
 *
 * **For codex and opencode the default is the ONLY rung that ever fires.**
 * Neither implements `getSessionCwd` (claude-code is the sole implementor), so
 * a codex or opencode session opened without `?cwd=` streams against
 * `DEFAULT_CWD` regardless of where it lives. That is unchanged from the blind
 * fallback it replaces, and it is harmless for those two runtimes' own history
 * reads (both are id-keyed — see {@link resolveSessionCwdOrNull}), but it does
 * mean the honest description of this rung is "a guess that is usually right",
 * not "a resolution". A window that lands on it sees an empty transcript with a
 * working live feed rather than an explicit refusal — a quieter failure than
 * "live updates lost", and a more confusing one.
 *
 * Synchronous by construction: `getSessionCwd` answers without a lookup and
 * never throws, which is what lets the WebSocket upgrade decide this before the
 * handshake.
 *
 * The caller must still boundary-check the result — see the module note.
 *
 * @param runtime - The resolved runtime for this session.
 * @param sessionId - The CLIENT-FACING session id; translated internally.
 * @param cwdParam - The caller-supplied `?cwd=`, if any.
 * @returns The directory to read and boundary-check against.
 */
export function resolveSessionCwdOrDefault(
  runtime: AgentRuntime,
  sessionId: string,
  cwdParam: string | undefined
): string {
  if (callerNamedCwd(cwdParam)) return cwdParam;
  return liveSessionCwd(runtime, sessionId) ?? DEFAULT_CWD;
}
