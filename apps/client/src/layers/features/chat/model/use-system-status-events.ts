/**
 * Drive the chat status strip's compaction state from projected `system_status`
 * session events (DOR-118).
 *
 * Under the durable `/events` contract the SDK's status messages land in the
 * stream store's `inProgressTurn` (the bubble projection correctly skips them).
 * The strip, however, renders from the per-session `systemStatus` store field,
 * whose producer was retired with the legacy in-band pipeline — so "Compacting
 * context…" never showed. This hook derives the strip's compaction state from
 * the projected turn and writes it to `setSystemStatus`.
 *
 * The strip is a PURE FUNCTION of the turn: {@link compactionStripState} folds
 * the turn's `system_status` events to "is a compaction in flight right now?".
 * In-flight `status: 'compacting'` shows the strip; a resolving `compactResult`
 * (success OR failure) or the turn ending clears it. Because it is re-derived
 * from `inProgressTurn` every change, it is correct across reconnect with no
 * extra bookkeeping: a snapshot taken mid-compaction re-shows the strip, and one
 * taken after the resolution (even if that resolution arrived during the gap)
 * clears it — so the strip can never get stuck. Writes are gated on a real
 * change to avoid render churn. A failed compaction's detail is surfaced inline
 * by the bubble projection, so the strip just clears here.
 *
 * Scope is deliberately compaction-only. The OTHER `system_status` states the
 * strip can render ("Thinking…" for `status: 'requesting'`, "Running hook…",
 * truncation/refusal notices) were also orphaned by PR #18 and are intentionally
 * left out — restoring them is a UX decision, not a mechanical forward:
 * `deriveStripState` ranks system-message ABOVE streaming, so forwarding
 * `'requesting'` would suppress the rotating-verb animation mid-turn. That
 * broader restoration is tracked in DOR-125.
 *
 * @module features/chat/model/use-system-status-events
 */
import { useEffect, useRef } from 'react';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import type { SystemStatusState } from './chat-types';

/**
 * Fold a turn's events to the compaction strip state it implies: the payload to
 * show when the LAST compaction signal is an unresolved `status: 'compacting'`,
 * or `null` when compaction has resolved or never started. Pure and
 * order-sensitive — a later `compactResult` clears an earlier `compacting`.
 *
 * @param turn - The in-progress turn's events, in seq order.
 */
function compactionStripState(turn: SessionEvent[]): SystemStatusState | null {
  let payload: SystemStatusState | null = null;
  for (const event of turn) {
    if (event.type !== 'system_status') continue;
    if (event.compactResult !== undefined) {
      payload = null;
    } else if (event.status === 'compacting') {
      payload = { message: event.message, status: 'compacting' };
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
 * Keep the chat status strip's compaction state in sync with the projected
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
    const derived = compactionStripState(inProgressTurn);
    const prev = lastWrittenRef.current.get(sessionId) ?? null;
    if (sameStrip(prev, derived)) return;
    setSystemStatusRef.current(derived);
    lastWrittenRef.current.set(sessionId, derived);
  }, [sessionId, inProgressTurn]);
}
