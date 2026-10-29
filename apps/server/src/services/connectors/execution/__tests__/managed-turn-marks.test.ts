import { describe, expect, it } from 'vitest';
import { managedTurnMarks } from '../managed-turn-marks.js';

// #3196 review, S2: the marks the broker derives for the owner's approval card.
describe('managedTurnMarks', () => {
  it('marks a turn that read outside words, or that a stranger started, as outsider', () => {
    expect(managedTurnMarks({ outsider: true }, false)).toEqual(['outsider']);
    expect(managedTurnMarks({}, true)).toEqual(['outsider']);
  });

  it('marks a teammate chain, even with no origin listed', () => {
    expect(managedTurnMarks({ teammate: [] }, false)).toEqual(['teammate']);
    expect(managedTurnMarks({ outsider: true, teammate: [] }, false)).toEqual([
      'outsider',
      'teammate',
    ]);
  });

  it('marks nothing for an unmarked turn', () => {
    expect(managedTurnMarks({}, false)).toEqual([]);
  });
});
