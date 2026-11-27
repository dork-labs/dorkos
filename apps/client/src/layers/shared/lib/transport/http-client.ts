/**
 * HTTP client utilities for the Transport layer.
 *
 * @module shared/lib/transport/http-client
 */
import { setAuthRequired, setSignInWith } from '../auth-signal';
import { getCommunityAuthority, invalidateCommunityAuthority } from '../community-authority-state';
import { errorFromReading, readResponseError } from '../response-error';

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
 * The codes a 401 that asks for a sign-in carries: the login gate's own
 * `AUTH_REQUIRED` (not a problem document, on purpose) and the problem code
 * `unauthenticated` other routes answer with.
 */
const LOGIN_GATE_CODES = new Set(['AUTH_REQUIRED', 'unauthenticated']);

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
  opts?: RequestInit & { timeout?: number | null }
): Promise<Response> {
  const { timeout = DEFAULT_TIMEOUT_MS, ...requestInit } = opts ?? {};
  const timeoutSignal = timeout === null ? undefined : AbortSignal.timeout(timeout);
  const signal = timeoutSignal
    ? requestInit.signal
      ? AbortSignal.any([timeoutSignal, requestInit.signal])
      : timeoutSignal
    : requestInit.signal;
  const headers = new Headers(requestInit.headers);
  // JSON is the default only for a JSON string or no body. FormData, Blob,
  // URLSearchParams and binary bodies need `fetch` to write their own type:
  // a multipart body under a JSON header has no boundary, so the server
  // finds no file (the avatar upload answered `avatar_missing`).
  const body = requestInit.body;
  const jsonBody = body === undefined || body === null || typeof body === 'string';
  if (jsonBody && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const communityOwner = getCommunityAuthority().ownerKey;
  if (communityOwner) headers.set('X-DorkOS-Community-Owner', communityOwner);

  let res: Response;
  try {
    res = await fetch(`${baseUrl}${url}`, {
      ...requestInit,
      headers,
      // Ride the Better Auth session cookie on every API call (login enabled).
      // Harmless when auth is off; HttpTransport needs no constructor change.
      credentials: 'include',
      signal,
    });
  } catch (err) {
    if (timeout !== null && err instanceof DOMException && err.name === 'TimeoutError') {
      throw new Error(`Request timed out after ${timeout / 1000}s. Check your network`, {
        cause: err,
      });
    }
    // `fetch` rejects with a TypeError when no response came back at all: the
    // server is down, or the network is. Marked so a caller can tell this from
    // a body that broke AFTER a response, which also throws a TypeError but
    // means the server did answer (DOR-3481).
    if (err instanceof TypeError) throw Object.assign(err, { noResponse: true });
    throw err;
  }
  if (!res.ok) {
    // One reader for every failed answer: a problem document, or the login gate
    // and a held action, which are not problems on purpose (`shared/lib/response-error`).
    const reading = await readResponseError(res);
    const err = errorFromReading(reading);
    // A body that was not JSON still leaves an object to read fields off.
    if (err.body === undefined) err.body = {};
    // The numeric Retry-After header wins over a body's `retryAfterMs`.
    const retryAfter = res.headers.get('Retry-After');
    if (res.status === 429 && retryAfter !== null && /^\d+(?:\.\d+)?$/.test(retryAfter.trim())) {
      const milliseconds = Number(retryAfter) * 1000;
      if (Number.isFinite(milliseconds)) err.retryAfterMs = milliseconds;
    }
    // Some refusals carry data the caller must act on, not just describe: a
    // `chat_already_bound` 409 names the binding that already owns the chat,
    // which is the id the "move it instead?" dialog calls `moveBinding` with.
    // `message`/`code`/`status` cannot carry it, so the parsed body rides along
    // as `err.body`.
    const body = (reading.body ?? {}) as { signInWith?: unknown };
    // A gated request without a valid credential (server task 1.2) flips the
    // app-wide auth-required state so the AuthGuard renders the login screen.
    if (res.status === 401 && LOGIN_GATE_CODES.has(reading.code ?? '')) {
      const named = body.signInWith;
      setSignInWith(named === 'dorkos' || named === 'wifi-code' ? named : 'password');
      setAuthRequired(true);
    }
    if (res.status === 412 && reading.code === 'owner_changed') {
      invalidateCommunityAuthority();
    }
    throw err;
  }
  return res;
}

/**
 * Fetch authorized bytes with the same local authentication/error handling as JSON.
 * `timeout: null` is reserved for a stream whose caller owns its header deadline
 * and cancellation; ordinary files retain the normal request timeout.
 */
export function fetchResponse(
  baseUrl: string,
  url: string,
  opts?: RequestInit & { timeout?: number | null }
): Promise<Response> {
  return request(baseUrl, url, opts);
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

/** The most one page of a list holds; the full-list reads below ask for this many at a time. */
const LIST_PAGE_LIMIT = 200;

/** The most pages one full-list read follows: 10,000 rows, far past any list the app shows. */
const LIST_PAGE_CAP = 50;

/**
 * Every row of a paged list (`cursor` and `limit` in, `nextCursor` back), read
 * page by page, for a surface that shows the whole list.
 *
 * @param baseUrl - The API's base URL.
 * @param path - The list's path, without a query string.
 * @param params - The list's own query fields.
 * @param rowsOf - The rows one page holds.
 * @returns The first page, as the server sent it, and every row in server order.
 * @throws {Error} When a cursor comes back twice, or past {@link LIST_PAGE_CAP} pages.
 */
export async function fetchAllPages<P extends { nextCursor: string | null }, T>(
  baseUrl: string,
  path: string,
  params: Record<string, string | number | boolean | undefined>,
  rowsOf: (page: P) => readonly T[]
): Promise<{ first: P; rows: T[] }> {
  const read = (cursor?: string) =>
    fetchJSON<P>(
      baseUrl,
      `${path}${buildQueryString({ ...params, cursor, limit: LIST_PAGE_LIMIT })}`
    );
  const first = await read();
  const rows: T[] = [...rowsOf(first)];
  const seen = new Set<string>();
  for (let cursor = first.nextCursor, pages = 1; cursor; pages++) {
    // A server that hands back a cursor twice, or never ends, must not spin the app forever.
    if (seen.has(cursor) || pages >= LIST_PAGE_CAP) {
      throw new Error(`${path} kept giving more pages; stopped after ${pages}.`);
    }
    seen.add(cursor);
    const page = await read(cursor);
    rows.push(...rowsOf(page));
    cursor = page.nextCursor;
  }
  return { first, rows };
}
