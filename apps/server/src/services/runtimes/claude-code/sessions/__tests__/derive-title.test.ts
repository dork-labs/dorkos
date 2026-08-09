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

  it('marks first-line truncation of a longer message with an ellipsis', () => {
    const derived = deriveSessionTitle('one two three four five six seven');
    expect(derived).toBe('One two three four five six…');
  });
});
