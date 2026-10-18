/**
 * Where one request came from: this computer, another device, the session
 * relay, or (on a hub) anywhere at all. One answer, so every later step of the
 * login work reads the same one (ADR 261015-125850, rule 1; spec
 * `specs/request-classifier`).
 *
 * ## What makes it tighter than the old `isLocalCaller`
 *
 * Every gate decides from this answer (`services/core/auth/gate-policy.ts`,
 * F1 DOR-2967). It replaced `isLocalCaller`, which read only the socket and
 * `Host`. Everything this calls `this-computer`, the old check called local
 * too, but not the reverse:
 *
 * - **No `DORKOS_ALLOW_INSECURE_BIND` shortcut.** A browser reaching a Docker
 *   install arrives from the bridge gateway, and it is another device.
 * - **A proxy forwarding header means another device.** A reverse proxy on this
 *   same host connects from loopback and can rewrite `Host` to `localhost`
 *   (default nginx `proxy_pass`, `ngrok --host-header=rewrite`, `ssh -L`), so
 *   the socket and `Host` alone read it as local. A proxy adds these headers; a
 *   local caller never does; an attacker cannot strip what the proxy adds.
 * - **A non-loopback `Origin` or `Referer` means another device.** A browser
 *   writing through a proxy that forwards no headers still names the public
 *   page it is on.
 *
 * ## What it does not close
 *
 * A same-host proxy that forwards no headers and rewrites `Host` to loopback
 * (nginx's default `proxy_pass`) carries any request with neither `Origin` nor
 * `Referer` as this computer: a browser's same-origin GET, and every request
 * from a non-browser client. A browser's writes are caught by the `Origin`
 * rule. The docs name this (`docs/self-hosting/threat-model.mdx`).
 *
 * Pure: it takes resolved facts, never a framework request, so any surface
 * that can build them (an HTTP route today; a WebSocket upgrade once F1 moves
 * the gate onto this) is judged by the same lines.
 *
 * @module lib/request-classifier
 */
import type { RequestFacts } from '../http/request-facts.js';
import { logger } from './logger.js';
import type { ServerRole } from './server-role.js';
import { isLoopbackHost, isLoopbackHostHeader, isLoopbackPeer } from './trusted-origins.js';

/** Who a request is from, as far as trust goes. */
export type RequestKind = 'this-computer' | 'other-device' | 'relayed' | 'hub' | 'agent-computer';

/**
 * The way a request came in, for binding a session to the route that made it
 * (ADR 261015-125850 rule 5). `network` is any other way: a non-loopback bind,
 * a Docker port, or a proxy.
 */
export type RequestRoute =
  'local' | 'wifi' | 'own-tunnel' | 'managed' | 'relay' | 'hub' | 'network';

/** The first rule that made a request `other-device`. */
export type OtherDeviceReason =
  /** It came through the own-tunnel, managed or Wi-Fi listener. */
  | 'ingress'
  /** A proxy forwarding header is present. */
  | 'forwarded'
  /** The TCP peer is another machine (a LAN device, a Docker bridge). */
  | 'peer-not-loopback'
  /** `Host` names something other than this machine (a public name, DNS rebinding). */
  | 'host-not-loopback'
  /** `Origin` or `Referer` names a page that is not on this machine. */
  | 'foreign-origin';

/** The classifier's answer for one request. */
export type RequestClass =
  | { kind: 'this-computer'; route: 'local' }
  | { kind: 'other-device'; route: RequestRoute; reason: OtherDeviceReason }
  | { kind: 'relayed'; route: 'relay' }
  | { kind: 'hub'; route: 'hub' }
  /**
   * Any request to a sealed agent computer (DOR-2940), which serves no person:
   * `local` when it passes every rule a request from this machine passes (so
   * it can only be a process here, such as an agent's tools), `network` for
   * anything else. Never `this-computer`, which means a person at the machine
   * and unlocks what is reserved for one.
   */
  | { kind: 'agent-computer'; route: 'local' | 'network' };

/** The facts the classifier reads. */
export type ClassifierFacts = Pick<RequestFacts, 'peerAddress' | 'headers' | 'ingress'>;

/**
 * Headers a proxy adds and a local caller never sends. `X-Forwarded-Proto` is
 * not here: it names no address, and nothing local sends it either, so it would
 * add nothing the five do not.
 */
export const FORWARDING_HEADERS = [
  'x-forwarded-for',
  'forwarded',
  'x-real-ip',
  'via',
  'x-forwarded-host',
] as const;

/**
 * Classify one request.
 *
 * Rules, first match wins: a hub; an agent computer (`local` only for what
 * would otherwise be this computer); the relay; a marked listener; a forwarding
 * header (present at all, even empty); a non-loopback peer; a non-loopback
 * `Host`; a non-loopback `Origin`, or with no `Origin` a non-loopback `Referer`.
 * What is left is this computer.
 *
 * @param facts - The request's TCP peer, raw headers and ingress.
 * @param role - What this server is (`currentServerRole`).
 * @returns The request's kind and route, and why when it is another device.
 */
export function classifyRequest(facts: ClassifierFacts, role: ServerRole): RequestClass {
  if (role === 'hub') return { kind: 'hub', route: 'hub' };
  if (role === 'agent-computer') {
    const local = facts.ingress === 'direct' && otherDeviceReason(facts) === null;
    return { kind: 'agent-computer', route: local ? 'local' : 'network' };
  }
  if (facts.ingress === 'relay') return { kind: 'relayed', route: 'relay' };
  if (facts.ingress !== 'direct') {
    return { kind: 'other-device', route: facts.ingress, reason: 'ingress' };
  }
  const reason = otherDeviceReason(facts);
  if (reason) return { kind: 'other-device', route: 'network', reason };
  return { kind: 'this-computer', route: 'local' };
}

/** Why a direct request is another device, or `null` when it is this computer. */
function otherDeviceReason(facts: ClassifierFacts): OtherDeviceReason | null {
  const { headers } = facts;
  if (FORWARDING_HEADERS.some((name) => headers[name] !== undefined)) return 'forwarded';
  if (!isLoopbackPeer(facts.peerAddress)) return 'peer-not-loopback';
  if (!isLoopbackHostHeader(headers.host)) return 'host-not-loopback';
  if (namesForeignPage(headers.origin, headers.referer)) return 'foreign-origin';
  return null;
}

/**
 * Whether `Origin`, or with no `Origin` the `Referer`, names a page that is not
 * on this machine. The literal `Origin: null` (a sandboxed frame, a `file://`
 * page, a `data:` document) and an unreadable value count as foreign: neither
 * can be shown to be a page on this machine.
 */
function namesForeignPage(origin: string | undefined, referer: string | undefined): boolean {
  if (origin !== undefined) return !isLoopbackPageUrl(origin);
  if (referer !== undefined) return !isLoopbackPageUrl(referer);
  return false;
}

/** Whether a URL is an http(s) page on a loopback host, on any port. */
function isLoopbackPageUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  // `URL` keeps the brackets on an IPv6 literal (`[::1]`).
  return isLoopbackHost(url.hostname.replace(/^\[|\]$/g, ''));
}

let warnedForeignOrigin = false;

/**
 * Log one warning, once per process, the first time a direct, loopback request
 * names a page somewhere else. That is what a reverse proxy that forwards no
 * headers looks like, though a browser extension or a `file://` page reads the
 * same, so the line names the page and suggests rather than concludes. The
 * request itself is already another device, so the gate asks it to sign in.
 *
 * @param facts - The request's headers, for the page it names.
 * @param requestClass - The request's class.
 */
export function noteForeignOrigin(
  facts: Pick<ClassifierFacts, 'headers'>,
  requestClass: RequestClass
): void {
  if (warnedForeignOrigin) return;
  if (requestClass.kind !== 'other-device' || requestClass.reason !== 'foreign-origin') return;
  warnedForeignOrigin = true;
  logger.warn(
    '[DorkOS] A request on this computer came from a page on another site. If DorkOS is ' +
      'behind a reverse proxy, that proxy sends no forwarding headers, and such ' +
      'requests count as another device, which must sign in.',
    { page: pageOrigin(facts.headers.origin ?? facts.headers.referer) }
  );
}

/**
 * The origin of a page address, for a log line. Never the whole address: a
 * `Referer` carries the path and query, where an invite link or an OAuth code
 * can sit.
 */
function pageOrigin(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const url = new URL(value);
    // A non-web scheme (`chrome-extension:`) has the opaque origin `null`.
    return url.origin === 'null' ? `${url.protocol}//${url.host}` : url.origin;
  } catch {
    return '(unreadable)';
  }
}

/**
 * Forget that the warning was logged.
 *
 * @internal Exported for testing only.
 */
export function resetForeignOriginNoteForTests(): void {
  warnedForeignOrigin = false;
}
