/**
 * Rendering the contract's micro-unit amounts.
 *
 * Every amount on the `/v1` wire is a DECIMAL STRING of millionths, and it stays
 * a string the whole way here for one reason: `Number('48000000')` is fine today
 * and quietly wrong the first time somebody's balance needs more precision than
 * a double has. These helpers divide with `BigInt` and never construct a
 * `Number` from a wire amount.
 *
 * **No currency symbol is printed anywhere.** The contract carries no currency
 * code — deliberately, since publishing one would say something about the
 * catalog — so the app renders the figure and labels what it is, and never
 * decorates it with a unit nobody sent.
 *
 * @module features/cloud-plan/lib/micro
 */

/** One whole unit, in millionths. */
const MICRO = 1_000_000n;

/**
 * Format a micro-unit amount for display, to two decimal places.
 *
 * Returns `null` for anything that is not a micro-unit integer string, so a
 * caller renders nothing rather than `NaN` if the wire ever surprises it.
 *
 * @param micro - The amount, as the contract's decimal string of millionths.
 */
export function formatMicro(micro: string | null | undefined): string | null {
  if (typeof micro !== 'string' || !/^-?\d+$/.test(micro)) return null;
  const value = BigInt(micro);
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / MICRO;
  // Round the remainder to hundredths rather than truncating, so a figure never
  // reads lower than it is.
  const hundredths = (absolute % MICRO) / 10_000n;
  const remainder = (absolute % MICRO) % 10_000n >= 5_000n ? hundredths + 1n : hundredths;
  const carried = remainder === 100n;
  const shown = carried ? 0n : remainder;
  const wholeShown = carried ? whole + 1n : whole;
  // `en-US` explicitly, not the ambient locale. A bare `toLocaleString()` picks
  // the viewer's grouping separator while the decimal point below stays a `.`,
  // so in de-DE a balance renders `9.007.199.254.740.993.00` — unreadable, and
  // actively misleading about where the decimal point is. Formatting both halves
  // in one locale is the fix; doing it in the VIEWER's locale needs the two
  // halves formatted together and is a listed follow-up.
  const grouped = wholeShown.toLocaleString('en-US');
  return `${negative ? '-' : ''}${grouped}.${shown.toString().padStart(2, '0')}`;
}

/**
 * The fraction of `granted` that `remaining` leaves, clamped to 0..1.
 *
 * Returns `null` when nothing was granted — a gauge with no denominator is not
 * a gauge, and drawing it at zero would claim an allowance is spent when there
 * was never one to spend.
 *
 * @param remainingMicro - What is left, in millionths.
 * @param grantedMicro - What was granted, in millionths.
 */
export function remainingFraction(remainingMicro: string, grantedMicro: string): number | null {
  if (!/^\d+$/.test(remainingMicro) || !/^\d+$/.test(grantedMicro)) return null;
  const granted = BigInt(grantedMicro);
  if (granted === 0n) return null;
  const remaining = BigInt(remainingMicro);
  if (remaining >= granted) return 1;
  if (remaining <= 0n) return 0;
  // Scale to basis points before leaving BigInt, so the only float is a small
  // ratio of two bounded integers.
  return Number((remaining * 10_000n) / granted) / 10_000;
}
