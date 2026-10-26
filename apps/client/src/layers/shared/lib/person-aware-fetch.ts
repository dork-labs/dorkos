/**
 * The app window's `fetch`, aware of the owner's step-up at this computer
 * (DOR-3330).
 *
 * Every call this window makes to its own server's API (the app's, and a
 * mini app's that runs in it) carries the person proof this page holds, and a
 * change refused with `401 person_session_required` asks the owner's password
 * once, then goes again. One wrapper, so the app and every mini app ask the
 * same way, and the proof never leaves this origin.
 *
 * @module shared/lib/person-aware-fetch
 */
import {
  PERSON_PROOF_HEADER,
  PERSON_SESSION_PATH,
  PERSON_SESSION_REQUIRED_CODE,
} from '@dorkos/shared/person-session';

import { readPersonProof } from './person-proof-store';
import { requestPersonStepUp } from './person-step-up-signal';

/** How long the call sent again after the step-up may take. */
const RETRY_TIMEOUT_MS = 30_000;

/** The URL a call goes to, resolved against this page. */
function targetOf(input: RequestInfo | URL, origin: string): URL | null {
  try {
    const raw = input instanceof Request ? input.url : String(input);
    return new URL(raw, origin);
  } catch {
    return null;
  }
}

/** Whether a `401` asks for the step-up, reading a copy of its body. */
async function asksForPersonSession(res: Response): Promise<boolean> {
  if (res.status !== 401) return false;
  const body = (await res
    .clone()
    .json()
    .catch(() => null)) as { code?: unknown } | null;
  return body?.code === PERSON_SESSION_REQUIRED_CODE;
}

/**
 * Wrap a `fetch` so calls to this page's own API carry the person proof and
 * step up once when refused for want of it.
 *
 * @param base - The `fetch` to wrap.
 * @param origin - This page's origin; calls anywhere else pass through untouched.
 */
export function personAwareFetch(base: typeof fetch, origin: string): typeof fetch {
  return async (input, init) => {
    const target = targetOf(input, origin);
    const ours = target !== null && target.origin === origin && target.pathname.startsWith('/api/');
    if (!ours) return base(input, init);

    const build = (): [RequestInfo | URL, RequestInit] => {
      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
      const proof = readPersonProof();
      if (proof) headers.set(PERSON_PROOF_HEADER, proof);
      return [input instanceof Request ? input.clone() : input, { ...init, headers }];
    };

    const first = build();
    const res = await base(...first);
    const replayable = !(init?.body instanceof ReadableStream) && !(input instanceof Request);
    if (!replayable || target.pathname === PERSON_SESSION_PATH) return res;
    if (!(await asksForPersonSession(res))) return res;
    if (!(await requestPersonStepUp())) return res;
    // A fresh clock for the retry: the caller's timeout kept running while the
    // person typed their password, and may already have fired.
    const [again, retryInit] = build();
    return base(again, { ...retryInit, signal: AbortSignal.timeout(RETRY_TIMEOUT_MS) });
  };
}

/** Whether this window's `fetch` is already wrapped. */
let installed = false;

/** Wrap this window's `fetch`, once, at startup. */
export function installPersonAwareFetch(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.fetch = personAwareFetch(window.fetch.bind(window), window.location.origin);
}
