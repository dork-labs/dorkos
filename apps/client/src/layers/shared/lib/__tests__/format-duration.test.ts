import { describe, it, expect } from 'vitest';
import { formatDuration } from '../format-duration';

describe('formatDuration', () => {
  it('returns "<100ms" for durations below 100ms', () => {
    expect(formatDuration(0)).toBe('<100ms');
    expect(formatDuration(50)).toBe('<100ms');
    expect(formatDuration(99)).toBe('<100ms');
  });

  it('returns rounded milliseconds for 100ms–999ms', () => {
    expect(formatDuration(100)).toBe('100ms');
    expect(formatDuration(347)).toBe('347ms');
    expect(formatDuration(999)).toBe('999ms');
  });

  it('returns decimal seconds for 1s–9.9s', () => {
    expect(formatDuration(1000)).toBe('1.0s');
    expect(formatDuration(1234)).toBe('1.2s');
    expect(formatDuration(9999)).toBe('10.0s');
  });

  it('returns whole seconds for 10s–59s', () => {
    expect(formatDuration(10_000)).toBe('10s');
    expect(formatDuration(14_000)).toBe('14s');
    expect(formatDuration(59_999)).toBe('60s');
  });

  it('returns minutes and seconds for 60s and above', () => {
    expect(formatDuration(60_000)).toBe('1m 0s');
    expect(formatDuration(83_000)).toBe('1m 23s');
    expect(formatDuration(125_000)).toBe('2m 5s');
  });

  it('handles exact tier boundaries correctly', () => {
    // Exactly 100ms — first ms tier
    expect(formatDuration(100)).toBe('100ms');
    // Exactly 1000ms — first seconds tier
    expect(formatDuration(1000)).toBe('1.0s');
    // Exactly 10000ms — whole seconds tier
    expect(formatDuration(10_000)).toBe('10s');
    // Exactly 60000ms — minutes tier
    expect(formatDuration(60_000)).toBe('1m 0s');
  });
});
