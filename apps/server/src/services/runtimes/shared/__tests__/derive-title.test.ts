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

  it('leaves a leading @-token alone by DEFAULT — stripping is opt-in (DOR-2083 review)', () => {
    expect(deriveSessionTitle('@agent do the thing')).toBe('@agent do the thing');
    expect(deriveSessionTitle('@meeting-notes please review all of our notes')).toBe(
      '@meeting-notes please review all of our…'
    );
  });

  it('strips a leading room @mention only when the caller opts in via stripLeadingMention', () => {
    expect(deriveSessionTitle('@agent do the thing', { stripLeadingMention: true })).toBe(
      'Do the thing'
    );
  });

  it('strips a leading room @mention followed by a courtesy opener, when opted in (DOR-2083)', () => {
    expect(
      deriveSessionTitle('@meeting-notes please review all of our notes', {
        stripLeadingMention: true,
      })
    ).toBe('Review all of our notes');
  });

  it('strips a hyphenated leading @mention with a comma, when opted in', () => {
    expect(
      deriveSessionTitle('@meeting-notes, can you summarize this', { stripLeadingMention: true })
    ).toBe('Summarize this');
  });

  it('leaves an email-shaped mid-message @ alone even opted in (not a leading mention)', () => {
    expect(
      deriveSessionTitle('email me at dorian@dorkos.ai please', { stripLeadingMention: true })
    ).toBe('Email me at dorian@dorkos.ai please');
  });

  it('treats a bare @ with no handle as real content, not a mention, even opted in', () => {
    expect(
      deriveSessionTitle('@ is not a valid handle by itself', { stripLeadingMention: true })
    ).toBe('@ is not a valid handle…');
  });

  // DOR-2083 review: the mention pattern is syntactically indistinguishable
  // from real technical content that also opens a line with `@word` — these
  // must survive untouched under the DEFAULT (no options passed), which is
  // what every current caller uses.
  it('never eats a leading @override doc/code marker by default', () => {
    expect(deriveSessionTitle('@override this method to add validation')).toBe(
      '@override this method to add validation'
    );
  });

  it('never eats a leading @media CSS rule by default', () => {
    expect(deriveSessionTitle('@media queries are not resizing correctly')).toBe(
      '@media queries are not resizing correctly'
    );
  });

  it('never eats a leading @ts-expect-error directive by default', () => {
    expect(deriveSessionTitle('@ts-expect-error is suppressing a real bug')).toBe(
      '@ts-expect-error is suppressing a real bug'
    );
  });

  it('never eats a leading @import rule by default', () => {
    expect(deriveSessionTitle('@import rules are loading in the wrong order')).toBe(
      '@import rules are loading in the…'
    );
  });

  it('never eats a leading @echo off batch directive by default', () => {
    expect(deriveSessionTitle('@echo off is not suppressing console output')).toBe(
      '@echo off is not suppressing console…'
    );
  });
});
