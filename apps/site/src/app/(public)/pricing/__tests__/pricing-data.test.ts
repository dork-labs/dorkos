import { describe, expect, it } from 'vitest';
import {
  COMPARE,
  EXTRAS,
  MODEL_PRICES,
  NOTICE_DAYS,
  PAID_FROM,
  PLANS,
  POSTED_ON,
  creditsInDollars,
  formatCredits,
  formatDay,
  formatRate,
  formatRateDollars,
} from '../pricing-data';

describe('credit and money formatting', () => {
  it('prints a rate exactly, with at least two decimals of dollars', () => {
    expect(formatRate(520)).toBe('520 ($5.20)');
    expect(formatRate(2_600)).toBe('2,600 ($26.00)');
    expect(formatRate(812.5)).toBe('812.5 ($8.125)');
    expect(formatRate(32.5)).toBe('32.5 ($0.325)');
    expect(formatRate(13)).toBe('13 ($0.13)');
    expect(formatRateDollars(10)).toBe('$0.10');
    expect(formatRateDollars(6_500)).toBe('$65.00');
  });

  it('prints whole-dollar amounts without cents', () => {
    expect(creditsInDollars(1_000)).toBe('$10');
    expect(creditsInDollars(10_000)).toBe('$100');
    expect(formatCredits(10_000)).toBe('10,000');
    expect(() => creditsInDollars(1_050)).toThrow();
  });
});

describe('the model table', () => {
  it('prints the published rate for every model and token class', () => {
    const rows = Object.fromEntries(
      MODEL_PRICES.map((m) => [
        m.name,
        [m.input, m.output, m.cacheRead, m.cacheWrite].map(formatRate).join(' | '),
      ])
    );
    expect(rows).toEqual({
      'Claude Opus 5.5': '520 ($5.20) | 2,600 ($26.00) | 26 ($0.26) | 650 ($6.50)',
      'Claude Opus 5': '650 ($6.50) | 3,250 ($32.50) | 65 ($0.65) | 812.5 ($8.125)',
      'Claude Fable 5.1': '1,300 ($13.00) | 6,500 ($65.00) | 32.5 ($0.325) | 1,625 ($16.25)',
      'Claude Sonnet 5': '260 ($2.60) | 1,300 ($13.00) | 26 ($0.26) | 325 ($3.25)',
      'Claude Haiku 4.5': '130 ($1.30) | 650 ($6.50) | 13 ($0.13) | 162.5 ($1.625)',
    });
  });

  it('gives every model all four token classes, each with dollars beside it', () => {
    expect(MODEL_PRICES.length).toBeGreaterThan(0);
    for (const model of MODEL_PRICES) {
      for (const credits of [model.input, model.output, model.cacheRead, model.cacheWrite]) {
        expect(credits).toBeGreaterThan(0);
        expect(formatRate(credits)).toMatch(/^[\d,.]+ \(\$\d[\d,]*\.\d{2,}\)$/);
      }
    }
  });
});

describe('the page states one credit unit', () => {
  // Every plan's benefits and note, every comparison cell and hint.
  const text = JSON.stringify({ PLANS, COMPARE, EXTRAS });

  it('never says a credit is a dollar', () => {
    expect(text).not.toMatch(/credit (is|costs) \$1\b/i);
  });

  it('puts dollars beside every credit figure', () => {
    const strings = text.match(/"[^"]*"/g) ?? [];
    const withCredits = strings.filter((s) => /\d[\d,]*( or more)? (AI )?credits/.test(s));
    expect(withCredits.length).toBeGreaterThanOrEqual(7);
    for (const s of withCredits) expect(s).toMatch(/\(\$\d/);
    const included = COMPARE.flatMap((g) => g.rows).find((r) => r.label.startsWith('AI credits'));
    expect(included?.cells.slice(1)).toEqual([
      '1,000 ($10)',
      '5,000 ($50)',
      '10,000 ($100)',
      '1,000 ($10) per seat, shared',
    ]);
  });
});

describe('plan figures', () => {
  it('prints the published price and allowance in every figure row', () => {
    const rows = Object.fromEntries(
      COMPARE.flatMap((g) => g.rows).map((r) => [r.label, r.cells.join(' | ')])
    );
    expect(rows).toMatchObject({
      Monthly: '$0 | $20 | $100 | $200 | $30 per seat',
      Yearly: '— | $200 | $1,000 | $2,000 | $300 per seat',
      'In the cloud':
        'None | You + 3 agents | You + 10 agents | You + 25 agents | One seat per person or agent. No minimum.',
      'Extra agents': '— | $30 a month each | $30 a month each | $30 a month each | $30 per seat',
      'Communities you can host': expect.stringMatching(/^1 \| /),
      'People in each community': 'Up to 50 | No limit | No limit | No limit | No limit',
      'Community storage': expect.stringMatching(/^1 GB \| /),
      'Your own web address': '— | $10 a month | $10 a month | $10 a month | Included',
      'Cloud time each month': '— | 5 hours | 40 hours | 100 hours | 10 hours per seat, shared',
      'Cloud storage': '— | 5 GB | 25 GB | 50 GB | 10 GB per seat, shared',
      'Actions in connected apps each month':
        'With your own keys | 2,000 | 20,000 | 20,000 | Per seat, amount to come',
    });
  });

  it('agrees with the plan cards and the extras', () => {
    expect(PLANS.map((p) => [p.id, p.monthly, p.yearly])).toEqual([
      ['free', 0, null],
      ['pro', 20, 200],
      ['max', 100, 1000],
      ['team', 30, 300],
    ]);
    expect(EXTRAS.map((e) => e.price)).toEqual(['$30 a month', '$10 a month', '$29, once']);
  });
});

describe('dates', () => {
  it('starts every price the notice period after it is posted', () => {
    expect(NOTICE_DAYS).toBe(30);
    expect(formatDay(POSTED_ON)).toBe('September 27, 2026');
    expect(PAID_FROM).toBe('October 27, 2026');
  });
});
