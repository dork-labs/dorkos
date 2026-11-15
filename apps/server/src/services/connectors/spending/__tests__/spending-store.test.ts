/**
 * The monthly spend meter (DOR-4204 PR 2): one limit per DorkOS, a price per
 * app, and a meter per UTC month that reserves a run's price before it runs
 * and settles it after.
 *
 * Real SQLite through the test database; the names and amounts are made up.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '@dorkos/db';
import { createTestDb } from '@dorkos/test-utils/db';
import { SpendingStore, SpendingMeterUnreadableError } from '../spending-store.js';

/** $1 in micro-units. */
const DOLLAR = 1_000_000;
const NOV = new Date('2026-11-14T12:00:00.000Z');

describe('the spending meter', () => {
  let db: Db;
  let store: SpendingStore;

  beforeEach(() => {
    db = createTestDb();
    store = new SpendingStore(db, () => NOV);
  });

  it('has no limit and no prices until a person sets them', () => {
    expect(store.limit()).toBeNull();
    expect(store.price('acmesearch')).toBeNull();
    expect(store.meter()).toMatchObject({ month: '2026-11', usedMicro: 0, estimated: false });
  });

  it('keeps a limit and a price', () => {
    store.setLimit(40 * DOLLAR);
    store.setPrice('acmesearch', 300_000);
    expect(store.limit()).toBe(40 * DOLLAR);
    expect(store.price('acmesearch')).toBe(300_000);
    store.setLimit(null);
    store.setPrice('acmesearch', null);
    expect(store.limit()).toBeNull();
    expect(store.price('acmesearch')).toBeNull();
  });

  it('counts a reserved run as used at once (spec 1.1: reserve shows as used)', () => {
    store.setLimit(DOLLAR);
    expect(
      store.reserve({
        id: 'run-1',
        toolkit: 'acmesearch',
        agentId: 'agent-kestrel',
        amountMicro: 300_000,
        source: 'person',
        enforceLimit: true,
      })
    ).toEqual({ ok: true });
    expect(store.meter()).toMatchObject({ usedMicro: 300_000, estimated: true });
  });

  it('lets three $0.30 runs fit a $1.00 limit and refuses the fourth as would-pass', () => {
    store.setLimit(DOLLAR);
    const run = (id: string) =>
      store.reserve({
        id,
        toolkit: 'acmesearch',
        agentId: 'agent-kestrel',
        amountMicro: 300_000,
        source: 'person',
        enforceLimit: true,
      });
    expect([run('a'), run('b'), run('c')]).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    expect(run('d')).toEqual({ ok: false, reason: 'would-pass', leftMicro: 100_000 });
    expect(store.meter().usedMicro).toBe(900_000);
  });

  it('refuses a run once the limit is reached', () => {
    store.setLimit(300_000);
    store.reserve({
      id: 'a',
      toolkit: 'acmesearch',
      agentId: 'agent-kestrel',
      amountMicro: 300_000,
      source: 'person',
      enforceLimit: true,
    });
    expect(
      store.reserve({
        id: 'b',
        toolkit: 'acmesearch',
        agentId: 'agent-kestrel',
        amountMicro: 0,
        source: 'unknown',
        enforceLimit: true,
      })
    ).toEqual({ ok: false, reason: 'reached', leftMicro: 0 });
  });

  it('reserves atomically: two runs at 60% of what is left, one goes (Security Must 3)', () => {
    store.setLimit(DOLLAR);
    const reserve = (id: string) =>
      store.reserve({
        id,
        toolkit: 'acmesearch',
        agentId: 'agent-kestrel',
        amountMicro: 600_000,
        source: 'person',
        enforceLimit: true,
      });
    const results = [reserve('left'), reserve('right')];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(store.meter().usedMicro).toBe(600_000);
  });

  it('counts with no limit but never refuses then', () => {
    expect(
      store.reserve({
        id: 'a',
        toolkit: 'acmesearch',
        agentId: 'agent-kestrel',
        amountMicro: null,
        source: 'unknown',
        enforceLimit: false,
      })
    ).toEqual({ ok: true });
    expect(store.meter()).toMatchObject({ usedMicro: 0, unknownRuns: 1 });
  });

  it('replaces an estimate with the reported cost once, and a replay changes nothing', () => {
    store.reserve({
      id: 'a',
      toolkit: 'acmesearch',
      agentId: 'agent-kestrel',
      amountMicro: 300_000,
      source: 'person',
      enforceLimit: false,
    });
    expect(store.meter().estimated).toBe(true);
    expect(store.settle('a', 420_000)).toBe(true);
    expect(store.settle('a', 420_000)).toBe(false);
    expect(store.meter()).toMatchObject({ usedMicro: 420_000, estimated: false });
  });

  it('gives a released run back', () => {
    store.setLimit(DOLLAR);
    store.reserve({
      id: 'a',
      toolkit: 'acmesearch',
      agentId: 'agent-kestrel',
      amountMicro: 600_000,
      source: 'person',
      enforceLimit: true,
    });
    store.release('a');
    expect(store.meter().usedMicro).toBe(0);
  });

  it('starts each UTC month empty', () => {
    store.setLimit(DOLLAR);
    store.reserve({
      id: 'a',
      toolkit: 'acmesearch',
      agentId: 'agent-kestrel',
      amountMicro: 600_000,
      source: 'person',
      enforceLimit: true,
    });
    const december = new SpendingStore(db, () => new Date('2026-12-01T00:00:00.000Z'));
    expect(december.meter()).toMatchObject({ month: '2026-12', usedMicro: 0 });
  });

  it('says the meter is unreadable when the database cannot be read', () => {
    db.$client.exec('DROP TABLE spending_runs');
    expect(() => store.meter()).toThrow(SpendingMeterUnreadableError);
  });

  it('splits the month by app', () => {
    for (const [id, toolkit] of [
      ['a', 'acmesearch'],
      ['b', 'acmesearch'],
      ['c', 'northwind'],
    ] as const) {
      store.reserve({
        id,
        toolkit,
        agentId: 'agent-kestrel',
        amountMicro: 300_000,
        source: 'person',
        enforceLimit: false,
      });
    }
    expect(store.meter().byApp).toEqual([
      { toolkit: 'acmesearch', runs: 2, amountMicro: 600_000, estimated: true, unknownRuns: 0 },
      { toolkit: 'northwind', runs: 1, amountMicro: 300_000, estimated: true, unknownRuns: 0 },
    ]);
  });
});
