/**
 * A typed caller for the DorkOS HTTP API, keyed by operationId.
 *
 * The types come from `docs/api/openapi.json` (`./generated/openapi.ts`) and the
 * method and path of each operation from `./generated/operation-routes.ts`, so a
 * call names an operation and gets that operation's input and answer types:
 *
 * ```ts
 * const api = createApiClient({ baseUrl: '/api' });
 * await api.call('extensions.restart', { path: { id: 'notes' } });
 * ```
 *
 * Small on purpose: it builds the URL and the body, hands both to the `fetch`
 * it was given, and reads the answer. Anything else a caller needs on every
 * request (credentials, timeouts, shared headers, how a refusal becomes an
 * error) belongs in that `fetch`, which is how the app's `HttpTransport` keeps
 * one request path for hand-written and generated calls alike. A header one
 * call needs and others don't (a window's `X-Client-Id`) rides in its input's
 * `headers`.
 *
 * @module api-client/client
 */
import { isProblem, readErrorBody, type Problem } from '@dorkos/shared/problem';
import type { operations } from './generated/openapi.js';
import { OPERATION_ROUTES } from './generated/operation-routes.js';

/** Every operation the API document names. */
export type OperationId = keyof operations;

/** The subset of the `fetch` signature this client uses. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Where the API lives and how to reach it. */
export interface ApiClientOptions {
  /** The URL the document's `/api` mount lives at, such as `/api` or `https://host:4242/api`. */
  baseUrl: string;
  /** The `fetch` to send with. Defaults to the global one. */
  fetch?: FetchLike;
}

type Operation<Id extends OperationId> = operations[Id];
type Parameters<Id extends OperationId> = Operation<Id> extends { parameters: infer P } ? P : never;

/** A field that is left out when the operation has none, and optional when it may be omitted. */
type Field<Key extends string, Value> = [Exclude<Value, undefined>] extends [never]
  ? { [K in Key]?: never }
  : undefined extends Value
    ? { [K in Key]?: Exclude<Value, undefined> }
    : { [K in Key]: Value };

type ParameterIn<Id extends OperationId, Where extends string> =
  Parameters<Id> extends { [K in Where]: infer V }
    ? V
    : Parameters<Id> extends { [K in Where]?: infer V }
      ? V | undefined
      : undefined;

type JsonBody<Id extends OperationId> =
  Operation<Id> extends { requestBody: { content: { 'application/json': infer B } } }
    ? B
    : Operation<Id> extends { requestBody?: { content: { 'application/json': infer B } } }
      ? B | undefined
      : undefined;

/**
 * The only headers a call may add of its own, lowercased: a window's
 * `X-Client-Id`, the connector catalog's ask for sign-in setup details, and
 * the approval token a confirming retry of a capability call carries.
 * Everything else (the body's type, the cookie, credentials, the
 * community-owner header) belongs to the request path, so a call that names
 * anything not listed here is refused.
 */
export const ALLOWED_CALL_HEADERS: readonly string[] = [
  'x-client-id',
  'x-dorkos-catalog-auth-setup',
  'x-dorkos-approval',
];

/**
 * What a call to an operation takes: its path and query parameters, its JSON
 * body, and any headers this one call adds (only those in
 * {@link ALLOWED_CALL_HEADERS}).
 */
export type OperationInput<Id extends OperationId> = Field<'path', ParameterIn<Id, 'path'>> &
  Field<'query', ParameterIn<Id, 'query'>> &
  Field<'body', JsonBody<Id>> & { headers?: Record<string, string> };

type SuccessStatus = 200 | 201 | 202 | 203 | 204 | 206;
type Responses<Id extends OperationId> = Operation<Id> extends { responses: infer R } ? R : never;
type ResponseBody<R> = R extends { content: { 'application/json': infer B } } ? B : undefined;

/** What a successful call answers: the JSON body of any of the operation's 2xx responses. */
export type OperationResult<Id extends OperationId> = {
  [S in keyof Responses<Id> & SuccessStatus]: ResponseBody<Responses<Id>[S]>;
}[keyof Responses<Id> & SuccessStatus];

/** Per-call settings that ride along to `fetch`. */
export type CallOptions = Pick<RequestInit, 'signal'>;

/**
 * A non-2xx answer. Every DorkOS error is an RFC 9457 problem document, so
 * {@link problem} holds it; the few answers that are not problems on purpose
 * (the login gate and a held action, `readErrorBody` in `@dorkos/shared/problem`)
 * leave it `undefined` and still give a message and {@link code}.
 */
export class ApiProblemError extends Error {
  /** The HTTP status. */
  readonly status: number;
  /** The problem document, when the answer was one. */
  readonly problem: Problem | undefined;
  /** The machine-readable code, from the problem or a held answer. */
  readonly code: string | undefined;
  /** The parsed body as it came, or `undefined` when it was not JSON. */
  readonly body: unknown;

  /**
   * Build the error from a failed answer's status and parsed body.
   *
   * @param status - The HTTP status.
   * @param body - The parsed JSON body, or `undefined`.
   * @param fallbackMessage - The message when the body says none.
   */
  constructor(status: number, body: unknown, fallbackMessage: string) {
    const reading = readErrorBody(body, fallbackMessage);
    super(reading.message);
    this.name = 'ApiProblemError';
    this.status = status;
    this.problem = isProblem(body) ? body : undefined;
    this.code = reading.code;
    this.body = body;
  }
}

/** A typed client for the DorkOS HTTP API. */
export interface ApiClient {
  /**
   * Call one operation by its operationId.
   *
   * @param operationId - The operation, as `docs/api/openapi.json` names it.
   * @param input - Its path and query parameters, its JSON body and its own headers.
   * @param options - A signal for this call.
   * @returns The answer's JSON body, or `undefined` for an empty answer.
   * @throws {SyntaxError} When a 2xx answer has a body that is not JSON.
   * @throws {ApiProblemError} When the answer is not 2xx (unless the `fetch`
   *   the client was given throws first).
   * @throws {TypeError} When `input.headers` names a header not in
   *   {@link ALLOWED_CALL_HEADERS}, before anything is sent.
   */
  call<Id extends OperationId>(
    operationId: Id,
    input: OperationInput<Id>,
    options?: CallOptions
  ): Promise<OperationResult<Id>>;
}

/** Fill an operation's path template, encoding each value. */
function fillPath(operationId: string, template: string, values: Record<string, unknown> = {}) {
  return template.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const value = values[name];
    if (value === undefined || value === null) {
      throw new TypeError(`${operationId} needs the path parameter "${name}".`);
    }
    return encodeURIComponent(String(value));
  });
}

/**
 * The call's own headers, refusing any not on the allow list. The names are
 * read back from `Headers`, which lowercases them, so a `Headers` instance or
 * an entries array cast past the type is checked the same way. The error names
 * the header, never its value.
 */
function callHeaders(operationId: string, values?: HeadersInit): Headers {
  const headers = new Headers(values);
  for (const name of headers.keys()) {
    if (!ALLOWED_CALL_HEADERS.includes(name)) {
      throw new TypeError(`${operationId} may not set the "${name}" header itself.`);
    }
  }
  return headers;
}

/** Serialize query parameters, leaving out `undefined` and repeating arrays. */
function queryString(values: Record<string, unknown> = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== undefined && item !== null) params.append(key, String(item));
    }
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

/**
 * Create a client bound to one API mount.
 *
 * A call sends a body only when it is given one, writes included, as the
 * app's hand-written writes do. A write sent with no body carries no
 * `Content-Type` from here, and some server routes refuse a write without
 * `application/json`: the `fetch` you pass must add it (the app's transport
 * does).
 *
 * @param options - The base URL and the `fetch` to send with.
 * @returns The client.
 */
export function createApiClient(options: ApiClientOptions): ApiClient {
  const send = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  return {
    async call(operationId, input, callOptions) {
      const route = OPERATION_ROUTES[operationId];
      const loose = input as {
        path?: Record<string, unknown>;
        query?: Record<string, unknown>;
        body?: unknown;
        headers?: Record<string, string>;
      };
      const url = `${options.baseUrl}${fillPath(operationId, route.path, loose.path)}${queryString(loose.query)}`;
      const body = loose.body === undefined ? undefined : JSON.stringify(loose.body);
      const headers = callHeaders(operationId, loose.headers);
      if (body !== undefined && !headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json');
      }
      const res = await send(url, {
        method: route.method,
        headers,
        ...(body === undefined ? {} : { body }),
        ...(callOptions?.signal ? { signal: callOptions.signal } : {}),
      });
      const text = await res.text();
      if (!res.ok) {
        const parsed: unknown = text ? safeJson(text) : undefined;
        throw new ApiProblemError(res.status, parsed, res.statusText || `HTTP ${res.status}`);
      }
      // An empty answer (a 204) is `undefined`. A body that is not JSON (an HTML
      // fallback page, say) throws a `SyntaxError`, as `res.json()` did for the
      // hand-written calls; the message never repeats the body.
      if (!text) return undefined as OperationResult<typeof operationId>;
      try {
        return JSON.parse(text) as OperationResult<typeof operationId>;
      } catch {
        // No `cause`: the parser's own error quotes the start of the body.
        // eslint-disable-next-line preserve-caught-error
        throw new SyntaxError(`${operationId} answered with a body that is not JSON.`);
      }
    },
  };
}

/** Parse a failed answer's JSON, or `undefined` when it is not JSON. */
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
