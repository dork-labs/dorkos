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
 * this reads real API state.
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
      evidence: { url, status, body },
      detail: passed
        ? undefined
        : (parseError ??
          `expected status ${expectedStatus}, got ${status}${bodyOk ? '' : ' (body assertion failed)'}`),
    };
  };
}
