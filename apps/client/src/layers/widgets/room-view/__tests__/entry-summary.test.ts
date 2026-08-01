import { describe, it, expect } from 'vitest';
import { entrySummary } from '../lib/entry-summary';

describe('entrySummary', () => {
  it('leaves a short line alone, so nothing is written into the page twice', () => {
    // `null` means "point at the words themselves". A copy of every short
    // message, hidden, purely to describe it is a page holding the room twice.
    expect(entrySummary('why is the build slow?')).toBeNull();
  });

  it('replaces a fenced block with the words “code block”', () => {
    // The defect this exists for: a pasted diff became the row's accessible
    // description, so landing on the message read the diff out line by line
    // before saying anything about it.
    const summary = entrySummary('here you go:\n\n```diff\n- const a = 1\n+ const a = 2\n```');

    expect(summary).toBe('here you go: code block');
    expect(summary).not.toContain('const a');
  });

  it('summarises a fenced block even when the message around it is tiny', () => {
    // Length is the wrong test for a code block: eighty lines of YAML inside a
    // twenty-character message is still eighty lines to listen to.
    expect(entrySummary('```\nx\n```')).toBe('code block');
  });

  it('closes an unfinished fence, which is what a streaming message looks like', () => {
    expect(entrySummary('look:\n```ts\nconst huge = ')).toBe('look: code block');
  });

  it('cuts a long message on a word, and says it was cut', () => {
    const summary = entrySummary('word '.repeat(60))!;

    expect(summary.length).toBeLessThanOrEqual(121);
    expect(summary.endsWith('…')).toBe(true);
    expect(summary.endsWith(' …')).toBe(false);
  });

  it('reads markdown as a sentence rather than as source', () => {
    const summary = entrySummary(
      `## A heading\n\n> quoted, **bold**, \`inline\` and a [link](https://example.com) — ${'padding '.repeat(12)}`
    )!;

    expect(summary.startsWith('A heading quoted, bold, inline and a link')).toBe(true);
    expect(summary).not.toContain('#');
    expect(summary).not.toContain('**');
    expect(summary).not.toContain('https://');
  });
});
