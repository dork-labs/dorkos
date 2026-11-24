import { expect, it, vi } from 'vitest';
import { PendingApprovalRegistry } from '../pending-approval-registry.js';

const COUNTDOWN_MS = 10 * 60 * 1000;
const ATTENDED_EXPIRY_MS = 4 * 60 * 60 * 1000;

it('keeps one live owner per scope and expires only its own record', () => {
  vi.useFakeTimers();
  try {
    const registry = new PendingApprovalRegistry<string>();
    const first = vi.fn();
    const removeFirst = registry.insert('session-a', 'call', 'first', 'unattended', first);
    const other = vi.fn();
    registry.insert('session-b', 'call', 'other', 'unattended', other);

    const duplicate = vi.fn();
    expect(registry.insert('session-a', 'call', 'duplicate', 'unattended', duplicate)).toBe(
      undefined
    );
    expect(vi.getTimerCount()).toBe(2);
    expect(registry.take('session-a', 'call')).toBe('first');

    const replacement = vi.fn(() => {
      expect(registry.peek('session-a', 'call')).toBeUndefined();
    });
    registry.insert('session-a', 'call', 'replacement', 'attended', replacement);
    expect(removeFirst?.()).toBe(false);
    expect(registry.values('session-a')).toEqual(['replacement']);

    vi.advanceTimersByTime(COUNTDOWN_MS);
    expect(other).toHaveBeenCalledExactlyOnceWith('other');
    expect(first).not.toHaveBeenCalled();
    expect(duplicate).not.toHaveBeenCalled();
    expect(replacement).not.toHaveBeenCalled();
    expect(registry.peek('session-a', 'call')).toBe('replacement');

    vi.advanceTimersByTime(ATTENDED_EXPIRY_MS - COUNTDOWN_MS);
    expect(replacement).toHaveBeenCalledExactlyOnceWith('replacement');
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it('disarms a replaced scope without resolving it or clearing another scope', () => {
  vi.useFakeTimers();
  try {
    const registry = new PendingApprovalRegistry<string>();
    const stopped = vi.fn();
    const removeStopped = registry.insert('stopped', 'call', 'left', 'unattended', stopped);
    const active = vi.fn();
    registry.insert('active', 'call', 'right', 'unattended', active);

    registry.clear('stopped');
    expect(registry.peek('stopped', 'call')).toBeUndefined();
    expect(removeStopped?.()).toBe(false);
    expect(registry.peek('active', 'call')).toBe('right');
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(COUNTDOWN_MS);
    expect(stopped).not.toHaveBeenCalled();
    expect(active).toHaveBeenCalledExactlyOnceWith('right');
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
