/**
 * The money-word matcher behind the money pin test (DOR-4624). The test and
 * `scripts/composio-money-word-candidates.mjs`, which refreshes its fixture,
 * both import it, so the rows the script writes and the rows the test
 * re-checks can never be picked by two different rules.
 *
 * It is the "tight" matcher: words that name money going out, read from the
 * action's name with the app prefix taken off, plus a few description
 * phrases that only make sense when money moves. Words that are mostly noise
 * on their own ("order", "credit") count only beside a spend verb.
 *
 * @module connector-providers/composio/__tests__/helpers/money-words
 */
import { normalizeSlug } from '../../slug.js';

/** A whole-word, case-blind pattern from `|`-separated alternatives. */
const words = (alternatives: string): RegExp => new RegExp(`\\b(?:${alternatives})\\b`, 'i');

/** Words in an action's name that say money goes out, on their own. */
const MONEY_NAME_WORDS = [
  words('pay|pays|payment|payments|payroll|payrolls'),
  words('charge|charges|chargeback|recharge'),
  words('refund|refunds'),
  words(
    'payout|payouts|disburse|disbursement|disbursements|withdraw|withdrawal|withdrawals|reimburse|reimbursement|reimbursements'
  ),
  words('transfer|transfers|wire|wires'),
  words('trade|trades|swap'),
  words('debit|debits'),
  words('top up|topup|redeem|cheque|cheques'),
];

/**
 * Words that are mostly noise alone (a sort order, a film's credits) and
 * count only beside a spend verb. "card" is left out: even
 * beside a spend verb it matched only Trello and Kanbanize board cards
 * (`TRELLO_ADD_CARDS`) in the 2026-11-18 catalog.
 */
const SPEND_ONLY_NAME_WORDS = words('order|orders|credit|credits');
const SPEND_VERB =
  /\b(?:PLACE|SUBMIT|BUY|SELL|PURCHASE|ISSUE|ADD|GRANT|ADJUST|FUND|EXECUTE|CAPTURE|FINALIZE|CONFIRM)\b/;

/** Description phrases that only make sense when money moves. */
const MONEY_DESCRIPTION = new RegExp(
  [
    '\\bchargeable\\b',
    '\\bspends? (?:real )?money\\b',
    '\\bpaid ?\\/ ?metered\\b',
    '\\b(?:charges?|bills?|debits?) (?:a |the |your |their )?(?:customer|card|payment method|balance)',
    '\\b(?:transfers?|sends?|moves?) (?:funds|money)',
    '\\b(?:places?|submits?|executes?) (?:a |an )?(?:buy |sell |market |limit )?(?:order|trade)s?\\b(?! (?:form|line|note))',
    '\\bcapture[sd]? (?:a |the )?(?:payment|charge)',
    '\\b(?:initiates?|makes?|sends?) (?:a |an )?(?:new )?(?:payment|payout|wire|ach)\\b',
    '\\b(?:purchases?|buys?)\\b(?![ -](?:orders?|prices?|dates?|values?|amounts?|history|requisitions?))',
  ].join('|'),
  'i'
);

/**
 * An action's name as space-separated words, without its app prefix however
 * the prefix's words split (`GIFT_UP_…` and `GIFTUP_…` for `gift_up`).
 *
 * @param toolkit - Composio's app slug.
 * @param slug - Composio's action slug.
 */
export function actionWords(toolkit: string, slug: string): string {
  const app = toolkit.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const parts = normalizeSlug(slug).split('_');
  for (let end = 1; end < parts.length; end += 1) {
    if (parts.slice(0, end).join('') === app) return parts.slice(end).join(' ');
  }
  return parts.join(' ');
}

/**
 * The words of a description that say money moves, or `''` when none do. The
 * snapshot keeps only these words, never the whole description: vendor
 * descriptions quote prices, and the public repo's boundary gate (BND-301)
 * rightly refuses a money amount beside a plan-shaped word.
 *
 * @param description - Composio's description of the action.
 */
export function moneyDescriptionPhrase(description: string): string {
  return MONEY_DESCRIPTION.exec(description)?.[0] ?? '';
}

/**
 * Whether an action's name or description says it may move money, by the
 * tight matcher. A match is a candidate for review, not a verdict.
 *
 * @param slug - Composio's action slug.
 * @param description - Composio's description of the action.
 * @param toolkit - Composio's app slug.
 */
export function matchesMoneyWords(slug: string, description: string, toolkit: string): boolean {
  const name = actionWords(toolkit, slug);
  return (
    MONEY_NAME_WORDS.some((pattern) => pattern.test(name)) ||
    (SPEND_ONLY_NAME_WORDS.test(name) && SPEND_VERB.test(name.toUpperCase())) ||
    MONEY_DESCRIPTION.test(description)
  );
}
