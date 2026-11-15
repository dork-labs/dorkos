/**
 * The monthly spend meter (DOR-4204 PR 2): one limit per DorkOS, a person's
 * price per app, and the paid runs of each UTC month.
 *
 * Money is integer micro-units of the currency everywhere here, never a float.
 * A run's price is reserved before it runs and counts as used at once (spec
 * 1.1); a reported cost replaces it after, and a run that never started gives
 * it back. Every write is synchronous, so a reserve's read of the month and
 * its write of the run happen in one SQLite transaction with nothing between
 * them: two runs side by side cannot both fit the last of the limit (Security
 * Must 3).
 *
 * @module services/connectors/spending/spending-store
 */
import {
  and,
  eq,
  inArray,
  spendingPrices,
  spendingRuns,
  spendingSettings,
  type Db,
} from '@dorkos/db';

/** One micro-unit is a millionth of the currency's major unit. */
export const MICRO_PER_DOLLAR = 1_000_000;

/** The largest monthly limit a person may set: $10,000 (Security Q5). */
export const SPENDING_LIMIT_MAX_MICRO = 10_000 * MICRO_PER_DOLLAR;

/** The smallest limit or price: one cent. */
export const SPENDING_MIN_MICRO = 10_000;

/** Where a run's amount came from. */
export type SpendSource = 'person' | 'reported' | 'unknown';

/** One app's share of the month. */
export interface SpendingAppShare {
  toolkit: string;
  runs: number;
  amountMicro: number;
  /** Whether any of its runs counted at a person's price. */
  estimated: boolean;
  /** Runs counted with no price at all. */
  unknownRuns: number;
}

/** What one UTC month has spent so far. */
export interface SpendingMeter {
  /** `YYYY-MM`. */
  month: string;
  /** Reserved and settled runs together (spec 1.1: a reserve counts as used). */
  usedMicro: number;
  /** Whether any run counted at an estimate rather than a reported cost. */
  estimated: boolean;
  /** Runs counted with no price. */
  unknownRuns: number;
  /** Per app, largest first. */
  byApp: SpendingAppShare[];
}

/** One run to reserve. */
export interface SpendReservation {
  /** The broker's logical operation id. */
  id: string;
  toolkit: string;
  agentId: string;
  /** Its price, or null when unknown (counted as 0). */
  amountMicro: number | null;
  source: SpendSource;
  /** Refuse it when it would pass the limit; off only when no limit is set. */
  enforceLimit: boolean;
}

/** What a reserve answers. */
export type ReserveResult =
  { ok: true } | { ok: false; reason: 'reached' | 'would-pass'; leftMicro: number };

/** The month's runs could not be read; the meter fails closed (Security Q8). */
export class SpendingMeterUnreadableError extends Error {
  constructor(cause: unknown) {
    super('The monthly spending meter could not be read.', { cause });
    this.name = 'SpendingMeterUnreadableError';
  }
}

/** The UTC calendar month of an instant, `YYYY-MM`. */
export function monthOf(at: Date): string {
  return at.toISOString().slice(0, 7);
}

/** The first instant of the UTC month after `at`. */
export function nextMonthStart(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
}

/** See the module doc. */
export class SpendingStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date()
  ) {}

  /** The monthly limit in micro-units, or null for "Ask every time". */
  limit(): number | null {
    return (
      this.db.select().from(spendingSettings).where(eq(spendingSettings.id, 1)).get()?.limitMicro ??
      null
    );
  }

  /**
   * Set or clear the monthly limit. The routes decide whether a change waits
   * for "Confirm it's you"; this only writes.
   *
   * @param limitMicro - The new limit, or null to ask every time.
   */
  setLimit(limitMicro: number | null): void {
    const updatedAt = this.now().toISOString();
    this.db
      .insert(spendingSettings)
      .values({ id: 1, limitMicro, updatedAt })
      .onConflictDoUpdate({ target: spendingSettings.id, set: { limitMicro, updatedAt } })
      .run();
  }

  /** A person's price per run for an app, or null when unknown. */
  price(toolkit: string): number | null {
    return (
      this.db
        .select()
        .from(spendingPrices)
        .where(eq(spendingPrices.toolkit, toolkit.toLowerCase()))
        .get()?.priceMicro ?? null
    );
  }

  /** Every price a person set, by toolkit. */
  prices(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const row of this.db.select().from(spendingPrices).all())
      out[row.toolkit] = row.priceMicro;
    return out;
  }

  /**
   * Set or clear an app's price per run.
   *
   * @param toolkit - The provider toolkit id.
   * @param priceMicro - The price of one run, or null when unknown.
   */
  setPrice(toolkit: string, priceMicro: number | null): void {
    const id = toolkit.toLowerCase();
    if (priceMicro === null) {
      this.db.delete(spendingPrices).where(eq(spendingPrices.toolkit, id)).run();
      return;
    }
    const updatedAt = this.now().toISOString();
    this.db
      .insert(spendingPrices)
      .values({ toolkit: id, priceMicro, updatedAt })
      .onConflictDoUpdate({ target: spendingPrices.toolkit, set: { priceMicro, updatedAt } })
      .run();
  }

  /**
   * What this month has spent.
   *
   * @throws {SpendingMeterUnreadableError} When the runs cannot be read.
   */
  meter(): SpendingMeter {
    const month = monthOf(this.now());
    let rows: { toolkit: string; amountMicro: number; source: SpendSource }[];
    try {
      rows = this.db
        .select({
          toolkit: spendingRuns.toolkit,
          amountMicro: spendingRuns.amountMicro,
          source: spendingRuns.source,
        })
        .from(spendingRuns)
        .where(
          and(eq(spendingRuns.month, month), inArray(spendingRuns.state, ['reserved', 'settled']))
        )
        .all();
    } catch (error) {
      throw new SpendingMeterUnreadableError(error);
    }
    const apps = new Map<string, SpendingAppShare>();
    let usedMicro = 0;
    for (const row of rows) {
      usedMicro += row.amountMicro;
      const share = apps.get(row.toolkit) ?? {
        toolkit: row.toolkit,
        runs: 0,
        amountMicro: 0,
        estimated: false,
        unknownRuns: 0,
      };
      share.runs += 1;
      share.amountMicro += row.amountMicro;
      if (row.source === 'person') share.estimated = true;
      if (row.source === 'unknown') share.unknownRuns += 1;
      apps.set(row.toolkit, share);
    }
    const byApp = [...apps.values()].sort(
      (a, b) => b.amountMicro - a.amountMicro || a.toolkit.localeCompare(b.toolkit)
    );
    return {
      month,
      usedMicro,
      estimated: byApp.some((share) => share.estimated),
      unknownRuns: byApp.reduce((sum, share) => sum + share.unknownRuns, 0),
      byApp,
    };
  }

  /**
   * Reserve one run against this month, or refuse it, in one transaction.
   * A run already reserved under the same id is not counted twice.
   *
   * @param run - The run and what it counts as.
   * @throws {SpendingMeterUnreadableError} When the month cannot be read.
   */
  reserve(run: SpendReservation): ReserveResult {
    const at = this.now();
    return this.db.transaction((tx) => {
      const existing = tx.select().from(spendingRuns).where(eq(spendingRuns.id, run.id)).get();
      if (existing) return { ok: true } as const;
      const limitMicro = run.enforceLimit
        ? (tx.select().from(spendingSettings).where(eq(spendingSettings.id, 1)).get()?.limitMicro ??
          null)
        : null;
      if (limitMicro !== null) {
        const usedMicro = this.usedIn(tx, monthOf(at));
        const leftMicro = Math.max(0, limitMicro - usedMicro);
        if (usedMicro >= limitMicro) return { ok: false, reason: 'reached', leftMicro } as const;
        if (usedMicro + (run.amountMicro ?? 0) > limitMicro) {
          return { ok: false, reason: 'would-pass', leftMicro } as const;
        }
      }
      tx.insert(spendingRuns)
        .values({
          id: run.id,
          month: monthOf(at),
          toolkit: run.toolkit.toLowerCase(),
          agentId: run.agentId,
          amountMicro: run.amountMicro ?? 0,
          source: run.amountMicro === null ? 'unknown' : run.source,
          state: 'reserved',
          createdAt: at.toISOString(),
        })
        .run();
      return { ok: true } as const;
    });
  }

  /**
   * Settle a reserved run at the cost its provider reported. Idempotent: a
   * second report for the same run changes nothing.
   *
   * @param id - The run.
   * @param reportedMicro - What the provider says it cost.
   * @returns Whether this call changed the run.
   */
  settle(id: string, reportedMicro: number): boolean {
    const changed = this.db
      .update(spendingRuns)
      .set({
        amountMicro: Math.max(0, Math.round(reportedMicro)),
        source: 'reported',
        state: 'settled',
      })
      .where(and(eq(spendingRuns.id, id), eq(spendingRuns.state, 'reserved')))
      .run();
    return changed.changes > 0;
  }

  /**
   * Give a reserved run back: it never reached the provider.
   *
   * @param id - The run.
   */
  release(id: string): void {
    this.db
      .update(spendingRuns)
      .set({ state: 'released' })
      .where(and(eq(spendingRuns.id, id), eq(spendingRuns.state, 'reserved')))
      .run();
  }

  /** The month's reserved and settled total, read inside a transaction. */
  private usedIn(tx: Pick<Db, 'select'>, month: string): number {
    return tx
      .select({ amountMicro: spendingRuns.amountMicro })
      .from(spendingRuns)
      .where(
        and(eq(spendingRuns.month, month), inArray(spendingRuns.state, ['reserved', 'settled']))
      )
      .all()
      .reduce((sum, row) => sum + row.amountMicro, 0);
  }
}
