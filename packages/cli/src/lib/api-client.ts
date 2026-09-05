/**
 * Thin HTTP client for talking to a running DorkOS server from the CLI.
 *
 * The CLI assumes the server is reachable on `localhost:<port>`. Port
 * resolution mirrors the cleanup command's pattern: explicit env var first,
 * then `~/.dork/config.json`, then the default. No retries — a single failed
 * call surfaces the underlying error so the caller can render it directly.
 *
 * ## Credentials
 *
 * Every `/api/*` path is gated when the instance has login turned on
 * (`config.auth.enabled`), and the only credentials that gate accepts are a
 * Better Auth session cookie (browsers) or a personal API key as
 * `Authorization: Bearer <key>`. The CLI has no cookie, so it presents a key,
 * resolved by {@link resolveApiKey}: `DORKOS_API_KEY` first, then a key saved in
 * `<dork home>/api-key`. Note the branch is on key PRESENCE, not on server state
 * (which the CLI cannot know before it calls): with no key set up nothing is sent,
 * and a key that IS set up rides along even to a login-off server, which ignores it.
 *
 * The agent identity token (`X-DorkOS-Agent`) is attribution, not authorization:
 * it is resolved *after* the login gate, so it can never stand in for a key.
 *
 * @module lib/api-client
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** Default server port — kept in sync with `@dorkos/shared/constants`. */
const DEFAULT_PORT = 4242;

/** Env var holding the personal API key the CLI presents on gated `/api/*` calls. */
const API_KEY_ENV_VAR = 'DORKOS_API_KEY';

/**
 * File under the dork home holding that same key, so it survives a new shell and
 * so agent subprocesses (which inherit the server's env, not the person's) can
 * reach a login-on instance. A sibling of `mcp-local-token`; the operator saves
 * their key here once, owner-only.
 */
const API_KEY_FILE_NAME = 'api-key';

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
  /**
   * Discriminator on structured refusals that are not "errors" in the usual
   * sense — notably the capability tier gate's `denied` payload, which explains in
   * plain words why an agent was not allowed to run something.
   */
  status?: string;
  /** Plain-language explanation carried by a structured refusal. */
  message?: string;
  /** Machine-readable error code, e.g. `AUTH_REQUIRED` from the login gate. */
  code?: string;
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
    super(body.error ?? body.message ?? `HTTP ${status}`);
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

/** The DorkOS data directory: `DORK_HOME` when set, else `~/.dork`. */
function resolveDorkHome(): string {
  // eslint-disable-next-line no-restricted-syntax -- DORK_HOME is set imperatively by cli.ts after module load
  return process.env.DORK_HOME || path.join(os.homedir(), '.dork');
}

/**
 * Read `server.port` from `~/.dork/config.json`. Returns `null` if the
 * file is missing, malformed, or has no numeric port set. Mirrors the
 * helper in `cleanup-command.ts`, kept independent so the two surfaces
 * can evolve separately.
 */
function readConfigPort(): number | null {
  const dorkHome = resolveDorkHome();
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
 * The identity headers to send with an API call.
 *
 * When DorkOS spawns an agent session it injects `DORKOS_AGENT_TOKEN` into the
 * process env, so a `dorkos` command the agent runs inherits it and can say who
 * it is. The server resolves the token to an agent identity and attributes the
 * resulting Activity events to that agent.
 *
 * The header is purely additive: a server without the resolution middleware, an
 * older server, or any other HTTP endpoint simply ignores an unknown header, so
 * attaching it can never break a call. Absent the env var, nothing is sent and
 * the request is byte-identical to before.
 *
 * @returns The identity header, or an empty object when no token is present.
 */
function agentIdentityHeaders(): Record<string, string> {
  // eslint-disable-next-line no-restricted-syntax -- DORKOS_AGENT_TOKEN is injected into the spawned agent's env by the server, not CLI config
  const token = process.env.DORKOS_AGENT_TOKEN?.trim();
  return token ? { 'X-DorkOS-Agent': token } : {};
}

/** Absolute path of the file the CLI reads a saved API key from. */
function apiKeyFilePath(): string {
  return path.join(resolveDorkHome(), API_KEY_FILE_NAME);
}

/**
 * Resolve the personal API key the CLI presents on `/api/*` calls.
 *
 * Follows the CLI's config precedence (env var, then the dork home, then
 * nothing). There is deliberately no config.json entry: raw secrets never live in
 * `config.json` (ADR-0315), so the key sits in its own file instead.
 *
 * Returns `null` when no key is available, which is the normal case: with login
 * off the server asks for no credential at all.
 *
 * @returns The trimmed key, or `null` when neither source has one.
 */
export function resolveApiKey(): string | null {
  // eslint-disable-next-line no-restricted-syntax -- read at call time so a command can set it before dispatch
  const fromEnv = process.env[API_KEY_ENV_VAR]?.trim();
  if (fromEnv) return fromEnv;

  try {
    const fromFile = fs.readFileSync(apiKeyFilePath(), 'utf-8').trim();
    if (fromFile) return fromFile;
  } catch {
    // Missing or unreadable: this source simply has no key.
  }
  return null;
}

/** The `Authorization` header when a key is available, else nothing. */
function apiKeyHeaders(): Record<string, string> {
  const key = resolveApiKey();
  return key ? { Authorization: `Bearer ${key}` } : {};
}

/** The code `sessionGate` stamps on its own 401, and the only one this rewrites. */
const AUTH_REQUIRED_CODE = 'AUTH_REQUIRED';

/**
 * Turn the login gate's bare `Unauthorized` into something a person can act on.
 *
 * That gate's 401 means one thing: this instance has login turned on and the
 * call carried no key the server accepts. Say that, and say where the key comes
 * from. It is NOT the only 401 the API can answer — see the caller, which checks
 * the code before reaching for this.
 *
 * @param presentedKey - Whether the CLI actually sent a key (a rejected key and a
 *   missing key need different advice).
 * @returns The message to surface on stderr.
 */
function buildUnauthorizedMessage(presentedKey: boolean): string {
  const where =
    'Create one in DorkOS under Settings → Access → API keys, then either ' +
    `set ${API_KEY_ENV_VAR}=<your key> or save the key in ${apiKeyFilePath()} ` +
    '(and run `chmod 600` on it).';
  if (presentedKey) {
    return (
      'This DorkOS instance did not accept your API key. It may have been revoked, ' +
      `or it may belong to a different instance. ${where}`
    );
  }
  return `This DorkOS instance has login turned on, so the CLI needs your API key. ${where}`;
}

/**
 * Make a JSON HTTP call against the DorkOS server.
 *
 * Presents the personal API key from {@link resolveApiKey} as
 * `Authorization: Bearer <key>` when one is available, so the same command works
 * whether or not the instance has login turned on. A caller-supplied
 * `Authorization` header still wins (it is merged last).
 *
 * Throws an {@link ApiError} on non-2xx responses. The error carries the
 * full parsed body so callers can read structured fields like
 * `conflicts` (HTTP 409) or `errors` (HTTP 400). A `401` from the LOGIN GATE
 * gets its `error` rewritten to the actionable message from
 * {@link buildUnauthorizedMessage} while keeping the server's `code`, because
 * that gate's own body is just `Unauthorized`. A 401 carrying any other code
 * came from a route that explained itself and is passed through untouched.
 * Throws a generic `Error` with `code === 'ECONNREFUSED'` semantics if the
 * server is unreachable.
 *
 * @param method - HTTP method (e.g. `'GET'`, `'POST'`).
 * @param apiPath - Path on the server (must start with `/`).
 * @param body - Optional request body to JSON-encode.
 * @param headers - Extra request headers, merged last so a caller can add a
 *   one-off header (e.g. an approval token) without touching the defaults.
 * @returns The parsed JSON response body.
 */
export async function apiCall<T>(
  method: string,
  apiPath: string,
  body?: unknown,
  headers?: Record<string, string>
): Promise<T> {
  const res = await apiRequest(method, apiPath, body, headers);

  // 204 No Content: nothing to parse — return undefined as T.
  if (res.status === 204) {
    return undefined as T;
  }

  return (await res.json()) as T;
}

/**
 * Make an HTTP call and hand back the raw {@link Response}, unparsed.
 *
 * The half of {@link apiCall} that does not assume JSON: credentials, the agent
 * identity header, unreachable-server wrapping and the {@link ApiError} mapping
 * are all identical, and only the body is left alone. It exists for the handful
 * of endpoints whose body is not a JSON document — a room export is JSONL, and
 * one of these can be a room's whole history, so it is streamed to disk rather
 * than buffered through `JSON.parse`.
 *
 * The response is only handed back on a 2xx: a failure is still raised as an
 * {@link ApiError} here, so no caller has to re-implement the error mapping to
 * get at a stream.
 *
 * @param method - HTTP method (e.g. `'GET'`, `'POST'`).
 * @param apiPath - Path on the server (must start with `/`).
 * @param body - Optional request body to JSON-encode.
 * @param headers - Extra request headers, merged last.
 * @returns The successful response, body untouched.
 */
export async function apiRequest(
  method: string,
  apiPath: string,
  body?: unknown,
  headers?: Record<string, string>
): Promise<Response> {
  const url = `${getServerBaseUrl()}${apiPath}`;
  const keyHeaders = apiKeyHeaders();
  // Whether this request carried any bearer credential at all — ours or a
  // caller-supplied override (header names are case-insensitive over the wire).
  const presentedKey =
    'Authorization' in keyHeaders ||
    Object.keys(headers ?? {}).some((name) => name.toLowerCase() === 'authorization');

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...keyHeaders,
        ...agentIdentityHeaders(),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot reach DorkOS server at ${url}: ${message}`, { cause: err });
  }

  if (!res.ok) {
    let parsed: ApiErrorBody;
    try {
      parsed = (await res.json()) as ApiErrorBody;
    } catch {
      parsed = { error: res.statusText };
    }
    // Only the LOGIN gate's 401 is rewritten. A route that answers 401 for its
    // own reason — an `X-DorkOS-Agent` token the server could not verify, which
    // every room address refuses since DOR-1361 — already said something true
    // and specific, and replacing it with "the CLI needs your API key" would
    // send an agent whose identity expired to mint the wrong credential.
    if (res.status === 401 && (parsed.code === undefined || parsed.code === AUTH_REQUIRED_CODE)) {
      parsed = { ...parsed, error: buildUnauthorizedMessage(presentedKey) };
    }
    throw new ApiError(res.status, parsed);
  }

  return res;
}
