import { describe, it, expect } from 'vitest';
import { ccAuthors, markCc, type AddressableSpan } from '../mention-addressing.js';

/** Spans for every `@word` in `text`, keyed by the word itself. */
function spansOf(text: string): AddressableSpan[] {
  return [...text.matchAll(/@(\w+)/g)].map((match) => ({
    offset: match.index!,
    length: match[0].length,
    authorId: match[1]!,
  }));
}

/** Who a message only copies in. */
const ccIn = (text: string) => ccAuthors(markCc(text, spansOf(text)));

describe('first-@ addressing', () => {
  it('asks the first @mention and copies in every later one', () => {
    expect(ccIn('@ana ship it, and tell @bo')).toEqual(['bo']);
  });

  it('asks every @mention in a leading run', () => {
    expect(ccIn('@ana @bo: ship it')).toEqual([]);
    expect(ccIn('@ana, @bo and @kai ship it')).toEqual([]);
    expect(ccIn('@ana & @bo ship it')).toEqual([]);
  });

  it('ends the run at a colon or a word', () => {
    expect(ccIn('@ana: ask @bo')).toEqual(['bo']);
    expect(ccIn('@ana please @bo')).toEqual(['bo']);
  });

  it('asks the first @mention even when it is not at the start', () => {
    expect(ccIn('hey @ana can you check, cc @bo')).toEqual(['bo']);
  });

  it('asks a run of @mentions that starts mid-sentence', () => {
    expect(ccIn('hey @ana @bo check this')).toEqual([]);
  });

  it('never copies in someone it asked, however often it names them', () => {
    expect(ccIn('@ana ship it, then @ana tell @bo')).toEqual(['bo']);
  });

  it('marks only the cc spans, in text order, whatever order they arrive in', () => {
    const text = '@ana ship it, cc @bo';
    const marked = markCc(text, [...spansOf(text)].reverse());
    expect(marked.map((span) => [span.authorId, span.cc])).toEqual([
      ['ana', undefined],
      ['bo', true],
    ]);
  });

  it('reads unmarked spans as nobody copied in', () => {
    expect(ccAuthors(spansOf('@ana tell @bo'))).toEqual([]);
  });
});
