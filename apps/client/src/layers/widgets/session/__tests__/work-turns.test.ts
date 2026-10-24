/**
 * The time on a DM reply's folded line (DOR-3075): nothing under a second,
 * whole seconds from there, then minutes and seconds.
 */
import { describe, it, expect } from 'vitest';
import { turnDuration } from '../lib/work-turns';

const AT = '2026-10-20T14:00:00.000Z';
const after = (ms: number) => new Date(Date.parse(AT) + ms).toISOString();

describe('turnDuration', () => {
  it('says nothing under a second', () => {
    expect(turnDuration(AT, after(0))).toBeNull();
    expect(turnDuration(AT, after(400))).toBeNull();
    expect(turnDuration(AT, after(999))).toBeNull();
  });

  it('says whole seconds from one second up', () => {
    expect(turnDuration(AT, after(1000))).toBe('1s');
    expect(turnDuration(AT, after(4200))).toBe('4s');
    expect(turnDuration(AT, after(59_900))).toBe('59s');
  });

  it('says minutes and seconds from a minute up', () => {
    expect(turnDuration(AT, after(72_000))).toBe('1m 12s');
    expect(turnDuration(AT, after(60_000))).toBe('1m');
  });

  it('says nothing when a time is missing or backwards', () => {
    expect(turnDuration(undefined, after(5000))).toBeNull();
    expect(turnDuration(AT, '')).toBeNull();
    expect(turnDuration(after(5000), AT)).toBeNull();
  });
});
