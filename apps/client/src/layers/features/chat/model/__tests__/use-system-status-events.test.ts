/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import { useSystemStatusEvents } from '../use-system-status-events';

const SID = 'sess-1';

/** A compaction start — the standardized operation_progress `started` phase. */
function compacting(seq: number): SessionEvent {
  return {
    seq,
    type: 'operation_progress',
    operation: 'compaction',
    state: 'started',
    determinate: false,
    message: 'Compacting context…',
  };
}

/** A compaction resolution — `done` (success) or `failed`. */
function resolved(seq: number, result: 'success' | 'failed'): SessionEvent {
  return {
    seq,
    type: 'operation_progress',
    operation: 'compaction',
    state: result === 'success' ? 'done' : 'failed',
    determinate: false,
    ...(result === 'failed' ? { error: 'boom' } : {}),
  };
}

/** A non-tool hook progress event ("Running hook X…") — message, no operation. */
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

describe('useSystemStatusEvents — operation progress (compaction)', () => {
  it('shows the compaction bar while a compaction is in flight', () => {
    const setOp = vi.fn();
    const setStatus = vi.fn();
    renderHook(() =>
      useSystemStatusEvents(SID, [{ seq: 6, type: 'turn_start' }, compacting(7)], setOp, setStatus)
    );
    expect(setOp).toHaveBeenCalledWith({
      operation: 'compaction',
      determinate: false,
      message: 'Compacting context…',
    });
  });

  it('clears the bar when the compaction resolves (success)', () => {
    const setOp = vi.fn();
    const setStatus = vi.fn();
    const { rerender } = renderHook(
      ({ turn }: { turn: SessionEvent[] }) => useSystemStatusEvents(SID, turn, setOp, setStatus),
      { initialProps: { turn: [compacting(6)] as SessionEvent[] } }
    );
    expect(setOp).toHaveBeenLastCalledWith(expect.objectContaining({ operation: 'compaction' }));

    rerender({ turn: [compacting(6), resolved(7, 'success')] });
    expect(setOp).toHaveBeenLastCalledWith(null);
  });

  it('clears the bar when the compaction resolves with a failure', () => {
    const setOp = vi.fn();
    const setStatus = vi.fn();
    const { rerender } = renderHook(
      ({ turn }: { turn: SessionEvent[] }) => useSystemStatusEvents(SID, turn, setOp, setStatus),
      { initialProps: { turn: [compacting(6)] as SessionEvent[] } }
    );
    // The failure detail surfaces inline (bubble projection); the bar just clears.
    rerender({ turn: [compacting(6), resolved(7, 'failed')] });
    expect(setOp).toHaveBeenLastCalledWith(null);
  });

  it('clears the bar when the turn ends without an explicit resolution', () => {
    const setOp = vi.fn();
    const setStatus = vi.fn();
    const { rerender } = renderHook(
      ({ turn }: { turn: SessionEvent[] }) => useSystemStatusEvents(SID, turn, setOp, setStatus),
      { initialProps: { turn: [compacting(6)] as SessionEvent[] } }
    );
    rerender({ turn: [] });
    expect(setOp).toHaveBeenLastCalledWith(null);
  });

  it('re-shows the bar on a snapshot hydrated mid-compaction (reconnect)', () => {
    const setOp = vi.fn();
    const setStatus = vi.fn();
    renderHook(() =>
      useSystemStatusEvents(SID, [{ seq: 4, type: 'turn_start' }, compacting(5)], setOp, setStatus)
    );
    expect(setOp).toHaveBeenCalledWith(expect.objectContaining({ operation: 'compaction' }));
  });

  it('does not get stuck when the resolution landed during a disconnect (snapshot has both)', () => {
    const setOp = vi.fn();
    const setStatus = vi.fn();
    renderHook(() =>
      useSystemStatusEvents(SID, [compacting(4), resolved(5, 'success')], setOp, setStatus)
    );
    expect(setOp).not.toHaveBeenCalledWith(expect.objectContaining({ operation: 'compaction' }));
  });

  it('does not write redundantly while the compaction state is unchanged', () => {
    const setOp = vi.fn();
    const setStatus = vi.fn();
    const turn: SessionEvent[] = [compacting(6)];
    const { rerender } = renderHook(
      ({ t }: { t: SessionEvent[] }) => useSystemStatusEvents(SID, t, setOp, setStatus),
      { initialProps: { t: turn } }
    );
    expect(setOp).toHaveBeenCalledTimes(1);
    // A new turn array with the same compaction state must not re-write the bar.
    rerender({ t: [compacting(6)] });
    expect(setOp).toHaveBeenCalledTimes(1);
  });

  it('keeps the compaction bar through content events (durable, unlike hooks)', () => {
    const setOp = vi.fn();
    const setStatus = vi.fn();
    renderHook(() => useSystemStatusEvents(SID, [compacting(1), textDelta(2)], setOp, setStatus));
    expect(setOp).toHaveBeenLastCalledWith(expect.objectContaining({ operation: 'compaction' }));
  });

  it('does nothing without a session id', () => {
    const setOp = vi.fn();
    const setStatus = vi.fn();
    renderHook(() => useSystemStatusEvents(null, [compacting(1)], setOp, setStatus));
    expect(setOp).not.toHaveBeenCalled();
    expect(setStatus).not.toHaveBeenCalled();
  });
});

describe('useSystemStatusEvents — session hooks', () => {
  it('shows a session hook flash while the hook is running (DOR-125)', () => {
    const setOp = vi.fn();
    const setStatus = vi.fn();
    renderHook(() =>
      useSystemStatusEvents(
        SID,
        [{ seq: 1, type: 'turn_start' }, hook(2, 'inject-context')],
        setOp,
        setStatus
      )
    );
    expect(setStatus).toHaveBeenCalledWith({ message: 'Running hook "inject-context"...' });
  });

  it('clears the hook flash once the model resumes (next turn event)', () => {
    const setOp = vi.fn();
    const setStatus = vi.fn();
    const { rerender } = renderHook(
      ({ turn }: { turn: SessionEvent[] }) => useSystemStatusEvents(SID, turn, setOp, setStatus),
      { initialProps: { turn: [hook(1, 'pre')] as SessionEvent[] } }
    );
    expect(setStatus).toHaveBeenLastCalledWith({ message: 'Running hook "pre"...' });
    rerender({ turn: [hook(1, 'pre'), textDelta(2)] });
    expect(setStatus).toHaveBeenLastCalledWith(null);
  });

  it('does not surface "requesting" — the rotating verb owns the thinking phase (DOR-125)', () => {
    const setOp = vi.fn();
    const setStatus = vi.fn();
    renderHook(() =>
      useSystemStatusEvents(SID, [{ seq: 1, type: 'turn_start' }, requesting(2)], setOp, setStatus)
    );
    expect(setStatus).not.toHaveBeenCalled();
  });
});
