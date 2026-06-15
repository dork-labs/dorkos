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

/** A non-tool hook progress event ("Running hook X…") — message, no status. */
function hook(seq: number, name: string): SessionEvent {
  return { seq, type: 'system_status', message: `Running hook "${name}"...` };
}

/** A streamed assistant text delta — stands in for "the model resumed". */
function textDelta(seq: number, text = 'Hi'): SessionEvent {
  return { seq, type: 'text_delta', text };
}

/** The thinking-phase status the strip must NOT surface (the rotating verb owns it). */
function requesting(seq: number): SessionEvent {
  return { seq, type: 'system_status', message: 'Status: requesting', status: 'requesting' };
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

  it('shows a session hook flash while the hook is running (DOR-125)', () => {
    // A non-tool hook ("Running hook X…") was orphaned by PR #18. While it runs
    // and nothing else has streamed, the strip surfaces it.
    const setSystemStatus = vi.fn();
    renderHook(() =>
      useSystemStatusEvents(
        SID,
        [{ seq: 1, type: 'turn_start' }, hook(2, 'inject-context')],
        setSystemStatus
      )
    );
    expect(setSystemStatus).toHaveBeenCalledWith({
      message: 'Running hook "inject-context"...',
      status: null,
    });
  });

  it('clears the hook flash once the model resumes (next turn event)', () => {
    // The flash is transient: the first event after the hook (the model
    // streaming) clears it so the crafted rotating verb takes over instead of a
    // frozen label.
    const setSystemStatus = vi.fn();
    const { rerender } = renderHook(
      ({ turn }: { turn: SessionEvent[] }) => useSystemStatusEvents(SID, turn, setSystemStatus),
      { initialProps: { turn: [hook(1, 'pre')] as SessionEvent[] } }
    );
    expect(setSystemStatus).toHaveBeenLastCalledWith({
      message: 'Running hook "pre"...',
      status: null,
    });
    rerender({ turn: [hook(1, 'pre'), textDelta(2)] });
    expect(setSystemStatus).toHaveBeenLastCalledWith(null);
  });

  it('does not surface "requesting" — the rotating verb owns the thinking phase (DOR-125)', () => {
    const setSystemStatus = vi.fn();
    renderHook(() =>
      useSystemStatusEvents(SID, [{ seq: 1, type: 'turn_start' }, requesting(2)], setSystemStatus)
    );
    expect(setSystemStatus).not.toHaveBeenCalled();
  });

  it('keeps the compaction strip through content events (durable, unlike hooks)', () => {
    // A content delta clears a transient hook but must NOT clear an in-flight
    // compaction — compaction only resolves via compactResult or turn end.
    const setSystemStatus = vi.fn();
    renderHook(() => useSystemStatusEvents(SID, [compacting(1), textDelta(2)], setSystemStatus));
    expect(setSystemStatus).toHaveBeenLastCalledWith({
      message: 'Compacting context…',
      status: 'compacting',
    });
  });

  it('does nothing without a session id', () => {
    const setSystemStatus = vi.fn();
    renderHook(() => useSystemStatusEvents(null, [compacting(1)], setSystemStatus));
    expect(setSystemStatus).not.toHaveBeenCalled();
  });
});
