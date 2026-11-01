import { describe, it, expect } from 'vitest';
import { ccAuthors, markCc, reachLine, type AddressableSpan } from '../mention-addressing.js';

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

describe('cc addressing', () => {
  it('asks every @mention when no cc comes before it', () => {
    expect(ccIn('@ana ship it, and tell @bo')).toEqual([]);
    expect(ccIn('@ana: ask @bo')).toEqual([]);
    expect(ccIn('hey @ana @bo check this')).toEqual([]);
  });

  it('asks the agents a post assigns work to after answering a person', () => {
    const text =
      '@dorian yes, that is the plan.\n@designer take the overhaul. @cloud check the API.';
    expect(ccIn(text)).toEqual([]);
  });

  it('copies in every @mention after cc on that line', () => {
    expect(ccIn('cc @ana @bo')).toEqual(['ana', 'bo']);
    expect(ccIn('@ana ship it, cc @bo')).toEqual(['bo']);
    expect(ccIn('@ana ship it. CC: @bo, @kai')).toEqual(['bo', 'kai']);
    expect(ccIn('@ana ship it (cc @bo)')).toEqual(['bo']);
  });

  it('ends the cc at the end of its line', () => {
    expect(ccIn('cc @ana\n@bo please check')).toEqual(['ana']);
  });

  it('reads cc only as a word of its own', () => {
    expect(ccIn('accent @ana')).toEqual([]);
    expect(ccIn('@cc please look, @ana')).toEqual([]);
  });

  it('never copies in someone it asked, however often it names them', () => {
    expect(ccIn('@ana ship it\ncc @ana @bo')).toEqual(['bo']);
    expect(ccIn('cc @ana\n@ana ship it')).toEqual([]);
  });

  it('marks only the cc spans, in text order, whatever order they arrive in', () => {
    const text = '@ana ship it, cc @bo';
    const marked = markCc(text, [...spansOf(text)].reverse());
    expect(marked.map((span) => [span.authorId, span.cc])).toEqual([
      ['ana', undefined],
      ['bo', true],
    ]);
  });

  it('drops the cc mark from every span of an author it asked', () => {
    const text = 'cc @ana\n@ana ship it';
    expect(markCc(text, spansOf(text)).map((span) => span.cc)).toEqual([undefined, undefined]);
  });

  it('reads unmarked spans as nobody copied in', () => {
    expect(ccAuthors(spansOf('@ana tell @bo'))).toEqual([]);
  });
});

describe('reachLine', () => {
  it('names who a post woke and who it only copied in', () => {
    expect(reachLine(['@ana'], ['@bo'])).toBe('Woke @ana. Cc: @bo.');
    expect(reachLine(['@ana', '@bo'], [])).toBe('Woke @ana, @bo.');
  });

  it('says a post woke nobody', () => {
    expect(reachLine([], [])).toBe('Woke nobody.');
    expect(reachLine([], ['@ana', '@bo'])).toBe('Woke nobody. Cc: @ana, @bo.');
  });
});
