/**
 * HTTP client utilities for the Transport layer.
 *
 * @module shared/lib/transport/http-client
 */
import { setAuthRequired } from '../auth-signal';

/**
 * Default timeout for fetchJSON requests (ms).
 *
 * **This is the only clock a caller may wait on.** A surface that arms a second,
 * shorter timer over a transport call decides the outcome before the request
 * has answered, and the request then contradicts it: the Remote Access dialog
 * ran a 15s timer over this 30s one, so a slow start showed "Tunnel timed out
 * after 15 seconds" and then flipped the same dialog to connected when it
 * succeeded at 20s (DOR-1739). Pass `timeout` here to wait a different length of
 * time; never race this from outside.
 */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Perform the request and hand back the raw {@link Response}, throwing on
 * anything that is not OK.
 *
 * Split out of {@link fetchJSON} so a route that answers `204 No Content` can
 * share exactly this error handling — the auth signal, the `code`/`status` on
 * the thrown error, the timeout message — without `res.json()` choking on an
 * empty body.
 */
async function request(
  baseUrl: string,
  url: string,
  opts?: RequestInit & { timeout?: number }
): Promise<Response> {
  const { timeout = DEFAULT_TIMEOUT_MS, ...requestInit } = opts ?? {};
  const timeoutSignal = AbortSignal.timeout(timeout);
  const signal = requestInit.signal
    ? AbortSignal.any([timeoutSignal, requestInit.signal])
    : timeoutSignal;

  let res: Response;
  try {
    res = await fetch(`${baseUrl}${url}`, {
      headers: { 'Content-Type': 'application/json' },
      // Ride the Better Auth session cookie on every API call (login enabled).
      // Harmless when auth is off; HttpTransport needs no constructor change.
      credentials: 'include',
      ...requestInit,
      signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new Error(`Request timed out after ${timeout / 1000}s. Check your network`, {
        cause: err,
      });
    }
    throw err;
  }
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    const err = new Error(error.error || `HTTP ${res.status}`) as Error & {
      code?: string;
      status?: number;
      body?: unknown;
    };
    err.code = error.code;
    err.status = res.status;
    // Some refusals carry data the caller must act on, not just describe: a
    // `CHAT_ALREADY_BOUND` 409 names the binding that already owns the chat,
    // which is the id the "move it instead?" dialog calls `moveBinding` with.
    // `message`/`code`/`status` cannot carry it, so the parsed body rides along.
    err.body = error;
    // A gated request without a valid credential (server task 1.2) flips the
    // app-wide auth-required state so the AuthGuard renders the login screen.
    if (res.status === 401 && error.code === 'AUTH_REQUIRED') {
      setAuthRequired(true);
    }
    throw err;
  }
  return res;
}

/** Fetch JSON from a URL, throwing on non-OK responses. */
export async function fetchJSON<T>(
  baseUrl: string,
  url: string,
  opts?: RequestInit & { timeout?: number }
): Promise<T> {
  const res = await request(baseUrl, url, opts);
  return res.json() as Promise<T>;
}

/**
 * Call a route that answers with no body (`204 No Content`) and discard the
 * response, throwing on non-OK exactly as {@link fetchJSON} does.
 *
 * `fetchJSON` cannot be used for these: `res.json()` on an empty body rejects
 * with a parse error, which would surface as "Unexpected end of JSON input" on
 * a request that in fact succeeded.
 */
export async function fetchNoContent(
  baseUrl: string,
  url: string,
  opts?: RequestInit & { timeout?: number }
): Promise<void> {
  await request(baseUrl, url, opts);
}

/**
 * Build a query string from an object, omitting undefined values.
 *
 * @returns The query string prefixed with `?`, or empty string if no params.
 */
export function buildQueryString(
  params: Record<string, string | number | boolean | undefined>
): string {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      searchParams.set(key, String(value));
    }
  }
  const qs = searchParams.toString();
  return qs ? `?${qs}` : '';
}
