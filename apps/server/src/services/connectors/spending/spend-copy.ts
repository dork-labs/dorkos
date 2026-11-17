/**
 * Every sentence the spend limit says to an agent or a person (DOR-4204 PR 2,
 * spec 1.0 §5.1 and 1.1), in one place, so the copy-length check reads them
 * all and no amount is formatted two ways.
 *
 * @module services/connectors/spending/spend-copy
 */
import { SPEND_CURRENCY, spendLimitMoney, spendMoney } from '@dorkos/shared/connector-spending';

export { SPEND_CURRENCY };

/**
 * An amount in micro-units as money text, like `$0.30` or `$40.00` (spec §8):
 * rounded to the cent, both decimals always shown, and `<$0.01` under a cent.
 */
export const money: (micro: number) => string = spendMoney;

/**
 * A limit in micro-units as money text, like `$40.00`: rounded down to the cent
 * so it never reads higher than the limit enforced, with both decimals shown.
 */
export const limitMoney: (micro: number) => string = spendLimitMoney;

/** The day the month resets, like `Dec 1`, in UTC as the meter counts it. */
export function resetDay(at: Date): string {
  return at.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** The tool-result codes an agent can narrow on. */
export const SPEND_LIMIT = 'SPEND_LIMIT';
export const SPEND_OUTSIDER = 'SPEND_OUTSIDER';
export const SPEND_APPROVAL_REQUIRED = 'SPEND_APPROVAL_REQUIRED';

/** What an agent reads, by case. */
export const SPEND_COPY = {
  reached: (resets: string) =>
    `This month's spending limit is reached. Paid actions stop until ${resets}.`,
  wouldPass: (left: string) => `This run would pass the monthly spending limit. ${left} is left.`,
  hint: 'Ask the person to raise the limit in Connections, or wait.',
  outsider: 'Paid actions are off for this turn. It read outside content.',
  needsYes: 'This paid action needs a person to allow it first.',
  unreadable: "Spending can't be checked right now, so this paid action needs a yes.",
  limitReceipt: 'The monthly limit was reached. Nothing was spent.',
} as const;

/**
 * What a mini app reads when its paid read is refused (DOR-4575). A mini app
 * can't answer a card, so each case that would ask a person is a refusal.
 */
export const EXTENSION_SPEND_COPY = {
  noLimit:
    'This read spends money. Mini apps run paid reads only under a monthly limit, set in Connections.',
  unknownPrice:
    "This read spends money, and its app has no price per run, so the limit can't count it.",
  unreadable: "Spending can't be checked right now, so this paid read didn't run.",
} as const;

/** The full refusal an agent gets past the limit: the case, then what to do. */
export function limitRefusal(
  reason: 'reached' | 'would-pass',
  leftMicro: number,
  resetsAt: Date
): string {
  const head =
    reason === 'reached'
      ? SPEND_COPY.reached(resetDay(resetsAt))
      : SPEND_COPY.wouldPass(money(leftMicro));
  return `${head} ${SPEND_COPY.hint}`;
}
