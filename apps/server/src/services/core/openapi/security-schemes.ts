/**
 * How a caller signs in to the DorkOS API, as the OpenAPI document states it.
 *
 * Every sentence here is a claim about what the request chain enforces, so each
 * one is checked against the code that does it:
 *
 * - the session gate (`services/core/auth/session-gate.ts`) asks for a
 *   credential from another device always, and from this computer only when
 *   "Ask for a password on this computer too" is on; it then takes either the
 *   sign-in cookie or a personal API key as a bearer token;
 * - the cookie's name comes from `cookiePrefix` and `useSecureCookies` in
 *   `services/core/auth/index.ts`;
 * - `X-DorkOS-Agent` is resolved by `middleware/agent-identity.ts`, which never
 *   refuses a request; an agent computer's own gate
 *   (`services/core/agent-computer/agent-gate.ts`) does require one;
 * - `/mcp` and `/a2a` take the local token, a personal key or `MCP_API_KEY` by
 *   `middleware/mcp-auth.ts`;
 * - a few routes ask for a personal API key even from this computer with no
 *   password asked (`routes/connector-execution.ts`).
 *
 * Per-operation `security` is not declared yet, so the document-level
 * {@link DOCUMENT_SECURITY} is the honest whole answer: nothing, or one of the
 * two sign-ins.
 *
 * @module services/core/openapi/security-schemes
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

/** The sign-in cookie a browser gets, and when a request needs it. */
const SESSION_COOKIE = {
  type: 'apiKey',
  in: 'cookie',
  name: '__Secure-better-auth.session_token',
  description:
    'The sign-in cookie a browser gets when a person signs in to DorkOS. An installed DorkOS ' +
    'on port 4242 names it `__Secure-better-auth.session_token`. On any other port the prefix ' +
    'carries a suffix for its data folder (`better-auth-<hash>`), and a development server ' +
    'leaves off `__Secure-`. From this computer, most operations need nothing while "Ask for a ' +
    'password on this computer too" is off (`dorkos auth enable` turns it on). A few ask for ' +
    "a personal API key even there, such as running a connected app's action from a script. " +
    'A request from another device needs this cookie or a personal API key. A call that ' +
    'another computer relays here is refused, and on a hub the owner signs in with ' +
    'their DorkOS account.',
} as const;

/** A personal API key, sent as a bearer token. */
const API_KEY = {
  type: 'http',
  scheme: 'bearer',
  description:
    'A personal API key, sent as `Authorization: Bearer <key>`. Create one in DorkOS under ' +
    'Settings → Login & security → API keys, shown while you are signed in or "Ask for a ' +
    'password on this computer too" is on. The `dorkos` command line sends the key in ' +
    '`DORKOS_API_KEY`, or the one saved in `api-key` in its data folder.',
} as const;

/** The agent identity header: attribution, never authorization. */
const AGENT_IDENTITY = {
  type: 'apiKey',
  in: 'header',
  name: 'X-DorkOS-Agent',
  description:
    'Names the agent making the call, with the token DorkOS gave that agent. It says who is ' +
    'calling and grants nothing: it never stands in for a sign-in. The request chain never ' +
    'refuses a call for leaving it out, or for a token it cannot match. Some routes decide on ' +
    'it: a route only a person may call refuses a caller that sends it, and room routes refuse ' +
    'a token they cannot verify. An agent computer (a DorkOS set up to run only agents) is the ' +
    'exception: there, every API call but its health check needs a live agent token.',
} as const;

/** The local token `/mcp` and `/a2a` take from a caller at this computer. */
const INSTANCE_TOKEN = {
  type: 'http',
  scheme: 'bearer',
  description:
    'For `/mcp` and `/a2a`. The local MCP token this DorkOS made for itself, sent as ' +
    '`Authorization: Bearer <token>`. Find it in Settings → Advanced → Tools → Connect other ' +
    'apps to DorkOS. A caller at this computer that is not asked for a password may send it, ' +
    'and so may an agent on an agent computer. That same caller (never an agent ' +
    'computer) needs no token at all for MCP discovery and read-only MCP tools. A caller asked for a password ' +
    'sends a personal API key instead. A ' +
    'server started with `MCP_API_KEY` also takes that key here.',
} as const;

/** Every security scheme the document declares, by the name operations refer to. */
export const SECURITY_SCHEMES = {
  sessionCookie: SESSION_COOKIE,
  apiKey: API_KEY,
  agentIdentity: AGENT_IDENTITY,
  instanceToken: INSTANCE_TOKEN,
} as const;

/**
 * The document-level requirement: nothing (`{}`, a person at this computer
 * with no password asked), or the sign-in cookie, or a personal API key.
 */
export const DOCUMENT_SECURITY: Array<Record<string, string[]>> = [
  {},
  { sessionCookie: [] },
  { apiKey: [] },
];

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
