/**
 * The two ways an extension's server half can serve its API at
 * `/api/ext/<id>/*`, and how the host reads which one a server entry uses.
 *
 * - **An Express router.** `register(router, ctx)` adds routes to the router
 *   it is handed, as it always has.
 * - **A fetch handler.** `register` returns `{ fetch }`: a function that takes
 *   a web-standard `Request` and returns a `Response`, the shape a Hono app
 *   exposes. It runs on Node, so Bun- or Deno-only APIs are not there. A server entry that needs nothing from `ctx` can
 *   export that object itself (`export default app` for a Hono app).
 *
 * Both work together: a request the router does not answer goes to the
 * `dataProxy` when the request is for `/proxy/*` and the manifest declares
 * one, then to `fetch`.
 *
 * @module server-entry
 */
import type { DataProviderContext } from './server-extension-api.js';

/**
 * A web-standard request handler. It gets the request with the path below
 * the extension's mount: a request to `/api/ext/my-ext/items?page=2` arrives
 * with the URL `http://<host>/items?page=2`.
 */
export type ExtensionFetchHandler = (request: Request) => Response | Promise<Response>;

/** What `register()` returns to serve its API with a fetch handler. */
export interface ServerExtensionHandlers {
  /** Answers every request under `/api/ext/<id>/` the router does not. */
  fetch?: ExtensionFetchHandler;
  /** Called when the extension stops, like the function `register()` may return. */
  cleanup?: () => void | Promise<void>;
}

/** What `register()` may return: nothing, a cleanup function, or handlers. */
export type ServerExtensionRegisterResult = void | (() => void) | ServerExtensionHandlers;

/** Server-side extension entry point signature. */
export type ServerExtensionRegister = (
  router: import('express').Router,
  ctx: DataProviderContext
) => ServerExtensionRegisterResult | Promise<ServerExtensionRegisterResult>;

/**
 * The register function a loaded server entry provides, or `null` when it
 * provides none.
 *
 * Accepts `module.exports = register`, `export default register`, and a
 * default export that is itself a fetch handler's owner (`{ fetch }`, or a
 * Hono app), which is served as if `register` had returned it.
 *
 * @param exported - What loading the server entry produced.
 */
export function serverEntryRegister(exported: unknown): ServerExtensionRegister | null {
  const candidate =
    exported && typeof exported === 'object' && 'default' in exported
      ? (exported as { default: unknown }).default
      : exported;
  if (typeof candidate === 'function') return candidate as ServerExtensionRegister;
  if (hasFetch(candidate)) {
    return () => ({ fetch: (request) => candidate.fetch(request) });
  }
  return null;
}

/** What {@link readRegisterResult} found. */
export interface RegisterOutcome {
  /** Called when the extension stops. */
  cleanup: (() => unknown) | null;
  /** The fetch handler, when `register()` returned one. */
  fetch: ExtensionFetchHandler | null;
}

/**
 * Read what `register()` returned: a cleanup function, `{ fetch, cleanup }`,
 * or nothing.
 *
 * @param result - The value `register()` resolved to.
 * @throws TypeError when it returned `fetch` or `cleanup` that is not a function.
 */
export function readRegisterResult(result: unknown): RegisterOutcome {
  if (typeof result === 'function') return { cleanup: result as () => unknown, fetch: null };
  if (!result || typeof result !== 'object') return { cleanup: null, fetch: null };
  const { fetch, cleanup } = result as { fetch?: unknown; cleanup?: unknown };
  if (fetch !== undefined && typeof fetch !== 'function') {
    throw new TypeError('register() returned a `fetch` that is not a function');
  }
  if (cleanup !== undefined && typeof cleanup !== 'function') {
    throw new TypeError('register() returned a `cleanup` that is not a function');
  }
  return {
    cleanup: cleanup ? () => (cleanup as () => unknown).call(result) : null,
    fetch: fetch ? (request) => (fetch as ExtensionFetchHandler).call(result, request) : null,
  };
}

/** Whether a value carries a `fetch` method. */
function hasFetch(value: unknown): value is { fetch: ExtensionFetchHandler } {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as { fetch?: unknown }).fetch === 'function'
  );
}
