/**
 * Splitting an excerpt into plain and matched runs (`specs/message-search` §8).
 *
 * @module features/command-palette/model/__tests__/search-excerpt
 */
import { describe, it, expect } from 'vitest';
import { splitExcerpt } from '../search-excerpt';

describe('splitting a search excerpt', () => {
  it('pulls one match out of its sentence', () => {
    expect(splitExcerpt('a pack of <mark>dogs</mark> ran past')).toEqual([
      { text: 'a pack of ', matched: false },
      { text: 'dogs', matched: true },
      { text: ' ran past', matched: false },
    ]);
  });

  it('handles several matches, and a match at each end', () => {
    expect(splitExcerpt('<mark>dogs</mark> and more <mark>dogs</mark>')).toEqual([
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
    expect(splitExcerpt('…the <mark>port</mark> binding…')).toEqual([
      { text: '…the ', matched: false },
      { text: 'port', matched: true },
      { text: ' binding…', matched: false },
    ]);
  });

  it('treats every other angle bracket as text, not as markup', () => {
    // The load-bearing case. `snippet()` marks matches and leaves the rest of
    // the message exactly as it was typed, and people type markup into chat all
    // day. Nothing but the two markers may be consumed.
    const runs = splitExcerpt('he pasted <script>alert(1)</script> into <mark>chat</mark>');
    expect(runs).toEqual([
      { text: 'he pasted <script>alert(1)</script> into ', matched: false },
      { text: 'chat', matched: true },
    ]);
  });

  it('degrades unbalanced markers to text rather than guessing', () => {
    // Only reachable by somebody literally typing these characters, in which
    // case the excerpt is ambiguous at the source. The highlight may land
    // oddly; no branch here can turn any of it into markup.
    expect(splitExcerpt('open <mark>and never closed')).toEqual([
      { text: 'open ', matched: false },
      { text: 'and never closed', matched: true },
    ]);
    expect(splitExcerpt('a stray </mark> closer')).toEqual([
      { text: 'a stray </mark> closer', matched: false },
    ]);
  });
});
