/**
 * HTTP client utilities for the Transport layer.
 *
 * @module shared/lib/transport/http-client
 */
import { setAuthRequired } from '../auth-signal';

/** Default timeout for fetchJSON requests (ms). */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Fetch JSON from a URL, throwing on non-OK responses. */
export async function fetchJSON<T>(
  baseUrl: string,
  url: string,
  opts?: RequestInit & { timeout?: number }
): Promise<T> {
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
      throw new Error(`Request timed out after ${timeout / 1000}s — check your network connection`);
    }
    throw err;
  }
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    const err = new Error(error.error || `HTTP ${res.status}`) as Error & {
      code?: string;
      status?: number;
    };
    err.code = error.code;
    err.status = res.status;
    // A gated request without a valid credential (server task 1.2) flips the
    // app-wide auth-required state so the AuthGuard renders the login screen.
    if (res.status === 401 && error.code === 'AUTH_REQUIRED') {
      setAuthRequired(true);
    }
    throw err;
  }
  return res.json();
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
