/**
 * Direct session-stream methods factory — snapshot hydration and resumable
 * event streams via in-process iteration (no SSE involved).
 *
 * Mirrors `transport/session-stream-methods.ts` (the HTTP twin) so both
 * Transport implementations split along the same domain seams.
 *
 * @module shared/lib/direct/session-stream-methods
 */
import type { SessionOpts } from '@dorkos/shared/agent-runtime';
import type {
  SessionSnapshot,
  SessionEvent,
  SessionListEvent,
} from '@dorkos/shared/session-stream';
import type { DirectTransportServices } from './services';

/**
 * Create the snapshot + subscribe methods bound to the injected services.
 *
 * @param services - In-process service seams wired by the embedding host
 */
export function createDirectSessionStreamMethods(services: DirectTransportServices) {
  /**
   * Build the {@link SessionOpts} context the embedded runtime expects. The
   * snapshot/subscribe adapters read only `cwd`; `permissionMode` is required
   * by the type, and `'default'` is the portable, side-effect-free choice
   * (mirrors the server's events route and session-list broadcaster).
   */
  function sessionCtx(cwd?: string): SessionOpts {
    return { cwd: cwd ?? services.vaultRoot, permissionMode: 'default' };
  }

  return {
    /** Fetch the authoritative session snapshot via the in-process runtime. */
    async getSessionSnapshot(sessionId: string, cwd?: string): Promise<SessionSnapshot> {
      return services.runtime.getSessionSnapshot(sessionCtx(cwd), sessionId);
    },

    /**
     * Subscribe to a session's resumable event stream via in-process iteration —
     * the Direct/Obsidian half of the spec's stream contract (no SSE involved).
     *
     * Returns the runtime's iterable DIRECTLY — no `async *`/`yield*` wrapper. A
     * delegating generator serializes `iterator.return()` behind any pending
     * `next()`, so teardown of a parked stream would hang and the runtime's
     * cleanup would never run. Direct return keeps `return()` (and the abort
     * `signal`) wired straight to the runtime's own iterator.
     */
    subscribeSession(
      sessionId: string,
      sinceCursor?: number,
      cwd?: string,
      signal?: AbortSignal
    ): AsyncIterable<SessionEvent> {
      return services.runtime.subscribeSession(sessionCtx(cwd), sessionId, sinceCursor, signal);
    },

    /**
     * Subscribe to the global session-list stream via in-process iteration.
     *
     * Returns the runtime's iterable DIRECTLY (see {@link subscribeSession}) —
     * this stream has no abort signal in the contract, so a consumer's
     * `iterator.return()` is the ONLY teardown path; wrapping it in a delegating
     * generator would park that call behind a pending `next()` forever and leak
     * the runtime's directory watcher.
     */
    subscribeSessionList(): AsyncIterable<SessionListEvent> {
      return services.runtime.subscribeSessionList(sessionCtx());
    },
  };
}
