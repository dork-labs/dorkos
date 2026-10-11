/**
 * Which paths the session gate decides on: the API surface and the external
 * MCP endpoint. Everything else (the app's pages and assets) is served without
 * the gate, so the login screen can load. A leaf module, so the managed
 * ingress can ask without importing the auth stack.
 *
 * @module services/core/auth/gated-paths
 */

/**
 * Whether the session gate decides on a path. Matched without regard to case,
 * as the router matches.
 *
 * @param path - A pathname, or an origin-form target (its query is ignored).
 */
export function isSessionGatedPath(path: string): boolean {
  const lowered = path.split('?')[0]!.toLowerCase();
  return lowered.startsWith('/api/') || lowered === '/mcp' || lowered.startsWith('/mcp/');
}
