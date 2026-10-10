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
 *   (`/:id`, `/:id/messages`). It checks the live and durable bindings before
 *   verifying the default.
 * - {@link resolveSessionCwdOrDefault} — for a read that must not fail
 *   (`/:id/events`, `/:id/tasks`). The durable stream has to be openable for
 *   ANY well-formed session id, including one that does not exist server-side
 *   yet, so it checks the live and durable bindings, then defaults rather than
 *   refusing.
 *
 * Native discovery is asynchronous and takes precedence over a caller's
 * directory hint. Directory-scoped fallback applies only when the runtime
 * cannot discover the session by ID. Rename and fork share this resolution
 * and validate the resulting directory before writing.
 *
 * @module services/session/resolution/resolve-read-cwd
 *
 * Named `resolve-read-cwd` (not `resolve-session-cwd`) deliberately: the
 * workspace resolver of that name owns the ONE-RESOLUTION-PER-TURN binding and
 * guards its import graph by basename
 * (`services/workspace/__tests__/resolve-session-cwd.subagent.test.ts`). This
 * module answers a different question — which directory a READ route should
 * consult — and must stay clear of that guard's match.
 */
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import { DEFAULT_CWD } from '../../../lib/resolve-root.js';
import { runtimeRegistry } from '../../core/runtime-registry.js';
import { logger } from '../../../lib/logger.js';
import { resolveSettingsKey } from './session-settings-overlay.js';

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
 * Recover the directory from the durable session binding after eviction/restart.
 * Aliases use the same canonical key as settings. A missing or unavailable
 * binding leaves the existing runtime/default lookup in charge.
 */
async function persistedSessionCwd(
  runtime: AgentRuntime,
  sessionId: string
): Promise<string | null> {
  try {
    return await runtimeRegistry.getSessionAgentPath(resolveSettingsKey(sessionId, runtime));
  } catch (error) {
    logger.warn('[session read] could not read the durable directory binding', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Resolve an existing session's read directory asynchronously: live or durable
 * native binding, native store metadata, caller hint, persisted agent binding,
 * then verified default lookup.
 * Runtimes without directory-scoped native storage retain their default.
 * Every caller must boundary-check this result before reading.
 */
export async function resolveSessionCwdOrNull(
  runtime: AgentRuntime,
  sessionId: string,
  cwdParam: string | undefined
): Promise<string | null> {
  const knownCwd =
    liveSessionCwd(runtime, sessionId) ??
    runtimeRegistry.getNativeSessionCwd?.(resolveSettingsKey(sessionId, runtime)) ??
    (await runtime.findSession?.(runtime.getInternalSessionId(sessionId) ?? sessionId))?.cwd;
  if (knownCwd) return knownCwd;
  if (callerNamedCwd(cwdParam)) return cwdParam;
  const persisted = await persistedSessionCwd(runtime, sessionId);
  if (persisted) return persisted;

  if (runtime.getSessionCwd === undefined) return DEFAULT_CWD;

  try {
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
 * Resolve the directory for a read that accepts not-yet-created sessions.
 *
 * Verified live or native cwd wins, including its durable native binding.
 * Caller cwd supplies draft context only when no native directory is known.
 * Unknown ids retain the default so subscribe-before-create still works.
 * Every caller must boundary-check the resolved directory before reading it.
 *
 * @param runtime - The resolved runtime for this session.
 * @param sessionId - The client-facing session id; aliases resolve internally.
 * @param cwdParam - The caller-supplied directory, if any.
 * @returns The directory to read and boundary-check.
 */
export async function resolveSessionCwdOrDefault(
  runtime: AgentRuntime,
  sessionId: string,
  cwdParam: string | undefined
): Promise<string> {
  return (
    liveSessionCwd(runtime, sessionId) ??
    runtimeRegistry.getNativeSessionCwd?.(resolveSettingsKey(sessionId, runtime)) ??
    (await runtime.findSession?.(runtime.getInternalSessionId(sessionId) ?? sessionId))?.cwd ??
    (callerNamedCwd(cwdParam) ? cwdParam : undefined) ??
    (await persistedSessionCwd(runtime, sessionId)) ??
    DEFAULT_CWD
  );
}
