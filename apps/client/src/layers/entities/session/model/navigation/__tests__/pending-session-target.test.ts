import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  PENDING_TARGET_MAX_MS,
  clearPendingSessionTarget,
  getPendingSessionTarget,
  markPendingSessionTarget,
} from '../pending-session-target';

describe('the agent a click is heading to (DOR-2891)', () => {
  beforeEach(() => clearPendingSessionTarget());

  it('holds the latest click until that click clears it', () => {
    const clear = markPendingSessionTarget('/projects/alpha');
    expect(getPendingSessionTarget()).toBe('/projects/alpha');
    clear();
    expect(getPendingSessionTarget()).toBeNull();
  });

  it('an earlier click’s late clear does not erase a newer one', () => {
    const clearFirst = markPendingSessionTarget('/projects/alpha');
    const clearSecond = markPendingSessionTarget('/projects/beta');
    clearFirst();
    expect(getPendingSessionTarget()).toBe('/projects/beta');
    clearSecond();
    clearSecond();
    expect(getPendingSessionTarget()).toBeNull();
  });

  it('any navigation drops it, and the click’s own clear is then harmless', () => {
    const clear = markPendingSessionTarget('/projects/alpha');
    clearPendingSessionTarget();
    expect(getPendingSessionTarget()).toBeNull();
    const clearNext = markPendingSessionTarget('/projects/beta');
    clear();
    expect(getPendingSessionTarget()).toBe('/projects/beta');
    clearNext();
  });

  it('lets go on its own when the lookup never answers', () => {
    vi.useFakeTimers();
    try {
      markPendingSessionTarget('/projects/alpha');
      vi.advanceTimersByTime(PENDING_TARGET_MAX_MS - 1);
      expect(getPendingSessionTarget()).toBe('/projects/alpha');
      vi.advanceTimersByTime(1);
      expect(getPendingSessionTarget()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
