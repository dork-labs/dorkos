/**
 * The one denomination every fixture and test in this package may use.
 *
 * The real credit scale and currency are served by the service and are not
 * published here. Fixtures use the ISO 4217 test code and a placeholder scale,
 * and `amount-kinds.test.ts` fails if any fixture carries another, so no real
 * value can enter the corpus by accident.
 */

/** ISO 4217 reserves this code for testing; it is nobody's money. */
export const PLACEHOLDER_CURRENCY = 'XTS';

/** A scale chosen to be nobody's real one. */
export const PLACEHOLDER_MICRO_PER_CREDIT = '250';

/** The placeholder denomination, in the wire shape. */
export const PLACEHOLDER_DENOMINATION = {
  currency: PLACEHOLDER_CURRENCY,
  microPerCredit: PLACEHOLDER_MICRO_PER_CREDIT,
} as const;
