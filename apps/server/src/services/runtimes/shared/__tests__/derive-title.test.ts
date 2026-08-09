import { describe, expect, it } from 'vitest';
import { deriveSessionTitle } from '../derive-title.js';

describe('deriveSessionTitle', () => {
  it('returns empty string for empty or whitespace input', () => {
    expect(deriveSessionTitle('')).toBe('');
    expect(deriveSessionTitle('   \n  ')).toBe('');
  });

  it('keeps a short message intact, capitalized, without ellipsis', () => {
    expect(deriveSessionTitle('fix the build')).toBe('Fix the build');
  });

  it('strips a courtesy prefix', () => {
    expect(deriveSessionTitle('Please fix the build')).toBe('Fix the build');
  });

  it('strips stacked courtesy prefixes', () => {
    expect(deriveSessionTitle('Please, can you fix the build')).toBe('Fix the build');
  });

  it('never strips greetings — they can be real content', () => {
    expect(deriveSessionTitle('Hello world')).toBe('Hello world');
    expect(deriveSessionTitle('hello world program in rust')).toBe('Hello world program in rust');
  });

  it('does not strip a message that is only a courtesy phrase', () => {
    expect(deriveSessionTitle('please')).toBe('Please');
  });

  it('cuts at the word budget with an ellipsis', () => {
    expect(
      deriveSessionTitle('Review the help and feedback submission options on the settings page')
    ).toBe('Review the help and feedback submission…');
  });

  it('uses only the first line of a multi-line message', () => {
    expect(deriveSessionTitle('Refactor auth middleware\n\nHere is the full context…')).toBe(
      'Refactor auth middleware'
    );
  });

  it('never exceeds the transcript title cap even with giant words', () => {
    const giant = `${'a'.repeat(120)} tail`;
    const derived = deriveSessionTitle(giant);
    expect(derived.length).toBeLessThanOrEqual(81); // cap + ellipsis
  });

  it('does not add an ellipsis for odd spacing alone (reviewer defect 1)', () => {
    expect(deriveSessionTitle('fix  the  build')).toBe('Fix the build');
  });

  it('strips filler written with curly apostrophes (reviewer defect 2)', () => {
    expect(deriveSessionTitle('I\u2019d like you to fix the build')).toBe('Fix the build');
  });

  it('skips a courtesy-only first line in favor of the content line (reviewer defect 3)', () => {
    expect(deriveSessionTitle('Please\ncan you fix the build')).toBe('Fix the build');
  });

  it('handles emoji without splitting surrogate pairs', () => {
    const emoji = '\u{1F680}'.repeat(90);
    const derived = deriveSessionTitle(emoji);
    expect(derived.includes('\uFFFD')).toBe(false);
    expect([...derived].length).toBeLessThanOrEqual(81);
  });

  it('exactly at the word budget gets no ellipsis', () => {
    expect(deriveSessionTitle('one two three four five six')).toBe('One two three four five six');
  });

  it('marks first-line truncation of a longer message with an ellipsis', () => {
    const derived = deriveSessionTitle('one two three four five six seven');
    expect(derived).toBe('One two three four five six…');
  });
});
