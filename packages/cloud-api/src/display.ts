/**
 * `@dork-labs/cloud-api/display` — one way to render a Cloud amount for a person.
 *
 * Every amount on the wire is an exact integer count of micro-units carried as
 * a string, and a response names its unit in `denomination`: the currency the
 * micro-units are millionths of, and how many micro-units one credit is. This
 * module turns an amount and that denomination into text, by the kind of
 * figure it is:
 *
 * - a **position** (what someone has or may still spend) rounds down to whole
 *   credits, so no page shows credit that cannot be spent;
 * - a **charge** (what someone spent, was charged or is held for) rounds half
 *   away from zero to whole credits, and a non-zero amount under half a credit
 *   reads as less than one credit;
 * - a **rate** (a price per unit of something) is never rounded;
 * - **money** rounds to the currency's minor unit, half away from zero, and a
 *   non-zero amount that rounds to zero reads as less than the smallest unit;
 * - a **cap** (a money limit) rounds down, so a limit never reads higher than
 *   the one enforced.
 *
 * Rules this module keeps, so two clients can never disagree:
 *
 * - **No scale lives here.** The credit scale comes from the served
 *    denomination on every call. A missing or malformed denomination, or a
 *    malformed amount, returns `null`: never a guess.
 * - **No amount becomes a JavaScript number.** Every digit is produced with
 *    `BigInt`. `Intl.NumberFormat` is asked only for a currency's symbol, where
 *    the symbol sits, and how many minor-unit digits the currency has. No
 *    amount is ever handed to `Intl`.
 * - **No dependencies**, not even the contract's own schemas, so a renderer
 *    can import this without Zod.
 *
 * Numbers are grouped the way `en-US` groups them. Localised formatting is a
 * separate, later change. The package README lists every rule with worked
 * examples.
 *
 * @packageDocumentation
 */

/** The part of a response's `denomination` a credit renderer needs. */
export interface DisplayDenomination {
  /** An ISO 4217 code: what the micro-units are millionths of. */
  currency: string;
  /** How many micro-units one credit is, as a positive integer string. */
  microPerCredit: string;
}

/** The part of a response's `denomination` a money renderer needs. */
export interface DisplayCurrency {
  /** An ISO 4217 code: what the micro-units are millionths of. */
  currency: string;
}

/**
 * An amount as it came off the wire. Anything but a base-10 integer string
 * renders as `null`.
 */
export type AmountInput = string | null | undefined;

/**
 * A response's `denomination` as it came off the wire. Absent or malformed
 * renders as `null`.
 */
export type DenominationInput = DisplayDenomination | null | undefined;

/** A currency as it came off the wire. Absent or malformed renders as `null`. */
export type CurrencyInput = DisplayCurrency | null | undefined;

/** How a credit figure is rounded: see the module overview. */
export type CreditKind = 'position' | 'charge' | 'rate';

/** How any figure is rounded: the three credit kinds, plus money and cap. */
export type AmountDisplayKind = CreditKind | 'money' | 'cap';

const INTEGER_STRING = /^-?(0|[1-9][0-9]*)$/;
const POSITIVE_INTEGER_STRING = /^[1-9][0-9]*$/;
const CURRENCY_CODE = /^[A-Z]{3}$/;

/** How many decimal digits a micro-unit is below the major unit. */
const MICRO_DIGITS = 6;
const MICRO_PER_MAJOR = BigInt(10) ** BigInt(MICRO_DIGITS);
const ZERO = BigInt(0);
const ONE = BigInt(1);
const TWO = BigInt(2);
const TEN = BigInt(10);

/**
 * Floor division: the quotient rounded toward negative infinity.
 *
 * @param dividend - Any integer.
 * @param divisor - A positive integer.
 */
export function floorDiv(dividend: bigint, divisor: bigint): bigint {
  const quotient = dividend / divisor;
  return dividend % divisor !== ZERO && dividend < ZERO ? quotient - ONE : quotient;
}

/**
 * The quotient rounded to the nearest integer, a tie going away from zero.
 *
 * @param dividend - Any integer.
 * @param divisor - A positive integer.
 */
export function roundHalfAwayFromZero(dividend: bigint, divisor: bigint): bigint {
  const magnitude = dividend < ZERO ? -dividend : dividend;
  let quotient = magnitude / divisor;
  if ((magnitude % divisor) * TWO >= divisor) quotient += ONE;
  return dividend < ZERO ? -quotient : quotient;
}

/**
 * Reads an amount string, or `null` when it is not a base-10 integer string.
 *
 * @param micro - The amount as it came off the wire.
 */
function parseAmount(micro: unknown): bigint | null {
  if (typeof micro !== 'string' || !INTEGER_STRING.test(micro)) return null;
  return BigInt(micro);
}

/**
 * Reads the served credit scale, or `null` when the denomination is missing or
 * malformed.
 *
 * @param denomination - The response's `denomination`.
 */
function parseScale(denomination: unknown): bigint | null {
  if (typeof denomination !== 'object' || denomination === null) return null;
  const { microPerCredit } = denomination as { microPerCredit?: unknown };
  if (typeof microPerCredit !== 'string' || !POSITIVE_INTEGER_STRING.test(microPerCredit)) {
    return null;
  }
  if (currencyOf(denomination) === null) return null;
  return BigInt(microPerCredit);
}

/** How a currency is written: its affixes and its minor-unit digits. */
interface CurrencyShape {
  prefix: string;
  suffix: string;
  minorDigits: number;
}

const currencyShapes = new Map<string, CurrencyShape | null>();

/**
 * Learns how a currency is written in `en-US`, without formatting any amount.
 *
 * `formatToParts(0)` gives the symbol and which side of the digits it sits on;
 * `resolvedOptions()` gives the minor-unit digits. Cached per code.
 *
 * @param currency - An ISO 4217 code.
 */
function shapeOf(currency: string): CurrencyShape | null {
  const cached = currencyShapes.get(currency);
  if (cached !== undefined) return cached;
  let shape: CurrencyShape | null = null;
  try {
    const format = new Intl.NumberFormat('en-US', { style: 'currency', currency });
    const parts = format.formatToParts(0);
    const numeric = new Set(['integer', 'group', 'decimal', 'fraction']);
    const first = parts.findIndex((part) => numeric.has(part.type));
    let last = -1;
    parts.forEach((part, index) => {
      if (numeric.has(part.type)) last = index;
    });
    const minorDigits = format.resolvedOptions().maximumFractionDigits ?? 0;
    if (first >= 0 && minorDigits >= 0 && minorDigits <= MICRO_DIGITS) {
      const text = (slice: Intl.NumberFormatPart[]) =>
        slice
          .filter((part) => part.type !== 'minusSign' && part.type !== 'plusSign')
          .map((part) => part.value)
          .join('');
      shape = {
        prefix: text(parts.slice(0, first)),
        suffix: text(parts.slice(last + 1)),
        minorDigits,
      };
    }
  } catch {
    shape = null;
  }
  currencyShapes.set(currency, shape);
  return shape;
}

/**
 * Reads the currency of a denomination, or `null` when it is missing, not
 * three capital letters, or refused by this runtime's `Intl`. A well-formed
 * code `Intl` does not know is still written, with the code as its symbol.
 *
 * @param denomination - A response's `denomination`, or just `{ currency }`.
 */
function currencyOf(denomination: unknown): CurrencyShape | null {
  if (typeof denomination !== 'object' || denomination === null) return null;
  const { currency } = denomination as { currency?: unknown };
  if (typeof currency !== 'string' || !CURRENCY_CODE.test(currency)) return null;
  return shapeOf(currency);
}

/**
 * Groups the digits of a non-negative integer the way `en-US` does.
 *
 * @param value - A non-negative integer.
 */
function group(value: bigint): string {
  const digits = value.toString();
  let out = '';
  for (let index = 0; index < digits.length; index += 1) {
    if (index > 0 && (digits.length - index) % 3 === 0) out += ',';
    out += digits[index];
  }
  return out;
}

/**
 * Writes `numerator / 10^scaleDigits` exactly, grouped, with at least
 * `minFraction` decimals and no trailing zero beyond them.
 *
 * @param numerator - A non-negative integer.
 * @param scaleDigits - How many decimal places the numerator is scaled by.
 * @param minFraction - The fewest decimals to show.
 */
function decimal(numerator: bigint, scaleDigits: number, minFraction: number): string {
  const unit = TEN ** BigInt(scaleDigits);
  const whole = numerator / unit;
  let fraction = scaleDigits > 0 ? (numerator % unit).toString().padStart(scaleDigits, '0') : '';
  while (fraction.length > minFraction && fraction.endsWith('0')) fraction = fraction.slice(0, -1);
  return fraction.length > 0 ? `${group(whole)}.${fraction}` : group(whole);
}

/**
 * Writes an integer credit count with its sign, never as a negative zero.
 *
 * @param value - Whole credits.
 */
function signedCredits(value: bigint): string {
  return value < ZERO ? `-${group(-value)}` : group(value);
}

/**
 * Writes a count of minor units as money.
 *
 * @param minor - The amount in the currency's minor units.
 * @param shape - How the currency is written.
 * @param whole - Whether to drop the minor digits (the exact amount is whole).
 */
function writeMoney(minor: bigint, shape: CurrencyShape, whole: boolean): string {
  const magnitude = minor < ZERO ? -minor : minor;
  const digits = whole
    ? group(magnitude / TEN ** BigInt(shape.minorDigits))
    : decimal(magnitude, shape.minorDigits, shape.minorDigits);
  const sign = minor < ZERO ? '-' : '';
  return `${sign}${shape.prefix}${digits}${shape.suffix}`;
}

/**
 * The shared money rule, with the rounding as a parameter.
 *
 * @param micro - The amount string.
 * @param currency - The response's `denomination`, or just `{ currency }`.
 * @param round - How to turn micro-units into minor units.
 */
function money(
  micro: unknown,
  currency: unknown,
  round: (dividend: bigint, divisor: bigint) => bigint
): string | null {
  const amount = parseAmount(micro);
  const shape = currencyOf(currency);
  if (amount === null || shape === null) return null;
  const microPerMinor = TEN ** BigInt(MICRO_DIGITS - shape.minorDigits);
  const minor = round(amount, microPerMinor);
  if (minor === ZERO && amount !== ZERO) {
    const smallest = writeMoney(ONE, shape, shape.minorDigits === 0);
    return amount < ZERO ? `-<${smallest}` : `<${smallest}`;
  }
  // Whole means the EXACT amount is a whole major unit, so a rounded figure
  // keeps its minor digits and never reads as more exact than it is.
  return writeMoney(minor, shape, amount % MICRO_PER_MAJOR === ZERO);
}

/**
 * Renders what a person has or may still spend: whole credits, rounded toward
 * negative infinity, so it never shows credit that cannot be spent.
 *
 * @param micro - The amount string, in micro-units.
 * @param denomination - The response's `denomination`.
 * @returns The grouped credit count, or `null` for a malformed amount or denomination.
 */
export function formatPosition(micro: AmountInput, denomination: DenominationInput): string | null {
  const amount = parseAmount(micro);
  const scale = parseScale(denomination);
  if (amount === null || scale === null) return null;
  return signedCredits(floorDiv(amount, scale));
}

/**
 * Renders what a person spent, was charged or is held for: whole credits,
 * rounded half away from zero. Zero reads as zero; a non-zero amount that rounds
 * to zero reads as less than one credit, with a minus sign when negative.
 *
 * @param micro - The amount string, in micro-units.
 * @param denomination - The response's `denomination`.
 * @returns The grouped credit count, or `null` for a malformed amount or denomination.
 */
export function formatCharge(micro: AmountInput, denomination: DenominationInput): string | null {
  const amount = parseAmount(micro);
  const scale = parseScale(denomination);
  if (amount === null || scale === null) return null;
  if (amount === ZERO) return '0';
  const credits = roundHalfAwayFromZero(amount, scale);
  if (credits === ZERO) return amount < ZERO ? '-<1' : '<1';
  return signedCredits(credits);
}

/**
 * Renders a price per unit of something in credits, never rounded: every
 * significant digit, trailing zeros trimmed.
 *
 * A scale with a prime factor other than two or five cannot write every
 * amount as a finite decimal. Such an amount returns `null` rather than a
 * rounded figure.
 *
 * @param micro - The amount string, in micro-units.
 * @param denomination - The response's `denomination`.
 * @returns The exact credit figure, or `null` when it cannot be written exactly or the input is malformed.
 */
export function formatRate(micro: AmountInput, denomination: DenominationInput): string | null {
  const amount = parseAmount(micro);
  const scale = parseScale(denomination);
  if (amount === null || scale === null) return null;
  // amount / scale is a finite decimal exactly when, after cancelling, the
  // denominator has only twos and fives. Find the power of ten that clears it.
  let digits = 0;
  let numerator = amount < ZERO ? -amount : amount;
  let power = ONE;
  while ((numerator * power) % scale !== ZERO) {
    digits += 1;
    power *= TEN;
    if (digits > scale.toString().length * 4) return null;
  }
  numerator = (numerator * power) / scale;
  const text = decimal(numerator, digits, 0);
  return amount < ZERO ? `-${text}` : text;
}

/**
 * Renders money: rounded to the currency's minor unit, half away from zero.
 * An amount that is exactly a whole major unit prints without minor digits;
 * any other prints with all of them. A non-zero amount that rounds to zero
 * reads as less than the smallest unit.
 *
 * Money needs no credit scale, so a bare `{ currency }` is enough.
 *
 * @param micro - The amount string, in micro-units of the currency.
 * @param currency - The response's `denomination`, or just `{ currency }`.
 * @returns The money text, or `null` for a malformed amount or currency.
 */
export function formatMoney(micro: AmountInput, currency: CurrencyInput): string | null {
  return money(micro, currency, roundHalfAwayFromZero);
}

/**
 * Renders a money limit: the money rule, rounded toward negative infinity, so
 * a limit never reads higher than the one enforced.
 *
 * @param micro - The amount string, in micro-units of the currency.
 * @param currency - The response's `denomination`, or just `{ currency }`.
 * @returns The money text, or `null` for a malformed amount or currency.
 */
export function formatCap(micro: AmountInput, currency: CurrencyInput): string | null {
  return money(micro, currency, floorDiv);
}

/**
 * Renders a price in money, never rounded: the exact amount, with at least the
 * currency's minor digits.
 *
 * @param micro - The amount string, in micro-units of the currency.
 * @param currency - The response's `denomination`, or just `{ currency }`.
 * @returns The money text, or `null` for a malformed amount or currency.
 */
export function formatMoneyRate(micro: AmountInput, currency: CurrencyInput): string | null {
  const amount = parseAmount(micro);
  const shape = currencyOf(currency);
  if (amount === null || shape === null) return null;
  const magnitude = amount < ZERO ? -amount : amount;
  const sign = amount < ZERO ? '-' : '';
  return `${sign}${shape.prefix}${decimal(magnitude, MICRO_DIGITS, shape.minorDigits)}${shape.suffix}`;
}

/**
 * Renders a credit figure with its money value beside it:
 * `<credits> credits (<money>)`, with the singular for exactly one credit.
 *
 * For a position or a charge the money is worked out from the ROUNDED credit
 * count times the served scale, never separately from the exact amount, so the
 * two figures always agree. A charge under one credit reads as less than one
 * credit, beside less than the money of one credit. A rate is exact on both
 * sides.
 *
 * @param micro - The amount string, in micro-units.
 * @param denomination - The response's `denomination`.
 * @param kind - How the credit figure is rounded.
 * @returns The text, or `null` for a malformed amount or denomination.
 */
export function formatCreditsWithMoney(
  micro: AmountInput,
  denomination: DenominationInput,
  kind: CreditKind
): string | null {
  const amount = parseAmount(micro);
  const scale = parseScale(denomination);
  if (amount === null || scale === null) return null;
  const label = (credits: string) =>
    credits === '1' || credits === '-1' ? `${credits} credit` : `${credits} credits`;

  if (kind === 'rate') {
    const credits = formatRate(micro, denomination);
    const price = formatMoneyRate(micro, denomination);
    if (credits === null || price === null) return null;
    return `${label(credits)} (${price})`;
  }

  let credits: bigint;
  if (kind === 'position') {
    credits = floorDiv(amount, scale);
  } else {
    credits = amount === ZERO ? ZERO : roundHalfAwayFromZero(amount, scale);
    if (credits === ZERO && amount !== ZERO) {
      const oneCredit = formatMoney(scale.toString(), denomination);
      if (oneCredit === null) return null;
      // One credit may itself be under the smallest money unit, in which case
      // it already reads as less than that unit and needs no second marker.
      const under = oneCredit.startsWith('<') ? oneCredit : `<${oneCredit}`;
      return amount < ZERO ? `-<1 credit (-${under})` : `<1 credit (${under})`;
    }
  }
  const price = formatMoney((credits * scale).toString(), denomination);
  if (price === null) return null;
  return `${label(signedCredits(credits))} (${price})`;
}

/**
 * Renders a total the only honest way: the exact sum of the lines, rounded once
 * by the kind of what it totals. Never the sum of rounded lines, so a total may
 * differ from its rounded lines by a credit or two, and it is the total that
 * matches what was charged.
 *
 * @param lines - The exact amount strings being totalled.
 * @param denomination - The response's `denomination` (or `{ currency }` for money and cap).
 * @param kind - How the total is rounded.
 * @returns The total's text, or `null` when any line or the denomination is malformed.
 */
export function formatTotal(
  lines: readonly AmountInput[],
  denomination: DenominationInput | CurrencyInput,
  kind: AmountDisplayKind
): string | null {
  let sum = ZERO;
  for (const line of lines) {
    const amount = parseAmount(line);
    if (amount === null) return null;
    sum += amount;
  }
  const total = sum.toString();
  // The credit kinds read the scale off the denomination and return null
  // without one, so a bare currency is safe to pass through.
  const scaled = denomination as DenominationInput;
  switch (kind) {
    case 'position':
      return formatPosition(total, scaled);
    case 'charge':
      return formatCharge(total, scaled);
    case 'rate':
      return formatRate(total, scaled);
    case 'money':
      return formatMoney(total, denomination);
    case 'cap':
      return formatCap(total, denomination);
    default:
      return null;
  }
}
