import { logger } from '../lib/logger.js';
import { isLoopbackPeer } from '../lib/trusted-origins.js';
import { redactMediaTicket } from '../services/extensions/http/media-tickets.js';

/** A video link's ticket: 32 random bytes, base64url (`media-tickets.ts`). */
const TICKET_SEGMENT = /^[A-Za-z0-9_-]{43}$/;

/** At most this many lines per other device per minute; the rest are counted (DOR-5042). */
export const LAN_LINES_PER_MINUTE = 60;

/**
 * Decode the way the router does: each run of valid `%XX` sequences on its own,
 * leaving a malformed one as sent, so one bad sequence cannot keep the rest of
 * the path (and a ticket in it) from being decoded.
 */
function decodeLikeRouting(path: string): string {
  return path.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

/**
 * A request path as a log line may carry it: no query string at all (a query
 * can hold a secret), decoded the way routing reads it, then with every video
 * link ticket written as `[ticket]` (DOR-4321, DOR-4736). Decoding first means
 * a spelling that still routes, such as `/api/extensions/m%65dia/<ticket>`, is
 * redacted too; any 43-character base64url segment under `/extensions/` is
 * redacted whatever comes before it. Control characters a decode produced are
 * written as `?`, so a path cannot start a new log line.
 *
 * @param path - The path, as sent or as routing decoded it, with or without its query string.
 */
export function redactLogPath(path: string): string {
  const decoded = decodeLikeRouting(path.split('?')[0] ?? '');
  // eslint-disable-next-line no-control-regex -- the point is to remove control characters
  const redacted = redactMediaTicket(decoded).replace(/[\u0000-\u001f\u007f]/g, '?');
  const at = redacted.toLowerCase().indexOf('/extensions/');
  if (at < 0) return redacted;
  const head = redacted.slice(0, at + '/extensions/'.length);
  const rest = redacted
    .slice(head.length)
    .split('/')
    .map((segment) => (TICKET_SEGMENT.test(segment) ? '[ticket]' : segment))
    .join('/');
  return head + rest;
}

const lanWindows = new Map<string, { start: number; lines: number; held: number }>();

/**
 * Whether another device's line may be written now: at most
 * {@link LAN_LINES_PER_MINUTE} per device per minute, so a device flooding the
 * port cannot push its own earlier lines out of the rotating log. When its next
 * minute starts, one line says how many were held back.
 */
function lanLineAllowed(client: string, now: number): boolean {
  const window = lanWindows.get(client);
  if (!window || now - window.start >= 60_000) {
    if (window?.held)
      logger.warn(
        { client, held: window.held },
        'more requests from another device were not logged'
      );
    if (lanWindows.size > 1000) lanWindows.clear();
    lanWindows.set(client, { start: now, lines: 1, held: 0 });
    return true;
  }
  if (window.lines < LAN_LINES_PER_MINUTE) {
    window.lines += 1;
    return true;
  }
  window.held += 1;
  return false;
}

/** Forget every device's line count. For tests. */
export function resetLanLineLimits(): void {
  lanWindows.clear();
}

/**
 * Log one finished HTTP request.
 *
 * A request from this machine is logged at debug, or warn for a 4xx/5xx, as
 * before. A request from any other address (another device on the network) is
 * always logged, at info or warn for a 4xx/5xx, with that address, accepted or
 * refused (DOR-5042), at most {@link LAN_LINES_PER_MINUTE} a minute per
 * device. "Another address" is {@link isLoopbackPeer}'s answer, the same one
 * the server's loopback checks use, so a request through the tunnel or a proxy
 * on this machine, which connects from loopback, is logged as this machine's.
 *
 * The chain (`http/api-chain.ts`) writes the line once each response finishes
 * or its connection closes, ahead of every refusal, and passes `(unknown)`
 * when the socket reports no address. Not covered here: WebSocket upgrades,
 * which never enter the chain, and the hub's own admission in
 * `http/front-door.ts`.
 *
 * Takes only the method, path ({@link redactLogPath}), status, timing and the
 * peer address: never a body (may contain user messages), a header (may hold
 * an auth token or a cookie) or a query string.
 *
 * @param method - The request method.
 * @param path - The request path as sent.
 * @param status - The status that went out.
 * @param ms - How long the request took, in milliseconds.
 * @param client - The peer address, when the caller has one.
 * @param aborted - True when the connection closed before the response finished.
 */
export function logRequest(
  method: string,
  path: string,
  status: number,
  ms: number,
  client?: string,
  aborted = false
): void {
  const meta = { method, path: redactLogPath(path), status, ms, ...(aborted ? { aborted } : {}) };
  if (client !== undefined && !isLoopbackPeer(client)) {
    if (!lanLineAllowed(client, Date.now())) return;
    const lan = { ...meta, client };
    if (status >= 400) logger.warn(lan, 'request from another device');
    else logger.info(lan, 'request from another device');
    return;
  }
  if (status >= 400) {
    logger.warn(meta, 'request');
  } else {
    logger.debug(meta, 'request');
  }
}
