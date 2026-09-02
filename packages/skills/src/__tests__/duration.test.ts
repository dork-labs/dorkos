import { describe, it, expect } from 'vitest';
import { DurationSchema, DURATION_MAX_LENGTH, parseDuration, formatDuration } from '../duration.js';

describe('DurationSchema', () => {
  it('accepts valid duration strings', () => {
    expect(DurationSchema.safeParse('5m').success).toBe(true);
    expect(DurationSchema.safeParse('1h').success).toBe(true);
    expect(DurationSchema.safeParse('30s').success).toBe(true);
    expect(DurationSchema.safeParse('2h30m').success).toBe(true);
    expect(DurationSchema.safeParse('1h15m30s').success).toBe(true);
  });

  it('rejects empty string', () => {
    expect(DurationSchema.safeParse('').success).toBe(false);
  });

  it('rejects invalid duration strings', () => {
    expect(DurationSchema.safeParse('abc').success).toBe(false);
    expect(DurationSchema.safeParse('5').success).toBe(false);
    expect(DurationSchema.safeParse('5x').success).toBe(false);
    expect(DurationSchema.safeParse('five minutes').success).toBe(false);
  });
});

describe('parseDuration', () => {
  it('parses minutes only', () => {
    expect(parseDuration('5m')).toBe(300_000);
  });

  it('parses hours only', () => {
    expect(parseDuration('2h')).toBe(7_200_000);
  });

  it('parses seconds only', () => {
    expect(parseDuration('30s')).toBe(30_000);
  });

  it('parses combined duration', () => {
    expect(parseDuration('2h30m')).toBe(9_000_000);
  });

  it('parses full hours+minutes+seconds', () => {
    expect(parseDuration('1h15m30s')).toBe(4_530_000);
  });

  it('returns 0 for empty-ish input', () => {
    expect(parseDuration('')).toBe(0);
  });
});

describe('formatDuration', () => {
  it('formats hours and minutes', () => {
    expect(formatDuration(9_000_000)).toBe('2h30m');
  });

  it('formats zero as 0s', () => {
    expect(formatDuration(0)).toBe('0s');
  });

  it('formats seconds only', () => {
    expect(formatDuration(45_000)).toBe('45s');
  });

  it('formats large values', () => {
    expect(formatDuration(86_400_000)).toBe('24h');
  });

  it('round-trips with parseDuration', () => {
    expect(formatDuration(parseDuration('2h30m'))).toBe('2h30m');
    expect(formatDuration(parseDuration('1h15m30s'))).toBe('1h15m30s');
    expect(formatDuration(parseDuration('5m'))).toBe('5m');
  });
});

describe('parseDuration stays linear on a long digit run (js/polynomial-redos)', () => {
  // `maxRuntime` reaches this parser straight off POST /api/tasks. Before the
  // fix the three scans were unanchored, so the engine retried at every offset
  // of a digit run — a few hundred thousand digits froze the event loop for
  // minutes. These cases pin both the answer and the time.
  const LEGACY = {
    h: /(\d+)h/,
    m: /(\d+)m/,
    s: /(\d+)s/,
  };

  /** What `parseDuration` computed before the lookbehind guards were added. */
  const legacyParse = (duration: string): number => {
    let ms = 0;
    const hours = duration.match(LEGACY.h);
    const minutes = duration.match(LEGACY.m);
    const seconds = duration.match(LEGACY.s);
    if (hours) ms += parseInt(hours[1], 10) * 3_600_000;
    if (minutes) ms += parseInt(minutes[1], 10) * 60_000;
    if (seconds) ms += parseInt(seconds[1], 10) * 1_000;
    return ms;
  };

  // Legal shapes plus the awkward ones the parser deliberately tolerates —
  // it documents that it does not validate, so the messy answers are behaviour
  // somebody could be relying on and must not move.
  it.each([
    '',
    '0s',
    '5m',
    '1h',
    '30s',
    '2h30m',
    '1h15m30s',
    '999h',
    '007m',
    'invalid',
    '30',
    'h',
    'ms',
    '1h2h',
    '5m3m',
    'x12m',
    '12x3m',
    'take 45m please',
    '1234567890s',
    'a1b23h',
    '00030s',
    '9h9m9s9h',
    '1h m 2s',
  ])('answers exactly what the unguarded regexes answered for %j', (input) => {
    expect(parseDuration(input)).toBe(legacyParse(input));
  });

  // The budget is 500ms rather than something tighter on purpose. The guarded
  // parser does this in 1-2ms, and the unguarded one took over two MINUTES on
  // the same input, so anything in this range separates them by orders of
  // magnitude — while leaving room for a contended machine to be slow without
  // turning a real signal into a flake.
  const BUDGET_MS = 500;

  it('parses a 200k-digit hostile string in well under half a second', () => {
    // Passes TASK_DURATION_PATTERN's shape check on the way in (that anchored
    // regex is linear), so validation is no defence — the parser has to be.
    const hostile = `${'9'.repeat(200_000)}x`;
    const started = performance.now();
    const ms = parseDuration(hostile);
    const elapsed = performance.now() - started;
    expect(ms).toBe(0);
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });

  it('parses a 200k-digit run that DOES end in a unit, just as fast', () => {
    const hostile = `${'9'.repeat(200_000)}s`;
    // Computed BEFORE the clock starts: parsing a 200k-digit number is itself
    // slow, and it is not what this test is timing.
    const expected = Number.parseInt('9'.repeat(200_000), 10) * 1_000;
    const started = performance.now();
    const ms = parseDuration(hostile);
    const elapsed = performance.now() - started;
    expect(ms).toBe(expected);
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });
});

describe('DurationSchema length cap', () => {
  it('refuses a duration string past the cap, so no parser sees a giant one', () => {
    const overCap = `${'9'.repeat(DURATION_MAX_LENGTH)}s`;
    expect(DurationSchema.safeParse(overCap).success).toBe(false);
  });

  it('still accepts a duration at the cap', () => {
    const atCap = `${'9'.repeat(DURATION_MAX_LENGTH - 1)}s`;
    expect(atCap.length).toBe(DURATION_MAX_LENGTH);
    expect(DurationSchema.safeParse(atCap).success).toBe(true);
  });

  it('leaves every real duration a person would write well inside the cap', () => {
    for (const value of ['5m', '1h', '30s', '2h30m', '1h15m30s', '9999h59m59s']) {
      expect(value.length).toBeLessThanOrEqual(DURATION_MAX_LENGTH);
      expect(DurationSchema.safeParse(value).success).toBe(true);
    }
  });
});
