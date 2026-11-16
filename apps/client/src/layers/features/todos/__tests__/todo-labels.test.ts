import { describe, expect, it } from 'vitest';
import { todoMovedLabel } from '../lib/todo-labels';

/** Noon, so no time zone moves the date to another day. */
const NOW = new Date(2026, 10, 15, 12);

describe('todoMovedLabel (DOR-3034)', () => {
  it('leaves the year off a first date in the current year', () => {
    const label = todoMovedLabel(
      {
        moveCount: 1,
        originalDueAt: new Date(2026, 2, 14, 12).toISOString(),
        dueAt: new Date(2026, 2, 20, 12).toISOString(),
      },
      NOW
    );
    expect(label).toMatch(/^Moved once, first due Mar 14$/);
  });

  it('adds the year to a first date in another year', () => {
    const label = todoMovedLabel(
      {
        moveCount: 2,
        originalDueAt: new Date(2025, 11, 28, 12).toISOString(),
        dueAt: new Date(2026, 0, 9, 12).toISOString(),
      },
      NOW
    );
    expect(label).toBe('Moved twice, first due Dec 28, 2025');
  });

  it('says only how often when the first date is the current one', () => {
    const due = new Date(2026, 2, 20, 12).toISOString();
    expect(todoMovedLabel({ moveCount: 3, originalDueAt: due, dueAt: due }, NOW)).toBe(
      'Moved 3 times'
    );
  });

  it('says nothing for a date that never moved', () => {
    expect(todoMovedLabel({ moveCount: 0, originalDueAt: null, dueAt: null }, NOW)).toBeNull();
  });
});
