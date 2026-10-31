import { describe, expect, it } from 'vitest';
import { managedTurnMarks } from '../managed-turn-marks.js';

// #3196 review, S2: the marks the broker derives for the owner's approval card.
describe('managedTurnMarks', () => {
  it('marks a turn a hold bound as outsider', () => {
    expect(managedTurnMarks({ outsider: true })).toEqual(['outsider']);
  });

  it('marks a teammate chain, even with no origin listed', () => {
    expect(managedTurnMarks({ teammate: [] })).toEqual(['teammate']);
    expect(managedTurnMarks({ outsider: true, teammate: [] })).toEqual(['outsider', 'teammate']);
  });

  it('marks nothing for an unmarked turn', () => {
    expect(managedTurnMarks({})).toEqual([]);
  });
});
