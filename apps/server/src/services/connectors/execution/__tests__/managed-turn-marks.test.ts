import { describe, expect, it } from 'vitest';
import { liveTurnMarks, managedTurnMarks } from '../managed-turn-marks.js';
import { noteRoomTurnWords } from '../../../core/turn-power/outside-words.js';

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

describe('liveTurnMarks', () => {
  it('labels a turn noted as having read outside words, with no mark (DOR-4587)', () => {
    noteRoomTurnWords('chat-noted-only', true);
    expect(liveTurnMarks('chat-noted-only')).toEqual(['outsider']);
    noteRoomTurnWords('chat-noted-only', false);
    expect(liveTurnMarks('chat-noted-only')).toEqual([]);
  });
});
