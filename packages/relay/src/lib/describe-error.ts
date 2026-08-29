/**
 * Turn a caught error into the only fields worth logging.
 *
 * @module relay/lib/describe-error
 */

/**
 * Pull the safe-to-log fields out of a caught error, and nothing else.
 *
 * Every relay adapter wraps an HTTP-backed SDK whose caught errors can carry
 * a live credential somewhere inside them (DOR-1509):
 *
 * - `@slack/web-api` v8 dropped axios for native `fetch` (DOR-1542), so a
 *   network-level failure no longer arrives as an axios-shaped error with a
 *   `toJSON()` that serializes the request config. Confirmed against the
 *   installed `@slack/web-api@8.0.0` (`WebClient.js`): anything that is not
 *   already a recognized `SlackError` is wrapped as
 *   `new WebAPIRequestError(error)`, whose constructor puts the raw
 *   underlying error on `.original` and folds its `.message` into its own
 *   (`A request error occurred: ${original.message}`). The bot token still
 *   travels as an `Authorization: Bearer <token>` header (`WebClient.js`
 *   still sets `headers.Authorization` directly) — never in `.message` for a
 *   native-fetch network failure — but `.original` is exactly where a more
 *   revealing underlying transport error (a custom fetch, a corporate-proxy
 *   wrapper) could carry more, so it is still never touched here.
 * - grammY (the Telegram client) builds its request URL as
 *   `https://api.telegram.org/bot<TOKEN>/<method>` — the token lives in the
 *   URL path. On Node it fetches through `node-fetch`, whose `FetchError` is
 *   a pre-ES6 constructor that does an explicit `this.message = message`,
 *   making `.message` an OWN ENUMERABLE property that bakes the token-bearing
 *   URL in verbatim for every network-level failure (confirmed against the
 *   installed `node-fetch@2.7.0`). grammY wraps that in its own `HttpError`
 *   *before it ever reaches adapter code*, and `HttpError`'s own `.message`
 *   stays safe by default (`sensitiveLogs` defaults to `false`, never
 *   overridden in this repo) — but that safety is grammY's, not this
 *   function's: it holds only because every call site here is handed the
 *   wrapped `HttpError`, never a bare `FetchError` directly. A raw
 *   `FetchError` passed to this function would have its token-bearing
 *   `.message` read and logged verbatim — this function only ever protects a
 *   *nested* secret, never one already sitting on the top-level `.message`
 *   it is told to trust.
 *
 * Both real leaks share one shape: the credential survives only on a nested
 * property (`WebAPIRequestError.original`, grammY's `HttpError.error`), never
 * on the top-level `.message` of the wrapper actually caught. So the fix is
 * the same for both, and for anything shaped like them later: read only
 * `.message` (and, when the caller knows the error's shape, a stable `code`)
 * and never spread, serialize, or otherwise touch the error object itself.
 *
 * **Total, by construction.** A hostile or malformed error — a throwing
 * `.message`/`.code` getter, a null-prototype object whose `String()` throws,
 * a third-party `extractCode` that throws — must never crash the logger call
 * that is trying to report a DIFFERENT failure, so every internal step runs
 * inside one try/catch and any throw collapses to a fixed, safe sentinel
 * rather than attempting partial recovery. A `code` — from `extractCode` or
 * the generic fallback alike — is kept only when it is actually a `string`;
 * an object accidentally returned as `code` (a buggy extractor) is dropped
 * rather than logged, so it can never re-introduce the same nested-object
 * leak this function exists to prevent.
 *
 * @param err - The caught value, typed `unknown` at every call site.
 * @param extractCode - Optional adapter-specific code extractor (e.g.
 *   Slack's nested platform-error code, or Telegram's `error_code`). Without
 *   one, falls back to a plain string `.code` field when present. Its return
 *   value is validated the same way regardless of source.
 */
export function describeError(
  err: unknown,
  extractCode?: (err: unknown) => string | undefined
): { message: string; code?: string } {
  try {
    const message = err instanceof Error ? err.message : String(err);
    const rawCode = extractCode ? extractCode(err) : genericErrorCode(err);
    return typeof rawCode === 'string' ? { message, code: rawCode } : { message };
  } catch {
    // Whatever went wrong reading this error's own fields, the caller is
    // already mid-failure-handling for something else — this must never be
    // the thing that throws.
    return { message: 'unserializable error' };
  }
}

/** Fallback code source: a plain `.code` field. The caller validates its type. */
function genericErrorCode(err: unknown): unknown {
  return (err as { code?: unknown } | null)?.code;
}
