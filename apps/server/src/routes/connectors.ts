/**
 * Every `/api/connectors` group, in the one order they answer in.
 *
 * Five groups share the prefix, and the order is part of what they answer:
 *
 * 1. **Provider keys** (`/providers`), behind their own migration gate.
 * 2. **Notifications** (`/connections/:id/events/*`): any path under one
 *    connection's notifications asks for the owner before anything else, and
 *    these routes answer their own errors.
 * 3. **Owner reviews and grant changes**, whose migration gate has no path:
 *    it stands in front of every group after it as well.
 * 4. **Connections resources** (the catalog, accounts, sign-in flows).
 * 5. **Program execution and usage**, added once the capability registry
 *    exists.
 *
 * No route in one group shares a method and path with a route in another, so
 * a `:param` in one never claims a literal path another group answers. The
 * signed webhook ingress is not here: it answers before the body is parsed
 * and before the session gate (`services/connectors/events/signed-ingress.ts`).
 *
 * @module routes/connectors
 */
import { Hono } from 'hono';
import type { ApiEnv } from '../http/api-chain.js';
import { createConnectorEventsRoutes, type ConnectorEventsRouterDeps } from './connector-events.js';
import {
  createConnectorExecutionRoutes,
  type ConnectorExecutionRouterDeps,
} from './connector-execution.js';
import {
  createConnectorManagementRoutes,
  type ConnectorManagementRouterDeps,
} from './connector-management.js';
import {
  createConnectorProvidersRoutes,
  type ConnectorProvidersRouterDeps,
} from './connector-providers.js';
import {
  createConnectorResourcesRoutes,
  type ConnectorResourcesRouterDeps,
} from './connector-resources.js';

/** What the connector groups read, one entry per group. */
export interface ConnectorRoutesDeps {
  /** Provider keys and their status (`/providers`). */
  providers: ConnectorProvidersRouterDeps;
  /** The owner's notification setup (`/connections/:id/events/*`). */
  events: ConnectorEventsRouterDeps;
  /** Owner reviews, agent requests and grant changes. */
  management: ConnectorManagementRouterDeps;
  /** The catalog, the owner's accounts and their sign-in flows. */
  resources: ConnectorResourcesRouterDeps;
  /** Program execution and usage; set once the capability registry is composed. */
  execution?: ConnectorExecutionRouterDeps;
}

/**
 * Build the connector groups, in order, for mounting at `/api/connectors`.
 *
 * @param deps - See {@link ConnectorRoutesDeps}.
 * @returns The routes.
 */
export function createConnectorRoutes(deps: ConnectorRoutesDeps): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();
  app.route('/providers', createConnectorProvidersRoutes(deps.providers));
  app.route('/', createConnectorEventsRoutes(deps.events));
  app.route('/', createConnectorManagementRoutes(deps.management));
  app.route('/', createConnectorResourcesRoutes(deps.resources));
  if (deps.execution) app.route('/', createConnectorExecutionRoutes(deps.execution));
  return app;
}
