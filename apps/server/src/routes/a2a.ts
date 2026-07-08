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
  /** Base URL advertised on agent cards (public URL when configured). */
  baseUrl: string;
  /** DorkOS version string. */
  version: string;
  /** Whether the A2A surface enforces auth (cards advertise a security requirement). */
  authRequired: boolean;
  /** Rate limiter applied to the JSON-RPC endpoints. */
  rpcRateLimiter: RequestHandler;
  /** Lighter rate limiter applied to card (discovery) endpoints. */
  cardRateLimiter: RequestHandler;
}

/**
 * Create an Express router for A2A protocol endpoints.
 *
 * Mounts these endpoints on the router:
 * - `GET /agents/:id/card` — Per-agent Agent Card (404 if not found)
 * - `POST /agents/:id` — Per-agent JSON-RPC endpoint (the `url` on each
 *   per-agent card; binds the target agent from the URL)
 * - `POST /` — Fleet JSON-RPC endpoint (requires `metadata.agentId`)
 *
 * The fleet-level `GET /.well-known/agent-card.json` card (plus its legacy
 * `agent.json` alias) is mounted separately at the app root by the caller
 * since its path is outside the `/a2a` prefix.
 * Use the returned `fleetCardHandler` middleware for that.
 *
 * @param deps - Services required for A2A gateway operation
 */
export function createA2aRouter(deps: A2aRouterDeps): {
  router: Router;
  fleetCardHandler: RequestHandler;
} {
  const router = Router();
  const config: CardGeneratorConfig = {
    baseUrl: deps.baseUrl,
    version: deps.version,
    authRequired: deps.authRequired,
  };

  const handlers = createA2aHandlers({
    agentRegistry: deps.meshCore,
    relay: deps.relay,
    db: deps.db,
    config,
  });

  // GET /agents/:id/card — Per-agent Agent Card
  router.get('/agents/:id/card', deps.cardRateLimiter, handlers.agentCard);

  // POST /agents/:id — Per-agent A2A JSON-RPC endpoint
  router.post('/agents/:id', deps.rpcRateLimiter, handlers.agentJsonRpc);

  // POST / — Fleet A2A JSON-RPC endpoint
  router.post('/', deps.rpcRateLimiter, handlers.jsonRpc);

  return { router, fleetCardHandler: handlers.fleetCard };
}
