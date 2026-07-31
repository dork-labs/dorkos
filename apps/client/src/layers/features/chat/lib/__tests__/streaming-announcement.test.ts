import { describe, it, expect } from 'vitest';
import { nextAnnouncement } from '../streaming-announcement';

describe('nextAnnouncement', () => {
  it('says nothing until a sentence has closed', () => {
    expect(nextAnnouncement('Checking the ', '', false)).toEqual({ chunk: '', announced: '' });
  });

  it('says the finished sentence and remembers it verbatim', () => {
    const result = nextAnnouncement('Found it. Now runn', '', false);
    expect(result.chunk).toBe('Found it.');
    expect(result.announced).toBe('Found it.');
  });

  it('says only what is new on the next token', () => {
    const first = nextAnnouncement('Found it. Now runn', '', false);
    const second = nextAnnouncement(
      'Found it. Now running the tests. Almost',
      first.announced,
      false
    );
    expect(second.chunk).toBe('Now running the tests.');
  });

  it('says the leftover tail when the words settle, never the whole answer', () => {
    const first = nextAnnouncement('Found it. Now running.', '', false);
    const settled = nextAnnouncement('Found it. Now running. Done', first.announced, true);
    expect(settled.chunk).toBe('Done');
    expect(settled.chunk).not.toContain('Found it.');
  });

  it('says nothing when a settled message has nothing left over', () => {
    const first = nextAnnouncement('All set.', '', false);
    expect(nextAnnouncement('All set.', first.announced, true).chunk).toBe('');
  });

  it('starts over when the text is replaced rather than extended', () => {
    expect(nextAnnouncement('Short.', 'Something else entirely.', false).chunk).toBe('Short.');
  });

  it('starts over when a rewrite keeps the length but changes the words', () => {
    // Markdown reflows as it streams — a list re-indents, a code fence closes —
    // and a rewrite is routinely as long as what it replaced. A length-only
    // guard slices the middle out of a sentence nobody heard the start of.
    const heard = 'Hello there world.';
    const rewritten = '* Hello there world. And more.';
    const result = nextAnnouncement(rewritten, heard, false);
    expect(result.chunk).toBe('* Hello there world. And more.');
    expect(result.chunk).not.toBe('* there world.');
  });

  it('keeps going when the text genuinely continues what was heard', () => {
    const heard = 'Hello there world.';
    const result = nextAnnouncement(`${heard} And more.`, heard, false);
    expect(result.chunk).toBe('And more.');
  });

  it('treats a line break as a place to stop', () => {
    expect(nextAnnouncement('Here is the plan\nstep one', '', false).chunk).toBe(
      'Here is the plan'
    );
  });
});
