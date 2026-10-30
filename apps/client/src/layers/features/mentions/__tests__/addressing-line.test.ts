/**
 * The quiet line under a channel's composer: who a draft asks, and who it
 * only copies in (DOR-3401).
 */
import { describe, it, expect } from 'vitest';
import type { AuthorRef } from '@/layers/entities/room';
import { addressingLine } from '../lib/addressing-line';

function member(handle: string): { author: AuthorRef } {
  return { author: { id: handle, kind: 'agent', displayName: handle, handle } as AuthorRef };
}

const ROSTER = [member('ana'), member('bo'), member('kai')];

describe('addressingLine', () => {
  it('says nothing until the draft copies somebody in', () => {
    expect(addressingLine('', ROSTER)).toBeNull();
    expect(addressingLine('@ana ship it', ROSTER)).toBeNull();
    expect(addressingLine('@ana @bo: ship it', ROSTER)).toBeNull();
  });

  it('names who is asked and who gets a copy', () => {
    expect(addressingLine('@ana ship it, cc @bo and @kai.', ROSTER)).toBe(
      'Asks @ana · cc @bo, @kai'
    );
  });

  it('moves a name to "asks" when it moves to the front', () => {
    expect(addressingLine('@bo ship it, cc @ana', ROSTER)).toBe('Asks @bo · cc @ana');
  });

  it('ignores a name nobody in the room has', () => {
    expect(addressingLine('@ana ship it, cc @nobody', ROSTER)).toBeNull();
  });
});
