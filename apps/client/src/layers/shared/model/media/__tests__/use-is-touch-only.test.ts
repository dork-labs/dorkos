// @vitest-environment jsdom
/**
 * `useIsTouchOnly` — the device question the composer's Enter rule and its
 * autofocus both hang off.
 *
 * The cases that matter are the ones a single `(pointer: coarse)` check gets
 * wrong in opposite directions: a narrow desktop window (fine pointer, small
 * viewport) and a tablet with a trackpad (coarse primary, fine pointer present).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useIsTouchOnly } from '../use-is-touch-only';

/** Media-query listeners registered by the hook, so a test can fire a change. */
let listeners: Array<() => void> = [];

/** Install a `matchMedia` that answers each query from an emulated device. */
function emulate({
  primaryPointerCoarse,
  hasFinePointer,
}: {
  primaryPointerCoarse: boolean;
  hasFinePointer: boolean;
}) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: query.includes('(pointer: coarse)') ? primaryPointerCoarse : hasFinePointer,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: (_e: string, fn: () => void) => listeners.push(fn),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
}

beforeEach(() => {
  listeners = [];
});

describe('useIsTouchOnly', () => {
  it('is true on a phone — coarse primary, no fine pointer anywhere', () => {
    emulate({ primaryPointerCoarse: true, hasFinePointer: false });
    expect(renderHook(() => useIsTouchOnly()).result.current).toBe(true);
  });

  it('is false on a desktop', () => {
    emulate({ primaryPointerCoarse: false, hasFinePointer: true });
    expect(renderHook(() => useIsTouchOnly()).result.current).toBe(false);
  });

  // iPadOS reports a coarse primary pointer whether or not a Magic Keyboard is
  // attached. Keying off that alone would take Enter-to-send away from every
  // tablet with a keyboard, with no setting to get it back.
  it('is false on a tablet with a trackpad, despite the coarse primary pointer', () => {
    emulate({ primaryPointerCoarse: true, hasFinePointer: true });
    expect(renderHook(() => useIsTouchOnly()).result.current).toBe(false);
  });

  it('subscribes to BOTH queries, so plugging in a mouse can flip it', () => {
    emulate({ primaryPointerCoarse: true, hasFinePointer: false });
    renderHook(() => useIsTouchOnly());
    expect(listeners).toHaveLength(2);
  });

  it('never asks for the Level 4 `not (…)` operator, which older Safari drops', () => {
    const seen: string[] = [];
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: (query: string) => {
        seen.push(query);
        return {
          matches: false,
          media: query,
          onchange: null,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        };
      },
    });
    renderHook(() => useIsTouchOnly());
    // An engine without MQ4 boolean logic serializes such a query to `not all`,
    // which never matches — quietly handing a phone Enter-to-send.
    expect(seen.some((q) => q.includes('not'))).toBe(false);
    expect(seen).toContain('(pointer: coarse)');
    expect(seen).toContain('(any-pointer: fine)');
  });
});
