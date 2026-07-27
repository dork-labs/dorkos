/**
 * The budget's whole job is to hold when the cascade guard's discriminator does
 * not, so every number here is a pinned literal and the clock is injected —
 * nothing in this file reads config, and nothing waits on a real hour.
 */
import { describe, it, expect } from 'vitest';
import { RoomTurnBudget } from '../turn-budget.js';

/** A budget with a hand-cranked clock and a global cap high enough to stay out of the way. */
function budgetOf(perRoom: number, windowMs = 60_000, global = 100_000) {
  let now = 1_000_000;
  const budget = new RoomTurnBudget({
    limits: { perRoom: () => perRoom, global: () => global },
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
  });

  it('reads the cap per call, so raising it in Settings takes effect at once', () => {
    let max = 1;
    const budget = new RoomTurnBudget({
      limits: { perRoom: () => max, global: () => 100_000 },
    });
    expect(budget.tryReserve('room-1').allowed).toBe(true);
    expect(budget.tryReserve('room-1').allowed).toBe(false);

    max = 5;
    expect(budget.tryReserve('room-1').allowed).toBe(true);
  });

  it('stays bounded across many rooms rather than growing forever', () => {
    const { budget } = budgetOf(1, 60_000, 100_000);
    for (let i = 0; i < 600; i++) budget.tryReserve(`room-${i}`);
    // The oldest rooms were evicted, so their per-room window reads as fresh.
    // That is the deliberate trade: bounded memory, and eviction can only ever
    // be generous — which is exactly why the GLOBAL window is never evicted.
    expect(budget.tryReserve('room-0').allowed).toBe(true);
    expect(budget.tryReserve('room-599').allowed).toBe(false);
  });
});

describe('RoomTurnBudget — the global cap', () => {
  it('bounds the install however many rooms exist', () => {
    // The per-room cap alone is not a spend bound, because rooms are free: a
    // caller multiplies its allowance by creating them. Measured through the
    // real mount before this existed, 2/room bought 16 turns across 8 channels.
    const { budget } = budgetOf(2, 60_000, 3);
    expect(budget.tryReserve('room-1').allowed).toBe(true);
    expect(budget.tryReserve('room-1').allowed).toBe(true);
    expect(budget.tryReserve('room-2').allowed).toBe(true);

    // Room 2 has budget of its own and the install does not.
    const refused = budget.tryReserve('room-2');
    expect(refused.allowed).toBe(false);
    expect(refused.scope).toBe('global');
    expect(budget.tryReserve('room-3').allowed).toBe(false);
  });

  it('names which cap refused, so the copy points at the right setting', () => {
    const { budget } = budgetOf(1, 60_000, 10);
    budget.tryReserve('room-1');
    expect(budget.tryReserve('room-1').scope).toBe('room');

    const tight = budgetOf(10, 60_000, 1);
    tight.budget.tryReserve('room-1');
    expect(tight.budget.tryReserve('room-2').scope).toBe('global');
  });

  it('rolls the global window too', () => {
    const { budget, advance } = budgetOf(10, 60_000, 1);
    expect(budget.tryReserve('room-1').allowed).toBe(true);
    expect(budget.tryReserve('room-2').allowed).toBe(false);

    advance(60_001);
    expect(budget.tryReserve('room-2').allowed).toBe(true);
  });

  it('refuses everything at a global cap of zero', () => {
    const { budget } = budgetOf(10, 60_000, 0);
    expect(budget.tryReserve('room-1').allowed).toBe(false);
    expect(budget.tryReserve('room-1').scope).toBe('global');
  });

  it('never evicts the global window, unlike the per-room ones', () => {
    // Per-room eviction can only be generous — an evicted room reads as unspent
    // — so the global count is the one that has to stay exact across many rooms.
    const { budget } = budgetOf(1, 60_000, 300);
    for (let i = 0; i < 600; i++) budget.tryReserve(`room-${i}`);
    expect(budget.tryReserve('room-fresh').allowed).toBe(false);
    expect(budget.tryReserve('room-fresh').scope).toBe('global');
  });
});
