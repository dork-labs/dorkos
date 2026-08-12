import { describe, it, expect } from 'vitest';

import { WarmSlotBook } from '../warm-slot-book.js';

describe('WarmSlotBook slot reservations', () => {
  // Purpose: the arithmetic behind the ceiling fix, stated without a pump in the
  // way. `live` is ZERO for all three calls — exactly what three launches in one
  // tick see — and the ceiling still has to hold at two.
  it('counts granted slots against the ceiling before they are processes', () => {
    const book = new WarmSlotBook();

    expect(book.grant('a', 0, 2)).toBe(true);
    expect(book.grant('b', 0, 2)).toBe(true);
    expect(book.grant('c', 0, 2)).toBe(false);
  });

  // Purpose: a reservation is a loan, not a transfer. Once the launch it covered
  // has settled, the slot has to come back — otherwise every failed launch would
  // shrink the ceiling by one, permanently.
  it('gives the slot back on release', () => {
    const book = new WarmSlotBook();
    book.grant('a', 0, 1);
    expect(book.grant('b', 0, 1)).toBe(false);

    book.release('a');

    expect(book.grant('b', 0, 1)).toBe(true);
  });

  // Purpose: the live count and the reservations are added, so a session that
  // already HAS a process must not also be charged a reservation for it.
  it('adds live processes to reservations', () => {
    const book = new WarmSlotBook();

    expect(book.grant('a', 2, 3)).toBe(true);
    expect(book.grant('b', 2, 3)).toBe(false);
  });

  // Purpose: one session cannot be charged twice for the one launch it is making
  // — which is what a retry, or a stale reservation from a launch that died
  // before it ever transitioned, would otherwise cost it.
  it('does not charge a session twice for its own outstanding slot', () => {
    const book = new WarmSlotBook();
    book.grant('a', 0, 1);

    expect(book.grant('a', 0, 1)).toBe(true);
    expect(book.grant('b', 0, 1)).toBe(false);
  });
});

describe('WarmSlotBook use-recency', () => {
  // Purpose: LRU means LEAST RECENTLY USED, and the difference from "oldest" is
  // the entire point. Here insertion order and use order disagree on every
  // position, so an implementation that returns either the insertion order or
  // its reverse gets a different answer.
  it('orders by last use, not by when a session first appeared', () => {
    const book = new WarmSlotBook();
    book.touch('a');
    book.touch('b');
    book.touch('c');
    book.touch('b');
    book.touch('a');

    expect(book.leastRecentFirst(['a', 'b', 'c'])).toEqual(['c', 'b', 'a']);
    // The candidate order handed in must not change the answer.
    expect(book.leastRecentFirst(['b', 'a', 'c'])).toEqual(['c', 'b', 'a']);
  });

  // Purpose: two uses inside one millisecond still have an order. A clock-based
  // stamp would tie them and leave the reclaim picking by sort stability.
  it('orders two uses in the same millisecond', () => {
    const book = new WarmSlotBook();
    book.touch('a');
    book.touch('b');

    expect(book.leastRecentFirst(['b', 'a'])).toEqual(['a', 'b']);
  });

  // Purpose: nothing known about a session means nothing is lost by reclaiming
  // it, so it goes first rather than last.
  it('sorts a session it has never seen used as the oldest', () => {
    const book = new WarmSlotBook();
    book.touch('a');

    expect(book.leastRecentFirst(['a', 'unseen'])).toEqual(['unseen', 'a']);
  });

  // Purpose: a session that leaves the registry and later comes back is a new
  // session as far as the ceiling and the ordering are concerned.
  it('forgets a session entirely', () => {
    const book = new WarmSlotBook();
    book.grant('a', 0, 1);
    book.touch('a');
    book.touch('b');

    book.forget('a');

    expect(book.grant('b', 0, 1)).toBe(true);
    expect(book.leastRecentFirst(['a', 'b'])).toEqual(['a', 'b']);
  });
});
