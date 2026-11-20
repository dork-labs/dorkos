/**
 * The monthly spend limit on paid app actions (DOR-4204 PR 2): one limit per
 * DorkOS, a person's price per app, and one row per paid run.
 *
 * Kept in the database, not a file, because two runs side by side must not
 * both fit the last of the limit: a run's price is reserved in one
 * transaction that reads the month's total and writes the run.
 */
import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** The one limit. A single row, id 1; no row means no limit was ever set. */
export const spendingSettings = sqliteTable(
  'spending_settings',
  {
    /** Always 1. */
    id: integer('id').primaryKey(),
    /** The monthly limit in micro-units of the currency, or null for "Ask every time". */
    limitMicro: integer('limit_micro'),
    /** ISO time it last changed. */
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    check('spending_settings_singleton', sql`${table.id} = 1`),
    check(
      'spending_settings_limit_positive',
      sql`${table.limitMicro} IS NULL OR ${table.limitMicro} > 0`
    ),
  ]
);

/** A person's price per run for one app (toolkit). No row means the price is unknown. */
export const spendingPrices = sqliteTable(
  'spending_prices',
  {
    /** The provider's toolkit id, lower case. */
    toolkit: text('toolkit').primaryKey(),
    /** The price of one run in micro-units. */
    priceMicro: integer('price_micro').notNull(),
    /** ISO time it last changed. */
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [check('spending_prices_positive', sql`${table.priceMicro} > 0`)]
);

/** One paid run, counted against the month it ran in. */
export const spendingRuns = sqliteTable(
  'spending_runs',
  {
    /** The broker's logical operation id: one per run, whatever its retries. */
    id: text('id').primaryKey(),
    /** The UTC calendar month it counts against, `YYYY-MM`. */
    month: text('month').notNull(),
    /** The provider's toolkit id, lower case. */
    toolkit: text('toolkit').notNull(),
    /** The agent that ran it. */
    agentId: text('agent_id').notNull(),
    /** What it counts as, in micro-units; 0 while the price is unknown. */
    amountMicro: integer('amount_micro').notNull(),
    /** Where the amount came from. */
    source: text('source', { enum: ['person', 'reported', 'unknown'] }).notNull(),
    /** Reserved before the run, settled after, or released when nothing ran. */
    state: text('state', { enum: ['reserved', 'settled', 'released'] }).notNull(),
    /** ISO time it was reserved. */
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('spending_runs_month_idx').on(table.month),
    check('spending_runs_amount', sql`${table.amountMicro} >= 0`),
  ]
);

/** A stored `spending_runs` row. */
export type SpendingRunRow = typeof spendingRuns.$inferSelect;
