/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import { useSystemStatusEvents } from '../use-system-status-events';

const SID = 'sess-1';

function compacting(seq: number): SessionEvent {
  return { seq, type: 'system_status', message: 'Compacting context…', status: 'compacting' };
}

function resolved(seq: number, result: 'success' | 'failed'): SessionEvent {
  return { seq, type: 'system_status', message: 'done', compactResult: result };
}

describe('useSystemStatusEvents', () => {
  it('sets the compacting strip on an in-flight system_status', () => {
    // Real failure mode (DOR-118): the strip's legacy producer was retired, so
    // "Compacting context…" never showed under the durable /events contract.
    const setSystemStatus = vi.fn();
    renderHook(() =>
      useSystemStatusEvents(
        SID,
        [{ seq: 6, type: 'turn_start' }, compacting(7)],
        5,
        setSystemStatus
      )
    );
    expect(setSystemStatus).toHaveBeenCalledWith({
      message: 'Compacting context…',
      status: 'compacting',
    });
  });

  it('clears the strip when the compaction resolves (success)', () => {
    const setSystemStatus = vi.fn();
    const { rerender } = renderHook(
      ({ turn }: { turn: SessionEvent[] }) => useSystemStatusEvents(SID, turn, 5, setSystemStatus),
      { initialProps: { turn: [compacting(6)] as SessionEvent[] } }
    );
    expect(setSystemStatus).toHaveBeenLastCalledWith({
      message: 'Compacting context…',
      status: 'compacting',
    });

    rerender({ turn: [compacting(6), resolved(7, 'success')] });
    expect(setSystemStatus).toHaveBeenLastCalledWith(null);
  });

  it('clears the strip when the compaction resolves with a failure', () => {
    const setSystemStatus = vi.fn();
    renderHook(() =>
      useSystemStatusEvents(SID, [compacting(6), resolved(7, 'failed')], 5, setSystemStatus)
    );
    // The failure detail surfaces inline (bubble projection); the strip just clears.
    expect(setSystemStatus).toHaveBeenLastCalledWith(null);
  });

  it('clears a held compacting strip when the turn ends without a resolution', () => {
    // Real failure mode: if compaction never emits its resolving status (turn
    // aborted), the strip must not get stuck — the empty turn clears it.
    const setSystemStatus = vi.fn();
    const { rerender } = renderHook(
      ({ turn }: { turn: SessionEvent[] }) => useSystemStatusEvents(SID, turn, 5, setSystemStatus),
      { initialProps: { turn: [compacting(6)] as SessionEvent[] } }
    );
    expect(setSystemStatus).toHaveBeenLastCalledWith({
      message: 'Compacting context…',
      status: 'compacting',
    });

    // turn_end nulls inProgressTurn → the store exposes an empty turn.
    rerender({ turn: [] });
    expect(setSystemStatus).toHaveBeenLastCalledWith(null);
  });

  it('suppresses snapshot-hydrated events (seq at or below the cursor)', () => {
    // A mid-compaction reconnect replays the compacting event in the snapshot;
    // re-driving the strip from hydrated state would resurrect a finished one.
    const setSystemStatus = vi.fn();
    renderHook(() => useSystemStatusEvents(SID, [compacting(4)], 5, setSystemStatus));
    expect(setSystemStatus).not.toHaveBeenCalled();
  });

  it('does nothing without a session id', () => {
    const setSystemStatus = vi.fn();
    renderHook(() => useSystemStatusEvents(null, [compacting(1)], 0, setSystemStatus));
    expect(setSystemStatus).not.toHaveBeenCalled();
  });
});
