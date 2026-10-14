/**
 * The two ways an extension's server half can serve its API at
 * `/api/ext/<id>/*`, and how the host reads which one a server entry uses.
 *
 * - **An Express router.** `register(router, ctx)` adds routes to the router
 *   it is handed, as it always has.
 * - **A fetch handler.** `register` returns `{ fetch }`: a function that takes
 *   a web-standard `Request` and returns a `Response`, the shape a Hono app
 *   exposes. It runs on Node, so Bun- or Deno-only APIs are not there. A server entry that needs nothing from `ctx` can
 *   export that object itself (`export default app` for a Hono app). `hono`
 *   is built in: an extension imports it with nothing installed.
 *
 * A fetch handler gets who is asking as its second argument
 * ({@link ExtensionCaller}), which a Hono app reads as `c.env`. To keep a
 * route to people only, put {@link requirePerson} in front of it, or call
 * {@link checkPerson} in a handler written without Hono.
 *
 * Both work together: a request the router does not answer goes to the
 * `dataProxy` when the request is for `/proxy/*` and the manifest declares
 * one, then to `fetch`.
 *
 * @module server-entry
 */
import type { DataProviderContext } from './server-extension-api.js';

/** What DorkOS answers a caller who is not a person with. */
export interface PersonRefusal {
  /** Not a person. */
  readonly ok: false;
  /** The HTTP status to answer with. */
  readonly status: number;
  /** The JSON body to answer with. */
  readonly body: { readonly error: string; readonly code: string; readonly message: string };
}

/**
 * Whether the caller passed the person bar, the same bar as approving an
 * extension, including its login-off residual: with Require login off, a
 * local caller that does not name itself an agent passes, and in any posture
 * this extension's own page code passes.
 */
export type PersonCheck = { readonly ok: true } | PersonRefusal;

/**
 * Who sent a request, as DorkOS decided before handing it over. The request
 * itself carries no cookie a handler could use to decide this, in an
 * extension that runs in its own process.
 */
export interface ExtensionCaller {
  /** Whether the caller is a person. */
  readonly person: PersonCheck;
}

/**
 * A web-standard request handler. It gets the request with the path below
 * the extension's mount: a request to `/api/ext/my-ext/items?page=2` arrives
 * with the URL `http://<host>/items?page=2`. The second argument says who
 * sent it, which a Hono app reads as `c.env`.
 */
export type ExtensionFetchHandler = (
  request: Request,
  caller: ExtensionCaller
) => Response | Promise<Response>;

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
    return () => ({ fetch: (request, caller) => candidate.fetch(request, caller) });
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
    fetch: fetch
      ? (request, caller) => (fetch as ExtensionFetchHandler).call(result, request, caller)
      : null,
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

/** What a caller DorkOS said nothing about is refused with: fail closed. */
const UNKNOWN_CALLER: PersonRefusal = {
  ok: false,
  status: 403,
  body: {
    error: 'Only a person can do this.',
    code: 'extension_person_required',
    message: 'DorkOS changed nothing. Only a person can do this. Ask them to do it in DorkOS.',
  },
};

/**
 * The answer to send a caller who is not a person, or `null` when the caller
 * is one. For a fetch handler written without Hono:
 *
 * ```ts
 * fetch(request, caller) {
 *   const refused = checkPerson(caller);
 *   if (refused) return refused;
 *   // ...
 * }
 * ```
 *
 * Anything that is not a caller DorkOS handed over is refused.
 *
 * @param caller - The second argument the fetch handler was called with.
 */
export function checkPerson(caller: unknown): Response | null {
  const person = (caller as { person?: unknown } | null | undefined)?.person;
  const check: PersonCheck = isPersonCheck(person) ? person : UNKNOWN_CALLER;
  if (check.ok) return null;
  return Response.json(check.body, { status: check.status });
}

/**
 * Hono middleware that admits only a person; anyone else is answered as
 * {@link checkPerson} answers them. Put it in front of every route that
 * changes something on a person's behalf:
 *
 * ```ts
 * import { Hono } from 'hono';
 * import { requirePerson } from '@dorkos/extension-api/server';
 *
 * const app = new Hono();
 * app.put('/settings', requirePerson(), async (c) => c.json(await save(await c.req.json())));
 * ```
 *
 * Typed without Hono's own types, so this package does not depend on it.
 */
export function requirePerson(): (
  c: { readonly env: unknown },
  next: () => Promise<void>
) => Promise<Response | void> {
  return async (c, next) => {
    const refused = checkPerson(c.env);
    if (refused) return refused;
    await next();
  };
}

/** Whether a value is a well-formed {@link PersonCheck}. */
function isPersonCheck(value: unknown): value is PersonCheck {
  if (!value || typeof value !== 'object') return false;
  const check = value as { ok?: unknown; status?: unknown; body?: unknown };
  if (check.ok === true) return true;
  if (check.ok !== false) return false;
  const body = check.body as { error?: unknown; code?: unknown; message?: unknown } | null;
  return (
    typeof check.status === 'number' &&
    Number.isInteger(check.status) &&
    check.status >= 400 &&
    check.status <= 599 &&
    !!body &&
    typeof body === 'object' &&
    typeof body.error === 'string' &&
    typeof body.code === 'string' &&
    typeof body.message === 'string'
  );
}
