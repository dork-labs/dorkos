/**
 * The words ⌘K hands across (P3 AC-6, `specs/message-search` §8).
 *
 * @module features/command-palette/model/__tests__/search-surface
 */
import { describe, it, expect } from 'vitest';
import { searchHandoffTerm } from '../search-surface';

describe('the hand-off to the message-search box', () => {
  it('hands the words across as typed', () => {
    expect(searchHandoffTerm('dash')).toBe('dash');
    expect(searchHandoffTerm('two words')).toBe('two words');
  });

  it('carries whatever is in them, verbatim', () => {
    // The words go into a query string somewhere downstream, and nothing here
    // may pre-mangle them: `&`, `=` and `#` are all characters somebody may
    // have typed, and a search index asked for a half of what they meant finds
    // the wrong thing rather than nothing.
    expect(searchHandoffTerm('a&b=c#d')).toBe('a&b=c#d');
    expect(searchHandoffTerm('#dash')).toBe('#dash');
  });

  it('offers nothing to search for nothing', () => {
    // `Search messages for ""…` is a row that offers to look for nothing, and
    // whitespace is the same thing wearing a disguise.
    expect(searchHandoffTerm('')).toBeNull();
    expect(searchHandoffTerm('   ')).toBeNull();
    expect(searchHandoffTerm('\n\t')).toBeNull();
  });

  it('trims what it sends, so a trailing space is not part of the question', () => {
    expect(searchHandoffTerm('  dash  ')).toBe('dash');
  });
});
