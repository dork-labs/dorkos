/**
 * Thin HTTP client for talking to a running DorkOS server from the CLI.
 *
 * The CLI assumes the server is reachable on `localhost:<port>`. Port
 * resolution mirrors the cleanup command's pattern: explicit env var first,
 * then `~/.dork/config.json`, then the default. No retries — a single failed
 * call surfaces the underlying error so the caller can render it directly.
 *
 * @module lib/api-client
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** Default server port — kept in sync with `@dorkos/shared/constants`. */
const DEFAULT_PORT = 4242;

/**
 * The HTTP error envelope returned by the marketplace routes. The router
 * uses `mapErrorToStatus` in `apps/server/src/routes/marketplace.ts` to map
 * service errors into this shape, so the CLI can detect conflict reports
 * and validation errors without parsing free-form messages.
 */
export interface ApiErrorBody {
  error?: string;
  conflicts?: unknown[];
  errors?: unknown[];
  details?: unknown;
}

/**
 * An HTTP error from the DorkOS API. Carries the original status code and
 * the parsed JSON body so callers can branch on `status === 409` to detect
 * conflicts and read `body.conflicts` for the structured conflict array.
 */
export class ApiError extends Error {
  /**
   * Build a typed API error.
   *
   * @param status - HTTP status code returned by the server.
   * @param body - Parsed JSON error body. Empty object when the response
   *   was not JSON-decodable.
   */
  constructor(
    public readonly status: number,
    public readonly body: ApiErrorBody
  ) {
    super(body.error ?? `HTTP ${status}`);
    this.name = 'ApiError';
  }
}

/**
 * Resolve the DorkOS server base URL by reading port + host from the
 * environment, falling back to `~/.dork/config.json`, and finally the
 * default port. Always uses `http://localhost`.
 *
 * @returns The base URL with no trailing slash (e.g. `http://localhost:4242`).
 */
export function getServerBaseUrl(): string {
  // eslint-disable-next-line no-restricted-syntax -- DORKOS_PORT is set imperatively by cli.ts before subcommands run
  const envPort = process.env.DORKOS_PORT;
  if (envPort && /^\d+$/.test(envPort)) {
    return `http://localhost:${envPort}`;
  }

  const configPort = readConfigPort();
  return `http://localhost:${configPort ?? DEFAULT_PORT}`;
}

/**
 * Read `server.port` from `~/.dork/config.json`. Returns `null` if the
 * file is missing, malformed, or has no numeric port set. Mirrors the
 * helper in `cleanup-command.ts`, kept independent so the two surfaces
 * can evolve separately.
 */
function readConfigPort(): number | null {
  // eslint-disable-next-line no-restricted-syntax -- DORK_HOME is set imperatively by cli.ts after module load
  const dorkHome = process.env.DORK_HOME || path.join(os.homedir(), '.dork');
  try {
    const raw = fs.readFileSync(path.join(dorkHome, 'config.json'), 'utf-8');
    const config = JSON.parse(raw) as { server?: { port?: unknown } };
    const port = config?.server?.port;
    if (typeof port === 'number' && port > 0) return port;
  } catch {
    // Config missing or malformed — fall through to default.
  }
  return null;
}

/**
 * Make a JSON HTTP call against the DorkOS server.
 *
 * Throws an {@link ApiError} on non-2xx responses. The error carries the
 * full parsed body so callers can read structured fields like
 * `conflicts` (HTTP 409) or `errors` (HTTP 400). Throws a generic `Error`
 * with `code === 'ECONNREFUSED'` semantics if the server is unreachable.
 *
 * @param method - HTTP method (e.g. `'GET'`, `'POST'`).
 * @param apiPath - Path on the server (must start with `/`).
 * @param body - Optional request body to JSON-encode.
 * @returns The parsed JSON response body.
 */
export async function apiCall<T>(method: string, apiPath: string, body?: unknown): Promise<T> {
  const url = `${getServerBaseUrl()}${apiPath}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot reach DorkOS server at ${url}: ${message}`);
  }

  if (!res.ok) {
    let parsed: ApiErrorBody = {};
    try {
      parsed = (await res.json()) as ApiErrorBody;
    } catch {
      parsed = { error: res.statusText };
    }
    throw new ApiError(res.status, parsed);
  }

  // 204 No Content: nothing to parse — return undefined as T.
  if (res.status === 204) {
    return undefined as T;
  }

  return (await res.json()) as T;
}
