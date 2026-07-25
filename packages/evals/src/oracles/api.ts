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
  const expectedStatus = check.status ?? 200;
  return async (ctx) => {
    const rel = typeof path === 'function' ? path(ctx) : path;
    const url = `${ctx.baseUrl}${rel}`;
    let status = 0;
    let body: unknown;
    let parseError: string | undefined;
    try {
      const res = await fetch(url);
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

    const statusOk = status === expectedStatus;
    const bodyOk = check.body ? check.body(body) : true;
    const passed = !parseError && statusOk && bodyOk;
    return {
      label: label ?? `GET ${rel}`,
      passed,
      // The BODY ASSERTION above sees the whole body; the transcript keeps only a
      // bounded copy of it (see MAX_EVIDENCE_BODY_CHARS).
      evidence: { url, status, body: boundBody(body) },
      detail: passed
        ? undefined
        : (parseError ??
          `expected status ${expectedStatus}, got ${status}${bodyOk ? '' : ' (body assertion failed)'}`),
    };
  };
}
