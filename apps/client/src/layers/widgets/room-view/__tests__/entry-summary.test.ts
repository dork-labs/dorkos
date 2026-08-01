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

  it('returns null when nothing survives the flatten, rather than an empty line', () => {
    // An empty summary is worse than the body it replaces: the row would point
    // `aria-describedby` at an empty element, which resolves to no description
    // at all. `null` sends it back to describing itself with its own content.
    expect(
      entrySummary(`![](${'https://example.com/a-very-long-image-url'.repeat(3)})`)
    ).toBeNull();
    expect(entrySummary('_'.repeat(150))).toBeNull();
    // An EMPTY fence is not nothing, though — "code block" is still the honest
    // answer, and the row has nothing better to describe itself with.
    expect(entrySummary('```\n\n```')).toBe('code block');
  });

  it('reads a table as its cells, not as a fence of vertical bars', () => {
    const summary = entrySummary(
      `| step | owner |\n| --- | :---: |\n| build | Ana |\n| ship | Bo |\n${'padding '.repeat(15)}`
    )!;

    expect(summary).not.toContain('|');
    expect(summary).not.toContain('---');
    expect(summary.startsWith('step owner build Ana ship Bo')).toBe(true);
  });

  it('never cuts a character in half', () => {
    // `slice` counts UTF-16 units, so a fixed offset lands inside a surrogate
    // pair or a ZWJ sequence — "👩‍👩‍👧" becomes a lone woman plus an unpaired
    // surrogate, which a screen reader reads as a replacement character.
    //
    // **The fixture has no spaces in it, and that is the whole test.** With
    // spaces, the word-boundary back-off lands on one by luck and a naive
    // `slice` passes — which is exactly what the first version of this test did
    // (verified: it stayed green with the grapheme cut deleted). An unbroken
    // run leaves the raw cut with nowhere to retreat to. The leading `x` is
    // what stops the limit from dividing evenly into the emoji's 8 code units.
    const family = '👩‍👩‍👧';
    const summary = entrySummary(`x${family.repeat(30)}`)!;

    expect(summary).not.toContain('�');
    // No unpaired surrogate survived the cut.
    expect(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(summary)
    ).toBe(false);
    // And no half-built family: what is there is whole families and nothing else.
    expect(summary.replaceAll(family, '').replace(/[x…]/g, '')).toBe('');
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
