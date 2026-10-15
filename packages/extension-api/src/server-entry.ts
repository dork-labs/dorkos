/**
 * How an extension's server half serves its API at `/api/ext/<id>/*`, and how
 * the host reads a server entry.
 *
 * A server entry default-exports {@link defineServer}: a function DorkOS calls
 * with `ctx` that returns `{ fetch }`, a function that takes a web-standard
 * `Request` and returns a `Response` (the shape a Hono app exposes). `hono` is
 * built in: an extension imports it with nothing installed. It runs on Node,
 * so Bun- or Deno-only APIs are not there. A server entry that needs nothing
 * from `ctx` can export the handler's owner itself (`export default app`).
 *
 * A fetch handler gets who is asking as its second argument
 * ({@link ExtensionCaller}), which a Hono app reads as `c.env`. To keep a
 * route to people only, put {@link requirePerson} in front of it, or call
 * {@link checkPerson} in a handler written without Hono.
 *
 * DorkOS no longer runs the old Express router (DOR-2856). An older
 * `register(router, ctx)` entry still starts as long as it never touches
 * `router`; one that does stops with {@link OLD_ROUTER_MESSAGE}.
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

/** What a server entry's start returns to serve its API. */
export interface ServerExtensionHandlers {
  /** Answers every request under `/api/ext/<id>/`. */
  fetch?: ExtensionFetchHandler;
  /** Called when the extension stops. */
  cleanup?: () => void | Promise<void>;
}

/** What a server entry's start may return: nothing, a cleanup function, or handlers. */
export type ServerExtensionRegisterResult = void | (() => void) | ServerExtensionHandlers;

/** Starts an extension's server half with its context. */
export type ServerStart = (
  ctx: DataProviderContext
) => ServerExtensionRegisterResult | Promise<ServerExtensionRegisterResult>;

/**
 * An older server entry: `register(router, ctx)`. DorkOS hands it a router
 * that stops the extension with {@link OLD_ROUTER_MESSAGE} if touched.
 *
 * @deprecated Default-export {@link defineServer} instead (DOR-2856).
 */
export type ServerExtensionRegister = (
  router: unknown,
  ctx: DataProviderContext
) => ServerExtensionRegisterResult | Promise<ServerExtensionRegisterResult>;

/** The mark {@link defineServer} puts on what it returns. */
const SERVER_DEFINITION = Symbol.for('dorkos.extension.serverDefinition');

/** A server entry made with {@link defineServer}. */
export interface ServerDefinition {
  /** The start function, under the mark the host looks for. */
  readonly [SERVER_DEFINITION]: ServerStart;
}

/**
 * Define an extension's server half: a function DorkOS calls with `ctx`, which
 * returns `{ fetch, cleanup? }`.
 *
 * ```ts
 * import { Hono } from 'hono';
 * import { defineServer, requirePerson } from '@dorkos/extension-api/server';
 *
 * export default defineServer((ctx) => {
 *   const app = new Hono();
 *   app.get('/items', async (c) => c.json((await ctx.storage.loadData()) ?? []));
 *   app.put('/items', requirePerson(), async (c) => {
 *     await ctx.storage.saveData(await c.req.json());
 *     return c.json({ ok: true });
 *   });
 *   return { fetch: app.fetch };
 * });
 * ```
 *
 * @param start - Called once when the extension starts.
 */
export function defineServer(start: ServerStart): ServerDefinition {
  if (typeof start !== 'function') {
    throw new TypeError('defineServer() needs a function that takes ctx.');
  }
  return Object.freeze({ [SERVER_DEFINITION]: start });
}

/** What an extension that touches the old router stops with. */
export const OLD_ROUTER_MESSAGE =
  'This extension uses the old router, which DorkOS no longer runs. Ask an agent to update it.';

/** Thrown when an older `register(router, ctx)` touches `router`. */
export class OldRouterError extends Error {
  /** Names this failure for the host. */
  readonly code = 'old_router';

  /** Make the error. */
  constructor() {
    super(OLD_ROUTER_MESSAGE);
    this.name = 'OldRouterError';
  }
}

/**
 * The `ctx` members, so a server entry written as a bare `(ctx) => …` that
 * reads one from the router it is handed is told to wrap itself in
 * {@link defineServer}, not that it uses the old router.
 */
const CTX_MEMBERS = new Set([
  'secrets',
  'settings',
  'storage',
  'schedule',
  'emit',
  'extensionId',
  'extensionDir',
  'dorkHome',
  'filesDir',
  'accounts',
  'projects',
  'inbox',
  'projectSettings',
  'sessions',
  'agent',
  'tools',
]);

/** What a bare `(ctx) => …` server entry stops with. */
export const UNWRAPPED_SERVER_MESSAGE =
  'This server entry takes ctx directly. Wrap it: export default defineServer((ctx) => { ... }).';

/** The router an older `register(router, ctx)` is handed: touching it throws. */
const RETIRED_ROUTER: unknown = new Proxy(Object.freeze({}), {
  get(_target, key) {
    if (typeof key === 'string' && CTX_MEMBERS.has(key)) {
      throw new TypeError(UNWRAPPED_SERVER_MESSAGE);
    }
    throw new OldRouterError();
  },
  set() {
    throw new OldRouterError();
  },
  has() {
    throw new OldRouterError();
  },
});

/**
 * How to start the server half a loaded server entry provides, or `null`
 * when it provides none.
 *
 * Accepts, as `module.exports` or `export default`: a {@link defineServer}
 * definition; a fetch handler's owner (`{ fetch }`, or a Hono app), served as
 * if a start had returned it; or an older `register(router, ctx)` function,
 * handed a router that stops the extension if touched.
 *
 * @param exported - What loading the server entry produced.
 */
export function serverEntryStart(exported: unknown): ServerStart | null {
  const candidate =
    exported && typeof exported === 'object' && 'default' in exported
      ? (exported as { default: unknown }).default
      : exported;
  const defined =
    candidate && typeof candidate === 'object'
      ? (candidate as Partial<ServerDefinition>)[SERVER_DEFINITION]
      : undefined;
  if (typeof defined === 'function') return defined;
  if (typeof candidate === 'function') {
    const register = candidate as ServerExtensionRegister;
    return (ctx) => register(RETIRED_ROUTER, ctx);
  }
  if (hasFetch(candidate)) {
    return () => ({ fetch: (request, caller) => candidate.fetch(request, caller) });
  }
  return null;
}

/** What {@link readRegisterResult} found. */
export interface RegisterOutcome {
  /** Called when the extension stops. */
  cleanup: (() => unknown) | null;
  /** The fetch handler, when the start returned one. */
  fetch: ExtensionFetchHandler | null;
}

/**
 * Read what a server entry's start returned: a cleanup function,
 * `{ fetch, cleanup }`, or nothing.
 *
 * @param result - The value the start resolved to.
 * @throws TypeError when it returned `fetch` or `cleanup` that is not a function.
 */
export function readRegisterResult(result: unknown): RegisterOutcome {
  if (typeof result === 'function') return { cleanup: result as () => unknown, fetch: null };
  if (!result || typeof result !== 'object') return { cleanup: null, fetch: null };
  const { fetch, cleanup } = result as { fetch?: unknown; cleanup?: unknown };
  if (fetch !== undefined && typeof fetch !== 'function') {
    throw new TypeError('The server half returned a `fetch` that is not a function');
  }
  if (cleanup !== undefined && typeof cleanup !== 'function') {
    throw new TypeError('The server half returned a `cleanup` that is not a function');
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
