import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ThreadParticipationTracker } from '../thread-tracker.js';

describe('ThreadParticipationTracker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('markParticipating() stores entries', () => {
    const tracker = new ThreadParticipationTracker();
    tracker.markParticipating('C123', '1234567890.000100');

    expect(tracker.size).toBe(1);
  });

  it('isParticipating() returns true for tracked threads', () => {
    const tracker = new ThreadParticipationTracker();
    tracker.markParticipating('C123', '1234567890.000100');

    expect(tracker.isParticipating('C123', '1234567890.000100')).toBe(true);
  });

  it('isParticipating() returns false for unknown threads', () => {
    const tracker = new ThreadParticipationTracker();

    expect(tracker.isParticipating('C999', '9999999999.000000')).toBe(false);
  });

  it('TTL expiration removes stale entries', () => {
    const ttlMs = 60_000; // 1 minute
    const tracker = new ThreadParticipationTracker(1_000, ttlMs);
    tracker.markParticipating('C123', '1234567890.000100');

    expect(tracker.isParticipating('C123', '1234567890.000100')).toBe(true);

    // Advance past TTL
    vi.advanceTimersByTime(ttlMs + 1);

    expect(tracker.isParticipating('C123', '1234567890.000100')).toBe(false);
    expect(tracker.size).toBe(0);
  });

  it('LRU eviction removes oldest when at capacity', () => {
    const tracker = new ThreadParticipationTracker(3);

    tracker.markParticipating('C1', 'ts1');
    tracker.markParticipating('C2', 'ts2');
    tracker.markParticipating('C3', 'ts3');
    expect(tracker.size).toBe(3);

    // Adding a 4th should evict the oldest (C1:ts1)
    tracker.markParticipating('C4', 'ts4');
    expect(tracker.size).toBe(3);
    expect(tracker.isParticipating('C1', 'ts1')).toBe(false);
    expect(tracker.isParticipating('C2', 'ts2')).toBe(true);
    expect(tracker.isParticipating('C3', 'ts3')).toBe(true);
    expect(tracker.isParticipating('C4', 'ts4')).toBe(true);
  });

  it('clear() removes all entries', () => {
    const tracker = new ThreadParticipationTracker();
    tracker.markParticipating('C1', 'ts1');
    tracker.markParticipating('C2', 'ts2');
    expect(tracker.size).toBe(2);

    tracker.clear();

    expect(tracker.size).toBe(0);
    expect(tracker.isParticipating('C1', 'ts1')).toBe(false);
  });

  it('size returns correct count', () => {
    const tracker = new ThreadParticipationTracker();
    expect(tracker.size).toBe(0);

    tracker.markParticipating('C1', 'ts1');
    expect(tracker.size).toBe(1);

    tracker.markParticipating('C2', 'ts2');
    expect(tracker.size).toBe(2);

    // Re-marking the same thread should not increase size
    tracker.markParticipating('C1', 'ts1');
    expect(tracker.size).toBe(2);
  });
});
