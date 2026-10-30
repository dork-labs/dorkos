/**
 * The quiet lines that say who a channel message wakes and who it only copies
 * in: under the composer while typing, and under the author's own post
 * (DOR-3453, DOR-3454).
 */
import { describe, it, expect } from 'vitest';
import type { AuthorRef } from '@/layers/entities/room';
import { addressingLine, postedReachLine } from '../lib/addressing-line';

function member(handle: string, kind: AuthorRef['kind'] = 'agent'): { author: AuthorRef } {
  return { author: { id: handle, kind, displayName: handle, handle } as AuthorRef };
}

const ROSTER = [member('ana'), member('bo'), member('kai')];

describe('addressingLine', () => {
  it('says nothing until the draft copies somebody in', () => {
    expect(addressingLine('', ROSTER)).toBeNull();
    expect(addressingLine('@ana ship it', ROSTER)).toBeNull();
    expect(addressingLine('@ana ship it, then tell @bo', ROSTER)).toBeNull();
  });

  it('names who wakes and who gets a copy', () => {
    expect(addressingLine('@ana ship it, cc @bo and @kai.', ROSTER)).toBe(
      'Wakes @ana · cc @bo, @kai'
    );
  });

  it('wakes every name before the cc, wherever it sits', () => {
    expect(addressingLine('hey @ana, then @bo checks, cc @kai', ROSTER)).toBe(
      'Wakes @ana, @bo · cc @kai'
    );
  });

  it('says a draft that only copies people in wakes nobody', () => {
    expect(addressingLine('cc @ana @bo', ROSTER)).toBe('Wakes nobody · cc @ana, @bo');
  });

  it('ignores a name nobody in the room has', () => {
    expect(addressingLine('@ana ship it, cc @nobody', ROSTER)).toBeNull();
  });
});

describe('postedReachLine', () => {
  const authors = new Map(
    [...ROSTER, member('dorian', 'human')].map(({ author }) => [author.id, author])
  );

  it('says who a post woke and who it only cc’d', () => {
    const entry = {
      authorId: 'dorian',
      mentions: ['ana', 'bo'],
      mentionSpans: [
        { offset: 0, length: 4, authorId: 'ana' },
        { offset: 20, length: 3, authorId: 'bo', cc: true },
      ],
    };
    expect(postedReachLine(entry, authors)).toBe('Woke @ana. Cc: @bo.');
  });

  it('leaves a person named out of who woke', () => {
    const entry = {
      authorId: 'ana',
      mentions: ['dorian', 'bo', 'kai'],
      mentionSpans: [
        { offset: 0, length: 7, authorId: 'dorian' },
        { offset: 20, length: 3, authorId: 'bo' },
        { offset: 30, length: 4, authorId: 'kai' },
      ],
    };
    expect(postedReachLine(entry, authors)).toBe('Woke @bo, @kai.');
  });

  it('says nothing for a post that names nobody', () => {
    expect(postedReachLine({ authorId: 'dorian', mentions: [] }, authors)).toBeNull();
  });
});
