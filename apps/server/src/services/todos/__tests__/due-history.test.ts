import { describe, expect, it } from 'vitest';
import { nextDueHistory } from '../due-history.js';

const FIRST = '2026-11-13T10:00:00.000Z';
const SECOND = '2026-11-13T12:00:00.000Z';
const UNDATED = { dueAt: null, originalDueAt: null, scoreDueAt: null, moveCount: 0 };
const DATED = { dueAt: FIRST, originalDueAt: FIRST, scoreDueAt: FIRST, moveCount: 0 };

describe('nextDueHistory', () => {
  it('sets the original and score dates the first time a due date is set', () => {
    expect(nextDueHistory(UNDATED, FIRST, Date.parse(FIRST) - 1)).toEqual(DATED);
  });

  it('renegotiates the score date when an existing date moves before it is due', () => {
    expect(nextDueHistory(DATED, SECOND, Date.parse(FIRST) - 1)).toEqual({
      dueAt: SECOND,
      originalDueAt: FIRST,
      scoreDueAt: SECOND,
      moveCount: 1,
    });
  });

  it('keeps the missed score date when an existing date moves at or after it is due', () => {
    expect(nextDueHistory(DATED, SECOND, Date.parse(FIRST))).toEqual({
      dueAt: SECOND,
      originalDueAt: FIRST,
      scoreDueAt: FIRST,
      moveCount: 1,
    });
  });

  it('changes nothing when the due date is unchanged', () => {
    expect(nextDueHistory(DATED, FIRST, Date.parse(FIRST) + 1)).toEqual(DATED);
  });

  it('leaves both history dates in place when the due date is cleared', () => {
    expect(nextDueHistory(DATED, null, Date.parse(FIRST) - 1)).toEqual({
      ...DATED,
      dueAt: null,
      moveCount: 1,
    });
  });

  it('keeps a late to-do late when its date is cleared and set again', () => {
    const cleared = nextDueHistory(DATED, null, Date.parse(FIRST) + 1);
    expect(nextDueHistory(cleared, SECOND, Date.parse(FIRST) + 2)).toMatchObject({
      dueAt: SECOND,
      scoreDueAt: FIRST,
    });
  });

  it('renegotiates when a cleared date is set again before the scored date', () => {
    const cleared = nextDueHistory(DATED, null, Date.parse(FIRST) - 2);
    expect(nextDueHistory(cleared, SECOND, Date.parse(FIRST) - 1)).toMatchObject({
      dueAt: SECOND,
      originalDueAt: FIRST,
      scoreDueAt: SECOND,
    });
  });

  it('does not count the first date assigned to an undated to-do as a move', () => {
    expect(nextDueHistory(UNDATED, SECOND, Date.parse(FIRST))).toMatchObject({ moveCount: 0 });
  });
});
