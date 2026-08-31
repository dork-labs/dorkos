/**
 * Splitting an excerpt into plain and matched runs (`specs/message-search` §8).
 *
 * @module features/command-palette/model/__tests__/search-excerpt
 */
import { describe, it, expect } from 'vitest';
import { splitExcerpt } from '../search-excerpt';

/** The real sentinel characters `snippet()` wraps a match in (DOR-1552). */
const OPEN = '\u0001';
const CLOSE = '\u0002';

describe('splitting a search excerpt', () => {
  it('pulls one match out of its sentence', () => {
    expect(splitExcerpt(`a pack of ${OPEN}dogs${CLOSE} ran past`)).toEqual([
      { text: 'a pack of ', matched: false },
      { text: 'dogs', matched: true },
      { text: ' ran past', matched: false },
    ]);
  });

  it('handles several matches, and a match at each end', () => {
    expect(splitExcerpt(`${OPEN}dogs${CLOSE} and more ${OPEN}dogs${CLOSE}`)).toEqual([
      { text: 'dogs', matched: true },
      { text: ' and more ', matched: false },
      { text: 'dogs', matched: true },
    ]);
  });

  it('leaves an unmarked excerpt as one plain run', () => {
    expect(splitExcerpt('nothing was marked here')).toEqual([
      { text: 'nothing was marked here', matched: false },
    ]);
  });

  it('gives an empty excerpt no runs at all', () => {
    expect(splitExcerpt('')).toEqual([]);
  });

  it('keeps `…` elision, which is text like any other', () => {
    expect(splitExcerpt(`…the ${OPEN}port${CLOSE} binding…`)).toEqual([
      { text: '…the ', matched: false },
      { text: 'port', matched: true },
      { text: ' binding…', matched: false },
    ]);
  });

  it('treats every other angle bracket as text, not as markup', () => {
    // The load-bearing case. `snippet()` marks matches and leaves the rest of
    // the message exactly as it was typed, and people type markup into chat all
    // day. Nothing but the two sentinel characters may be consumed.
    const runs = splitExcerpt(`he pasted <script>alert(1)</script> into ${OPEN}chat${CLOSE}`);
    expect(runs).toEqual([
      { text: 'he pasted <script>alert(1)</script> into ', matched: false },
      { text: 'chat', matched: true },
    ]);
  });

  it('treats a literal "<mark>" typed into a message as text, not as a marker', () => {
    // The bug this module used to have (DOR-1552): the delimiter used to BE the
    // visible text `<mark>`, so a message that happened to contain that exact
    // substring was indistinguishable from a real match marker at the contract
    // level. The sentinel is a control character no message body can contain,
    // so the literal text renders as itself even right next to a real match.
    const runs = splitExcerpt(`she typed <mark>literally</mark> and then ${OPEN}found${CLOSE} it`);
    expect(runs).toEqual([
      { text: 'she typed <mark>literally</mark> and then ', matched: false },
      { text: 'found', matched: true },
      { text: ' it', matched: false },
    ]);
  });

  it('degrades unbalanced markers to text rather than guessing', () => {
    // Only reachable from a corrupted index, since no message body can carry
    // either sentinel itself. The highlight may land oddly; no branch here can
    // turn any of it into markup.
    expect(splitExcerpt(`open ${OPEN}and never closed`)).toEqual([
      { text: 'open ', matched: false },
      { text: 'and never closed', matched: true },
    ]);
    expect(splitExcerpt(`a stray ${CLOSE} closer`)).toEqual([
      { text: `a stray ${CLOSE} closer`, matched: false },
    ]);
  });
});
