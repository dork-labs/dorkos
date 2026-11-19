/**
 * Every sentence the spend limit says to an agent or a person (DOR-4204 PR 2,
 * spec 1.0 §5.1 and 1.1), in one place, so the copy-length check reads them
 * all and no amount is formatted two ways.
 *
 * @module services/connectors/spending/spend-copy
 */
import { SPEND_CURRENCY, spendLimitMoney, spendMoney } from '@dorkos/shared/connector-spending';
import type { SpendAskReason } from '../../core/capabilities/spend-permission.js';

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
  noLimit: 'This read spends money. It runs only under a monthly limit, set in Connections.',
  unknownPrice: 'This read spends money. Set its price per run in Connections first.',
  unreadable: "Spending can't be checked right now, so this paid read didn't run.",
  outsideLimit: "This paid read doesn't fit this month's spending limit. Nothing ran.",
} as const;

/**
 * Why a paid run that asks is waiting, and what the person can change so the
 * next one does not (DOR-4447). The labels match the Connections page: its
 * Monthly limit and each app's Price per run. A run past the limit never asks;
 * it is refused with {@link limitRefusal} instead.
 */
const SPEND_ASK: Record<SpendAskReason, { why: string; fix?: string }> = {
  'no-limit': {
    why: 'No monthly spending limit is set, so each paid action needs a yes.',
    fix:
      "They can set a monthly limit and this app's price per run in Connections, " +
      'so paid actions inside the limit stop asking about cost.',
  },
  'unknown-price': {
    why: "This app has no price per run set, so the monthly limit can't count it.",
    fix: "They can set this app's price per run in Connections, so it counts against the limit instead of asking.",
  },
  'meter-unreadable': { why: "This month's spending can't be read right now." },
};

/**
 * What an agent reads when its paid action is waiting on a person: that it
 * costs money, why that needs a yes, and, when spending is the only reason,
 * what the person can do about it.
 *
 * @param title - The action's title.
 * @param reason - Why the paid run asks.
 * @param alsoBecause - The other reason the card would be raised anyway, like
 *   `is high risk`. With one, the fix is left out: a limit would not stop it.
 */
export function spendAskMessage(
  title: string,
  reason: SpendAskReason,
  alsoBecause?: string
): string {
  const { why, fix } = SPEND_ASK[reason];
  const subject = alsoBecause
    ? `"${title}" ${alsoBecause} and costs money.`
    : `"${title}" costs money.`;
  const head = `${subject} ${why} DorkOS has asked the person to allow it.`;
  return fix && !alsoBecause ? `${head} ${fix}` : head;
}

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
