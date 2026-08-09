import { describe, it, expect } from 'vitest';
import {
  ROW_SESSION_MARKER,
  ROW_TITLE_CLASS,
  ROW_TRAILING_CLASS,
  ROW_WHO_CLASS,
  composeRowLabel,
  hasSecondLine,
} from '../row-grammar';

describe('composeRowLabel (BC-23)', () => {
  it('joins an owner to a title with the session marker', () => {
    expect(composeRowLabel('Scout', 'fix the flake')).toBe('Scout › fix the flake');
  });

  it('leaves a row that is a place rather than a thread of one unmarked', () => {
    // The `›` is the session marker; its absence is what says "this IS the
    // place". A room row must never grow one.
    expect(composeRowLabel(null, '#general')).toBe('#general');
    expect(composeRowLabel(undefined, '#general')).toBe('#general');
    expect(composeRowLabel('', '#general')).toBe('#general');
    expect(composeRowLabel('   ', '#general')).toBe('#general');
  });

  it('trims the owner rather than drawing a marker adrift from it', () => {
    expect(composeRowLabel('  Scout  ', 'fix the flake')).toBe('Scout › fix the flake');
  });
});

describe('hasSecondLine (BC-24)', () => {
  it('is false for a row with neither a verb line nor a preview', () => {
    expect(hasSecondLine({})).toBe(false);
    expect(hasSecondLine({ reservesVerbLine: false, preview: null })).toBe(false);
  });

  it('is true for a row that reserves a live verb line', () => {
    expect(hasSecondLine({ reservesVerbLine: true })).toBe(true);
  });

  it('is true for a row with a preview worth showing', () => {
    expect(hasSecondLine({ preview: 'Scout shipped the fix' })).toBe(true);
  });

  it('does not count whitespace as a preview', () => {
    // A row that grew a blank second line would be taller for no reason, and
    // height is supposed to carry meaning.
    expect(hasSecondLine({ preview: '   ' })).toBe(false);
  });
});

describe('the budget itself (BC-25)', () => {
  it('caps the owner, flexes the title, and pins the meta slot', () => {
    // Pinned as literals so a change to any of the three is a deliberate edit
    // to a stated contract rather than a class tweak nobody notices. The
    // computed-style proof at a real 272px lives in the browser spec.
    expect(ROW_WHO_CLASS).toContain('max-w-[42%]');
    expect(ROW_TITLE_CLASS).toContain('min-w-[6ch]');
    expect(ROW_TITLE_CLASS).toContain('flex-auto');
    expect(ROW_TRAILING_CLASS).toBe('flex-none');
  });

  it('spells the session marker one way', () => {
    expect(ROW_SESSION_MARKER).toBe('›');
  });
});
