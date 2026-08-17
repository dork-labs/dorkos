import { describe, it, expect } from 'vitest';
import { NotifyBudget } from '../notify-budget.js';

/** A budget on a clock the test moves, so an hour costs no wall time. */
function makeBudget(opts: { limit?: number; at?: () => number } = {}) {
  let clock = 1_000_000;
  const budget = new NotifyBudget({
    ...(opts.limit !== undefined ? { limit: () => opts.limit! } : {}),
    now: opts.at ?? (() => clock),
  });
  return {
    budget,
    /** Move the clock forward. */
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('NotifyBudget', () => {
  it('allows the ceiling and refuses the one after it', () => {
    const { budget } = makeBudget({ limit: 3 });

    expect([1, 2, 3].map(() => budget.tryReserve('ana'))).toEqual([true, true, true]);
    expect(budget.tryReserve('ana')).toBe(false);
  });

  it('costs an agent nothing to be refused', () => {
    // The refusal must not push the window out: an agent that keeps asking would
    // otherwise never get its allowance back, and the ceiling would become "ten
    // notes, then silence until you stop trying".
    const { budget, advance } = makeBudget({ limit: 2 });
    budget.tryReserve('ana');
    budget.tryReserve('ana');

    // Refused a hundred times right up against the window's edge.
    advance(59 * 60_000);
    for (let i = 0; i < 100; i++) expect(budget.tryReserve('ana')).toBe(false);

    // Only the two real notes aged out, so the full allowance is back.
    advance(61_000);
    expect(budget.tryReserve('ana')).toBe(true);
    expect(budget.tryReserve('ana')).toBe(true);
    expect(budget.tryReserve('ana')).toBe(false);
  });

  it('rolls the window rather than resetting it, so the allowance comes back one note at a time', () => {
    const { budget, advance } = makeBudget({ limit: 2 });
    expect(budget.tryReserve('ana')).toBe(true);
    advance(30 * 60_000);
    expect(budget.tryReserve('ana')).toBe(true);
    expect(budget.tryReserve('ana')).toBe(false);

    // An hour after the FIRST note, only that one has aged out.
    advance(30 * 60_000 + 1_000);
    expect(budget.tryReserve('ana')).toBe(true);
    expect(budget.tryReserve('ana')).toBe(false);
  });

  it('counts each agent separately, so one loud agent never silences another', () => {
    const { budget } = makeBudget({ limit: 1 });

    expect(budget.tryReserve('ana')).toBe(true);
    expect(budget.tryReserve('ana')).toBe(false);
    expect(budget.tryReserve('bo')).toBe(true);
    expect(budget.tryReserve('bo')).toBe(false);
  });

  it('gives a note back when a delivery did not happen', () => {
    const { budget } = makeBudget({ limit: 2 });
    budget.tryReserve('ana');
    budget.refund('ana');

    // The refunded note is available again, so the ceiling is unspent.
    expect([1, 2].map(() => budget.tryReserve('ana'))).toEqual([true, true]);
    expect(budget.tryReserve('ana')).toBe(false);
  });

  it('refunds nothing when there is nothing to give back', () => {
    // An agent whose window emptied under it (or a caller that refunds twice)
    // must not be handed a negative bill, and a bound is not a place to throw.
    const { budget } = makeBudget({ limit: 1 });
    budget.refund('ana');
    budget.refund('ana');

    expect(budget.tryReserve('ana')).toBe(true);
    expect(budget.tryReserve('ana')).toBe(false);
  });

  it('refunds the note the caller just reserved, not the oldest one still standing', () => {
    // WHICH timestamp comes back decides when the allowance recovers, and the
    // two plausible implementations disagree only here. Reserve at t0, then at
    // t0+30m reserve-and-refund a delivery that failed. The failed one must be
    // the one that went, leaving the t0 note standing and ageing out at t0+1h.
    //
    // `pop()` (correct): at t0+1h the t0 note expires, so both units are free.
    // `shift()` (the mutant): it would have refunded the t0 note instead and
    // kept the t0+30m one, which does not expire until t0+90m — so the second
    // reserve is refused. Without this the mutant is invisible.
    const { budget, advance } = makeBudget({ limit: 2 });
    expect(budget.tryReserve('ana')).toBe(true);

    advance(30 * 60_000);
    expect(budget.tryReserve('ana')).toBe(true);
    budget.refund('ana');

    advance(30 * 60_000 + 1_000);
    expect([1, 2].map(() => budget.tryReserve('ana'))).toEqual([true, true]);
  });

  it('refunds the note the caller reserved and never another agent’s', () => {
    const { budget } = makeBudget({ limit: 1 });
    expect(budget.tryReserve('ana')).toBe(true);
    expect(budget.tryReserve('bo')).toBe(true);

    budget.refund('bo');

    expect(budget.tryReserve('ana')).toBe(false);
    expect(budget.tryReserve('bo')).toBe(true);
  });

  it('ships a ceiling of ten notes an hour when nothing overrides it', () => {
    // The shipped default is the number a person actually meets, so it is pinned
    // here rather than left to whatever a test happens to pass.
    const { budget } = makeBudget();

    for (let i = 0; i < 10; i++) expect(budget.tryReserve('ana')).toBe(true);
    expect(budget.tryReserve('ana')).toBe(false);
  });
});
