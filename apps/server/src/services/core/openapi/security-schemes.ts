/**
 * How a caller signs in to the DorkOS API, as the OpenAPI document states it:
 * the two security schemes, the document-level default, and each operation's
 * own `security` where it differs.
 *
 * Every claim here is read from the code that enforces it, never from a hand
 * list:
 *
 * - **Open** (`security: []`): a path the session gate lets through with no
 *   credential ({@link isGateExemptPath}, the same function the gate runs) on a
 *   person's computer or a hub: the health probe, the signed-token and ticket
 *   routes, a hub's link path and a computer's passkey return.
 * - **The sign-in cookie only**: the Better Auth endpoints under `/api/auth/`.
 *   The gate lets them through so sign-in is reachable, but the documented ones
 *   act on the signed-in person's own account, and Better Auth reads that from
 *   its session cookie (its API-key plugin does not stand a key in for a
 *   session here).
 * - **A personal API key only**: the connector routes in
 *   `PROGRAM_KEY_ROUTES`, which the routers register from that same list.
 * - **The default**, for everything else: the sign-in cookie or a personal API
 *   key ({@link DOCUMENT_SECURITY}). The session gate asks for one from another
 *   device always, and from this computer only when "Ask for a password on this
 *   computer too" is on (`services/core/auth/gate-policy.ts`); the schemes'
 *   descriptions and {@link API_DESCRIPTION} say so.
 *
 * A `registerPath` call that sets its own `security` keeps it.
 *
 * `X-DorkOS-Agent` is not a scheme: it names the calling agent and grants
 * nothing (`middleware/agent-identity.ts`). The API docs landing page
 * (`docs/api/index.mdx`) describes it. `/mcp` is not in this document, so its
 * local token is not either.
 *
 * @module services/core/openapi/security-schemes
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { isGateExemptPath } from '../auth/gated-paths.js';
import { programKeyOperationKeys } from '../../connectors/principal/program-key-routes.js';

/** The note every description of the default carries: what a local call needs. */
const LOCAL_CALLS =
  'From this computer, an operation that takes the sign-in cookie or a personal API key needs ' +
  'neither while "Ask for a password on this computer too" is off, which is how DorkOS ' +
  'installs (`dorkos auth enable` turns it on). A request from another device always needs one.';

/** The document's `info.description`. */
export const API_DESCRIPTION =
  "The DorkOS server's HTTP and SSE API: sessions, agents, rooms, connections and the rest of " +
  `the app, served on this computer. ${LOCAL_CALLS} A call that another computer relays here ` +
  'is refused, and on a hub the owner signs in with their DorkOS account.';

/** The sign-in cookie a browser gets. */
const SESSION_COOKIE = {
  type: 'apiKey',
  in: 'cookie',
  name: '__Secure-better-auth.session_token',
  description:
    'The sign-in cookie a browser gets when a person signs in to DorkOS. An installed DorkOS ' +
    'on port 4242 names it `__Secure-better-auth.session_token`. On any other port the prefix ' +
    'carries a suffix for its data folder (`better-auth-<hash>`), and a development server ' +
    `leaves off \`__Secure-\`. ${LOCAL_CALLS}`,
} as const;

/** A personal API key, sent as a bearer token. */
const API_KEY = {
  type: 'http',
  scheme: 'bearer',
  description:
    'A personal API key, sent as `Authorization: Bearer <key>`. Create one in DorkOS under ' +
    'Settings → Login & security → API keys, shown while you are signed in or "Ask for a ' +
    'password on this computer too" is on. The `dorkos` command line sends the key in ' +
    '`DORKOS_API_KEY`, or the one saved in `api-key` in its data folder. A few operations ' +
    "take only a key, even from this computer, such as running a connected app's action " +
    `from a script. ${LOCAL_CALLS}`,
} as const;

/** Every security scheme the document declares, by the name operations refer to. */
export const SECURITY_SCHEMES = {
  sessionCookie: SESSION_COOKIE,
  apiKey: API_KEY,
} as const;

/** A security requirement list, as OpenAPI writes one. */
type SecurityRequirements = Array<Record<string, string[]>>;

/** The document-level requirement: the sign-in cookie or a personal API key. */
export const DOCUMENT_SECURITY: SecurityRequirements = [{ sessionCookie: [] }, { apiKey: [] }];

/** No credential: the session gate lets the path through. */
export const OPEN_SECURITY: SecurityRequirements = [];

/** The sign-in cookie only: Better Auth's own account endpoints. */
export const COOKIE_ONLY_SECURITY: SecurityRequirements = [{ sessionCookie: [] }];

/** A personal API key only: the connector routes in `PROGRAM_KEY_ROUTES`. */
export const API_KEY_ONLY_SECURITY: SecurityRequirements = [{ apiKey: [] }];

/** The HTTP methods an OpenAPI path item can hold an operation under. */
const OPERATION_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'];

/**
 * A concrete path for an OpenAPI path, each `{param}` filled with a value every
 * gate pattern accepts (43 URL-safe characters, a media ticket's length).
 *
 * @param path - The OpenAPI path.
 */
export function samplePath(path: string): string {
  return path.replace(/\{[^}]+\}/g, 'a'.repeat(43));
}

/**
 * The `security` one operation needs, by the rules in the module doc, or
 * `undefined` for the document default.
 *
 * @param method - The HTTP method, any case.
 * @param path - The OpenAPI path.
 * @param programKeyKeys - The API-key-only operations, as `programKeyOperationKeys` lists them.
 */
export function operationSecurity(
  method: string,
  path: string,
  programKeyKeys: ReadonlySet<string> = programKeyOperationKeys()
): SecurityRequirements | undefined {
  const exact = samplePath(path);
  const lowered = exact.toLowerCase();
  const exempt = (['computer', 'hub'] as const).some((role) =>
    isGateExemptPath(lowered, exact, role)
  );
  if (exempt) return lowered.startsWith('/api/auth/') ? COOKIE_ONLY_SECURITY : OPEN_SECURITY;
  if (programKeyKeys.has(`${method.toUpperCase()} ${path}`)) return API_KEY_ONLY_SECURITY;
  return undefined;
}

/** The slice of a generated document {@link assignOperationSecurity} reads and writes. */
export interface SecurityDocument {
  /** The document's paths, each mapping methods to operations. */
  paths?: Record<string, object | undefined>;
}

/**
 * Set `security` on every operation whose requirement differs from the
 * document default, leaving any an operation already sets.
 *
 * @param document - The generated OpenAPI document; changed in place.
 */
export function assignOperationSecurity(document: SecurityDocument): void {
  const programKeyKeys = programKeyOperationKeys();
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const method of OPERATION_METHODS) {
      const op = (item as Record<string, { security?: unknown } | undefined> | undefined)?.[method];
      if (!op || op.security !== undefined) continue;
      const security = operationSecurity(method, path, programKeyKeys);
      if (security !== undefined) op.security = security;
    }
  }
}

/**
 * Register {@link SECURITY_SCHEMES} as components on the OpenAPI registry.
 *
 * @param registry - The server's OpenAPI registry.
 */
export function registerSecuritySchemes(registry: OpenAPIRegistry): void {
  for (const [name, scheme] of Object.entries(SECURITY_SCHEMES)) {
    registry.registerComponent('securitySchemes', name, scheme);
  }
}
