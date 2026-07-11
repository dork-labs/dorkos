/**
 * Drive the chat status strip's transient signals from the projected in-progress
 * turn: operation progress (DOR-110 compaction) and session-hook flashes
 * (DOR-125).
 *
 * Under the durable `/events` contract the runtime's transient events land in the
 * stream store's `inProgressTurn` (the bubble projection correctly skips them).
 * The strip renders from the per-session `operationProgress` and `systemStatus`
 * store fields; this hook re-derives them from the projected turn and writes both.
 *
 * The strip is a PURE FUNCTION of the turn: {@link deriveStripFromTurn} folds the
 * turn's events to the two states to show. Two non-overlapping signals:
 *
 * - **Operation progress** (durable): a `operation_progress` `started` shows the
 *   strip's progress treatment (an indeterminate/percent bar); the matching
 *   `done`/`failed`, or the turn ending, clears it. A failed operation's detail is
 *   surfaced inline by the bubble projection, so the strip just clears here.
 * - **Session hooks** (transient): a non-tool hook emits a `system_status` with a
 *   `message` ("Running hook \"X\"…"). It shows until the next turn event (the
 *   model resuming) clears it — so it flashes for exactly as long as the hook
 *   runs, then yields to the streaming verb instead of clobbering it for the turn.
 *
 * Because state is re-derived from `inProgressTurn` on every change, it is correct
 * across reconnect with no extra bookkeeping: a snapshot taken mid-signal re-shows
 * it, and one taken after it resolved clears it — the strip can never get stuck.
 * Writes are gated on a real change to avoid render churn.
 *
 * @module features/chat/model/use-system-status-events
 */
import { useEffect, useRef } from 'react';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import type { SystemStatusState, OperationProgressState } from './chat-types';

/** The two transient strip states folded from one in-progress turn. */
interface StripSignals {
  operationProgress: OperationProgressState | null;
  systemStatus: SystemStatusState | null;
}

/**
 * Fold a turn's events to the transient strip signals they imply. Pure and
 * order-sensitive.
 *
 * Operation progress is durable: a `operation_progress` `started` is held until a
 * later matching `done`/`failed` (or the turn ending) clears it. A session hook
 * (`system_status` with a `message`) is transient: it is shown until the next
 * turn event — the model resuming — clears it.
 *
 * @param turn - The in-progress turn's events, in seq order.
 */
function deriveStripFromTurn(turn: SessionEvent[]): StripSignals {
  let operationProgress: OperationProgressState | null = null;
  let systemStatus: SystemStatusState | null = null;
  for (const event of turn) {
    if (event.type === 'operation_progress') {
      operationProgress =
        event.state === 'started'
          ? {
              operation: event.operation,
              determinate: event.determinate,
              ...(event.percent !== undefined ? { percent: event.percent } : {}),
              ...(event.message !== undefined ? { message: event.message } : {}),
            }
          : null;
      continue;
    }
    if (event.type === 'system_status') {
      // A non-tool hook flash ("Running hook \"X\"…") is a message with no raw
      // `status`. A generic status token (e.g. `'requesting'`, whose thinking
      // phase the rotating verb already owns) is deliberately NOT surfaced —
      // skip it so it neither shows nor clears a running hook flash.
      if (!event.status) systemStatus = { message: event.message };
      continue;
    }
    // Any other turn event after a hook flash means the turn moved on → clear it.
    // Operation progress is durable and is NOT cleared by unrelated events.
    systemStatus = null;
  }
  return { operationProgress, systemStatus };
}

/** Whether two operation-progress payloads are equivalent. */
function sameOperation(
  a: OperationProgressState | null,
  b: OperationProgressState | null
): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.operation === b.operation &&
    a.determinate === b.determinate &&
    a.percent === b.percent &&
    a.message === b.message
  );
}

/** Whether two system-status payloads are equivalent (both null, or same message). */
function sameStrip(a: SystemStatusState | null, b: SystemStatusState | null): boolean {
  return (a?.message ?? null) === (b?.message ?? null);
}

/**
 * Keep the chat status strip's transient signals in sync with the projected
 * in-progress turn.
 *
 * @param sessionId - The active session, or `null`.
 * @param inProgressTurn - The stream store's projected turn events (seq order).
 * @param setOperationProgress - Writes the per-session `operationProgress` field.
 * @param setSystemStatus - Writes the per-session `systemStatus` field.
 */
export function useSystemStatusEvents(
  sessionId: string | null,
  inProgressTurn: SessionEvent[],
  setOperationProgress: (payload: OperationProgressState | null) => void,
  setSystemStatus: (payload: SystemStatusState | null) => void
): void {
  // The last value written per session — gates redundant store writes (which
  // would otherwise re-render the strip on every projected-turn change).
  const lastOperationRef = useRef<Map<string, OperationProgressState | null>>(new Map());
  const lastStatusRef = useRef<Map<string, SystemStatusState | null>>(new Map());
  const setOperationProgressRef = useRef(setOperationProgress);
  const setSystemStatusRef = useRef(setSystemStatus);
  useEffect(() => {
    setOperationProgressRef.current = setOperationProgress;
    setSystemStatusRef.current = setSystemStatus;
  });

  useEffect(() => {
    if (!sessionId) return;
    const { operationProgress, systemStatus } = deriveStripFromTurn(inProgressTurn);

    const prevOperation = lastOperationRef.current.get(sessionId) ?? null;
    if (!sameOperation(prevOperation, operationProgress)) {
      setOperationProgressRef.current(operationProgress);
      lastOperationRef.current.set(sessionId, operationProgress);
    }

    const prevStatus = lastStatusRef.current.get(sessionId) ?? null;
    if (!sameStrip(prevStatus, systemStatus)) {
      setSystemStatusRef.current(systemStatus);
      lastStatusRef.current.set(sessionId, systemStatus);
    }
  }, [sessionId, inProgressTurn]);
}
