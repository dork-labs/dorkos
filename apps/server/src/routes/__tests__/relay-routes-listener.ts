/**
 * The Relay routes on the real `/api` chain, for a test that hands them its
 * own fakes: mounted at `/api/relay` with the signed webhook's raw-bytes body
 * rule, as `http/hono-api.ts` mounts them.
 */
import type { RequestListener } from 'node:http';
import {
  honoGroupListener,
  type HonoGroupListenerOptions,
} from '../../http/__tests__/hono-group-listener.js';
import { createRelayRoutes, type RelayRouteDeps } from '../relay.js';
import { relayWebhookBodyRule } from '../relay-webhooks.js';

/**
 * A Node request listener serving the Relay routes behind the `/api` chain.
 *
 * @param deps - The bus and whatever else the test hands over.
 * @param options - Middleware between the chain and the routes, as a test
 *   that sets the caller needs.
 * @returns The listener.
 */
export function relayRoutesListener(
  deps: Omit<RelayRouteDeps, 'isRoomSession'> & Partial<Pick<RelayRouteDeps, 'isRoomSession'>>,
  options: Pick<HonoGroupListenerOptions, 'before'> = {}
): RequestListener {
  return honoGroupListener(
    // No room conversations unless the test names some.
    { path: '/api/relay', routes: createRelayRoutes({ isRoomSession: () => false, ...deps }) },
    { ...options, bodyRules: [relayWebhookBodyRule] }
  );
}
