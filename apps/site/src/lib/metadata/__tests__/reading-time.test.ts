import { describe, expect, it } from 'vitest';
import { estimateReadingMinutes, readingTimeLabel } from '../reading-time';

describe('estimateReadingMinutes', () => {
  it('rounds word count over 200 wpm and floors at 1 minute', () => {
    expect(estimateReadingMinutes('word '.repeat(50))).toBe(1); // <200 -> 1
    expect(estimateReadingMinutes('word '.repeat(200))).toBe(1); // exactly 1
    expect(estimateReadingMinutes('word '.repeat(500))).toBe(3); // 2.5 -> 3
    expect(estimateReadingMinutes('word '.repeat(1000))).toBe(5);
  });

  it('always returns at least one minute, even for empty input', () => {
    expect(estimateReadingMinutes('')).toBe(1);
    expect(estimateReadingMinutes('   \n  ')).toBe(1);
  });

  it('ignores frontmatter, code fences, and markdown punctuation', () => {
    const body = [
      '---',
      'title: Test',
      'date: 2026-01-01',
      '---',
      '# A heading with **bold** and _italic_',
      '```ts',
      'const x = 1; // 400 words of code should not count',
      'word '.repeat(400),
      '```',
      'Just five real words here.',
    ].join('\n');
    // Only the six words outside the stripped regions count -> 1 minute.
    expect(estimateReadingMinutes(body)).toBe(1);
  });
});

describe('readingTimeLabel', () => {
  it('formats as "N min read"', () => {
    expect(readingTimeLabel('word '.repeat(500))).toBe('3 min read');
    expect(readingTimeLabel('word')).toBe('1 min read');
  });
});
