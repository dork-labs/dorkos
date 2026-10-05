/**
 * Decide whether a client's "where I started" link may travel to the service
 * that finishes a connection.
 *
 * The page that finishes connecting an account offers a way back into DorkOS.
 * The client says where that is, but the client is not trusted to say it: a
 * link this server forwards is one the service shows the person beside DorkOS's
 * name, so an arbitrary address would turn that page into an open redirect.
 * Only two shapes are kept, each rebuilt from its parts rather than passed on:
 *
 * - a `dorkos://` link to a route the desktop app handles, and
 * - an `http(s)` address whose origin this server serves right now (its own
 *   loopback origins and the live tunnel), pointing at a route the app has.
 *
 * Anything else is dropped, never refused: a missing way back costs the person
 * one click, while refusing the start would cost them the connection.
 *
 * @module services/connectors/resources/connect-return-to
 */

/** The app routes a connection may send a person back to. */
export const CONNECT_RETURN_ROUTES = ['connections'] as const;

const KNOWN_ROUTES: ReadonlySet<string> = new Set(CONNECT_RETURN_ROUTES);

/** The longest link considered at all. */
const MAX_RETURN_TO_LENGTH = 2048;

/**
 * The route a parsed link names, or `null` when it names none this app has.
 * Accepts the route alone, with or without one trailing slash, and nothing
 * after it: a query or fragment the app never asked for is not kept either.
 */
function knownRoute(path: string): string | null {
  const route = path.replace(/^\/+/, '').replace(/\/$/, '');
  return KNOWN_ROUTES.has(route) ? route : null;
}

/**
 * Keep a client-supplied return link only when it leads back into this app.
 *
 * @param raw - The value the client sent, of any shape.
 * @param servedOrigins - The origins this server serves right now
 *   (`resolveTrustedOrigins()`), compared exactly.
 * @returns A canonical link to forward, or `undefined` to send none.
 */
export function resolveConnectReturnTo(
  raw: unknown,
  servedOrigins: readonly string[]
): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_RETURN_TO_LENGTH) {
    return undefined;
  }
  let url: URL;
  try {
    // No base: a relative or scheme-relative value (`//evil.example`) throws.
    url = new URL(raw);
  } catch {
    return undefined;
  }
  // `http://localhost:4242@evil.example` parses with username `localhost` and
  // host `evil.example`. No link back into the app carries credentials.
  if (url.username || url.password) return undefined;

  if (url.protocol === 'dorkos:') {
    // The desktop app reads `dorkos://<route>` with the route as the host
    // (`apps/desktop/src/main/navigation.ts`, `parseDeepLink`).
    if (url.port || (url.pathname !== '' && url.pathname !== '/')) return undefined;
    const route = knownRoute(url.hostname.toLowerCase());
    return route ? `dorkos://${route}` : undefined;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  if (!servedOrigins.includes(url.origin)) return undefined;
  const route = knownRoute(url.pathname);
  return route ? `${url.origin}/${route}` : undefined;
}
