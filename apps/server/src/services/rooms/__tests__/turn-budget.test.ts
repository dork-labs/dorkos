/**
 * The budget's whole job is to hold when the cascade guard's discriminator does
 * not, so every number here is a pinned literal and the clock is injected —
 * nothing in this file reads config, and nothing waits on a real hour.
 */
import { describe, it, expect } from 'vitest';
import { RoomTurnBudget } from '../turn-budget.js';

/** A budget with a hand-cranked clock. */
function budgetOf(maxPerWindow: number, windowMs = 60_000) {
  let now = 1_000_000;
  const budget = new RoomTurnBudget({
    maxPerWindow: () => maxPerWindow,
    windowMs,
    now: () => now,
  });
  return { budget, advance: (ms: number) => (now += ms) };
}

describe('RoomTurnBudget', () => {
  it('allows up to the cap and refuses past it', () => {
    const { budget } = budgetOf(3);
    expect([1, 2, 3].map(() => budget.tryReserve('room-1').allowed)).toEqual([true, true, true]);
    expect(budget.tryReserve('room-1').allowed).toBe(false);
  });

  it('reports what is left, so the caller never has to count', () => {
    const { budget } = budgetOf(3);
    expect(budget.remaining('room-1')).toBe(3);
    expect(budget.tryReserve('room-1').remaining).toBe(2);
    budget.tryReserve('room-1');
    budget.tryReserve('room-1');
    expect(budget.remaining('room-1')).toBe(0);
  });

  it('reserves on success, so two turns cannot spend the same last unit', () => {
    const { budget } = budgetOf(1);
    expect(budget.tryReserve('room-1').allowed).toBe(true);
    expect(budget.tryReserve('room-1').allowed).toBe(false);
  });

  it('counts per room, so one busy room cannot silence another', () => {
    const { budget } = budgetOf(1);
    expect(budget.tryReserve('room-1').allowed).toBe(true);
    expect(budget.tryReserve('room-2').allowed).toBe(true);
    expect(budget.tryReserve('room-1').allowed).toBe(false);
  });

  it('rolls: budget spent an hour ago is available again', () => {
    const { budget, advance } = budgetOf(2, 60_000);
    budget.tryReserve('room-1');
    budget.tryReserve('room-1');
    expect(budget.tryReserve('room-1').allowed).toBe(false);

    advance(60_001);
    expect(budget.tryReserve('room-1').allowed).toBe(true);
  });

  it('rolls partially, rather than resetting on a boundary', () => {
    const { budget, advance } = budgetOf(2, 60_000);
    budget.tryReserve('room-1');
    advance(30_000);
    budget.tryReserve('room-1');
    expect(budget.tryReserve('room-1').allowed).toBe(false);

    // Only the first has aged out; the second is still inside the window.
    advance(30_001);
    expect(budget.tryReserve('room-1').allowed).toBe(true);
    expect(budget.tryReserve('room-1').allowed).toBe(false);
  });

  it('refuses everything at a cap of zero — the way to turn automatic replies off', () => {
    const { budget } = budgetOf(0);
    expect(budget.tryReserve('room-1').allowed).toBe(false);
    expect(budget.remaining('room-1')).toBe(0);
  });

  it('reads the cap per call, so raising it in Settings takes effect at once', () => {
    let max = 1;
    const budget = new RoomTurnBudget({ maxPerWindow: () => max });
    expect(budget.tryReserve('room-1').allowed).toBe(true);
    expect(budget.tryReserve('room-1').allowed).toBe(false);

    max = 5;
    expect(budget.tryReserve('room-1').allowed).toBe(true);
  });

  it('stays bounded across many rooms rather than growing forever', () => {
    const { budget } = budgetOf(1);
    for (let i = 0; i < 600; i++) budget.tryReserve(`room-${i}`);
    // The oldest rooms were evicted, so their budget reads as fresh. That is the
    // deliberate trade: bounded memory, and eviction can only ever be generous.
    expect(budget.remaining('room-0')).toBe(1);
    expect(budget.remaining('room-599')).toBe(0);
  });
});
