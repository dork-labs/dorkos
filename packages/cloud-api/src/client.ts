/**
 * A thin `fetch` client for the DorkOS Cloud `/v1` contract.
 *
 * Deliberately small and deliberately portable: no Node-only import, no
 * dependency beyond `zod`, and no baked-in origin. A CLI, a server and a
 * browser can all use it, and the caller supplies the base URL, so nothing in
 * this package knows where the service lives.
 *
 * @packageDocumentation
 */
import type { z } from 'zod';

import { WIRE_VERSION_HEADER, WIRE_VERSION_HEADER_VALUE } from './primitives.js';
import { ProblemSchema, type Problem } from './problem.js';

/** The subset of the `fetch` signature this client uses. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** How to reach the service, and who is calling. */
export interface CloudApiClientOptions {
  /** The origin the `/v1` paths hang off, e.g. `https://example.invalid`. No default: this package bakes in no host. */
  baseUrl: string;
  /** The bearer token, or a function returning one. Omitted for the two device-code routes, which are unauthenticated. */
  token?: string | (() => string | undefined | Promise<string | undefined>);
  /** The `fetch` to use. Defaults to the global one. */
  fetch?: FetchLike;
  /** Extra headers sent with every request. */
  headers?: Record<string, string>;
}

/** What one call may override. */
export interface RequestOptions {
  /** Query parameters. Values that are `undefined` are dropped. */
  query?: Record<string, string | number | boolean | undefined>;
  /** A JSON request body. */
  body?: unknown;
  /** Aborts the request. */
  signal?: AbortSignal;
  /** Extra headers for this call only. */
  headers?: Record<string, string>;
}

/**
 * A response that is neither the route's success schema nor a well-formed
 * {@link Problem}.
 *
 * It is its own error rather than a generic one because the two failures need
 * different follow-up: a malformed problem envelope is a service bug, and a
 * success body that fails its schema usually means the client is older than the
 * contract the service is serving.
 */
export class CloudApiResponseError extends Error {
  /** The HTTP status the service answered with. */
  readonly status: number;

  /** The raw body, for a bug report. */
  readonly body: unknown;

  /**
   * Builds the error.
   *
   * @param message - What went wrong.
   * @param status - The HTTP status the service answered with.
   * @param body - The raw response body.
   */
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = 'CloudApiResponseError';
    this.status = status;
    this.body = body;
  }
}

/**
 * A refusal the service described with the contract's {@link Problem}
 * envelope.
 */
export class CloudApiProblemError extends Error {
  /** The parsed problem envelope. */
  readonly problem: Problem;

  /**
   * Builds the error.
   *
   * @param problem - The parsed problem envelope.
   */
  constructor(problem: Problem) {
    super(`${problem.code}: ${problem.title}`);
    this.name = 'CloudApiProblemError';
    this.problem = problem;
  }
}

/**
 * Narrows an unknown error to a {@link CloudApiProblemError}.
 *
 * @param error - The caught value.
 */
export function isCloudApiProblemError(error: unknown): error is CloudApiProblemError {
  return error instanceof CloudApiProblemError;
}

/**
 * Creates a client bound to one origin and one credential.
 *
 * @param options - Where to reach the service and who is calling.
 */
export function createCloudApiClient(options: CloudApiClientOptions) {
  const doFetch: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const base = options.baseUrl.replace(/\/+$/, '');

  /**
   * Sends one request and validates the answer against `schema`.
   *
   * Throws {@link CloudApiProblemError} when the service refuses, and
   * {@link CloudApiResponseError} when neither the success schema nor the
   * problem envelope fits.
   *
   * @param method - The HTTP method.
   * @param path - A `/v1` path from `V1_ROUTES` or `v1Path`.
   * @param schema - The success schema for this route.
   * @param init - Query, body, headers and an abort signal.
   */
  async function request<T extends z.ZodTypeAny>(
    method: string,
    path: string,
    schema: T,
    init: RequestOptions = {}
  ): Promise<z.output<T>> {
    const url = new URL(base + path);
    for (const [key, value] of Object.entries(init.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    // Headers are merged case-insensitively, which a plain object spread cannot
    // do. HTTP header names are case-insensitive, so a caller passing
    // `Authorization` alongside this client's lowercase `authorization` does not
    // override it — `Headers` keeps both and joins them with a comma, and
    // `Bearer a, Bearer b` is not a credential any service accepts. Same for a
    // caller's `Accept`. Lowercasing every key before merging makes the later
    // value win, which is what "override" has to mean.
    const token = typeof options.token === 'function' ? await options.token() : options.token;
    const headers: Record<string, string> = {};
    /**
     * Merges one set of headers, letting a later value replace an earlier one
     * whatever its casing.
     *
     * @param source - The headers to merge in.
     */
    const merge = (source: Record<string, string> | undefined): void => {
      for (const [key, value] of Object.entries(source ?? {})) headers[key.toLowerCase()] = value;
    };

    merge({
      accept: 'application/json',
      [WIRE_VERSION_HEADER]: WIRE_VERSION_HEADER_VALUE,
    });
    // The token goes on before the caller's headers, so a per-call
    // `Authorization` replaces it rather than being silently discarded.
    if (token) headers.authorization = `Bearer ${token}`;
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    merge(options.headers);
    merge(init.headers);

    const response = await doFetch(url.toString(), {
      method,
      headers,
      signal: init.signal,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });

    // 204 is a success with nothing to validate. Hand the schema `undefined`
    // rather than parsing an empty string as JSON, so a route typed
    // `z.void()` succeeds and one typed as an object fails loudly.
    const text = response.status === 204 ? '' : await response.text();
    let payload: unknown;
    if (text === '') {
      payload = undefined;
    } else {
      try {
        payload = JSON.parse(text);
      } catch (error) {
        throw new CloudApiResponseError(
          `Response body was not JSON: ${(error as Error).message}`,
          response.status,
          text
        );
      }
    }

    if (!response.ok) {
      const problem = ProblemSchema.safeParse(payload);
      if (problem.success) throw new CloudApiProblemError(problem.data);
      throw new CloudApiResponseError(
        `HTTP ${response.status} with a body that is not a Problem envelope`,
        response.status,
        payload
      );
    }

    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new CloudApiResponseError(
        `Response did not match the contract: ${parsed.error.message}`,
        response.status,
        payload
      );
    }
    return parsed.data as z.output<T>;
  }

  return {
    request,
    /**
     * `GET` one route.
     *
     * @param path - A `/v1` path.
     * @param schema - The success schema for this route.
     * @param init - Query, headers and an abort signal.
     */
    get: <T extends z.ZodTypeAny>(path: string, schema: T, init?: RequestOptions) =>
      request('GET', path, schema, init),
    /**
     * `POST` to one route.
     *
     * @param path - A `/v1` path.
     * @param schema - The success schema for this route.
     * @param init - Body, query, headers and an abort signal.
     */
    post: <T extends z.ZodTypeAny>(path: string, schema: T, init?: RequestOptions) =>
      request('POST', path, schema, init),
    /**
     * `PATCH` one route.
     *
     * @param path - A `/v1` path.
     * @param schema - The success schema for this route.
     * @param init - Body, query, headers and an abort signal.
     */
    patch: <T extends z.ZodTypeAny>(path: string, schema: T, init?: RequestOptions) =>
      request('PATCH', path, schema, init),
    /**
     * `PUT` one route.
     *
     * @param path - A `/v1` path.
     * @param schema - The success schema for this route.
     * @param init - Body, query, headers and an abort signal.
     */
    put: <T extends z.ZodTypeAny>(path: string, schema: T, init?: RequestOptions) =>
      request('PUT', path, schema, init),
    /**
     * `DELETE` one route.
     *
     * @param path - A `/v1` path.
     * @param schema - The success schema for this route.
     * @param init - Query, headers and an abort signal.
     */
    delete: <T extends z.ZodTypeAny>(path: string, schema: T, init?: RequestOptions) =>
      request('DELETE', path, schema, init),
  };
}

/** A client bound to one origin and one credential. */
export type CloudApiClient = ReturnType<typeof createCloudApiClient>;
