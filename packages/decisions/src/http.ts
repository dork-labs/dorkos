/**
 * The one HTTP call the network bridges make: POST a JSON body, wait at most a
 * fixed time, and turn every way that can go wrong into a {@link DecisionFailure}
 * instead of a thrown error.
 *
 * @module decisions/http
 */
import type { DecisionFailure } from '@dorkos/shared/decision-model';

/** The subset of `fetch` the bridges use, injectable so tests never touch the network. */
export type FetchLike = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal }
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** What one POST came back with. */
export type PostOutcome = { ok: true; body: unknown } | { ok: false; failure: DecisionFailure };

/** Arguments for {@link postJson}. */
export interface PostJsonArgs {
  /** The fetch to call. */
  fetch: FetchLike;
  /** Full endpoint URL. */
  url: string;
  /** Request headers (content type is added). */
  headers: Record<string, string>;
  /** The JSON body. */
  body: unknown;
  /** Give up after this many milliseconds. */
  timeoutMs: number;
  /** The caller's signal; when it fires the call stops with `aborted`. */
  signal: AbortSignal;
}

/**
 * POST a JSON body and read a JSON reply. Never rejects.
 *
 * Races the fetch against the deadline and the caller's signal itself, rather
 * than trusting the fetch to honor its signal, so a transport that ignores
 * aborts still cannot hold a decision open past its time limit.
 *
 * @param args - See {@link PostJsonArgs}.
 */
export async function postJson(args: PostJsonArgs): Promise<PostOutcome> {
  if (args.signal.aborted) return { ok: false, failure: 'aborted' };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stop = new Promise<PostOutcome>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ ok: false, failure: 'timeout' });
    }, args.timeoutMs);
    onAbort = () => {
      controller.abort();
      resolve({ ok: false, failure: 'aborted' });
    };
    args.signal.addEventListener('abort', onAbort, { once: true });
  });
  const call = (async (): Promise<PostOutcome> => {
    try {
      const res = await args.fetch(args.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...args.headers },
        body: JSON.stringify(args.body),
        signal: controller.signal,
      });
      if (!res.ok) return { ok: false, failure: 'outage' };
      try {
        return { ok: true, body: await res.json() };
      } catch {
        return { ok: false, failure: 'invalid-answer' };
      }
    } catch {
      return { ok: false, failure: 'outage' };
    }
  })();
  try {
    return await Promise.race([call, stop]);
  } finally {
    clearTimeout(timer);
    if (onAbort) args.signal.removeEventListener('abort', onAbort);
  }
}

/** True when `x` is a plain object. */
export function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}
