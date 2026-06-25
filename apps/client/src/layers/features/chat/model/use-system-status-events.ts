/**
 * Drive the chat status strip's `system_status` state from the projected
 * in-progress turn (DOR-118 compaction; DOR-125 session hooks).
 *
 * Under the durable `/events` contract the SDK's status messages land in the
 * stream store's `inProgressTurn` (the bubble projection correctly skips them).
 * The strip renders from the per-session `systemStatus` store field, whose
 * producer was retired with the legacy in-band pipeline — so these states stopped
 * showing. This hook re-derives them from the projected turn and writes
 * `setSystemStatus`.
 *
 * The strip is a PURE FUNCTION of the turn: {@link deriveStripFromTurn} folds the
 * turn's events to the state to show. Two non-overlapping signals are surfaced:
 *
 * - **Compaction** (durable): an unresolved `status: 'compacting'` shows
 *   "Compacting context…"; a resolving `compactResult` (success OR failure) or
 *   the turn ending clears it. A failed compaction's detail is surfaced inline by
 *   the bubble projection, so the strip just clears here.
 * - **Session hooks** (transient): a non-tool hook emits a `system_status` with a
 *   `message` and no `status` ("Running hook \"X\"…"). It shows until the next
 *   turn event (the model resuming) clears it — so it flashes for exactly as long
 *   as the hook runs, then yields to the streaming verb instead of clobbering it
 *   for the whole turn.
 *
 * Because state is re-derived from `inProgressTurn` on every change, it is correct
 * across reconnect with no extra bookkeeping: a snapshot taken mid-signal re-shows
 * it, and one taken after it resolved clears it — the strip can never get stuck.
 * Writes are gated on a real change to avoid render churn.
 *
 * `status: 'requesting'` ("Thinking…") is deliberately NOT surfaced: the crafted
 * rotating-verb animation already covers the thinking phase for the entire
 * streaming turn, and a system-message outranks streaming in `deriveStripState`,
 * so forwarding it would freeze the verb to a static word (DOR-125).
 *
 * @module features/chat/model/use-system-status-events
 */
import { useEffect, useRef } from 'react';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import type { SystemStatusState } from './chat-types';

/**
 * Fold a turn's events to the strip state they imply. Pure and order-sensitive.
 *
 * Compaction is durable: an unresolved `status: 'compacting'` is shown until a
 * later `compactResult` (success OR failure) or the turn ending clears it. A
 * session hook (`system_status` with a `message` and no `status`) is transient:
 * it is shown until the next turn event — the model resuming — clears it. Any
 * other status (notably `'requesting'`) is ignored; see the module doc.
 *
 * @param turn - The in-progress turn's events, in seq order.
 */
function deriveStripFromTurn(turn: SessionEvent[]): SystemStatusState | null {
  let payload: SystemStatusState | null = null;
  // A hook flash is cleared by the next turn event (the model moving on);
  // compaction is durable and ignores that.
  let payloadIsTransientHook = false;
  for (const event of turn) {
    if (event.type === 'system_status') {
      if (event.compactResult !== undefined) {
        payload = null;
        payloadIsTransientHook = false;
      } else if (event.status === 'compacting') {
        payload = { message: event.message, status: 'compacting' };
        payloadIsTransientHook = false;
      } else if (!event.status) {
        // Non-tool hook progress ("Running hook \"X\"…"): message, no status.
        payload = { message: event.message, status: null };
        payloadIsTransientHook = true;
      }
      // Any other status (e.g. 'requesting') is intentionally not surfaced.
      continue;
    }
    // A non-status event after a hook flash means the turn moved on → clear it.
    if (payloadIsTransientHook) {
      payload = null;
      payloadIsTransientHook = false;
    }
  }
  return payload;
}

/** Whether two strip payloads are equivalent (both null, or same message+status). */
function sameStrip(a: SystemStatusState | null, b: SystemStatusState | null): boolean {
  return (
    (a?.status ?? null) === (b?.status ?? null) && (a?.message ?? null) === (b?.message ?? null)
  );
}

/**
 * Keep the chat status strip's `system_status` state in sync with the projected
 * in-progress turn.
 *
 * @param sessionId - The active session, or `null`.
 * @param inProgressTurn - The stream store's projected turn events (seq order).
 * @param setSystemStatus - Writes the per-session `systemStatus` store field.
 */
export function useSystemStatusEvents(
  sessionId: string | null,
  inProgressTurn: SessionEvent[],
  setSystemStatus: (payload: SystemStatusState | null) => void
): void {
  // The last value written per session — gates redundant store writes (which
  // would otherwise re-render the strip on every projected-turn change).
  const lastWrittenRef = useRef<Map<string, SystemStatusState | null>>(new Map());
  const setSystemStatusRef = useRef(setSystemStatus);
  useEffect(() => {
    setSystemStatusRef.current = setSystemStatus;
  });

  useEffect(() => {
    if (!sessionId) return;
    const derived = deriveStripFromTurn(inProgressTurn);
    const prev = lastWrittenRef.current.get(sessionId) ?? null;
    if (sameStrip(prev, derived)) return;
    setSystemStatusRef.current(derived);
    lastWrittenRef.current.set(sessionId, derived);
  }, [sessionId, inProgressTurn]);
}
