/**
 * The Remote Access switch (DOR-3650): while `remoteAccess.enabled` is off,
 * every request from another device is refused at the server, before any
 * sign-in, webhook or route sees it.
 *
 * "Another device" is the classifier's answer (`lib/request-classifier.ts`):
 * the own tunnel, managed remote access, Wi-Fi, a proxy's forwarding headers, a
 * non-loopback peer or `Host`, a page on another site, and the relay. The
 * setting is read on every request, so turning it off takes effect on each
 * device's next request with no restart, and it stays off across one because
 * it is stored.
 *
 * **Streams already open are closed when it turns off** (Security, DOR-3650).
 * An event stream, a streamed MCP or A2A answer, or a WebSocket another device
 * holds would otherwise keep reading after the person turned it off. Each one
 * registers here while it runs ({@link trackRemoteStream}), and so does each
 * listener only other devices reach ({@link registerRemoteListener}: the own
 * tunnel, managed remote access, Wi-Fi). The change listener
 * {@link watchRemoteAccessSwitch} closes the streams and cuts every connection
 * on those listeners the moment the setting is written off in this process,
 * whatever credential opened them. The client reconnects, and the
 * reconnect is refused. A write from another process (`dorkos config set`)
 * fires no listener here: those streams end at their next reconnect.
 *
 * Never refused, so the switch cannot lock a person out of their own app:
 *
 * - **This computer.** A request the classifier calls `this-computer`.
 * - **A container's own port.** Under `DORKOS_ALLOW_INSECURE_BIND`, the
 *   published port is how the owner reaches a Docker install at all
 *   (`isContainerPortClass`), so it counts as this computer here.
 * - **A hub or an agent computer.** Every request to them is remote by design,
 *   and they have their own gates.
 *
 * Asked by the `/api` chain (`http/api-chain.ts`) right after the managed-host
 * guard, and by the upgrade router for WebSockets.
 *
 * @module middleware/remote-access-switch
 */
import type { IncomingMessage } from 'node:http';
import type { MiddlewareHandler } from 'hono';
import { logger } from '../lib/logger.js';
import { ingressOf } from '../services/core/remote/ingress-mark.js';
import { classifyRequest, type ClassifierFacts } from '../lib/request-classifier.js';
import { currentServerRole } from '../lib/server-role.js';
import { isContainerPortClass } from '../services/core/auth/gate-policy.js';
import { configManager } from '../services/core/config-manager.js';
import { honoRequestFacts, type RequestFactsEnv } from '../http/request-facts.js';

/** The code a refused request carries, so a client can say why. */
export const REMOTE_ACCESS_OFF_CODE = 'REMOTE_ACCESS_OFF';

/** The body every refused request gets. */
export const REMOTE_ACCESS_OFF_BODY = {
  error: 'Remote access is off. Only this computer can reach DorkOS.',
  code: REMOTE_ACCESS_OFF_CODE,
} as const;

/** Whether the Remote Access switch is on. Anything but an explicit `false` reads as on. */
export function remoteAccessOn(): boolean {
  return configManager.get('remoteAccess')?.enabled !== false;
}

/**
 * Whether the switch refuses this request: it is off, and the request is from
 * another device that is not a container's own port.
 *
 * @param facts - The request's TCP peer, raw headers and ingress.
 */
export function refusedByRemoteAccessSwitch(facts: ClassifierFacts): boolean {
  // The device first: a request from this computer never reads the setting.
  return reachedFromAnotherDevice(facts) && !remoteAccessOn();
}

/**
 * Whether the switch covers this request: another device that is not a
 * container's own port, or the relay. Says nothing about the setting.
 */
function reachedFromAnotherDevice(facts: ClassifierFacts): boolean {
  const requestClass = classifyRequest(facts, currentServerRole());
  if (requestClass.kind === 'relayed') return true;
  if (requestClass.kind !== 'other-device') return false;
  return !isContainerPortClass(requestClass);
}

/** Every open stream another device holds, by the function that closes it. */
const remoteStreams = new Set<() => void>();

/**
 * Register a long-lived stream so turning the switch off closes it. A stream
 * from this computer (or a container's own port) is not registered.
 *
 * @param req - The request that opened it: headers, socket and ingress mark.
 * @param close - Ends it.
 * @returns Unregister; call it when the stream ends on its own.
 */
export function trackRemoteStream(
  req: Pick<IncomingMessage, 'headers' | 'socket'>,
  close: () => void
): () => void {
  const facts = {
    headers: req.headers,
    peerAddress: req.socket.remoteAddress,
    ingress: ingressOf(req as IncomingMessage),
  };
  if (!reachedFromAnotherDevice(facts)) return () => {};
  const entry = (): void => close();
  remoteStreams.add(entry);
  return () => void remoteStreams.delete(entry);
}

/** The listeners that serve only other devices, by the function that cuts what each carries. */
const remoteListeners = new Set<() => void>();

/**
 * Register a listener that only other devices reach (the own tunnel, managed
 * remote access, Wi-Fi), so turning the switch off cuts every connection it
 * carries: requests, keep-alive sockets and WebSockets, whatever credential
 * opened them.
 *
 * @param dropConnections - Cuts what the listener carries and keeps it listening.
 * @returns Unregister.
 */
export function registerRemoteListener(dropConnections: () => void): () => void {
  const entry = (): void => dropConnections();
  remoteListeners.add(entry);
  return () => void remoteListeners.delete(entry);
}

/**
 * Close every open stream another device holds, and cut every connection on
 * the listeners only other devices reach. A close that throws is logged,
 * never thrown.
 *
 * @returns How many streams on the main listener were closed.
 */
export function closeRemoteStreams(): number {
  const open = [...remoteStreams];
  remoteStreams.clear();
  for (const close of [...open, ...remoteListeners]) {
    try {
      close();
    } catch (err) {
      logger.warn('[remote-access] a connection would not close', { err });
    }
  }
  return open.length;
}

/**
 * Close every remote stream the moment the setting is written off. Wired once
 * at start-up.
 *
 * @returns Unsubscribe.
 */
export function watchRemoteAccessSwitch(): () => void {
  return configManager.onChange((change) => {
    if (!change.sections.includes('remoteAccess') || remoteAccessOn()) return;
    const closed = closeRemoteStreams();
    if (closed > 0) logger.info(`[remote-access] turned off; closed ${closed} open stream(s)`);
  });
}

/** Forget every registered stream and listener without closing them. Tests only. */
export function resetRemoteStreamsForTests(): void {
  remoteStreams.clear();
  remoteListeners.clear();
}

/** The chain step: answer 403 with {@link REMOTE_ACCESS_OFF_BODY} for a refused request. */
export const refuseWhileRemoteAccessOff: MiddlewareHandler<RequestFactsEnv> = async (c, next) => {
  if (refusedByRemoteAccessSwitch(honoRequestFacts(c))) {
    return c.json(REMOTE_ACCESS_OFF_BODY, 403);
  }
  await next();
};
