/**
 * One Codex turn's use of its thread key: attach the open turn's binding so the
 * thread's DorkOS tools act for that turn, detach it when the turn ends, and say
 * so at the default log level when a thread that was handed the `dorkos` MCP
 * server never fetched its tool list (DOR-4384).
 *
 * That last part is the only sign left when the binding breaks: DOR-3169's
 * threads loaded the server, the key never resolved, the listener refused every
 * call, and the agent quietly had no DorkOS tools while nothing was logged. The
 * listener records each answered `tools/list` on the key
 * (`ConnectorThreadKeyRegistry.noteToolsListed`); a completed turn whose key has
 * none is the broken binding. Read-only threads connect lazily once the turn
 * opens, so it is checked when the turn completes, never at load.
 *
 * @module services/runtimes/codex/transport/thread-key-turn
 */
import { logger } from '../../../../lib/logger.js';
import type { ConnectorThreadKeyPort } from '../../../connectors/runtime-principal-port.js';
import type { CodexTurnRequest } from './codex-transport.js';

/** One turn's thread-key steps, in order: attach, then end. */
export interface ThreadKeyTurn {
  /** Attach the open turn's binding; a failure is logged and the turn runs without it. */
  attach(): void;
  /**
   * Detach the binding, and once the turn has completed, warn if its thread
   * never fetched its DorkOS tools.
   *
   * @param completed - The turn's final status, or `undefined` for a turn that
   *   runs no tools (a compaction).
   */
  end(completed: Promise<string> | undefined): void;
}

/** Keys already warned about, so a load warns once however many turns it runs. */
const warned = new Set<string>();
/** Past this many, the warned set starts over: a bound, not a ledger. */
const MAX_WARNED = 1000;

/**
 * Warn once for a live key whose thread never fetched its DorkOS tool list.
 *
 * @param keys - The thread-key registry.
 * @param keyId - The key the thread was loaded with.
 * @param where - The chat and the thread, for the log line.
 */
function warnIfUnlisted(
  keys: ConnectorThreadKeyPort | undefined,
  keyId: string,
  where: { sessionId: string; threadId: string }
): void {
  const listing = keys?.toolListing?.(keyId);
  if (listing === undefined || listing.listed || warned.has(keyId)) return;
  if (warned.size >= MAX_WARNED) warned.clear();
  warned.add(keyId);
  logger.warn(
    '[CodexAppServer] a Codex thread got the DorkOS tools server but listed none of its tools',
    {
      sessionId: where.sessionId,
      threadId: where.threadId,
      loadKind: listing.scope.loadKind ?? 'unknown',
      keyId,
    }
  );
}

/**
 * The thread-key steps for one turn.
 *
 * @param keys - The thread-key registry, when the listener is wired.
 * @param loaded - The loaded thread and the key it was loaded with.
 * @param request - The turn's tools: its DorkOS tools and its binding.
 * @param sessionId - The DorkOS chat.
 */
export function threadKeyTurn(
  keys: ConnectorThreadKeyPort | undefined,
  loaded: { readonly threadId: string; readonly keyId: string | undefined },
  request: Pick<CodexTurnRequest, 'tools'>,
  sessionId: string
): ThreadKeyTurn {
  const attached =
    loaded.keyId !== undefined && request.tools.connectorBindingId !== undefined
      ? { keyId: loaded.keyId, bindingId: request.tools.connectorBindingId }
      : undefined;
  return {
    attach() {
      if (!attached) return;
      try {
        keys?.attach(attached.keyId, {
          bindingId: attached.bindingId,
          canonicalSessionId: sessionId,
        });
      } catch (err) {
        // The turn runs; its DorkOS tools are refused (nothing is attached).
        logger.warn('[CodexAppServer] could not attach the turn to its thread key', {
          sessionId,
          keyId: attached.keyId,
          err: String(err),
        });
      }
    },
    end(completed) {
      if (attached) keys?.detach(attached.keyId, attached.bindingId);
      const keyId = loaded.keyId;
      if (completed === undefined || keyId === undefined || !request.tools.dorkosTools) return;
      void completed.then((status) => {
        if (status === 'completed') warnIfUnlisted(keys, keyId, { sessionId, ...loaded });
      });
    },
  };
}

/**
 * Forget which keys were warned about.
 *
 * @internal Exported for tests.
 */
export function resetThreadKeyTurnWarnings(): void {
  warned.clear();
}
