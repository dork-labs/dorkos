// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useLongPress } from '../use-long-press';

const HOLD_MS = 500;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** The only three fields the hook reads off a pointer event. */
function pointer(x: number, y: number, button = 0): ReactPointerEvent {
  return { button, clientX: x, clientY: y } as ReactPointerEvent;
}

describe('useLongPress', () => {
  it('fires once the press has lasted long enough', () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress({ onLongPress }));

    act(() => result.current.onPointerDown(pointer(10, 10)));
    act(() => void vi.advanceTimersByTime(HOLD_MS));

    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it('does not fire for a press that ends early', () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress({ onLongPress }));

    act(() => result.current.onPointerDown(pointer(10, 10)));
    act(() => void vi.advanceTimersByTime(HOLD_MS - 1));
    act(() => result.current.onPointerUp());
    act(() => void vi.advanceTimersByTime(HOLD_MS));

    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('tolerates the drift of a finger that is trying to hold still', () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress({ onLongPress }));

    act(() => result.current.onPointerDown(pointer(10, 10)));
    act(() => result.current.onPointerMove(pointer(14, 13)));
    act(() => void vi.advanceTimersByTime(HOLD_MS));

    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it('stands down once the pointer has travelled — that is a scroll or a selection', () => {
    // The gesture the reader started belongs to them. A menu opening under a
    // drag would take it away mid-motion, and a mouse dragged across selectable
    // text never fires the `pointercancel` this used to wait for.
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress({ onLongPress }));

    act(() => result.current.onPointerDown(pointer(10, 10)));
    act(() => result.current.onPointerMove(pointer(10, 60)));
    act(() => void vi.advanceTimersByTime(HOLD_MS));

    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('ignores movement when no press is underway', () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress({ onLongPress }));

    expect(() => act(() => result.current.onPointerMove(pointer(400, 400)))).not.toThrow();
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('ignores a non-primary button', () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress({ onLongPress }));

    act(() => result.current.onPointerDown(pointer(10, 10, 2)));
    act(() => void vi.advanceTimersByTime(HOLD_MS));

    expect(onLongPress).not.toHaveBeenCalled();
  });
});
