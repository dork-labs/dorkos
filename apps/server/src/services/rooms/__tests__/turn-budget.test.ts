/**
 * The budget's whole job is to hold when the cascade guard's discriminator does
 * not, so every number here is a pinned literal and the clock is injected —
 * nothing in this file reads config, and nothing waits on a real hour.
 */
import { describe, it, expect, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { roomTurnSpend } from '@dorkos/db';
import { RoomTurnBudget } from '../turn-budget.js';
import { logger } from '../../../lib/logger.js';

/**
 * A budget with a hand-cranked clock, its own database, and a global cap high
 * enough to stay out of the way.
 *
 * `restart()` is what a restart IS here: a brand-new budget over the same
 * database and the same hour. Nothing in this process is carried across — if a
 * ceiling still holds after one, it held because the spend was written down.
 */
function budgetOf(perRoom: number, windowMs = 60_000, global = 100_000) {
  let now = 1_000_000;
  const db = createTestDb();
  const limits = { perRoom: () => perRoom, global: () => global };
  const boot = () => new RoomTurnBudget({ limits, db, windowMs, now: () => now });
  return { db, budget: boot(), restart: boot, advance: (ms: number) => (now += ms) };
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
      db: createTestDb(),
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

describe('RoomTurnBudget — surviving a restart (DOR-1205)', () => {
  it('does not hand a room a fresh allowance halfway through its hour', () => {
    const { budget, restart } = budgetOf(2);
    budget.tryReserve('room-1');
    budget.tryReserve('room-1');
    expect(budget.tryReserve('room-1').allowed).toBe(false);

    // The whole point: a caller who can restart the server used to clear both
    // windows, roughly 36 times an hour through the rate-limited admin route.
    const rebooted = restart();
    expect(rebooted.tryReserve('room-1')).toEqual({ allowed: false, scope: 'room' });
  });

  it('carries the global ceiling across too, not just the per-room one', () => {
    const { budget, restart } = budgetOf(100, 60_000, 1);
    expect(budget.tryReserve('room-a').allowed).toBe(true);

    // A DIFFERENT room after the restart, so only the global window can refuse
    // it — which is the window that has to be exact.
    expect(restart().tryReserve('room-b')).toEqual({ allowed: false, scope: 'global' });
  });

  it('reports the surviving spend through remaining(), not only through refusals', () => {
    const { budget, restart } = budgetOf(3, 60_000, 10);
    budget.tryReserve('room-1');
    budget.tryReserve('room-2');

    expect(restart().remaining('room-1')).toEqual({ room: 2, global: 8 });
  });

  it('starts clean once the window has rolled past what it wrote down', () => {
    const { budget, restart, advance } = budgetOf(1);
    budget.tryReserve('room-1');
    advance(60_001);

    expect(restart().tryReserve('room-1').allowed).toBe(true);
  });

  it('keeps only the last hour on disk, so the table cannot grow forever', () => {
    const { db, budget, advance } = budgetOf(100, 60_000);
    for (let i = 0; i < 5; i += 1) budget.tryReserve('room-1');
    advance(60_001);
    budget.tryReserve('room-1');

    // The prune rides the write: five spends at one instant, then a sixth an
    // hour later, and the sixth write is what drops the five that aged out.
    expect(db.select().from(roomTurnSpend).all()).toHaveLength(1);
  });

  it('ignores a spend stamped in the future, so a clock that went backwards cannot wedge a room', () => {
    // An NTP correction or a VM resumed from a snapshot leaves rows the prune
    // (`at <= floor`) will not delete. Counting them would keep a room's ceiling
    // spent until wall clock caught up — and durably, where the in-memory
    // version was healed by the very restart that now reloads them.
    const { db, restart } = budgetOf(1);
    db.insert(roomTurnSpend)
      .values({ roomId: 'room-1', at: 1_000_000 + 10 * 60_000 })
      .run();

    expect(restart().tryReserve('room-1').allowed).toBe(true);
  });

  it('still bounds this process when the write fails, rather than refusing the turn', () => {
    const { db, budget } = budgetOf(2);
    const insert = vi.spyOn(db, 'insert').mockImplementation(() => {
      throw new Error('database is locked');
    });

    // A counter that cannot be persisted must not cost an agent its reply — but
    // the ceiling this process is enforcing still holds.
    expect(budget.tryReserve('room-1').allowed).toBe(true);
    expect(budget.tryReserve('room-1').allowed).toBe(true);
    expect(budget.tryReserve('room-1').allowed).toBe(false);
    insert.mockRestore();
  });

  it('gives a SPENT ceiling back, loudly, when the durable window cannot be read at boot', () => {
    // The fail-open branch, proved against a window that really was spent —
    // asserting it on an empty database would pass whether or not the read ever
    // happened. Restoring the allowance is the deliberate trade (a server that
    // will not boot because a counter is unreadable is worse), so the warn is
    // half the behaviour under test, not decoration.
    const { db, budget, restart } = budgetOf(2);
    budget.tryReserve('room-1');
    budget.tryReserve('room-1');
    expect(budget.tryReserve('room-1').allowed).toBe(false);

    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const select = vi.spyOn(db, 'select').mockImplementation(() => {
      throw new Error('database is locked');
    });
    const rebooted = restart();
    select.mockRestore();

    expect(rebooted.tryReserve('room-1').allowed).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('already spent this hour'),
      expect.objectContaining({ error: 'database is locked' })
    );
    warn.mockRestore();
  });
});

describe('RoomTurnBudget.remaining', () => {
  it('reports what is left, per room and in total', () => {
    const { budget } = budgetOf(3, 60_000, 10);
    budget.tryReserve('room-1');
    budget.tryReserve('room-2');
    expect(budget.remaining('room-1')).toEqual({ room: 2, global: 8 });
    expect(budget.remaining('room-2')).toEqual({ room: 2, global: 8 });
    expect(budget.remaining('room-3')).toEqual({ room: 3, global: 8 });
  });

  it('claims nothing, so reading it can never make a turn unaffordable', () => {
    // The trap this exists to avoid: an agent asking what is left and spending
    // it by asking. Five reads, then the cap is still available in full.
    const { budget } = budgetOf(1);
    for (let i = 0; i < 5; i += 1) budget.remaining('room-1');
    expect(budget.tryReserve('room-1').allowed).toBe(true);
  });

  it('rolls with the window', () => {
    const { budget, advance } = budgetOf(2, 60_000);
    budget.tryReserve('room-1');
    budget.tryReserve('room-1');
    expect(budget.remaining('room-1').room).toBe(0);
    advance(60_001);
    expect(budget.remaining('room-1').room).toBe(2);
  });

  it('never goes below zero when a cap is lowered under a spent window', () => {
    let cap = 5;
    const budget = new RoomTurnBudget({
      db: createTestDb(),
      limits: { perRoom: () => cap, global: () => 100_000 },
      windowMs: 60_000,
      now: () => 1_000_000,
    });
    for (let i = 0; i < 5; i += 1) budget.tryReserve('room-1');
    cap = 2;
    expect(budget.remaining('room-1').room).toBe(0);
  });
});
