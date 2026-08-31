// @vitest-environment jsdom
/**
 * Pinned directly at the hook's contract (DOR-1275): on a vaul drawer a
 * downward drag over the sheet ends where it started, so the browser fires a
 * click on whatever is under the finger. `travelled` is what tells that click
 * apart from a real tap; `RoomMemberRow.click-to-profile.test.tsx` and
 * `RoomMemberRow.test.tsx` exercise it end to end through the three controls
 * that share it.
 */
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useDragVsTapGuard } from '../use-drag-vs-tap-guard';

describe('useDragVsTapGuard', () => {
  it('says a press stayed put when the pointer barely moved', () => {
    const { result } = renderHook(() => useDragVsTapGuard());

    result.current.onPointerDown({ clientX: 100, clientY: 100 });
    const travelled = result.current.travelled({ clientX: 103, clientY: 104, detail: 1 });

    expect(travelled).toBe(false);
  });

  it('says a press travelled once it crosses the drift threshold', () => {
    const { result } = renderHook(() => useDragVsTapGuard());

    result.current.onPointerDown({ clientX: 100, clientY: 100 });
    const travelled = result.current.travelled({ clientX: 100, clientY: 260, detail: 1 });

    expect(travelled).toBe(true);
  });

  it('never calls a keyboard click a drag, even with a stale origin on record', () => {
    // `detail === 0` is a keyboard/screen-reader click. It carries no
    // coordinates worth measuring, and a stale origin left behind by an
    // earlier, unrelated press must never be read against it.
    const { result } = renderHook(() => useDragVsTapGuard());

    result.current.onPointerDown({ clientX: 100, clientY: 100 });
    const travelled = result.current.travelled({ clientX: 900, clientY: 900, detail: 0 });

    expect(travelled).toBe(false);
  });

  it('says nothing travelled when no press was ever recorded', () => {
    // A click with no matching `pointerdown` — the keyboard path, or an
    // origin already consumed by an earlier click — reads as a tap rather
    // than a drag with no origin to compare against.
    const { result } = renderHook(() => useDragVsTapGuard());

    const travelled = result.current.travelled({ clientX: 900, clientY: 900, detail: 1 });

    expect(travelled).toBe(false);
  });

  it('consumes the recorded origin — a second click has nothing to compare against', () => {
    const { result } = renderHook(() => useDragVsTapGuard());
    result.current.onPointerDown({ clientX: 100, clientY: 100 });
    result.current.travelled({ clientX: 100, clientY: 260, detail: 1 });

    // No second `pointerdown` before this click — the drawer-drag guard is not
    // still measuring against the FIRST press.
    const secondTravelled = result.current.travelled({ clientX: 900, clientY: 900, detail: 1 });

    expect(secondTravelled).toBe(false);
  });
});
