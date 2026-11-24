import { describe, expect, it } from 'vitest';
import { describeBytes, noRoomSentence, tooLargeSentence } from '../move-sizes.js';

describe('move sizes', () => {
  it('rounds a shortfall apart, so it never reads as two equal numbers', () => {
    expect(describeBytes(536_870_947, 'up')).toBe('537 MB');
    expect(describeBytes(536_870_946, 'down')).toBe('536 MB');
    expect(describeBytes(1_250_000_000, 'up')).toBe('1.3 GB');
    expect(describeBytes(35, 'up')).toBe('35 bytes');
  });

  it('says both sentences from the numbers alone', () => {
    expect(noRoomSentence(536_870_947, 536_870_946)).toBe(
      'This computer doesn’t have room to hold the export. It needs 537 MB free and has 536 MB. Free up some space, then try again.'
    );
    expect(tooLargeSentence(35, 34)).toBe(
      'This export is too large to move. It is 35 bytes, and the most DorkOS takes is 34 bytes.'
    );
  });
});
