/**
 * How a scheduled chat's rows move with its rekey (DOR-3703; spec
 * `computer-side-starts-alone` §5.12): through the moves the space side hands
 * over, inside the caller's transaction, and not at all before they are.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@dorkos/db';
import { moveScheduledChats, setScheduledChatMoves } from '../rekey-moves.js';

const DB = {} as Db;

afterEach(() => setScheduledChatMoves(undefined));

describe('moveScheduledChats', () => {
  it('moves nothing, and does not throw, before the moves are handed over', () => {
    expect(() => moveScheduledChats(DB, 'from', 'to')).not.toThrow();
  });

  it('runs the handed-over moves with the caller’s database and both ids', () => {
    const moves = vi.fn();
    setScheduledChatMoves(moves);
    moveScheduledChats(DB, 'from', 'to');
    expect(moves).toHaveBeenCalledWith(DB, 'from', 'to');
  });

  it('moves nothing again once cleared', () => {
    const moves = vi.fn();
    setScheduledChatMoves(moves);
    setScheduledChatMoves(undefined);
    moveScheduledChats(DB, 'from', 'to');
    expect(moves).not.toHaveBeenCalled();
  });
});
