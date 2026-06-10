/**
 * Subscribe-first hydration for a single chat session (spec
 * chat-stream-reconnection, Phase 3 / #9).
 *
 * Wires the active session to the durable `/events` stream and the global
 * session-list stream via the {@link streamManager} singleton, feeding the
 * per-session {@link useSessionStreamState} store through the binding. On open /
 * `sessionId` change / refresh it:
 *
 * 1. Installs the StreamManager → store binding (idempotent).
 * 2. Attaches the active session's durable stream BEFORE relying on live events,
 *    so the cold `snapshot` frame hydrates the store and no `turn_start` is
 *    missed (reconnect + `Last-Event-ID` gap replay are handled by the
 *    StreamManager/SSEConnection).
 * 3. Opens the global session-list stream (idempotent).
 *
 * The store retains per-session state across switches, so detaching the active
 * stream on switch does not discard the previous session's hydrated state — it
 * stays in the `Record<sessionId, …>` store for instant re-display.
 *
 * @module features/chat/model/use-session-stream
 */
import { useEffect } from 'react';
import {
  initSessionStreamBinding,
  useSessionStreamState,
  type SessionStreamState,
} from '@/layers/entities/session';
import { streamManager } from '@/layers/shared/lib/transport';

/**
 * Hydrate and keep-live the per-session stream store for the active session.
 *
 * @param sessionId - The active session id, or `null` when no session is open.
 * @param cwd - The active session's working directory, forwarded to the durable
 *   stream as `?cwd=` so the server resolves completed-message history from the
 *   correct JSONL project (omitting it returns empty history for any session
 *   outside the default cwd). Re-attaches if either `sessionId` or `cwd` changes.
 * @returns The reactive {@link SessionStreamState} for the active session.
 */
export function useSessionStream(sessionId: string | null, cwd: string | null): SessionStreamState {
  useEffect(() => {
    initSessionStreamBinding();
    streamManager.connectList();
    if (!sessionId) return;
    // Subscribe-first: attach BEFORE any reliance on live events so the cold
    // snapshot hydrates and turn_start isn't missed. attachSession is idempotent
    // on the same id+cwd and re-targets on a new one.
    streamManager.attachSession(sessionId, cwd);
  }, [sessionId, cwd]);

  return useSessionStreamState(sessionId ?? '');
}
