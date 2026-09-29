/**
 * How full the credits gauge is drawn.
 *
 * A ratio of two amounts in the same unit, so it needs no credit scale and
 * prints no figure: the figures beside the gauge come from
 * `@dork-labs/cloud-api/display`, with the unit the service served.
 *
 * @module features/cloud-plan/lib/remaining-fraction
 */

/**
 * How finely the ratio is resolved before it leaves `BigInt`: 2^16 steps.
 * A drawing resolution, not a unit — both inputs are in the same unit, and it
 * cancels.
 */
const RATIO_STEPS = 1n << 16n;

/**
 * The fraction of `granted` that `remaining` leaves, clamped to 0..1.
 *
 * Returns `null` when nothing was granted — a gauge with no denominator is not
 * a gauge, and drawing it at zero would claim an allowance is spent when there
 * was never one to spend.
 *
 * @param remainingMicro - What is left, as the contract's integer string.
 * @param grantedMicro - What was granted, as the contract's integer string.
 */
export function remainingFraction(remainingMicro: string, grantedMicro: string): number | null {
  if (!/^\d+$/.test(remainingMicro) || !/^\d+$/.test(grantedMicro)) return null;
  const granted = BigInt(grantedMicro);
  if (granted === 0n) return null;
  const remaining = BigInt(remainingMicro);
  if (remaining >= granted) return 1;
  if (remaining <= 0n) return 0;
  // Scale before leaving BigInt, so the only float is a small ratio of two
  // bounded integers.
  return Number((remaining * RATIO_STEPS) / granted) / Number(RATIO_STEPS);
}
