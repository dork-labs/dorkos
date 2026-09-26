/**
 * The shared display formatter, `@dork-labs/cloud-api/display`.
 *
 * Two clients render Cloud amounts, and they used to round differently. These
 * tests pin the one set of rules both now share, by kind of figure, against
 * generated amounts at several scales. The scale is served, not published, so
 * the rules must hold at any scale; the scales below are arbitrary.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  floorDiv,
  formatCap,
  formatCharge,
  formatCreditsWithMoney,
  formatMoney,
  formatMoneyRate,
  formatPosition,
  formatRate,
  formatTotal,
  roundHalfAwayFromZero,
  type DisplayDenomination,
} from '../display.js';
import { PLACEHOLDER_DENOMINATION } from './denomination-placeholder.js';

/** The scales every property runs at: the placeholder, and a spread of others. */
const SCALES = [PLACEHOLDER_DENOMINATION.microPerCredit, '1', '3', '7', '100', '1048576'];

/** A denomination in the test currency at a given scale. */
function at(microPerCredit: string): DisplayDenomination {
  return { currency: PLACEHOLDER_DENOMINATION.currency, microPerCredit };
}

/** A seeded generator, so a failure reproduces exactly. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    // mulberry32
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LIMIT = BigInt(2) ** BigInt(70);

/**
 * A random integer in [-2^70, 2^70], biased toward small magnitudes and the
 * edges around a scale, where rounding goes wrong.
 */
function amountGen(random: () => number, scale: bigint): () => bigint {
  return () => {
    const pick = random();
    let magnitude: bigint;
    if (pick < 0.3) {
      // Near a multiple of the scale, or of half of it.
      const base = BigInt(Math.floor(random() * 1000)) * scale;
      const half = random() < 0.5 ? scale / BigInt(2) : BigInt(0);
      magnitude = base + half + BigInt(Math.floor(random() * 5)) - BigInt(2);
    } else if (pick < 0.6) {
      magnitude = BigInt(Math.floor(random() * 10_000_000));
    } else {
      // Up to 70 random bits.
      let value = BigInt(0);
      for (let i = 0; i < 70; i += 1) value = (value << BigInt(1)) | BigInt(random() < 0.5 ? 1 : 0);
      magnitude = value;
    }
    if (magnitude < BigInt(0)) magnitude = -magnitude;
    if (magnitude > LIMIT) magnitude = LIMIT;
    return random() < 0.5 ? -magnitude : magnitude;
  };
}

/** Reads a grouped credit count back as an integer; `<1` reads as zero. */
function credits(text: string): bigint {
  if (text === '<1' || text === '-<1') return BigInt(0);
  return BigInt(text.replace(/,/g, ''));
}

/** Reads an exact grouped decimal back as a rational `numerator / 10^digits`. */
function exactTimes(text: string, scale: bigint): bigint | null {
  const negative = text.startsWith('-');
  const [whole, fraction = ''] = text.replace(/^-/, '').replace(/,/g, '').split('.');
  const digits = BigInt(10) ** BigInt(fraction.length);
  const numerator = BigInt(whole + fraction) * scale;
  if (numerator % digits !== BigInt(0)) return null;
  const value = numerator / digits;
  return negative ? -value : value;
}

const CASES_PER_SCALE = 2000;

describe('the bigint helpers', () => {
  it('floor toward negative infinity, and round ties away from zero', () => {
    const b = BigInt;
    expect(floorDiv(b(7), b(2))).toBe(b(3));
    expect(floorDiv(b(-7), b(2))).toBe(b(-4));
    expect(floorDiv(b(-8), b(2))).toBe(b(-4));
    expect(roundHalfAwayFromZero(b(5), b(10))).toBe(b(1));
    expect(roundHalfAwayFromZero(b(-5), b(10))).toBe(b(-1));
    expect(roundHalfAwayFromZero(b(4), b(10))).toBe(b(0));
    expect(roundHalfAwayFromZero(b(-4), b(10))).toBe(b(0));
  });
});

describe('the worked examples (placeholder scale of one hundred)', () => {
  // Purpose: the spec's examples, one line each, at a scale that is nobody's.
  const d = at('100');

  it('renders charges', () => {
    expect(formatCharge('45', d)).toBe('<1');
    expect(formatCharge('49', d)).toBe('<1');
    expect(formatCharge('50', d)).toBe('1');
    expect(formatCharge('0', d)).toBe('0');
    expect(formatCharge('-45', d)).toBe('-<1');
    expect(formatCharge('650', d)).toBe('7');
    expect(formatCharge('-650', d)).toBe('-7');
  });

  it('renders positions', () => {
    expect(formatPosition('6123', d)).toBe('61');
    expect(formatPosition('9999', d)).toBe('99');
    expect(formatPosition('-1', d)).toBe('-1');
    expect(formatPosition('123456789', d)).toBe('1,234,567');
  });

  it('computes the money beside a position from the rounded count', () => {
    expect(formatCreditsWithMoney('9999', d, 'position')).toBe(
      `99 credits (${formatMoney('9900', d)})`
    );
    // At a scale where one credit is two minor units of money, the exact
    // amount and the rounded count name different money: the count wins.
    const coarse = at('20000');
    expect(formatCreditsWithMoney('999999', coarse, 'position')).toBe(
      `49 credits (${formatMoney('980000', coarse)})`
    );
    expect(formatCreditsWithMoney('999999', coarse, 'position')).not.toContain(
      formatMoney('999999', coarse) as string
    );
    expect(formatCreditsWithMoney('100', d, 'position')).toBe(
      `1 credit (${formatMoney('100', d)})`
    );
  });

  it('renders rates exactly', () => {
    expect(formatRate('325', d)).toBe('3.25');
    expect(formatRate('300', d)).toBe('3');
    expect(formatRate('-5', d)).toBe('-0.05');
    expect(formatRate('0', d)).toBe('0');
  });

  it('totals from the exact sum, not from rounded lines', () => {
    const lines = ['50', '50', '50'];
    expect(lines.map((line) => formatCharge(line, d))).toEqual(['1', '1', '1']);
    expect(formatTotal(lines, d, 'charge')).toBe('2');
    const small = ['40', '40', '40'];
    expect(small.map((line) => formatCharge(line, d))).toEqual(['<1', '<1', '<1']);
    expect(formatTotal(small, d, 'charge')).toBe('1');
  });
});

describe('money', () => {
  // A currency with two minor digits: a minor unit is ten thousand micro-units.
  const xts = { currency: PLACEHOLDER_DENOMINATION.currency };
  it('prints whole amounts without minor digits and others with all of them', () => {
    expect(formatMoney('30000000', xts)).toMatch(/[^.\d]30$/);
    expect(formatMoney('6120000', xts)).toMatch(/6\.12$/);
    expect(formatMoney('6125000', xts)).toMatch(/6\.13$/); // half away from zero
    expect(formatMoney('-6125000', xts)).toMatch(/^-.*6\.13$/);
    expect(formatMoney('1234567890000', xts)).toMatch(/1,234,567\.89$/);
    expect(formatMoney('0', xts)).toMatch(/0$/);
  });

  it('keeps minor digits when rounding lands on a whole unit the amount is not', () => {
    // A figure that was rounded must not read as more exact than it is.
    expect(formatMoney('9999999', xts)).toMatch(/10\.00$/);
    expect(formatCap('1005000', xts)).toMatch(/1\.00$/);
  });

  it('reads a non-zero amount that rounds to zero as less than the smallest unit', () => {
    expect(formatMoney('3500', xts)).toMatch(/^<.*0\.01$/);
    expect(formatMoney('-3500', xts)).toMatch(/^-<.*0\.01$/);
    expect(formatMoney('5000', xts)).toMatch(/^[^<]*0\.01$/);
  });

  it('rounds a cap down, so a limit never reads higher than the one enforced', () => {
    expect(formatCap('1009999', xts)).toMatch(/1\.00$/);
    expect(formatMoney('1009999', xts)).toMatch(/1\.01$/);
  });

  it('renders a money rate exactly, with at least the minor digits', () => {
    expect(formatMoneyRate('375000', xts)).toMatch(/0\.375$/);
    expect(formatMoneyRate('1700000', xts)).toMatch(/1\.70$/);
    expect(formatMoneyRate('42000000', xts)).toMatch(/42\.00$/);
    expect(formatMoneyRate('1', xts)).toMatch(/0\.000001$/);
  });

  it('learns minor digits from the currency, never assuming two', () => {
    // A currency with no minor unit and one with three, both ISO 4217.
    expect(formatMoney('1500000', { currency: 'JPY' })).toMatch(/2$/);
    expect(formatMoney('400000', { currency: 'JPY' })).toMatch(/^<.*1$/);
    expect(formatMoney('1234500', { currency: 'BHD' })).toMatch(/1\.235$/);
    expect(formatMoneyRate('1000000', { currency: 'BHD' })).toMatch(/1\.000$/);
  });

  it('accepts a full denomination as well as a bare currency', () => {
    expect(formatMoney('6120000', PLACEHOLDER_DENOMINATION)).toBe(formatMoney('6120000', xts));
  });
});

describe('malformed input returns null, never a guess', () => {
  const d = PLACEHOLDER_DENOMINATION;
  const all = [
    (m: string | undefined | null, den: DisplayDenomination | undefined | null) =>
      formatPosition(m, den),
    (m: string | undefined | null, den: DisplayDenomination | undefined | null) =>
      formatCharge(m, den),
    (m: string | undefined | null, den: DisplayDenomination | undefined | null) =>
      formatRate(m, den),
    (m: string | undefined | null, den: DisplayDenomination | undefined | null) =>
      formatMoney(m, den),
    (m: string | undefined | null, den: DisplayDenomination | undefined | null) =>
      formatCap(m, den),
    (m: string | undefined | null, den: DisplayDenomination | undefined | null) =>
      formatMoneyRate(m, den),
    (m: string | undefined | null, den: DisplayDenomination | undefined | null) =>
      formatCreditsWithMoney(m, den, 'position'),
    (m: string | undefined | null, den: DisplayDenomination | undefined | null) =>
      formatTotal([m], den, 'charge'),
  ];

  it('for a malformed amount', () => {
    for (const render of all) {
      for (const bad of ['1.5', '', '01', ' 1', '1e6', '+1', undefined, null]) {
        expect(render(bad, d), String(bad)).toBeNull();
      }
      expect(render(1 as unknown as string, d)).toBeNull();
    }
  });

  it('for a missing or malformed denomination', () => {
    const badDenominations = [
      undefined,
      null,
      { currency: 'xts', microPerCredit: '250' },
      { currency: 'XTS', microPerCredit: '0' },
      { currency: 'XTS', microPerCredit: '-1' },
      { currency: 'XTS', microPerCredit: 250 as unknown as string },
      { currency: 'ZZZ1', microPerCredit: '250' },
    ];
    const badCurrency = [undefined, null, badDenominations[2], badDenominations[6]];
    for (const [index, render] of all.entries()) {
      const needsScale = ![3, 4, 5].includes(index); // money, cap and money rate need no scale
      for (const bad of needsScale ? badDenominations : badCurrency) {
        expect(render('100', bad as DisplayDenomination), JSON.stringify(bad)).toBeNull();
      }
    }
    // The credit renderers need a scale; money does not.
    expect(formatPosition('100', { currency: 'XTS' } as DisplayDenomination)).toBeNull();
    expect(formatCharge('100', { currency: 'XTS' } as DisplayDenomination)).toBeNull();
    expect(formatRate('100', { currency: 'XTS' } as DisplayDenomination)).toBeNull();
  });
});

describe('precision', () => {
  it('keeps the last digit of an amount past the float limit', () => {
    // 2^53 + 1 is the first integer a JavaScript number cannot hold.
    const big = (BigInt(2) ** BigInt(53) + BigInt(1)).toString();
    expect(big.endsWith('993')).toBe(true);
    expect(formatRate(big, at('1'))).toBe('9,007,199,254,740,993');
    expect(formatPosition(big, at('1'))).toBe('9,007,199,254,740,993');
    expect(formatCharge(big, at('1'))).toBe('9,007,199,254,740,993');
    expect(formatMoneyRate(big, PLACEHOLDER_DENOMINATION)).toMatch(/9,007,199,254\.740993$/);
  });

  it('never prints a negative zero', () => {
    for (const scale of SCALES) {
      const d = at(scale);
      for (const text of [
        formatPosition('-0', d),
        formatCharge('-0', d),
        formatRate('-0', d),
        formatMoney('-0', d),
        formatCap('-0', d),
        formatMoneyRate('-0', d),
        formatCreditsWithMoney('-0', d, 'charge'),
        formatCreditsWithMoney('-0', d, 'position'),
        formatCreditsWithMoney('-0', d, 'rate'),
      ]) {
        expect(text, String(text)).not.toMatch(/^-/);
        expect(text, String(text)).not.toMatch(/\(-/);
      }
    }
  });
});

describe('the properties, over generated amounts at every scale', () => {
  for (const scaleText of SCALES) {
    const scale = BigInt(scaleText);
    const d = at(scaleText);

    it(`hold at a scale of ${scaleText}`, () => {
      const random = prng(Number(scale % BigInt(2147483647)) + 17);
      const next = amountGen(random, scale);
      for (let i = 0; i < CASES_PER_SCALE; i += 1) {
        const m = next();
        const text = m.toString();

        // position(m) * s <= m < (position(m) + 1) * s
        const position = credits(formatPosition(text, d) as string);
        expect(position * scale <= m && m < (position + BigInt(1)) * scale, text).toBe(true);

        // |charge(m) * s - m| <= s / 2, and charge is "<1" iff 0 < |m| < s / 2
        const chargeText = formatCharge(text, d) as string;
        const magnitude = m < BigInt(0) ? -m : m;
        const isUnder = magnitude > BigInt(0) && magnitude * BigInt(2) < scale;
        expect(chargeText === '<1' || chargeText === '-<1', text).toBe(isUnder);
        if (!isUnder) {
          const charge = credits(chargeText);
          const error = charge * scale - m;
          expect((error < BigInt(0) ? -error : error) * BigInt(2) <= scale, text).toBe(true);
        }

        // rate(m) parses back to exactly m, or is null because it cannot be
        // written as a finite decimal at this scale.
        const rate = formatRate(text, d);
        if (rate === null) {
          let reduced: bigint;
          for (let g = m < BigInt(0) ? -m : m, s = scale; ;) {
            if (g === BigInt(0)) {
              reduced = scale / s;
              break;
            }
            [g, s] = [s % g, g];
          }
          while (reduced % BigInt(2) === BigInt(0)) reduced /= BigInt(2);
          while (reduced % BigInt(5) === BigInt(0)) reduced /= BigInt(5);
          expect(reduced > BigInt(1), `${text} had a finite decimal and got null`).toBe(true);
        } else {
          expect(exactTimes(rate, scale), text).toBe(m);
        }

        // the money beside a position or a charge is the rounded count times s
        expect(formatCreditsWithMoney(text, d, 'position'), text).toBe(
          `${formatPosition(text, d)} ${position === BigInt(1) || position === BigInt(-1) ? 'credit' : 'credits'} (${formatMoney((position * scale).toString(), d)})`
        );
        if (!isUnder) {
          const charge = credits(chargeText);
          expect(formatCreditsWithMoney(text, d, 'charge'), text).toContain(
            `(${formatMoney((charge * scale).toString(), d)})`
          );
        } else {
          expect(formatCreditsWithMoney(text, d, 'charge'), text).toMatch(/^-?<1 credit \(-?</);
        }

        // cap(m) never exceeds m
        const cap = formatCap(text, d) as string;
        const capMinor = cap.includes('<')
          ? BigInt(0)
          : BigInt(cap.replace(/[^\d-]/g, '').replace(/(?!^)-/g, '') || '0');
        // XTS has two minor digits, so one minor unit is a hundredth of a
        // million micro-units.
        const microPerMinor = BigInt(10) ** BigInt(6 - 2);
        const capMicro = (cap.includes('.') ? capMinor : capMinor * BigInt(100)) * microPerMinor;
        expect(capMicro <= m || cap.includes('<'), `${text} capped to ${cap}`).toBe(true);
      }
    });

    it(`keeps rounded lines within floor((n + 1) / 2) of the rounded total at a scale of ${scaleText}`, () => {
      const random = prng(Number(scale % BigInt(2147483647)) + 101);
      const next = amountGen(random, scale);
      for (let i = 0; i < 200; i += 1) {
        const n = 1 + Math.floor(random() * 50);
        const lines = Array.from({ length: n }, () => next().toString());
        const sumOfRounded = lines
          .map((line) => credits(formatCharge(line, d) as string))
          .reduce((a, b) => a + b, BigInt(0));
        const total = credits(formatTotal(lines, d, 'charge') as string);
        const gap = sumOfRounded - total;
        expect(
          (gap < BigInt(0) ? -gap : gap) <= BigInt(Math.floor((n + 1) / 2)),
          lines.join()
        ).toBe(true);
      }
    });
  }

  it('lets the nudge sentence subtract in money when one credit is one minor unit', () => {
    // With a scale of one minor unit and a plan price of whole minor units, the
    // money beside the rounded spend, minus the price, is the money of the exact
    // saving rounded: so "spend (money). Price: money. Difference: money."
    // always checks.
    // A currency with three minor digits, so one minor unit is a thousand
    // micro-units: the property is about the relation, not about any one scale.
    const currency = 'BHD';
    const minorDigits = 3;
    const minorUnit = BigInt(10) ** BigInt(6 - minorDigits);
    const d = { currency, microPerCredit: minorUnit.toString() };
    const random = prng(4242);
    for (let i = 0; i < 5000; i += 1) {
      const price = BigInt(Math.floor(random() * 100000)) * minorUnit;
      const spend = price + BigInt(Math.floor(random() * 1e9));
      const charge = credits(formatCharge(spend.toString(), d) as string);
      const lhs = charge * minorUnit - price; // money beside the rounded spend, minus the price
      const saving = formatMoney((spend - price).toString(), d) as string;
      const shown = formatMoney(lhs.toString(), d) as string;
      // Compare the minor units both render, ignoring whole-unit trimming.
      const digits = (text: string) => {
        if (text.startsWith('<')) return BigInt(0);
        const numeric = text.replace(/[^\d.]/g, '');
        const [whole, fraction = ''] = numeric.split('.');
        return (
          BigInt(whole) * BigInt(10) ** BigInt(minorDigits) +
          BigInt((fraction + '0'.repeat(minorDigits)).slice(0, minorDigits))
        );
      };
      expect(digits(shown), `${spend} - ${price}`).toBe(digits(saving));
    }
  });
});

describe('the module itself', () => {
  it('imports nothing, not even the contract`s own schemas', () => {
    // Purpose: a renderer can use it without Zod, and nothing it imports can
    // bring a scale with it.
    const source = readFileSync(path.join(import.meta.dirname, '..', 'display.ts'), 'utf8');
    expect(source.match(/^\s*import\s/m)).toBeNull();
    expect(source).not.toMatch(/\brequire\(/);
  });

  it('never turns an amount into a JavaScript number', () => {
    // Purpose: a float loses precision past the float limit. The only Number
    // conversions allowed are none at all.
    const source = readFileSync(path.join(import.meta.dirname, '..', 'display.ts'), 'utf8');
    for (const banned of [
      /\bNumber\(/,
      /\bparseFloat\(/,
      /\bparseInt\(/,
      /[=(,]\s*\+\s*micro/,
      /\.format\(/,
    ]) {
      expect(source, String(banned)).not.toMatch(banned);
    }
  });
});
