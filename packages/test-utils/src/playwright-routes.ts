/**
 * Playwright route helpers that never strand a request.
 *
 * `page.route(url, handler, { times: n })` unregisters itself once it has run
 * `n` times, and that removal is asynchronous. A request the page issues while
 * the removal is still settling can be caught by the interception layer with no
 * handler left to answer it, so it never reaches the server and the test hangs
 * until its timeout. PR #1999 hit exactly this on the owner-claim spec: a
 * `times: 1` failure route followed by a retry against the same URL.
 *
 * The helper here stays registered for the whole page lifetime instead. It
 * answers the first `count` matching requests itself, then hands every later
 * one to `route.fallback()`, which lets it reach earlier routes or the network
 * exactly as if this route were gone. No unregistering, so no window.
 *
 * `scripts/__tests__/one-shot-routes.test.ts` refuses new `times:` options in
 * the browser suites so the pattern cannot creep back in.
 *
 * Kept structural (no `@playwright/test` import) so this package does not take
 * a Playwright dependency; a Playwright `Page` or `BrowserContext` satisfies
 * {@link RouteTarget} as is.
 *
 * @module playwright-routes
 */

/** The part of a Playwright `Route` this helper needs. */
export interface FallbackRoute {
  /** Pass the request on to the next matching route, or the network. */
  fallback(): Promise<void>;
}

/** Anything that registers routes the way a Playwright `Page` or `BrowserContext` does. */
export interface RouteTarget<R extends FallbackRoute> {
  /** Register `handler` for requests matching `url`. */
  route(url: string | RegExp, handler: (route: R) => unknown): Promise<unknown>;
}

/** Options for {@link interceptNext}. */
export interface InterceptNextOptions<R extends FallbackRoute> {
  /** How many matching requests to intercept before stepping aside. Defaults to 1. */
  count?: number;
  /**
   * Narrow which matching requests count. A request that fails the filter falls
   * through untouched and does not use up the count, for example to fail only
   * `GET` reads of a URL the page also writes to.
   */
  filter?: (route: R) => boolean;
}

/**
 * Intercept the next `count` requests matching `url`, then let every later one
 * through, without ever unregistering the route. Use it instead of
 * `page.route(url, handler, { times: n })`.
 *
 * ```ts
 * await interceptNext(page, '**\/api/v1/host/communities', (route) =>
 *   route.fulfill({ status: 503, body: '{}' })
 * );
 * ```
 *
 * @param target - The Playwright `Page` or `BrowserContext` to route on.
 * @param url - The URL glob or pattern, exactly as `page.route` takes it.
 * @param handle - Answers an intercepted request (fulfill, abort, continue, ...).
 * @param options - How many requests to intercept, and which ones count.
 * @returns The promise from registering the route.
 */
export function interceptNext<R extends FallbackRoute>(
  target: RouteTarget<R>,
  url: string | RegExp,
  handle: (route: R) => unknown,
  options: InterceptNextOptions<R> = {}
): Promise<unknown> {
  const { count = 1, filter } = options;
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError(`interceptNext count must be a positive integer, got ${count}`);
  }
  let remaining = count;
  return target.route(url, async (route) => {
    if (remaining === 0 || (filter && !filter(route))) return route.fallback();
    remaining -= 1;
    await handle(route);
  });
}
