/**
 * Token classes and what they cost at public list price.
 *
 * Prices are per million tokens, as published. No discount, commitment, batch
 * or partner rate is modelled, and nothing here is derived from anything but a
 * public price page — a model with no published rate gets no dollar figure
 * rather than a plausible-looking guess.
 *
 * @module scripts/agent-hours/prices
 */

/** List price per million tokens for one model. */
export interface ModelPrice {
  /** Uncached input tokens, USD per million. */
  readonly input: number;
  /** Output tokens (thinking included), USD per million. */
  readonly output: number;
}

/**
 * Public list prices, USD per million tokens, keyed by an exact model id.
 *
 * Only models we can price honestly appear here. Anything absent is reported in
 * tokens with no dollar figure attached. Codex's and OpenCode's model ids are
 * deliberately missing: the first are another vendor's, the second are
 * provider-local aliases with no list price at all.
 */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-fable-5-1': { input: 10, output: 50 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

/**
 * Cache reads bill at this fraction of the uncached input rate.
 *
 * 10% is the standard published ratio. Some models publish a cheaper cache-read
 * rate than that, so using the standard ratio everywhere overstates their cost
 * slightly.
 */
export const CACHE_READ_RATIO = 0.1;

/**
 * Cache writes bill at a premium over the input rate, and **the premium depends
 * on the cache's time-to-live**: 1.25× for the 5-minute TTL, 2× for the 1-hour.
 *
 * Keeping these apart is not a refinement. An agent harness that opts into
 * 1-hour caching does so for nearly every write, so collapsing both into the
 * 5-minute rate understates the cache-write line by 60% — and cache writes are
 * the second-largest class on a cached workload. The transcripts carry the
 * split (`cache_creation.ephemeral_1h_input_tokens` /
 * `ephemeral_5m_input_tokens`), so there is no reason to guess.
 */
export const CACHE_WRITE_5M_RATIO = 1.25;
export const CACHE_WRITE_1H_RATIO = 2;

/**
 * The price row for a model id, or `null` when we have no published rate.
 *
 * Transcripts carry dated snapshot ids (`claude-haiku-4-5-20251001`) beside bare
 * ones, so an exact miss falls back to the longest table key the id starts with.
 */
export function priceFor(model: string): ModelPrice | null {
  const exact = MODEL_PRICES[model];
  if (exact) return exact;
  let best: ModelPrice | null = null;
  let bestLength = 0;
  for (const [key, price] of Object.entries(MODEL_PRICES)) {
    if (model.startsWith(key) && key.length > bestLength) {
      best = price;
      bestLength = key.length;
    }
  }
  return best;
}

/**
 * The token classes, kept separate because they are priced very differently — a
 * cache read costs a twentieth of what the same token costs as output, and a
 * 1-hour cache write costs sixteen times a cache read. A single "tokens" total
 * hides the entire shape of the bill.
 */
export interface TokenMix {
  input: number;
  output: number;
  cacheRead: number;
  /** Cache writes at the 5-minute TTL. */
  cacheWrite5m: number;
  /** Cache writes at the 1-hour TTL. */
  cacheWrite1h: number;
}

/** An empty mix, for accumulating into. */
export function emptyMix(): TokenMix {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
}

/** Add `add`'s tokens into `into`, scaled by `share`. */
export function addMix(into: TokenMix, add: TokenMix, share: number): void {
  into.input += add.input * share;
  into.output += add.output * share;
  into.cacheRead += add.cacheRead * share;
  into.cacheWrite5m += add.cacheWrite5m * share;
  into.cacheWrite1h += add.cacheWrite1h * share;
}

/** Every token in a mix. */
export function mixTotal(mix: TokenMix): number {
  return mix.input + mix.output + mix.cacheRead + mix.cacheWrite5m + mix.cacheWrite1h;
}

/** What a mix costs at one model's list price. */
export function priceMix(mix: TokenMix, price: ModelPrice): number {
  return (
    (mix.input * price.input +
      mix.output * price.output +
      mix.cacheRead * price.input * CACHE_READ_RATIO +
      mix.cacheWrite5m * price.input * CACHE_WRITE_5M_RATIO +
      mix.cacheWrite1h * price.input * CACHE_WRITE_1H_RATIO) /
    1_000_000
  );
}
