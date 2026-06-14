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
  it('shows the compacting strip while a compaction is in flight', () => {
    // Real failure mode (DOR-118): the strip's legacy producer was retired, so
    // "Compacting context…" never showed under the durable /events contract.
    const setSystemStatus = vi.fn();
    renderHook(() =>
      useSystemStatusEvents(SID, [{ seq: 6, type: 'turn_start' }, compacting(7)], setSystemStatus)
    );
    expect(setSystemStatus).toHaveBeenCalledWith({
      message: 'Compacting context…',
      status: 'compacting',
    });
  });

  it('clears the strip when the compaction resolves (success)', () => {
    const setSystemStatus = vi.fn();
    const { rerender } = renderHook(
      ({ turn }: { turn: SessionEvent[] }) => useSystemStatusEvents(SID, turn, setSystemStatus),
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
    const { rerender } = renderHook(
      ({ turn }: { turn: SessionEvent[] }) => useSystemStatusEvents(SID, turn, setSystemStatus),
      { initialProps: { turn: [compacting(6)] as SessionEvent[] } }
    );
    // The failure detail surfaces inline (bubble projection); the strip just clears.
    rerender({ turn: [compacting(6), resolved(7, 'failed')] });
    expect(setSystemStatus).toHaveBeenLastCalledWith(null);
  });

  it('clears the strip when the turn ends without an explicit resolution', () => {
    // Real failure mode: if compaction never emits its resolving status (turn
    // aborted), the strip must not get stuck — the empty turn clears it.
    const setSystemStatus = vi.fn();
    const { rerender } = renderHook(
      ({ turn }: { turn: SessionEvent[] }) => useSystemStatusEvents(SID, turn, setSystemStatus),
      { initialProps: { turn: [compacting(6)] as SessionEvent[] } }
    );
    rerender({ turn: [] });
    expect(setSystemStatus).toHaveBeenLastCalledWith(null);
  });

  it('re-shows the strip on a snapshot hydrated mid-compaction (reconnect)', () => {
    // A reconnect during an active compaction hydrates the turn with the
    // unresolved `compacting` event — the strip is re-derived and shown, so the
    // operator does not lose the indicator across the gap.
    const setSystemStatus = vi.fn();
    renderHook(() =>
      useSystemStatusEvents(SID, [{ seq: 4, type: 'turn_start' }, compacting(5)], setSystemStatus)
    );
    expect(setSystemStatus).toHaveBeenCalledWith({
      message: 'Compacting context…',
      status: 'compacting',
    });
  });

  it('does not get stuck when the resolution landed during a disconnect (snapshot has both)', () => {
    // The snapshot taken after reconnect carries BOTH the compacting event and
    // its resolution — derived state is "resolved", so the strip is never shown.
    const setSystemStatus = vi.fn();
    renderHook(() =>
      useSystemStatusEvents(SID, [compacting(4), resolved(5, 'success')], setSystemStatus)
    );
    expect(setSystemStatus).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: 'compacting' })
    );
  });

  it('does not write redundantly while the compaction state is unchanged', () => {
    const setSystemStatus = vi.fn();
    const turn: SessionEvent[] = [compacting(6)];
    const { rerender } = renderHook(
      ({ t }: { t: SessionEvent[] }) => useSystemStatusEvents(SID, t, setSystemStatus),
      { initialProps: { t: turn } }
    );
    expect(setSystemStatus).toHaveBeenCalledTimes(1);
    // A new turn array with the same compaction state must not re-write the strip.
    rerender({ t: [compacting(6)] });
    expect(setSystemStatus).toHaveBeenCalledTimes(1);
  });

  it('does nothing without a session id', () => {
    const setSystemStatus = vi.fn();
    renderHook(() => useSystemStatusEvents(null, [compacting(1)], setSystemStatus));
    expect(setSystemStatus).not.toHaveBeenCalled();
  });
});
