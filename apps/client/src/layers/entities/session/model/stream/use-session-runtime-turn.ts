/**
 * Whether the turn now open was started by the runtime rather than by a
 * person (DOR-3202): a helper's ask raised after the reply, or the agent
 * waking itself up.
 *
 * Read off the open turn's own `turn_start`, so it holds after a reload as
 * well as live: a snapshot carries the in-progress turn but no origin field
 * of its own.
 *
 * @module entities/session/model/stream/use-session-runtime-turn
 */
import { useCallback } from 'react';
import { useSessionStreamStore } from './session-stream-store';

/**
 * True while the open turn is one no person started.
 *
 * @param sessionId - The session to read.
 */
export function useSessionRuntimeTurn(sessionId: string): boolean {
  return useSessionStreamStore(
    useCallback(
      (s) => {
        const turn = s.sessions[sessionId]?.inProgressTurn ?? [];
        for (let i = turn.length - 1; i >= 0; i--) {
          const event = turn[i]!;
          if (event.type === 'turn_start') return event.origin === 'runtime';
        }
        return false;
      },
      [sessionId]
    )
  );
}
