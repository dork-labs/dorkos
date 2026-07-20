import { describe, it, expect } from 'vitest';
import { nextRovingIndex } from '../lib/use-roving-focus';

describe('nextRovingIndex', () => {
  // A 2-column, 5-item grid:  0 1 / 2 3 / 4
  const COLS = 2;
  const COUNT = 5;

  it('ArrowRight moves forward and clamps at the end', () => {
    expect(nextRovingIndex('ArrowRight', 0, COLS, COUNT)).toBe(1);
    expect(nextRovingIndex('ArrowRight', 4, COLS, COUNT)).toBe(4);
  });

  it('ArrowLeft moves back and clamps at the start', () => {
    expect(nextRovingIndex('ArrowLeft', 3, COLS, COUNT)).toBe(2);
    expect(nextRovingIndex('ArrowLeft', 0, COLS, COUNT)).toBe(0);
  });

  it('ArrowDown moves a full row and clamps at the last item', () => {
    expect(nextRovingIndex('ArrowDown', 0, COLS, COUNT)).toBe(2);
    expect(nextRovingIndex('ArrowDown', 3, COLS, COUNT)).toBe(4);
  });

  it('ArrowUp moves a row back and clamps at the first item', () => {
    expect(nextRovingIndex('ArrowUp', 3, COLS, COUNT)).toBe(1);
    expect(nextRovingIndex('ArrowUp', 1, COLS, COUNT)).toBe(0);
  });

  it('Home and End jump to the edges', () => {
    expect(nextRovingIndex('Home', 3, COLS, COUNT)).toBe(0);
    expect(nextRovingIndex('End', 0, COLS, COUNT)).toBe(4);
  });

  it('returns null for non-roving keys so callers let them through', () => {
    expect(nextRovingIndex('Enter', 2, COLS, COUNT)).toBeNull();
    expect(nextRovingIndex('Tab', 2, COLS, COUNT)).toBeNull();
    expect(nextRovingIndex('a', 2, COLS, COUNT)).toBeNull();
  });
});
