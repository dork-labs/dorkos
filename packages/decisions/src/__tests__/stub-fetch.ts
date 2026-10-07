/**
 * A recording fetch stub for the bridge tests. No test in this package touches
 * the network: every bridge is handed one of these.
 *
 * @module decisions/__tests__/stub-fetch
 */
import type { FetchLike } from '../http.js';

/** One recorded call. */
export interface StubCall {
  /** The URL posted to. */
  url: string;
  /** The headers sent. */
  headers: Record<string, string>;
  /** The parsed JSON body. */
  body: Record<string, unknown>;
}

/** What the stub does for one call. */
export type StubReply = { status: number; json: unknown } | 'hang' | 'throw';

/** A stub fetch plus the calls it saw. */
export interface StubFetch {
  /** The fetch to hand a bridge. */
  fetch: FetchLike;
  /** Every call, in order. */
  calls: StubCall[];
}

/**
 * Build a stub fetch. `reply` is asked for each call in turn.
 *
 * @param reply - What to answer for call number `n` (0-based).
 */
export function stubFetch(reply: (n: number, call: StubCall) => StubReply): StubFetch {
  const calls: StubCall[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call: StubCall = {
      url,
      headers: init.headers,
      body: JSON.parse(init.body) as Record<string, unknown>,
    };
    calls.push(call);
    const r = reply(calls.length - 1, call);
    // 'hang' ignores the signal on purpose: the bridge must not rely on the
    // transport honouring an abort to stop waiting.
    if (r === 'hang') return new Promise(() => {});
    if (r === 'throw') throw new TypeError('fetch failed');
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.json };
  };
  return { fetch, calls };
}
