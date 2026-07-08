/**
 * Parse a stat value into a countable number plus its surrounding text, so a
 * metric can animate its magnitude while preserving currency symbols, units,
 * and separators — `"$1,234/mo"` counts the `1234` and keeps `"$"` and `"/mo"`.
 *
 * @module features/gen-ui/lib/stat-format
 */

/** A stat value split into the parts needed to count and re-render it. */
export interface ParsedStat {
  /** Text before the number (e.g. `"$"`). */
  prefix: string;
  /** Text after the number (e.g. `"/mo"`, `"°F"`). */
  suffix: string;
  /** Decimal places to preserve while counting. */
  decimals: number;
  /** Whether the original used thousands separators. */
  grouped: boolean;
  /** The numeric magnitude to animate to. */
  value: number;
}

/**
 * Split a stat value into a {@link ParsedStat}. Returns `null` when there is no
 * number to animate (e.g. `"Online"`), in which case the caller renders the
 * value verbatim.
 *
 * @param input - The raw `stat.value` (string or number).
 */
export function parseStatValue(input: string | number): ParsedStat | null {
  if (typeof input === 'number') {
    return Number.isFinite(input)
      ? { prefix: '', suffix: '', decimals: 0, grouped: false, value: input }
      : null;
  }
  const match = input.match(/^(.*?)(-?\d[\d,]*(?:\.\d+)?)(.*)$/s);
  if (!match) return null;
  const [, prefix, digits, suffix] = match;
  const numeric = Number(digits.replace(/,/g, ''));
  if (!Number.isFinite(numeric)) return null;
  const decimals = digits.includes('.') ? (digits.split('.')[1]?.length ?? 0) : 0;
  return { prefix, suffix, decimals, grouped: digits.includes(','), value: numeric };
}

/**
 * Render a (possibly mid-count) number back into the parsed value's original
 * format — restoring decimals, thousands grouping, prefix, and suffix.
 *
 * @param parsed - The {@link ParsedStat} from {@link parseStatValue}.
 * @param current - The current animated magnitude.
 */
export function formatStatValue(parsed: ParsedStat, current: number): string {
  const fixed = current.toFixed(parsed.decimals);
  const body = parsed.grouped
    ? Number(fixed).toLocaleString('en-US', {
        minimumFractionDigits: parsed.decimals,
        maximumFractionDigits: parsed.decimals,
      })
    : fixed;
  return `${parsed.prefix}${body}${parsed.suffix}`;
}
