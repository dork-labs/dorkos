/**
 * API oracles: assert that the running server's state reflects the prompt's
 * side effect — a `pulse_schedules` row surfaced by `GET /api/tasks`, a created
 * agent listed by `GET /api/agents`, a healthy server. Asserts on the API
 * response (status + parsed body), never on the assistant's prose.
 *
 * @module evals/oracles/api
 */
import type { Oracle, OracleContext } from '../types.js';

/** A path to GET: a fixed string or one resolved from the oracle context. */
export type ApiPath = string | ((ctx: OracleContext) => string);

/**
 * How much of a response body is kept as evidence.
 *
 * Evidence lands in the JSONL transcript, which the credentialed CI job uploads
 * as a 30-day artifact — so a body recorded here is a body published. The sandbox
 * `DORK_HOME` holds `mcp-local-token` and `better-auth-secret`, and while no
 * current case GETs a route that serves either, an oracle added later could. A
 * bound is the cheap half of that defense: it caps how much of any future
 * response can be copied out, without pretending to redact a shape nobody has
 * written yet.
 */
const MAX_EVIDENCE_BODY_CHARS = 2_000;

/**
 * Bound a response body for the transcript, keeping its shape legible.
 *
 * @param body - The parsed (or raw-text) response body.
 * @returns The body when it serializes small, else a truncated string marker.
 */
function boundBody(body: unknown): unknown {
  if (body === undefined) return undefined;
  const serialized = typeof body === 'string' ? body : JSON.stringify(body);
  if (serialized === undefined) return '[unserializable body omitted]';
  if (serialized.length <= MAX_EVIDENCE_BODY_CHARS) return body;
  return `${serialized.slice(0, MAX_EVIDENCE_BODY_CHARS)}… [truncated, ${serialized.length} chars total]`;
}

/** What to assert about the GET response. */
export interface HttpGetCheck {
  /** Expected HTTP status. Defaults to `200`. */
  status?: number;
  /** Predicate over the parsed JSON body (when the response is JSON). */
  body?: (body: unknown) => boolean;
}

/**
 * Oracle: `GET ${baseUrl}${path}` and assert its status (and, optionally, its
 * parsed JSON body). The request is made against the running harness server, so
 * this reads real API state. The recorded evidence body is bounded (see
 * {@link MAX_EVIDENCE_BODY_CHARS}); the `check.body` predicate still sees all of it.
 *
 * @param path - The path to GET (string or context resolver).
 * @param check - Status and optional body assertion; see {@link HttpGetCheck}.
 * @param label - Human-readable label; defaults to `GET <path>`.
 * @returns An {@link Oracle}.
 */
export function httpGetAssert(path: ApiPath, check: HttpGetCheck = {}, label?: string): Oracle {
  return httpRequestAssert({ method: 'GET', path }, check, label);
}

/** The request {@link httpRequestAssert} sends. */
export interface HttpRequestSpec {
  /** The HTTP method, e.g. `POST` or `PUT`. */
  method: string;
  /** The path to request (string or context resolver). */
  path: ApiPath;
  /** Extra request headers, e.g. `x-dorkos-agent` to call as an agent. */
  headers?: Record<string, string>;
  /** A JSON body, sent with `Content-Type: application/json` when present. */
  json?: unknown;
}

/** What to assert about a response from {@link httpRequestAssert}. */
export interface HttpRequestCheck {
  /** The status, or any of several (`[200, 201, 204]`). Defaults to `200`. */
  status?: number | readonly number[];
  /** Predicate over the parsed JSON body (when the response is JSON). */
  body?: (body: unknown) => boolean;
}

/**
 * Oracle: send one request to the running harness server and assert its status
 * (and, optionally, its parsed JSON body). The mutating sibling of
 * {@link httpGetAssert}: a case that has to start something, write something or
 * prove a write is refused sends it here.
 *
 * It sends no credential of its own. A credentialed eval server runs with login
 * off, where a request that carries no agent identity is the local operator, so
 * a plain call here is what a person in the app would send; adding an
 * `x-dorkos-agent` header is what an agent would send.
 *
 * @param request - The method, path, headers and JSON body to send.
 * @param check - Status and optional body assertion; see {@link HttpRequestCheck}.
 * @param label - Human-readable label; defaults to `<METHOD> <path>`.
 * @returns An {@link Oracle}.
 */
export function httpRequestAssert(
  request: HttpRequestSpec,
  check: HttpRequestCheck = {},
  label?: string
): Oracle {
  const expected = typeof check.status === 'number' ? [check.status] : (check.status ?? [200]);
  return async (ctx) => {
    const rel = typeof request.path === 'function' ? request.path(ctx) : request.path;
    const url = `${ctx.baseUrl}${rel}`;
    const headers: Record<string, string> = { ...request.headers };
    if (request.json !== undefined) headers['Content-Type'] = 'application/json';
    let status = 0;
    let body: unknown;
    let parseError: string | undefined;
    try {
      const res = await fetch(url, {
        method: request.method,
        headers,
        ...(request.json !== undefined ? { body: JSON.stringify(request.json) } : {}),
      });
      status = res.status;
      const text = await res.text();
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        body = text;
      }
    } catch (err) {
      parseError = err instanceof Error ? err.message : String(err);
    }

    const statusOk = expected.includes(status);
    const bodyOk = check.body ? check.body(body) : true;
    const passed = !parseError && statusOk && bodyOk;
    const expectedText = expected.length === 1 ? `${expected[0]}` : `one of ${expected.join(', ')}`;
    return {
      label: label ?? `${request.method} ${rel}`,
      passed,
      // The BODY ASSERTION above sees the whole body; the transcript keeps only a
      // bounded copy of it (see MAX_EVIDENCE_BODY_CHARS).
      evidence: { url, method: request.method, status, body: boundBody(body) },
      detail: passed
        ? undefined
        : (parseError ??
          `expected status ${expectedText}, got ${status}${bodyOk ? '' : ' (body assertion failed)'}`),
    };
  };
}
