// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useLongPress } from '../use-long-press';

const HOLD_MS = 500;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** The only fields the hook reads off a pointer event. */
function pointer(x: number, y: number, button = 0, target?: Element): ReactPointerEvent {
  return { button, clientX: x, clientY: y, target } as unknown as ReactPointerEvent;
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

  it('drops a press whose element goes away mid-hold', () => {
    // The surface a press opens can take the pressed row with it — a menu item
    // that navigates, a model rebuild that drops the row. A timer still running
    // then calls back into a component that no longer exists, and reports it in
    // a stack trace naming none of this.
    const onLongPress = vi.fn();
    const onPressStateChange = vi.fn();
    const { result, unmount } = renderHook(() => useLongPress({ onLongPress, onPressStateChange }));

    act(() => result.current.onPointerDown(pointer(10, 10)));
    expect(onPressStateChange).toHaveBeenLastCalledWith('pressing');

    unmount();
    act(() => void vi.advanceTimersByTime(HOLD_MS * 3));

    expect(onLongPress).not.toHaveBeenCalled();
    // …and the press was ended rather than merely muted: a gesture nobody
    // finished is `cancelled`, which is what a pressed surface springs back on.
    expect(onPressStateChange).toHaveBeenLastCalledWith('cancelled');
  });

  it('still fires for a press whose element stays put — the pair for the case above', () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress({ onLongPress }));

    act(() => result.current.onPointerDown(pointer(10, 10)));
    act(() => void vi.advanceTimersByTime(HOLD_MS * 3));

    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  describe('yieldToSelector', () => {
    it('never arms when the press starts on the marked element itself', () => {
      const onLongPress = vi.fn();
      const marked = document.createElement('button');
      marked.setAttribute('data-gesture-priority', '');
      const { result } = renderHook(() =>
        useLongPress({ onLongPress, yieldToSelector: '[data-gesture-priority]' })
      );

      act(() => result.current.onPointerDown(pointer(10, 10, 0, marked)));
      act(() => void vi.advanceTimersByTime(HOLD_MS));

      expect(onLongPress).not.toHaveBeenCalled();
    });

    it('never arms when the press starts on a DESCENDANT of the marked element', () => {
      // A press on the mention pill's own Bot icon, say — the marked node is
      // an ancestor of the actual event target, not the target itself.
      const onLongPress = vi.fn();
      const marked = document.createElement('span');
      marked.setAttribute('data-gesture-priority', '');
      const child = document.createElement('b');
      marked.appendChild(child);
      const { result } = renderHook(() =>
        useLongPress({ onLongPress, yieldToSelector: '[data-gesture-priority]' })
      );

      act(() => result.current.onPointerDown(pointer(10, 10, 0, child)));
      act(() => void vi.advanceTimersByTime(HOLD_MS));

      expect(onLongPress).not.toHaveBeenCalled();
    });

    it('still fires for a press elsewhere — yielding is per-press, not a global switch', () => {
      const onLongPress = vi.fn();
      const unmarked = document.createElement('div');
      const { result } = renderHook(() =>
        useLongPress({ onLongPress, yieldToSelector: '[data-gesture-priority]' })
      );

      act(() => result.current.onPointerDown(pointer(10, 10, 0, unmarked)));
      act(() => void vi.advanceTimersByTime(HOLD_MS));

      expect(onLongPress).toHaveBeenCalledTimes(1);
    });
  });
});
