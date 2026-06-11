/**
 * Subscribe-first hydration + rekey follow-through for a single chat session
 * (spec chat-stream-reconnection, Phase 3 / #9).
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
 * {@link useSessionRekeyRedirect} is this module's id-side companion: when the
 * canonical id resolves only AFTER the trigger 202 (the common Claude path),
 * the server's retire announce rewrites the active URL in place, and the
 * attach effect above re-targets the durable stream to the canonical id.
 *
 * @module features/chat/model/use-session-stream
 */
import { useEffect, useRef } from 'react';
import {
  initSessionStreamBinding,
  useSessionRekeyTarget,
  useSessionStreamState,
  type SessionStreamState,
} from '@/layers/entities/session';
import { streamManager } from '@/layers/shared/lib/transport';
import type { ChatSessionOptions } from './chat-types';

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

/**
 * Replace a retired active-session id with its canonical id — the rekey
 * follow-through for a canonical id that resolves AFTER the trigger 202.
 *
 * The 202 body's canonical id is best-effort: the Claude adapter usually
 * assigns the real SDK id only when the init message lands, AFTER the POST has
 * already resolved with the request UUID. The server then re-keys its projector
 * and re-announces on the global stream (`session_status.retiredSessionId`).
 * This hook watches that announce for the ACTIVE session and rewrites the URL
 * to the canonical id in place — the same `onSessionIdChangeReplace` rewrite
 * the 202-path performs when the id resolves early — so the operator never
 * keeps driving a retired id whose client-side state (compose-next queue,
 * optimistic message) has migrated to the canonical bucket (NF-2, acceptance
 * run 20260611-145454). Once the URL rekeys, {@link useSessionStream}
 * re-attaches the durable stream under the canonical id; a canonical id never
 * retires, so the redirect fires at most once per session.
 *
 * @param sessionId - The active session id, or `null` when no session is open.
 * @param onSessionIdChangeReplace - The caller's in-place URL rewrite (history
 *   `replace`, not push). Optional — embedded hosts without URL routing simply
 *   re-point their store.
 */
export function useSessionRekeyRedirect(
  sessionId: string | null,
  onSessionIdChangeReplace: ChatSessionOptions['onSessionIdChangeReplace']
): void {
  const canonicalId = useSessionRekeyTarget(sessionId);

  // Latest-callback ref, synced in an effect (the use-session-submit pattern).
  // Declared before the redirect effect so the sync runs first each commit.
  const replaceRef = useRef(onSessionIdChangeReplace);
  useEffect(() => {
    replaceRef.current = onSessionIdChangeReplace;
  });

  useEffect(() => {
    if (canonicalId) replaceRef.current?.(canonicalId);
  }, [canonicalId]);
}
