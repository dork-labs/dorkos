/**
 * Derive the status strip's live-turn metrics from the projected session
 * stream (CLI-B6).
 *
 * The legacy in-band pipeline wrote `streamStartTime` / `estimatedTokens` /
 * `isTextStreaming` into the per-session chat store as frames arrived; under
 * the durable `/events` contract no writer remained, so the strip rendered a
 * dead "0m 00s" / "~0 tokens" for every turn. This hook re-derives all three
 * from the stream store's projection:
 *
 * - `streamStartTime` — wall-clock anchor captured at the session's
 *   not-streaming → streaming edge (the contract carries no timestamps, so a
 *   client attaching mid-turn anchors at attach time — honest best effort).
 * - `estimatedTokens` — ~4 chars/token across the turn's streamed text deltas
 *   (the legacy heuristic).
 * - `isTextStreaming` — true while text deltas are actively arriving, decaying
 *   500ms after the last one (drives the message-list typing affordances).
 *
 * @module features/chat/model/use-stream-timing
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionEvent } from '@dorkos/shared/session-stream';

/** How long after the last text delta the "actively typing" flag stays up. */
const TEXT_STREAM_DECAY_MS = 500;

/** The status strip's live-turn metrics. */
export interface StreamTiming {
  /** Wall-clock ms when the active turn started streaming, or `null` when idle. */
  streamStartTime: number | null;
  /** Rough output-token estimate for the active turn (~4 chars/token). */
  estimatedTokens: number;
  /** Whether assistant text is actively arriving (500ms decay). */
  isTextStreaming: boolean;
}

/**
 * Derive `streamStartTime` / `estimatedTokens` / `isTextStreaming` for the
 * active session from its projected in-progress turn.
 *
 * @param sessionId - The active session, or `null`.
 * @param inProgressTurn - The stream store's projected turn events (seq order).
 * @param isStreaming - Whether the rendered chat status is `streaming`.
 */
export function useStreamTiming(
  sessionId: string | null,
  inProgressTurn: SessionEvent[],
  isStreaming: boolean
): StreamTiming {
  // Per-session start anchors, keyed to the TURN's identity (its first event's
  // seq — the turn_start). Switching away and back mid-turn keeps the original
  // elapsed baseline, while a DIFFERENT turn under the same session (settled and
  // restarted while backgrounded, or back-to-back turns coalesced into one
  // render by a queued flush) re-anchors instead of reusing the stale clock.
  const startTimesRef = useRef<Map<string, { turnSeq: number; anchor: number }>>(new Map());
  const [streamStartTime, setStreamStartTime] = useState<number | null>(null);
  const turnSeq = inProgressTurn.length > 0 ? inProgressTurn[0].seq : -1;

  /* eslint-disable react-hooks/set-state-in-effect -- both effects synchronize
     with the wall clock (an external system): the first anchors Date.now() at
     the streaming edge, the second decays a flag on a timer. */
  useEffect(() => {
    const startTimes = startTimesRef.current;
    if (!sessionId || !isStreaming) {
      if (sessionId) startTimes.delete(sessionId);
      setStreamStartTime(null);
      return;
    }
    let entry = startTimes.get(sessionId);
    if (!entry || entry.turnSeq !== turnSeq) {
      entry = { turnSeq, anchor: Date.now() };
      startTimes.set(sessionId, entry);
    }
    setStreamStartTime(entry.anchor);
  }, [sessionId, isStreaming, turnSeq]);

  const estimatedTokens = useMemo(() => {
    let chars = 0;
    for (const event of inProgressTurn) {
      if (event.type === 'text_delta') chars += event.text.length;
    }
    return chars / 4;
  }, [inProgressTurn]);

  // "Actively typing" with decay: flips true when the token estimate grows for
  // the SAME session, then decays once no growth lands for TEXT_STREAM_DECAY_MS.
  // The timer is (re)armed on every run while the flag is up, so an unrelated
  // re-render can never strand it true.
  const [isTextStreaming, setIsTextStreaming] = useState(false);
  const prevRef = useRef<{ sid: string | null; tokens: number }>({ sid: null, tokens: 0 });
  useEffect(() => {
    const prev = prevRef.current;
    const grew = sessionId === prev.sid && estimatedTokens > prev.tokens;
    prevRef.current = { sid: sessionId, tokens: estimatedTokens };
    if (grew && !isTextStreaming) setIsTextStreaming(true);
    if (!grew && !isTextStreaming) return;
    const timer = setTimeout(() => setIsTextStreaming(false), TEXT_STREAM_DECAY_MS);
    return () => clearTimeout(timer);
  }, [sessionId, estimatedTokens, isTextStreaming]);
  /* eslint-enable react-hooks/set-state-in-effect */

  return { streamStartTime, estimatedTokens, isTextStreaming };
}
