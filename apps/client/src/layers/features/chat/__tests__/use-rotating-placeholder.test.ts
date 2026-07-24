// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { STORAGE_KEYS } from '@/layers/shared/lib/constants';
import { useRotatingPlaceholder } from '../model/use-rotating-placeholder';

const HINTS = ['hint one', 'hint two'] as const;
const INTERVAL = 1000;

/** Advance the rotation by `n` transitions. */
function tick(n: number) {
  for (let i = 0; i < n; i++) {
    act(() => {
      vi.advanceTimersByTime(INTERVAL);
    });
  }
}

function setup(enabled = true) {
  return renderHook(() =>
    useRotatingPlaceholder({
      defaultText: 'Message Dorkbot...',
      hints: HINTS,
      enabled,
      intervalMs: INTERVAL,
    })
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useRotatingPlaceholder', () => {
  it('starts on the default text', () => {
    const { result } = setup();
    expect(result.current.text).toBe('Message Dorkbot...');
  });

  it('alternates default and hints', () => {
    const { result } = setup();
    tick(1);
    expect(HINTS).toContain(result.current.text);
    tick(1);
    expect(result.current.text).toBe('Message Dorkbot...');
    tick(1);
    expect(HINTS).toContain(result.current.text);
  });

  it('shows every hint before repeating one', () => {
    const { result } = setup();
    const seen: string[] = [];
    tick(1);
    seen.push(result.current.text);
    tick(2);
    seen.push(result.current.text);
    expect(new Set(seen).size).toBe(HINTS.length);
  });

  it('bumps the persisted cycle count once per full pass', () => {
    setup();
    tick(2 * HINTS.length);
    expect(localStorage.getItem(STORAGE_KEYS.PLACEHOLDER_HINT_CYCLES)).toBe('1');
    tick(2 * HINTS.length);
    expect(localStorage.getItem(STORAGE_KEYS.PLACEHOLDER_HINT_CYCLES)).toBe('2');
  });

  it('settles on the default text after three full passes', () => {
    const { result } = setup();
    tick(3 * 2 * HINTS.length);
    expect(localStorage.getItem(STORAGE_KEYS.PLACEHOLDER_HINT_CYCLES)).toBe('3');
    expect(result.current.text).toBe('Message Dorkbot...');
    // And stays there — no further transitions, no further writes.
    tick(6);
    expect(result.current.text).toBe('Message Dorkbot...');
    expect(localStorage.getItem(STORAGE_KEYS.PLACEHOLDER_HINT_CYCLES)).toBe('3');
  });

  it('never rotates again once the count is already spent', () => {
    localStorage.setItem(STORAGE_KEYS.PLACEHOLDER_HINT_CYCLES, '3');
    const { result } = setup();
    tick(4);
    expect(result.current.text).toBe('Message Dorkbot...');
  });

  it('stays on the default text while disabled', () => {
    const { result } = setup(false);
    tick(4);
    expect(result.current.text).toBe('Message Dorkbot...');
  });
});
