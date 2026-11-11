import { describe, expect, it } from 'vitest';
import { receiptSwapTransition } from '../lib/receipt-swap';

describe('receiptSwapTransition (DOR-3112)', () => {
  it('collapses and crossfades over 200ms, easing out', () => {
    expect(receiptSwapTransition(false)).toEqual({ duration: 0.2, ease: 'easeOut' });
    // Motion reports null before it knows the person's setting: animate as usual.
    expect(receiptSwapTransition(null)).toEqual({ duration: 0.2, ease: 'easeOut' });
  });

  it('swaps instantly under reduced motion', () => {
    expect(receiptSwapTransition(true)).toEqual({ duration: 0 });
  });
});
