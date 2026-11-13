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
 * it is stored. Streams already open are not cut here: they end when they next
 * reconnect.
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
import type { MiddlewareHandler } from 'hono';
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
  if (remoteAccessOn()) return false;
  const requestClass = classifyRequest(facts, currentServerRole());
  if (requestClass.kind === 'relayed') return true;
  if (requestClass.kind !== 'other-device') return false;
  return !isContainerPortClass(requestClass);
}

/** The chain step: answer 403 with {@link REMOTE_ACCESS_OFF_BODY} for a refused request. */
export const refuseWhileRemoteAccessOff: MiddlewareHandler<RequestFactsEnv> = async (c, next) => {
  if (refusedByRemoteAccessSwitch(honoRequestFacts(c))) {
    return c.json(REMOTE_ACCESS_OFF_BODY, 403);
  }
  await next();
};
