/**
 * Drive the chat status strip's compaction state from projected `system_status`
 * session events (DOR-118).
 *
 * Under the durable `/events` contract the SDK's status messages land in the
 * stream store's `inProgressTurn` (the bubble projection correctly skips them).
 * The strip, however, renders from the per-session `systemStatus` store field,
 * whose producer was retired with the legacy in-band pipeline — so "Compacting
 * context…" never showed. This hook watches the projected turn and forwards the
 * compaction-relevant `system_status` events to `setSystemStatus`.
 *
 * Scope is deliberately compaction-only: in-flight `status: 'compacting'` shows
 * the strip and a resolving `compactResult` (success OR failure) clears it. The
 * strip is held STICKY (not auto-dismissed) so it persists for the full
 * compaction — which can exceed the 4s `SYSTEM_STATUS_DISMISS_MS` — and is
 * cleared on the resolution event OR, as a safety net, when the turn ends
 * without one (so the strip can never get stuck). A failed compaction's detail
 * is surfaced inline by the bubble projection, so the strip just clears here.
 *
 * The OTHER `system_status` states the strip can render ("Thinking…" for
 * `status: 'requesting'`, "Running hook…", truncation/refusal notices) were also
 * orphaned by PR #18 and are intentionally left out here — restoring them is a
 * UX decision, not a mechanical forward: `deriveStripState` ranks system-message
 * ABOVE streaming, so forwarding `'requesting'` would suppress the rotating-verb
 * animation mid-turn. That broader restoration is tracked in DOR-125.
 *
 * Snapshot-hydrated events (`seq <= ` the snapshot cursor) are suppressed, as in
 * {@link useTodoEvents}: a reconnect must not replay a long-finished compaction.
 * The trade-off is that a reconnect landing DURING an active compaction will not
 * re-show the strip until the resolution event arrives — acceptable, since the
 * compaction still resolves correctly and the strip is never left stuck.
 *
 * @module features/chat/model/use-system-status-events
 */
import { useEffect, useRef } from 'react';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import type { SystemStatusState } from './chat-types';

/** Per-session forwarding bookkeeping. */
interface StatusWatermark {
  /** The snapshot cursor this watermark was last anchored to. */
  floor: number;
  /** Highest seq already forwarded (or suppressed as snapshot state). */
  seen: number;
  /** Whether a "Compacting context…" strip is currently held for this session. */
  compacting: boolean;
}

/**
 * Forward newly-streamed compaction `system_status` events from the projected
 * in-progress turn to the chat status strip.
 *
 * @param sessionId - The active session, or `null`.
 * @param inProgressTurn - The stream store's projected turn events (seq order).
 * @param streamReadyCursor - The session's snapshot cursor (`null` pre-hydration).
 * @param setSystemStatus - Writes the per-session `systemStatus` store field.
 */
export function useSystemStatusEvents(
  sessionId: string | null,
  inProgressTurn: SessionEvent[],
  streamReadyCursor: number | null,
  setSystemStatus: (payload: SystemStatusState | null) => void
): void {
  const watermarksRef = useRef<Map<string, StatusWatermark>>(new Map());
  const setSystemStatusRef = useRef(setSystemStatus);
  useEffect(() => {
    setSystemStatusRef.current = setSystemStatus;
  });

  useEffect(() => {
    if (!sessionId) return;
    const watermarks = watermarksRef.current;
    const floor = streamReadyCursor ?? 0;
    let mark = watermarks.get(sessionId);
    // First observation, or a NEW snapshot re-anchored the session (reconnect /
    // server-restart seq reset): everything at or below its cursor is hydrated
    // state — start forwarding strictly above it.
    if (!mark || mark.floor !== floor) {
      mark = { floor, seen: floor, compacting: mark?.compacting ?? false };
      watermarks.set(sessionId, mark);
    }
    for (const event of inProgressTurn) {
      if (event.seq <= mark.seen) continue;
      if (event.type === 'system_status') {
        if (event.compactResult !== undefined) {
          // Compaction resolved (success or failure) — clear the strip.
          setSystemStatusRef.current(null);
          mark.compacting = false;
        } else if (event.status === 'compacting') {
          setSystemStatusRef.current({ message: event.message, status: 'compacting' });
          mark.compacting = true;
        }
      }
      mark.seen = event.seq;
    }
    // Safety net: the turn ended (no events in progress) while a compaction strip
    // is still held — its resolution never arrived. Clear so it cannot get stuck.
    if (inProgressTurn.length === 0 && mark.compacting) {
      setSystemStatusRef.current(null);
      mark.compacting = false;
    }
  }, [sessionId, inProgressTurn, streamReadyCursor]);
}
