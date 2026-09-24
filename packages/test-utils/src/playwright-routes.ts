/**
 * Playwright route helpers that never strand a request.
 *
 * What was observed: PR #1999 found that after a `page.route(url, handler,
 * { times: 1 })` failure route had run, the page's retry against the same URL
 * could hang. It never reached the server, and the test waited out its timeout.
 * The exact mechanism inside Playwright was not pinned down. The likely one is
 * the moment an exhausted route is retired while the page's next matching
 * request is already on its way.
 *
 * The helper here never retires its route, so that moment never comes. It
 * answers the first `count` matching requests itself, then hands every later
 * one to `route.fallback()`, which lets it reach earlier routes or the network
 * exactly as if this route were gone.
 *
 * `scripts/check-one-shot-routes.ts` refuses new `times:` options in the
 * browser suites so the pattern cannot creep back in.
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
