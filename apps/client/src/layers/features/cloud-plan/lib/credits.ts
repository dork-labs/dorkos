/**
 * The cloud-plan panel's side of `@dork-labs/cloud-api/display`.
 *
 * Every figure the panel shows goes through the contract's shared formatter,
 * with the `denomination` the response that carried it served. Nothing here
 * knows what a credit is worth or which currency it is in: a response that
 * names no unit renders the panel's "couldn't read" line, never a guessed
 * number.
 *
 * @module features/cloud-plan/lib/credits
 */
import { formatPosition, type DenominationInput } from '@dork-labs/cloud-api/display';

/**
 * Whether a response named a unit its amounts can be rendered in.
 *
 * Asked of the formatter itself, with a zero amount, so this check can never
 * accept a denomination the formatter would then refuse.
 *
 * @param denomination - The response's `denomination`, as it came off the wire.
 */
export function isReadableDenomination(denomination: DenominationInput): boolean {
  return formatPosition('0', denomination) !== null;
}

/**
 * Puts the unit after a credit figure the formatter produced: `1 credit`,
 * `<1 credit`, `61 credits`.
 *
 * @param figure - A position or charge from the formatter, or `null`.
 * @returns The labelled figure, or `null` when there was no figure.
 */
export function withCreditUnit(figure: string | null): string | null {
  if (figure === null) return null;
  const singular = figure === '1' || figure === '-1' || figure === '<1' || figure === '-<1';
  return `${figure} ${singular ? 'credit' : 'credits'}`;
}
