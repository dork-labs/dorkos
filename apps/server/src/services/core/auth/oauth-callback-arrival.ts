/**
 * How an OAuth sign-in's loopback callback is judged when it lands.
 *
 * Finishing a sign-in (a managed MCP server, OpenRouter) ends with the
 * provider's page sending the person's browser to this computer's callback
 * route. That top-level navigation carries the provider's page as `Referer`
 * (browsers default to `strict-origin-when-cross-origin`), and the request
 * classifier reads a non-loopback `Referer` as another device. Left alone, the
 * session gate asked the person to sign in and the handler refused them, so the
 * sign-in could never finish from the redirect itself.
 *
 * For a GET to one of these exact routes, the page a navigation came from says
 * nothing about where the request came from: the provider is always another
 * site. So the gate and the handler judge the callback without `Origin` and
 * `Referer`. Every other rule still holds: a loopback TCP peer, a loopback
 * `Host`, no proxy forwarding header, the direct listener. What ties the
 * request to a sign-in a person here started is the unguessable `state` (plus
 * PKCE), which each handler checks before it exchanges anything.
 *
 * @module services/core/auth/oauth-callback-arrival
 */
import type { ClassifierFacts } from '../../../lib/request-classifier.js';

/** The loopback OAuth callback routes, as the router matches them. */
const OAUTH_CALLBACK_PATHS: readonly string[] = [
  '/api/agents/mcp-oauth/callback',
  '/api/runtimes/opencode/openrouter/oauth/callback',
];

/**
 * Whether a request is a GET (or HEAD) to a loopback OAuth callback route.
 *
 * Matched the way the gate matches: case-insensitive, doubled slashes
 * collapsed, one trailing slash ignored.
 *
 * @param method - The request method.
 * @param path - The request path, without the query string.
 */
export function isOAuthCallbackArrival(method: string, path: string): boolean {
  const verb = method.toUpperCase();
  if (verb !== 'GET' && verb !== 'HEAD') return false;
  const collapsed = path.toLowerCase().replace(/\/{2,}/g, '/');
  const normalized = collapsed.length > 1 ? collapsed.replace(/\/$/, '') : collapsed;
  return OAUTH_CALLBACK_PATHS.includes(normalized);
}

/**
 * The request's facts with `Origin` and `Referer` removed, for judging an
 * OAuth callback arrival (see the module doc). Everything else is kept as is.
 *
 * @param facts - The request's facts.
 * @returns A copy whose headers name no referring page.
 */
export function withoutReferringPage<T extends ClassifierFacts>(facts: T): T {
  const { origin: _origin, referer: _referer, ...headers } = facts.headers;
  return { ...facts, headers };
}

/**
 * The facts the session gate should judge a request by: the callback-arrival
 * view for a GET to an OAuth callback route, the request's own facts otherwise.
 *
 * @param method - The request method.
 * @param path - The request path, without the query string.
 * @param facts - The request's facts.
 */
export function gateFactsFor<T extends ClassifierFacts>(method: string, path: string, facts: T): T {
  return isOAuthCallbackArrival(method, path) ? withoutReferringPage(facts) : facts;
}
