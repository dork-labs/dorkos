// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useFrozenReadCursor } from '../model/use-frozen-read-cursor';

describe('useFrozenReadCursor', () => {
  it('holds the cursor still while the real one advances underneath', () => {
    const { result, rerender } = renderHook(
      ({ roomId, seq }: { roomId: string | null; seq: number | null }) =>
        useFrozenReadCursor(roomId, seq),
      { initialProps: { roomId: 'a' as string | null, seq: 3 as number | null } }
    );
    expect(result.current).toBe(3);
    // Reading the room advances the real cursor; the rule must not move.
    rerender({ roomId: 'a', seq: 9 });
    expect(result.current).toBe(3);
  });

  it('takes a fresh reading when you open a different room', () => {
    const { result, rerender } = renderHook(
      ({ roomId, seq }: { roomId: string | null; seq: number | null }) =>
        useFrozenReadCursor(roomId, seq),
      { initialProps: { roomId: 'a' as string | null, seq: 3 as number | null } }
    );
    rerender({ roomId: 'b', seq: 11 });
    expect(result.current).toBe(11);
  });

  it('takes a fresh reading when you come back to a room', () => {
    const { result, rerender } = renderHook(
      ({ roomId, seq }: { roomId: string | null; seq: number | null }) =>
        useFrozenReadCursor(roomId, seq),
      { initialProps: { roomId: 'a' as string | null, seq: 3 as number | null } }
    );
    rerender({ roomId: null, seq: null });
    expect(result.current).toBeNull();
    rerender({ roomId: 'a', seq: 9 });
    expect(result.current).toBe(9);
  });

  it('waits for the room to load rather than freezing "not read yet"', () => {
    const { result, rerender } = renderHook(
      ({ roomId, seq }: { roomId: string | null; seq: number | null }) =>
        useFrozenReadCursor(roomId, seq),
      { initialProps: { roomId: 'a' as string | null, seq: null as number | null } }
    );
    expect(result.current).toBeNull();
    rerender({ roomId: 'a', seq: 4 });
    expect(result.current).toBe(4);
  });
});
