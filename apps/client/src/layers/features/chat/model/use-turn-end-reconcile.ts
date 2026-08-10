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
import type { QueryClient } from '@tanstack/react-query';
import type { useTransport } from '@/layers/shared/model';
import { useSessionStreamStore, type SessionStreamState } from '@/layers/entities/session';
import { projectInProgressTurn } from './stream/project-session-turn';
import { collectApprovalReceipts, applyApprovalReceipts } from '../lib/carry-approval-receipts';

interface UseTurnEndReconcileParams {
  sessionId: string | null;
  transport: ReturnType<typeof useTransport>;
  selectedCwd: string | null;
  streamState: SessionStreamState;
  /** Used to re-sync canonical task state (`['tasks']`) after the turn settles. */
  queryClient: QueryClient;
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
  queryClient,
  onStreamingDone,
}: UseTurnEndReconcileParams) {
  // Latest values captured in refs so the settle effect reads current state
  // without re-subscribing the effect to every render.
  const sessionIdRef = useRef(sessionId);
  const selectedCwdRef = useRef(selectedCwd);
  const onStreamingDoneRef = useRef(onStreamingDone);
  // Who opened the window that is settling (DOR-1100). A ref, not a dep: it must
  // colour the settle effect without re-running it. Synced in this effect —
  // declared BEFORE the settle effect, so it always holds the current value by
  // the time that one reads it — rather than during render, which the
  // refs-during-render rule rightly refuses.
  const turnOriginRef = useRef(streamState.turnOrigin);
  useEffect(() => {
    sessionIdRef.current = sessionId;
    selectedCwdRef.current = selectedCwd;
    onStreamingDoneRef.current = onStreamingDone;
    turnOriginRef.current = streamState.turnOrigin;
  });

  // Previous lifecycle per session — detect the streaming → settled edge once.
  const prevLifecycleRef = useRef<Map<string, string | null>>(new Map());

  // Per session: the hydrationGeneration last observed. A change means the
  // lifecycle now held was set by a SNAPSHOT, not a live event — a switch-back
  // or cold reconnect discovering a turn that settled long ago must re-baseline,
  // not fire the settle effects (spurious reload + notification sound, CLI-B9).
  // The snapshot itself carries fresh history, so skipping the reload is safe;
  // a RESUME reconnect sends no snapshot, so a turn_end replayed from the gap
  // still settles normally (its reload IS needed there).
  const prevHydrationGenRef = useRef<Map<string, number>>(new Map());

  // Per session: the id of the optimistic user message the CURRENT turn owns,
  // recorded at the turn's →streaming edge. The settle reload uses it to avoid
  // clearing a NEWER optimistic message submitted while the reload was in flight
  // (deterministic with the queued-message auto-flush, which fires on the same
  // settle edge that triggers the reload).
  const turnOptimisticIdRef = useRef<Map<string, string | null>>(new Map());

  const lifecycle = streamState.status?.lifecycle ?? null;
  const hydrationGeneration = streamState.hydrationGeneration;

  useEffect(() => {
    if (!sessionId) return;

    const prevGen = prevHydrationGenRef.current.get(sessionId);
    prevHydrationGenRef.current.set(sessionId, hydrationGeneration);
    if (prevGen !== hydrationGeneration) {
      // Snapshot hydration (or first observation): re-baseline without firing.
      prevLifecycleRef.current.set(sessionId, lifecycle);
      if (lifecycle === 'streaming') {
        // The snapshot caught a turn mid-flight — adopt its optimistic message
        // so the eventual LIVE settle can clear the right one.
        turnOptimisticIdRef.current.set(
          sessionId,
          useSessionStreamStore.getState().getSession(sessionId).optimisticUserMessage?.id ?? null
        );
      }
      return;
    }

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

    // Capture the settling turn's answered approvals NOW, before the await: a
    // new turn starting while the reload is in flight replaces `inProgressTurn`
    // and would take this turn's answers with it.
    const settledReceipts = collectApprovalReceipts(
      projectInProgressTurn(useSessionStreamStore.getState().getSession(reloadId).inProgressTurn)
    );

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
        // Canonical history is runtime-owned, so its record of a DorkOS
        // permission prompt is whatever the server overlaid back onto it — and
        // a turn's answers are only durable once the turn ENDS, while this
        // reload also fires when a turn settles to `blocked` mid-turn. Re-apply
        // what the client already derived: this turn's answers plus the ones an
        // earlier reconcile carried, so repeated reloads keep all of them. See
        // `lib/carry-approval-receipts` for the division of labour.
        const carried = new Map([
          ...collectApprovalReceipts(fresh.messages.flatMap((m) => m.parts ?? [])),
          ...settledReceipts,
        ]);
        store.setHistoryMessages(reloadId, applyApprovalReceipts(result.messages, carried), {
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

    // Re-sync canonical task state: the live todo_update forwarding covers the
    // streamed turn, but the settled turn's final list is authoritative on the
    // server (and a turn observed with this tab backgrounded may have throttled
    // effects) — invalidate so useTaskState reloads it (CLI-B4).
    void queryClient.invalidateQueries({ queryKey: ['tasks', reloadId] });

    // The notification answers a REQUEST — "the thing you asked for is done" —
    // so a window nobody asked for does not sound it (DOR-1100). A background
    // task finishing wakes the agent for another window milliseconds after the
    // first one closed, and without this the person is pinged twice for one
    // message. The history reload above deliberately still runs for both: the
    // second one is what folds the continuation into canonical history.
    //
    // The cost, stated plainly: the ping lands when the turn the person sent
    // finishes, not when the wake-up work finishes. That is the honest reading
    // of what the sound has always meant, and it is the quieter of the two.
    if (turnOriginRef.current !== 'runtime') onStreamingDoneRef.current?.();
  }, [sessionId, lifecycle, hydrationGeneration, transport, queryClient]);
}
