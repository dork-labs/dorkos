/**
 * Resolve which account a SESSION is bound to, so a re-login started from that
 * session signs the right one back in (DOR-1651).
 *
 * The client cannot answer this. `Session.account` on the session list is
 * derived from the transcript on disk, so it is absent for exactly the session
 * that most needs it: one whose FIRST turn failed on a bad credential, before
 * anything was written. An agent pinned to a second account would then re-auth
 * the default account, report success, and fail again — the DOR-1652 bug one
 * rung down. The server owns the launch ladder, so the server answers.
 *
 * @module services/runtimes/connect/resolve-session-account
 */
import { logger } from '../../../lib/logger.js';
import { DEFAULT_CWD } from '../../../lib/resolve-root.js';
import { runtimeRegistry } from '../../core/runtime-registry.js';

/**
 * A runtime that can name the account one of its sessions runs on.
 *
 * Structural rather than a widened `AgentRuntime`: accounts are a
 * Claude-Code-only concept, and every other runtime would have to implement a
 * method meaning nothing to it.
 */
interface AccountAwareRuntime {
  /** The absolute config directory this session runs and bills on. */
  accountRootForSession(sessionId: string, projectDir: string): Promise<string>;
}

/** Whether this runtime can name a session's account. */
function isAccountAware(runtime: unknown): runtime is AccountAwareRuntime {
  return (
    typeof runtime === 'object' &&
    runtime !== null &&
    typeof (runtime as AccountAwareRuntime).accountRootForSession === 'function'
  );
}

/**
 * The account root a session is bound to, or `undefined` when there is no
 * honest answer — an unknown session, a runtime with no account concept, or a
 * lookup that failed.
 *
 * `undefined` always means "sign into the account DorkOS runs new sessions on",
 * never an error: every failure here degrades to the behaviour the endpoint had
 * before a session could be named, rather than blocking a sign-in someone is
 * waiting on.
 *
 * @param sessionId - The session whose account is wanted.
 */
export async function resolveAccountRootForSession(sessionId: string): Promise<string | undefined> {
  try {
    const runtime = await runtimeRegistry.resolveForSession(sessionId);
    if (!isAccountAware(runtime)) return undefined;
    const projectDir = (await runtimeRegistry.getSessionAgentPath(sessionId)) ?? DEFAULT_CWD;
    return await runtime.accountRootForSession(sessionId, projectDir);
  } catch (err) {
    // An unregistered runtime, a session with no binding row, an unreadable
    // manifest: none of these are worth refusing a sign-in over.
    logger.warn('[Connect] could not resolve the session account; using the active one', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}
