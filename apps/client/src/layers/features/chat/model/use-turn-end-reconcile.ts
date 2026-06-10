/**
 * Turn-end reconciliation for a chat session (spec chat-stream-reconnection,
 * Phase 5 / DOR-74).
 *
 * The projector NULLs `inProgressTurn` on `turn_end` and the `/events` snapshot
 * is captured once at connect time, so the completed assistant turn (and the
 * now-canonical user message) would vanish from the projection after the turn
 * settles. This hook detects the active session's streaming→settled transition
 * and reloads canonical history (`transport.getMessages`) into the stream
 * store's `messages`, then clears the optimistic user message — persisting the
 * completed user+assistant turn as full-fidelity JSONL history.
 *
 * @module features/chat/model/use-turn-end-reconcile
 */
import { useEffect, useRef } from 'react';
import type { useTransport } from '@/layers/shared/model';
import { useSessionStreamStore, type SessionStreamState } from '@/layers/entities/session';

interface UseTurnEndReconcileParams {
  sessionId: string | null;
  transport: ReturnType<typeof useTransport>;
  selectedCwd: string | null;
  streamState: SessionStreamState;
  /** Called once per settled turn (e.g. notification sound). */
  onStreamingDone?: () => void;
}

/**
 * Reload canonical history and clear the optimistic message when the active
 * session's turn settles (streaming → idle/blocked/interrupted).
 *
 * Keyed off the CURRENT sessionId via a ref so a session switch mid-turn cannot
 * reload into the wrong session, and gated on a per-session lifecycle ref so the
 * reload runs at most once per settle transition (no infinite loop).
 */
export function useTurnEndReconcile({
  sessionId,
  transport,
  selectedCwd,
  streamState,
  onStreamingDone,
}: UseTurnEndReconcileParams) {
  // Latest values captured in refs so the settle effect reads current state
  // without re-subscribing the effect to every render.
  const sessionIdRef = useRef(sessionId);
  const selectedCwdRef = useRef(selectedCwd);
  const onStreamingDoneRef = useRef(onStreamingDone);
  useEffect(() => {
    sessionIdRef.current = sessionId;
    selectedCwdRef.current = selectedCwd;
    onStreamingDoneRef.current = onStreamingDone;
  });

  // Previous lifecycle per session — detect the streaming → settled edge once.
  const prevLifecycleRef = useRef<Map<string, string | null>>(new Map());

  // Per session: the id of the optimistic user message the CURRENT turn owns,
  // recorded at the turn's →streaming edge. The settle reload uses it to avoid
  // clearing a NEWER optimistic message submitted while the reload was in flight
  // (deterministic with the queued-message auto-flush, which fires on the same
  // settle edge that triggers the reload).
  const turnOptimisticIdRef = useRef<Map<string, string | null>>(new Map());

  const lifecycle = streamState.status?.lifecycle ?? null;

  useEffect(() => {
    if (!sessionId) return;
    const prev = prevLifecycleRef.current.get(sessionId) ?? null;
    prevLifecycleRef.current.set(sessionId, lifecycle);

    if (lifecycle === 'streaming' && prev !== 'streaming') {
      turnOptimisticIdRef.current.set(
        sessionId,
        useSessionStreamStore.getState().getSession(sessionId).optimisticUserMessage?.id ?? null
      );
    }

    // Settle edge: was streaming, now anything else (idle / blocked / interrupted /
    // error). Blocked stays settled-but-waiting; reloading history is still correct
    // because the completed portion of the turn is now persisted.
    const settled = prev === 'streaming' && lifecycle !== 'streaming' && lifecycle !== null;
    if (!settled) return;

    const reloadId = sessionId;
    const ownedOptimisticId = turnOptimisticIdRef.current.get(reloadId) ?? null;
    void transport
      .getMessages(reloadId, selectedCwdRef.current ?? undefined)
      .then((result) => {
        // Guard against a session switch landing the reload on the wrong store
        // entry — only fold history into the session it was requested for.
        const store = useSessionStreamStore.getState();
        const fresh = store.getSession(reloadId);
        // If a NEW turn started while this reload was in flight, the reload
        // predates it: folding it must not wipe the new turn's streamed events…
        const newTurnStreaming = fresh.status?.lifecycle === 'streaming';
        store.setHistoryMessages(reloadId, result.messages, {
          preserveInProgressTurn: newTurnStreaming,
        });
        // …nor clear an optimistic message belonging to the newer send. Only
        // clear the one the settled turn owned (now in the reloaded history).
        const current = fresh.optimisticUserMessage;
        if (current === null || current.id === ownedOptimisticId) {
          store.setOptimisticUserMessage(reloadId, null);
        }
      })
      .catch((err) => {
        // History reload is best-effort; the next snapshot/refresh recovers it.
        // Log so a persistently-stuck optimistic message is diagnosable.
        console.warn('[turn-end-reconcile] history reload failed', {
          sessionId: reloadId,
          error: err instanceof Error ? err.message : String(err),
        });
      });

    onStreamingDoneRef.current?.();
  }, [sessionId, lifecycle, transport]);
}
