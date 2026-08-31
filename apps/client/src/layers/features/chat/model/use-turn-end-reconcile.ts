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
import {
  useSessionStreamStore,
  type SessionScopedCwd,
  type SessionStreamState,
} from '@/layers/entities/session';
import { projectInProgressTurn } from './stream/project-session-turn';
import { collectApprovalReceipts, applyApprovalReceipts } from '../lib/carry-approval-receipts';

interface UseTurnEndReconcileParams {
  sessionId: string | null;
  transport: ReturnType<typeof useTransport>;
  /** Where this session's own transcript lives — see `useSessionScopedCwd`. */
  sessionCwd: SessionScopedCwd;
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
  sessionCwd,
  streamState,
  queryClient,
  onStreamingDone,
}: UseTurnEndReconcileParams) {
  // The reload has to name the SAME directory the history query used, or the
  // settle would re-fetch a different project's transcript (DOR-1444).
  const selectedCwd = sessionCwd.cwd;
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

  // Per session: whether the turn-finished notification has already been spent
  // on the message currently being answered (DOR-1100). Not "did the settling
  // window belong to a person" — see below.
  const chimeSpentRef = useRef<Map<string, boolean>>(new Map());

  // Per session: the `userTurnCount` last observed, so a CHANGE re-arms the
  // notification. See `SessionStreamState.userTurnCount` for why this is a
  // counter and not an edge.
  const prevUserTurnCountRef = useRef<Map<string, number>>(new Map());

  const lifecycle = streamState.status?.lifecycle ?? null;
  const hydrationGeneration = streamState.hydrationGeneration;
  const userTurnCount = streamState.userTurnCount;

  useEffect(() => {
    if (!sessionId) return;

    // A turn the person started re-arms the notification, wherever in the batch
    // that `turn_start` happened to land.
    const prevUserTurns = prevUserTurnCountRef.current.get(sessionId);
    prevUserTurnCountRef.current.set(sessionId, userTurnCount);
    if (prevUserTurns !== undefined && userTurnCount !== prevUserTurns) {
      chimeSpentRef.current.set(sessionId, false);
    }

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
    // effects) — invalidate so useTaskState reloads it (CLI-B4). This is also
    // the ONLY way useTaskState ever learns a todo list was cleared to empty:
    // an empty result has no live event of its own (opencode's `mapTodos` and
    // claude-code's `buildTodoWriteEvent` both emit nothing for `[]`), and
    // useTaskState only accepts an empty answer from a fetch it can tell was
    // issued at or after every live fold — which firing this AFTER the turn
    // has settled guarantees (DOR-1632).
    void queryClient.invalidateQueries({ queryKey: ['tasks', reloadId] });

    // The notification answers a REQUEST — "the thing you asked for is done" —
    // so it fires ONCE per message, however many windows answering it took
    // (DOR-1100). A background task finishing wakes the agent for another window
    // milliseconds after the first closed, and unguarded that pings the person
    // twice for one message. The history reload above deliberately still runs
    // for every settle: the later ones fold the continuation into canonical
    // history.
    //
    // Spent-once, NOT "the settling window was runtime-opened", because those
    // two only agree when every event arrives in its own commit. When a
    // `turn_end` and the wake-up's `turn_start` land together — guaranteed on a
    // `Last-Event-ID` reconnect replay — the person's own turn never presents a
    // settled edge at all, and origin-keying then fires ZERO times: strictly
    // worse than the double it was fixing.
    if (chimeSpentRef.current.get(reloadId) !== true) {
      chimeSpentRef.current.set(reloadId, true);
      onStreamingDoneRef.current?.();
    }
  }, [sessionId, lifecycle, hydrationGeneration, userTurnCount, transport, queryClient]);
}
