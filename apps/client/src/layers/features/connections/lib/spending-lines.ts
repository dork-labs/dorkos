/**
 * What the Spending block and an app's price per run say (DOR-4204 spec 1.0
 * §2, §3, §5, §7, §8). Pure: amounts arrive as the server's micro-unit
 * strings, and "left" and "over by" are the server's numbers, never the
 * app's arithmetic.
 *
 * @module features/connections/lib/spending-lines
 */
import {
  spendLimitMoney,
  spendMoney,
  type SpendingAppLine,
  type SpendingSummary,
} from '@dorkos/shared/connector-spending';

/** Micro-units in one cent. */
const MICRO_PER_CENT = 10_000n;

/** A typed amount: the micro-units to save (null for empty), or the error to show. */
export type ParsedAmount = { ok: true; micro: string | null } | { ok: false; error: string };

/**
 * Read what a person typed in a `$` field (spec §2.3). It rounds to the cent,
 * must be at least $0.01, and at most the server's maximum. Empty means none.
 *
 * @param text - What the person typed.
 * @param maxMicro - The server's largest accepted amount.
 */
export function parseSpendAmount(text: string, maxMicro: string): ParsedAmount {
  const typed = text
    .trim()
    .replace(/^\$\s*/, '')
    .replace(/,/g, '');
  if (typed === '') return { ok: true, micro: null };
  const match = /^(\d*)(?:\.(\d*))?$/.exec(typed);
  if (!match || (match[1] === '' && !match[2])) {
    return { ok: false, error: 'Enter an amount, like 40.' };
  }
  const whole = BigInt(match[1] || '0');
  const fraction = (match[2] ?? '').padEnd(3, '0');
  // Round half up on the third decimal.
  const cents = whole * 100n + BigInt(fraction.slice(0, 2)) + (Number(fraction[2]) >= 5 ? 1n : 0n);
  if (cents < 1n) return { ok: false, error: 'Enter at least $0.01, or leave it empty.' };
  const micro = cents * MICRO_PER_CENT;
  if (micro > BigInt(maxMicro)) {
    return { ok: false, error: `Enter ${spendLimitMoney(maxMicro)} or less.` };
  }
  return { ok: true, micro: String(micro) };
}

/** A saved amount as the field shows it: `40.00`, or empty for none. */
export function fieldValueOf(micro: string | null | undefined): string {
  if (micro == null) return '';
  return spendMoney(micro).replace(/^\$/, '');
}

/**
 * The day the month resets, in the person's own calendar (spec §8): if the UTC
 * reset lands on the evening of Nov 30 locally, it says Nov 30.
 *
 * @param resetsAt - The reset instant, ISO.
 */
export function resetDayOf(resetsAt: string): string {
  return new Date(resetsAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** The status line, as its two halves: they sit on one line, or two on a phone. */
export interface SpendingStatus {
  first: string;
  second: string | null;
}

/** At this share of the limit the second half says what is left (spec §5). */
const NEAR_NUMERATOR = 4n;
const NEAR_DENOMINATOR = 5n;

/**
 * The status line under the field (spec §2.1, §5, §7).
 *
 * @param summary - What the server says about this month.
 */
export function spendingStatus(summary: SpendingSummary): SpendingStatus {
  if (!summary.meterReadable) {
    return {
      first: 'Couldn’t read this month’s spending.',
      second: 'Paid actions ask every time.',
    };
  }
  const used = summary.usedMicro ?? '0';
  const resets = `resets ${resetDayOf(summary.resetsAt)}`;
  const approximate = summary.approximate ? ', approximate' : '';
  if (summary.limitMicro === null) {
    if (BigInt(used) === 0n) return { first: 'Nothing spent this month.', second: null };
    return { first: `${spendMoney(used)} spent this month`, second: `${resets}${approximate}` };
  }
  const limit = summary.limitMicro;
  const of = `${spendMoney(used)} of ${spendLimitMoney(limit)} used`;
  const over = summary.overMicro ?? '0';
  if (BigInt(over) > 0n) return { first: of, second: `over by ${spendMoney(over)}${approximate}` };
  if (BigInt(used) >= BigInt(limit)) return { first: 'Limit reached', second: resets };
  if (BigInt(used) * NEAR_DENOMINATOR >= BigInt(limit) * NEAR_NUMERATOR) {
    return { first: of, second: `${spendMoney(summary.leftMicro ?? '0')} left${approximate}` };
  }
  return { first: of, second: `${resets}${approximate}` };
}

/** The bar's spoken value (spec §11): never a bare percent. */
export function barValueText(summary: SpendingSummary): string {
  return `${spendMoney(summary.usedMicro ?? '0')} of ${spendLimitMoney(summary.limitMicro ?? '0')} used`;
}

/** The bar's fill, 0 to 100, or null when no limit is set or the meter can't be read. */
export function barPercent(summary: SpendingSummary): number | null {
  if (summary.limitMicro === null || !summary.meterReadable) return null;
  const limit = BigInt(summary.limitMicro);
  if (limit === 0n) return 100;
  const used = BigInt(summary.usedMicro ?? '0');
  // A whole percent is all a bar can show; the line above it says the amount.
  return Math.min(100, Number((used * 100n) / limit));
}

/** One "Where it went" row. */
export interface WhereItWentRow {
  toolkit: string;
  label: string;
  amount: string;
}

/** How many "Where it went" rows show before "+N more" (spec §2.1). */
export const WHERE_IT_WENT_LIMIT = 5;

/**
 * "Where it went": one row per app, largest first (spec §2.1, §7.8).
 *
 * @param byApp - The server's per-app lines.
 * @param nameOf - An app's display name.
 */
export function whereItWent(
  byApp: readonly SpendingAppLine[],
  nameOf: (toolkit: string) => string
): { rows: WhereItWentRow[]; more: number } {
  const sorted = [...byApp].sort((a, b) => {
    const diff = BigInt(b.amountMicro) - BigInt(a.amountMicro);
    return diff > 0n ? 1 : diff < 0n ? -1 : b.runs - a.runs;
  });
  const rows = sorted.slice(0, WHERE_IT_WENT_LIMIT).map((line) => {
    const runs = `${line.runs} ${line.runs === 1 ? 'run' : 'runs'}`;
    const unpriced = BigInt(line.amountMicro) === 0n && line.unknownRuns > 0;
    return {
      toolkit: line.toolkit,
      label: `${nameOf(line.toolkit)} · ${runs}${unpriced ? ' · price unknown' : ''}`,
      amount: unpriced ? '—' : `${line.estimated ? 'about ' : ''}${spendMoney(line.amountMicro)}`,
    };
  });
  return { rows, more: Math.max(0, sorted.length - rows.length) };
}

/**
 * The help line under an app's price per run (spec §3).
 *
 * @param appName - The app's display name.
 * @param summary - What the server says, or undefined while it loads.
 * @param toolkit - The app's service id.
 */
export function priceHelpLine(
  appName: string,
  summary: SpendingSummary | undefined,
  toolkit: string
): string {
  if (summary && summary.limitMicro !== null && summary.prices[toolkit] === undefined) {
    return `Without a price, ${appName} runs ask you every time.`;
  }
  return `DorkOS can’t see what ${appName} charges. Set your best guess.`;
}
