/**
 * A person's sign-in works only on the route it was made on (F4 part 1,
 * DOR-2969; ADR 261015-125850 rule 5).
 *
 * Every session records the way the sign-in that made it came in: this
 * computer, Wi-Fi, the own tunnel, managed remote access, any other network
 * path, or a hub. A cookie copied from one route and replayed on another (a
 * Wi-Fi cookie sent to the tunnel's address, a cookie from this computer sent
 * over Wi-Fi) then verifies as nobody, so the caller is asked to sign in again
 * there.
 *
 * - **Stamped, never sent.** The `route` column is a Better Auth session field
 *   with `input: false`, and {@link stampSessionRoute} (the session-create
 *   hook in `../index.ts`) always overwrites it, so no client can choose it.
 * - **Read from the request that signed in.** Better Auth's hooks see no
 *   socket, so the route comes from the classified request the auth handler
 *   already runs inside (`withRegistrationCaller` in `../registration-policy.ts`,
 *   set by `http/better-auth.ts` and the desktop sign-in route). With no such
 *   scope the session came from code in this process and gets no route.
 * - **No route means this computer.** A session made before routes were
 *   recorded, or by in-process code, works only on `local`.
 * - **Wi-Fi sign-ins last 7 days at most**, counted from the sign-in, whatever
 *   use renews.
 * - **The relay never mints one.** A relayed request is never a person signing
 *   in, so a session it would make is refused.
 *
 * @module services/core/auth/sessions/session-route
 */
import { APIError } from 'better-auth/api';
import { parseCookies } from 'better-auth/cookies';

import {
  classifyRequest,
  type ClassifierFacts,
  type RequestRoute,
} from '../../../../lib/request-classifier.js';
import { currentServerRole } from '../../../../lib/server-role.js';
import { currentRegistrationCaller } from '../registration-policy.js';

/** Every route a person session can be bound to. */
export const SESSION_ROUTES = ['local', 'wifi', 'tunnel', 'managed', 'network', 'hub'] as const;

/** The route a person session was made on, and the only one it works on. */
export type SessionRoute = (typeof SESSION_ROUTES)[number];

/** How long a Wi-Fi sign-in lasts at most, from the moment it was made: 7 days. */
export const WIFI_SESSION_MAX_SECONDS = 7 * 24 * 60 * 60;

/** Refusal code when a session would be made on a route that never makes one. */
export const SESSION_ROUTE_REFUSED = 'SESSION_ROUTE_REFUSED';

/**
 * The session route for a classifier route, or `null` for the relay, which
 * never carries a person session.
 *
 * @param route - The classifier's route for a request.
 */
export function sessionRouteOf(route: RequestRoute): SessionRoute | null {
  if (route === 'own-tunnel') return 'tunnel';
  if (route === 'relay') return null;
  return route;
}

/**
 * The session route of one request, from the same classifier every gate reads.
 *
 * @param facts - The request's TCP peer, raw headers and ingress.
 */
export function requestSessionRoute(facts: ClassifierFacts): SessionRoute | null {
  return sessionRouteOf(classifyRequest(facts, currentServerRole()).route);
}

/**
 * The session-create hook's work: stamp the route the sign-in came in on,
 * overwriting anything else, and hold a Wi-Fi session to 7 days.
 *
 * @param data - The session row Better Auth is about to write.
 * @param now - The current time, for tests.
 * @returns The row to write.
 * @throws APIError `FORBIDDEN` when the request is relayed.
 */
export function stampSessionRoute<T extends { expiresAt?: Date }>(
  data: T,
  now = Date.now()
): T & { route: SessionRoute | null } {
  const caller = currentRegistrationCaller();
  // No network request made this session: code in this process did.
  if (caller === 'in-process' || caller === 'provisioning') return { ...data, route: null };
  const route = sessionRouteOf(caller.route);
  if (route === null) {
    throw new APIError('FORBIDDEN', {
      code: SESSION_ROUTE_REFUSED,
      message: 'Sign in on the computer DorkOS runs on.',
    });
  }
  if (route !== 'wifi') return { ...data, route };
  const cap = new Date(now + WIFI_SESSION_MAX_SECONDS * 1000);
  const expiresAt = data.expiresAt && data.expiresAt < cap ? data.expiresAt : cap;
  return { ...data, route, expiresAt };
}

/** The session fields {@link sessionWorksOn} reads. */
export interface RoutedSession {
  /** The stored route, `null` or absent for a session made before routes were recorded. */
  route?: string | null;
  /** When the sign-in was made. */
  createdAt?: Date | string;
}

/**
 * Whether a session may stand for its person on this request's route.
 *
 * @param session - The verified session.
 * @param requestRoute - The route the request came in on (`null` for the relay).
 * @param now - The current time, for tests.
 */
export function sessionWorksOn(
  session: RoutedSession,
  requestRoute: SessionRoute | null,
  now = Date.now()
): boolean {
  if (requestRoute === null) return false;
  const stored = session.route ?? null;
  if (stored === null) return requestRoute === 'local';
  if (stored !== requestRoute) return false;
  if (stored === 'wifi') {
    // No sign-in time to count from reads as too old.
    if (session.createdAt === undefined) return false;
    const age = now - new Date(session.createdAt).getTime();
    if (!(age <= WIFI_SESSION_MAX_SECONDS * 1000)) return false;
  }
  return true;
}

/**
 * A Better Auth session cookie's name, under any prefix: the token, the signed
 * snapshot (chunked or not) and the "don't remember me" marker. Other Better
 * Auth cookies (an OAuth sign-in's state) are not sessions.
 */
const SESSION_COOKIE = /\.(?:session_token|session_data(?:\.\d+)?|dont_remember)$/;

/**
 * Whether a `Cookie` header might carry a session cookie. Deliberately loose:
 * it reads the raw text, so it can only say yes too often, never too rarely.
 * Neither cookie parser Better Auth uses decodes a name.
 *
 * @param header - The raw `Cookie` header.
 */
export function mayCarrySessionCookie(header: string): boolean {
  return /session_token|session_data|dont_remember/.test(header);
}

/**
 * A `Cookie` header with every session cookie taken out, so Better Auth sees
 * nobody signed in.
 *
 * Rebuilt from Better Auth's own cookie parser rather than edited as text, so
 * the two cannot disagree about a name: `name =value`, a tab before the `=`,
 * a repeated name, all read as the parser reads them. A pair that parser
 * refuses is dropped, which only ever takes a cookie away.
 *
 * @param header - The raw `Cookie` header.
 */
export function withoutSessionCookies(header: string): string {
  return [...parseCookies(header)]
    .filter(([name]) => !SESSION_COOKIE.test(name))
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join('; ');
}
