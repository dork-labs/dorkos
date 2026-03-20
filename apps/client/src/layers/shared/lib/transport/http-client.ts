/**
 * HTTP client utilities for the Transport layer.
 *
 * @module shared/lib/transport/http-client
 */

/** Fetch JSON from a URL, throwing on non-OK responses. */
export async function fetchJSON<T>(baseUrl: string, url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${baseUrl}${url}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    const err = new Error(error.error || `HTTP ${res.status}`) as Error & {
      code?: string;
      status?: number;
    };
    err.code = error.code;
    err.status = res.status;
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
