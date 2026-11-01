/**
 * The Wi-Fi level (F4 part 3, DOR-2969; plan `2026-10-accounts-and-devices`).
 *
 * A person signed in over Wi-Fi reaches DorkOS over plain `http` on the local
 * network, where anyone on the same network can watch or relay the traffic.
 * The level is about that proof, not the place (DOR-3172): the same person on
 * the own tunnel, managed remote access or `https` gets what the desk gets
 * (`isOnEncryptedConnection` in `../gate-policy.ts`). So a Wi-Fi sign-in gets
 * a lower level: it can chat, read, and answer
 * approvals that are not front-door settings, and is refused (403,
 * {@link NOT_FROM_WIFI}) on everything in {@link WIFI_REFUSED_ROUTES}:
 *
 * - **the terminal**, over HTTP and its WebSocket;
 * - **file writes**: the file editor's saves, creating, moving and deleting
 *   files, a room's files, and recovering a failed save. Chat attachments are
 *   chat, and stay allowed;
 * - **API keys**, all of `/api/auth/api-key/*`, reads included: a key is not
 *   bound to a route, so one made or read here would work from anywhere;
 * - **`/mcp` and A2A by cookie**: an agent tool brings its own key, never a
 *   person's Wi-Fi sign-in;
 * - **Owner-only front-door settings**: remote access and the own tunnel,
 *   Wi-Fi itself, the session relay, runtime credentials and sign-ins, package
 *   sources, and the password. `PATCH /api/config` carries front-door settings
 *   in its body, so that route runs the front-door bar on them itself
 *   (`refuseFrontDoorChange` in `lib/caller-authority.ts`), which refuses
 *   Wi-Fi as it refuses every caller neither at this computer nor on an
 *   encrypted connection;
 * - **the host itself**: resetting or restarting DorkOS, syncing or adopting
 *   the harness, adding a workspace, folder or agent, turning on and setting
 *   up extensions, installing and removing packages. Pairing a new device
 *   joins here once it is built;
 * - **MCP tokens and app keys**: revealing or rotating the MCP token, and an
 *   app's stored credential;
 * - **signing out everywhere**, here and through Better Auth.
 *
 * A request is at the Wi-Fi level when the Wi-Fi listener admitted it (its
 * ingress mark, read by the request classifier). A Wi-Fi sign-in works only on
 * that listener (`./session-route.ts`), so this covers every request it
 * can make, and an API key or a request with no credential arriving the same
 * way is held to the same level.
 *
 * It runs in two places, from the one list: the HTTP chain
 * ({@link wifiLevelMiddleware}, ahead of Better Auth so `/api/auth/*` is
 * covered) and the WebSocket upgrade router ({@link refuseUpgradeFromWifi}).
 *
 * @module services/core/auth/sessions/wifi-level
 */
import type { IncomingMessage } from 'node:http';
import type { MiddlewareHandler } from 'hono';
import type { ApiEnv } from '../../../../http/api-chain.js';
import { honoRequestFacts } from '../../../../http/request-facts.js';
import { classifyRequest, type ClassifierFacts } from '../../../../lib/request-classifier.js';
import { currentServerRole } from '../../../../lib/server-role.js';
import { upgradeFacts } from '../../streams/stream-upgrade-auth.js';
import { mayCarrySessionCookie } from './session-route.js';

/** Refusal code for an action a Wi-Fi sign-in may not take. */
export const NOT_FROM_WIFI = 'NOT_FROM_WIFI';

/**
 * What a Wi-Fi sign-in reads when an action's tier is beyond its level: a
 * capability that acts or destroys, called directly, or a destructive one
 * approved. Those two checks live where the tier is known
 * (`routes/capabilities-invoke.ts`, `routes/approvals.ts`), not in the list.
 */
export const WIFI_ACTION_REFUSAL = 'Do this at this computer.';

/**
 * What a Wi-Fi sign-in reads when it answers with a standing yes: an
 * approval's "Always allow", a tool prompt's always-allow, an extension's "next
 * time, on its own". From Wi-Fi an answer is Allow once or Deny, never a yes
 * that outlives the request (DOR-2969).
 */
export const WIFI_STANDING_YES_REFUSAL = 'Always allow is only available at this computer.';

/**
 * The refusal for a standing yes from Wi-Fi, or `undefined` when the request
 * is not from Wi-Fi or the answer is not a standing one.
 *
 * @param facts - The request's TCP peer, raw headers and ingress.
 * @param standing - Whether the answer would outlive this request.
 */
export function refuseStandingYesFromWifi(
  facts: ClassifierFacts,
  standing: boolean
): { error: string; code: typeof NOT_FROM_WIFI } | undefined {
  if (!standing || !isFromWifi(facts)) return undefined;
  return { error: WIFI_STANDING_YES_REFUSAL, code: NOT_FROM_WIFI };
}

/** What kind of action a refused route is, for tests and the audit of the list. */
export type WifiRefusedSurface =
  | 'terminal'
  | 'file-writes'
  | 'api-keys'
  | 'mcp'
  | 'a2a'
  | 'front-door'
  | 'host'
  | 'sign-out-all'
  | 'spending'
  | 'work-queue';

/** One refused route pattern, and why. */
export interface WifiRefusedRoute {
  /** What kind of action it is. */
  readonly surface: WifiRefusedSurface;
  /** The methods it covers: `all`, the ones that change something, or `DELETE`. */
  readonly methods: 'all' | 'writes' | 'deletes';
  /** Matched against the normalized path (lower case, single slashes, no trailing one). */
  readonly pattern: RegExp;
  /**
   * Refused when the request carries a session cookie or no `Authorization`
   * header. A bearer with no cookie at all is left to the surface's own key
   * check, which on Wi-Fi never accepts a cookie (`middleware/mcp-auth.ts`).
   */
  readonly cookieOnly?: boolean;
  /** The sentence the person reads. */
  readonly reason: string;
}

/** Where a refused action can be done instead, as every reason ends. */
const ON_THE_COMPUTER = 'at this computer.';

/** Every route a Wi-Fi sign-in is refused on. The single source of the level. */
export const WIFI_REFUSED_ROUTES: readonly WifiRefusedRoute[] = [
  // A queue starts chats later with nobody watching, at the agent's own level, so
  // turning one on or filling it is a standing grant (DOR-3462). The stop goes with
  // it, so this list stays one rule: every queue write is made at the computer.
  {
    surface: 'work-queue',
    methods: 'writes',
    pattern: /^\/api\/agents\/[^/]+\/work-queue(?:\/|$)/,
    reason: `A work queue can be changed only ${ON_THE_COMPUTER}`,
  },
  {
    surface: 'work-queue',
    methods: 'writes',
    pattern: /^\/api\/work-queues(?:\/|$)/,
    reason: `Work queues can be stopped only ${ON_THE_COMPUTER}`,
  },
  {
    surface: 'terminal',
    methods: 'all',
    pattern: /^\/api\/terminal(?:\/|$)/,
    reason: `The terminal opens only ${ON_THE_COMPUTER}`,
  },
  {
    surface: 'file-writes',
    methods: 'writes',
    pattern: /^\/api\/files(?:\/|$)/,
    reason: `Files can be changed only ${ON_THE_COMPUTER}`,
  },
  {
    surface: 'file-writes',
    methods: 'writes',
    pattern: /^\/api\/rooms\/[^/]+\/files(?:\/|$)/,
    reason: `Files can be changed only ${ON_THE_COMPUTER}`,
  },
  {
    surface: 'file-writes',
    methods: 'writes',
    pattern: /^\/api\/canvas\/docs\/[^/]+\/file-saves(?:\/|$)/,
    reason: `Files can be changed only ${ON_THE_COMPUTER}`,
  },
  {
    surface: 'api-keys',
    methods: 'all',
    pattern: /^\/api\/auth\/api-key(?:\/|$)/,
    reason: `API keys are managed only ${ON_THE_COMPUTER}`,
  },
  {
    surface: 'mcp',
    methods: 'all',
    pattern: /^\/mcp(?:\/|$)/,
    cookieOnly: true,
    reason: 'Agent tools need their own key, not a Wi-Fi sign-in.',
  },
  {
    surface: 'a2a',
    methods: 'all',
    pattern: /^\/a2a(?:\/|$)/,
    cookieOnly: true,
    reason: 'Agent tools need their own key, not a Wi-Fi sign-in.',
  },
  {
    surface: 'front-door',
    methods: 'writes',
    pattern: /^\/api\/(?:remote-access|tunnel|lan-access|session-relay)(?:\/|$)/,
    reason: `Change how DorkOS is reached ${ON_THE_COMPUTER}`,
  },
  {
    surface: 'front-door',
    methods: 'writes',
    pattern: /^\/api\/runtimes(?:\/|$)/,
    reason: `Change sign-ins and keys ${ON_THE_COMPUTER}`,
  },
  {
    surface: 'front-door',
    methods: 'writes',
    pattern: /^\/api\/(?:marketplace\/sources|extensions\/trusted-sources)(?:\/|$)/,
    reason: `Change where code comes from ${ON_THE_COMPUTER}`,
  },
  {
    surface: 'front-door',
    methods: 'writes',
    pattern: /^\/api\/auth\/(?:change-password|set-password|change-email)(?:\/|$)/,
    reason: `Change the password ${ON_THE_COMPUTER}`,
  },
  // Pairing a new device is not built yet (DOR-2969 part 4). When it is, its
  // minting and confirming routes join this list as a `host` entry.
  {
    surface: 'host',
    methods: 'writes',
    pattern: /^\/api\/admin(?:\/|$)/,
    reason: `Reset or restart DorkOS ${ON_THE_COMPUTER}`,
  },
  {
    surface: 'host',
    methods: 'writes',
    pattern:
      /^\/api\/(?:harness\/(?:sync|adopt)|workspaces|directory|agents|agents\/create|agents\/current\/migrate-persona)$/,
    reason: `Change folders and agents' setup ${ON_THE_COMPUTER}`,
  },
  {
    surface: 'host',
    methods: 'writes',
    pattern:
      /^\/api\/extensions\/(?:reload|[^/]+\/(?:enable|disable|init-server|approve|revoke|dismiss-approval|secrets|settings|project-settings|room-access|forward-agents|forward\/pending))(?:\/|$)/,
    reason: `Turn on and set up extensions ${ON_THE_COMPUTER}`,
  },
  {
    surface: 'host',
    methods: 'writes',
    pattern:
      /^\/api\/marketplace\/(?:packages\/[^/]+\/(?:install|uninstall|update|keep-files)|held-back\/[^/]+\/decision|updates|dev-links)(?:\/|$)/,
    reason: `Install and remove packages ${ON_THE_COMPUTER}`,
  },
  {
    // A server for every agent runs in every agent's session (DOR-3213).
    surface: 'host',
    methods: 'writes',
    pattern: /^\/api\/mcp-servers(?:\/|$)/,
    reason: `Add and change MCP servers for every agent ${ON_THE_COMPUTER}`,
  },
  {
    surface: 'host',
    methods: 'writes',
    pattern: /^\/api\/shapes\/[^/]+\/apply$/,
    reason: `Change folders and agents' setup ${ON_THE_COMPUTER}`,
  },
  {
    // Removing a workspace can run its removal hooks.
    surface: 'host',
    methods: 'deletes',
    pattern: /^\/api\/workspaces\/[^/]+$/,
    reason: `Change folders and agents' setup ${ON_THE_COMPUTER}`,
  },
  {
    // Linking mints, and unlinking clears, the account key this computer holds.
    surface: 'front-door',
    methods: 'writes',
    pattern: /^\/api\/cloud\/(?:link\/start|unlink)$/,
    reason: `Change sign-ins and keys ${ON_THE_COMPUTER}`,
  },
  {
    surface: 'host',
    methods: 'writes',
    pattern: /^\/api\/(?:templates(?:\/|$)|mesh\/(?!agents\/[^/]+\/heartbeat$))/,
    reason: `Change folders and agents' setup ${ON_THE_COMPUTER}`,
  },
  {
    // Chat app bots hold a token and decide which outside chats reach an agent.
    surface: 'front-door',
    methods: 'writes',
    pattern: /^\/api\/relay\/(?:adapters|bindings|endpoints|unclaimed-chats\/[^/]+\/claim)(?:\/|$)/,
    reason: `Change who reaches your agents ${ON_THE_COMPUTER}`,
  },
  {
    // A connected app holds a sign-in to an outside account; using one
    // directly acts in that account, as an `act` capability would.
    surface: 'front-door',
    methods: 'writes',
    pattern:
      /^\/api\/connectors\/(?:connections|reconciliation|executions|cli|agent-requests)(?:\/|$)/,
    reason: `Manage connected apps ${ON_THE_COMPUTER}`,
  },
  {
    surface: 'file-writes',
    methods: 'writes',
    pattern: /^\/api\/rooms\/[^/]+\/(?:repo|canvas\/[^/]+\/diff)(?:\/|$)/,
    reason: `Files can be changed only ${ON_THE_COMPUTER}`,
  },
  {
    surface: 'file-writes',
    methods: 'writes',
    pattern: /^\/api\/diff\/revert$/,
    reason: `Files can be changed only ${ON_THE_COMPUTER}`,
  },
  {
    surface: 'api-keys',
    methods: 'writes',
    pattern: /^\/api\/config\/mcp\/(?:reveal|rotate)-token$/,
    reason: `API keys are managed only ${ON_THE_COMPUTER}`,
  },
  {
    surface: 'front-door',
    methods: 'writes',
    pattern: /^\/api\/connectors\/providers\/[^/]+\/credential$/,
    reason: `Change sign-ins and keys ${ON_THE_COMPUTER}`,
  },
  {
    // A promise's due beat runs at the agent's own level (DOR-3037).
    surface: 'host',
    methods: 'writes',
    pattern: /^\/api\/agents\/[^/]+\/commitments$/,
    reason: `Record an agent's promises ${ON_THE_COMPUTER}`,
  },
  {
    surface: 'sign-out-all',
    methods: 'writes',
    pattern: /^\/api\/devices\/sign-out-all(?:\/|$)/,
    reason: `Sign out everywhere ${ON_THE_COMPUTER}`,
  },
  {
    surface: 'sign-out-all',
    methods: 'writes',
    pattern: /^\/api\/auth\/revoke-(?:other-)?sessions(?:\/|$)/,
    reason: `Sign out everywhere ${ON_THE_COMPUTER}`,
  },
  {
    // What teammates' turns in a space may cost is the owner's money. Raising
    // it is a spend, so it is set where the password was typed, never from a
    // phone that only has a session cookie.
    surface: 'spending',
    methods: 'writes',
    pattern: /^\/api\/community-connections\/[^/]+\/teammate-spend$/,
    reason: `Change spending limits ${ON_THE_COMPUTER}`,
  },
];

/** Methods that only read. Everything else is a write. */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** A refusal at the Wi-Fi level. */
export interface WifiLevelRefusal {
  /** Always 403. */
  readonly status: 403;
  /** Always {@link NOT_FROM_WIFI}. */
  readonly code: typeof NOT_FROM_WIFI;
  /** The plain sentence the person reads. */
  readonly error: string;
  /** Which refused route matched. */
  readonly surface: WifiRefusedSurface;
}

/** One request, as the level reads it. */
export interface WifiLevelRequest {
  /** The HTTP method (`GET` for a WebSocket upgrade). */
  readonly method: string;
  /**
   * Every spelling of the path a router might act on: the raw one and the
   * decoded one. A match on any of them refuses.
   */
  readonly paths: readonly string[];
  /** The request's TCP peer, raw headers and ingress. */
  readonly facts: ClassifierFacts;
}

/**
 * Whether a request is at the Wi-Fi level: the Wi-Fi listener admitted it.
 *
 * @param facts - The request's TCP peer, raw headers and ingress.
 */
export function isFromWifi(facts: ClassifierFacts): boolean {
  return classifyRequest(facts, currentServerRole()).route === 'wifi';
}

/**
 * A path as a lenient router might read it: lower case, doubled slashes
 * collapsed, the trailing slash and any query dropped.
 */
function normalizePath(path: string): string {
  const bare = path.split('?')[0] ?? '';
  return bare
    .toLowerCase()
    .replace(/\/{2,}/g, '/')
    .replace(/\/$/, '');
}

/**
 * The refused route a request matches, ignoring where it came from. Pure.
 *
 * @param method - The HTTP method.
 * @param paths - Every spelling of the path (see {@link WifiLevelRequest.paths}).
 * @param keyOnly - Whether the request carries an `Authorization` header and
 *   no session cookie, so only a key can speak for it.
 */
export function matchWifiRefusedRoute(
  method: string,
  paths: readonly string[],
  keyOnly: boolean
): WifiRefusedRoute | undefined {
  const upper = method.toUpperCase();
  const write = !READ_METHODS.has(upper);
  const normalized = paths.map(normalizePath);
  const covers = (route: WifiRefusedRoute): boolean =>
    route.methods === 'all' || (route.methods === 'writes' ? write : upper === 'DELETE');
  return WIFI_REFUSED_ROUTES.find(
    (route) =>
      covers(route) &&
      !(route.cookieOnly && keyOnly) &&
      normalized.some((path) => route.pattern.test(path))
  );
}

/**
 * The refusal for a request at the Wi-Fi level that matches a refused route,
 * or `undefined` when it may go on.
 *
 * @param request - The request.
 */
export function wifiLevelRefusal(request: WifiLevelRequest): WifiLevelRefusal | undefined {
  if (!isFromWifi(request.facts)) return undefined;
  const { authorization, cookie } = request.facts.headers;
  const keyOnly = authorization !== undefined && !mayCarrySessionCookie(cookie ?? '');
  const route = matchWifiRefusedRoute(request.method, request.paths, keyOnly);
  if (!route) return undefined;
  return { status: 403, code: NOT_FROM_WIFI, error: route.reason, surface: route.surface };
}

/** Both spellings of a path: as sent, and decoded where it decodes. */
function pathSpellings(raw: string, decoded?: string): string[] {
  const spellings = [raw];
  if (decoded !== undefined) spellings.push(decoded);
  try {
    spellings.push(decodeURIComponent(raw));
  } catch {
    // A malformed escape: the raw spelling is still checked.
  }
  return spellings;
}

/**
 * The Wi-Fi level on the HTTP chain. Runs before Better Auth and the session
 * gate, so it reads the listener's mark rather than a resolved user.
 *
 * @returns The middleware.
 */
export function wifiLevelMiddleware(): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const raw = (c.env.incoming.url ?? c.req.path).split('?')[0] ?? c.req.path;
    const refusal = wifiLevelRefusal({
      method: c.req.method,
      paths: pathSpellings(raw, c.req.path),
      facts: honoRequestFacts(c),
    });
    if (refusal) return c.json({ error: refusal.error, code: refusal.code }, 403);
    await next();
  };
}

/**
 * The Wi-Fi level on a WebSocket upgrade, which runs no chain.
 *
 * @param req - The upgrade request.
 * @param pathname - The parsed pathname the router routes on.
 * @returns The refusal, or `undefined` when the upgrade may go on.
 */
export function refuseUpgradeFromWifi(
  req: Pick<IncomingMessage, 'headers' | 'socket' | 'url'>,
  pathname: string
): WifiLevelRefusal | undefined {
  return wifiLevelRefusal({
    method: 'GET',
    paths: [...pathSpellings((req.url ?? pathname).split('?')[0] ?? pathname), pathname],
    facts: upgradeFacts(req),
  });
}
