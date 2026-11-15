/**
 * The monthly spend limit's wire contract (DOR-4204 PR 2), under
 * `/api/connectors/spending`: what the Spending block reads, and what a person
 * sends to set the limit or an app's price per run. Amounts are micro-unit
 * integer strings, never floats, so the client never does arithmetic on money.
 *
 * @module shared/connector-spending
 */
import { z } from 'zod';
import { formatMoneyRate } from '@dork-labs/cloud-api/display';

/** A micro-unit amount: one millionth of the currency's unit, as an integer string. */
export const SpendingMicroSchema = z.string().regex(/^\d+$/);

/** One app's line in "Where it went". */
export const SpendingAppLineSchema = z.object({
  toolkit: z.string(),
  runs: z.number().int(),
  amountMicro: SpendingMicroSchema,
  /** Whether any run was counted at a person's price rather than a reported cost. */
  estimated: z.boolean(),
  /** Runs with no price at all. */
  unknownRuns: z.number().int(),
});

/** What the Spending block reads. */
export const SpendingSummarySchema = z.object({
  currency: z.string(),
  /** The monthly limit, or null: every paid action asks. */
  limitMicro: SpendingMicroSchema.nullable(),
  /** The largest limit the server accepts. */
  maxMicro: SpendingMicroSchema,
  /** When this month's meter resets, ISO. */
  resetsAt: z.string(),
  /** A person's price per run, by app. */
  prices: z.record(z.string(), SpendingMicroSchema),
  /** False when this month's meter can't be read; the fields below are then absent. */
  meterReadable: z.boolean(),
  month: z.string().optional(),
  usedMicro: SpendingMicroSchema.optional(),
  leftMicro: SpendingMicroSchema.nullable().optional(),
  overMicro: SpendingMicroSchema.nullable().optional(),
  approximate: z.boolean().optional(),
  byApp: z.array(SpendingAppLineSchema).optional(),
});

/** What the Spending block reads. */
export type SpendingSummary = z.infer<typeof SpendingSummarySchema>;

/** One app's line in "Where it went". */
export type SpendingAppLine = z.infer<typeof SpendingAppLineSchema>;

/** An amount a person sends: up to 16 digits of micro-units, or null to clear it. */
const SpendingAmountSchema = z
  .string()
  .regex(/^\d{1,16}$/)
  .nullable();

/** The body that sets, lowers or clears the monthly limit. */
export const SetSpendingLimitBodySchema = z.object({ limit: SpendingAmountSchema }).strict();

/** The body that sets or clears an app's price per run. */
export const SetSpendingPriceBodySchema = z.object({ price: SpendingAmountSchema }).strict();

/** The only currency in 1.0; the formatter, not the copy, changes for another. */
export const SPEND_CURRENCY = 'USD';

/** Micro-units in one cent. */
const MICRO_PER_CENT = 10_000;

/**
 * An amount in micro-units as money text, like `$0.30` or `$40.00` (spec §8):
 * rounded to the cent, both decimals always shown, and `<$0.01` under a cent.
 * The one formatter the server and the app both use, so no amount reads two ways.
 *
 * @param micro - The amount, as a number or a micro-unit string.
 */
export function spendMoney(micro: number | string): string {
  const whole = Math.max(0, Math.round(Number(micro) || 0));
  if (whole > 0 && whole < MICRO_PER_CENT / 2) return '<$0.01';
  const cents = Math.round(whole / MICRO_PER_CENT) * MICRO_PER_CENT;
  return formatMoneyRate(String(cents), { currency: SPEND_CURRENCY }) ?? '$0.00';
}

/**
 * A limit in micro-units as money text, like `$40.00`: rounded down to the cent
 * so it never reads higher than the limit enforced.
 *
 * @param micro - The limit, as a number or a micro-unit string.
 */
export function spendLimitMoney(micro: number | string): string {
  const whole = Math.max(0, Number(micro) || 0);
  return spendMoney(Math.floor(whole / MICRO_PER_CENT) * MICRO_PER_CENT);
}
