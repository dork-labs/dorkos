import { Router, type RequestHandler } from 'express';
import type { MeshCore } from '@dorkos/mesh';
import type { RelayCore } from '@dorkos/relay';
import type { Db } from '@dorkos/db';
import { createA2aHandlers } from '@dorkos/a2a-gateway';
import type { CardGeneratorConfig } from '@dorkos/a2a-gateway';

/** Dependencies for creating the A2A router. */
interface A2aRouterDeps {
  /** MeshCore instance for agent registry access. */
  meshCore: MeshCore;
  /** RelayCore instance for message routing. */
  relay: RelayCore;
  /** Drizzle database instance for task persistence. */
  db: Db;
  /** Base URL where the DorkOS server is accessible. */
  baseUrl: string;
  /** DorkOS version string. */
  version: string;
}

/**
 * Create an Express router for A2A protocol endpoints.
 *
 * Mounts three endpoints on the router:
 * - `GET /agents/:id/card` — Per-agent Agent Card (404 if not found)
 * - `POST /` — JSON-RPC handler for A2A protocol messages
 *
 * The fleet-level `GET /.well-known/agent.json` card is mounted separately
 * at the app root by the caller since its path is outside the `/a2a` prefix.
 * Use the returned `handlers.fleetCard` middleware for that.
 *
 * @param deps - Services required for A2A gateway operation
 */
export function createA2aRouter(deps: A2aRouterDeps): {
  router: Router;
  fleetCardHandler: RequestHandler;
} {
  const router = Router();
  const config: CardGeneratorConfig = { baseUrl: deps.baseUrl, version: deps.version };

  const handlers = createA2aHandlers({
    agentRegistry: deps.meshCore,
    relay: deps.relay,
    db: deps.db,
    config,
  });

  // GET /agents/:id/card — Per-agent Agent Card
  router.get('/agents/:id/card', handlers.agentCard);

  // POST / — A2A JSON-RPC protocol endpoint
  router.post('/', handlers.jsonRpc);

  return { router, fleetCardHandler: handlers.fleetCard };
}
