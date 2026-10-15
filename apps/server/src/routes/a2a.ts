/**
 * The A2A gateway's endpoints on the Hono chain (DOR-2809,
 * `plans/2026-10-express-to-hono.md` item 18).
 *
 * The gateway itself is framework-free (`@dorkos/a2a-gateway`): fetch-style
 * handlers over the A2A SDK's JSON-RPC transport. This file mounts them, behind
 * the chain every moved route runs (`http/api-chain.ts`: body parse, session
 * gate, agent identity, audit actor) and the surface's own gates:
 *
 * - the fleet card, at the spec's well-known path and its legacy alias: the
 *   discovery limiter, then the credential check;
 * - everything under `/a2a`: the credential check, then the route's limiter
 *   (the lighter one for the per-agent card, the tighter one for JSON-RPC).
 *
 * The credential check is `decideMcpAuth` for the `'a2a'` surface: card
 * discovery is open with login off, JSON-RPC execution never is.
 * `http/__tests__/contract/a2a-groups.contract.test.ts` pins the answers.
 *
 * @module routes/a2a
 */
import { Hono } from 'hono';
import type { MeshCore } from '@dorkos/mesh';
import type { RelayCore } from '@dorkos/relay';
import type { Db } from '@dorkos/db';
import { createA2aGateway } from '@dorkos/a2a-gateway';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { buildA2aRateLimiters } from '../middleware/a2a-rate-limit.js';
import { honoMcpAuth } from '../middleware/mcp-auth.js';
import { logger } from '../lib/logger.js';

/** What the A2A routes read from the running server. */
export interface A2aRouteDeps {
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
  /** Max JSON-RPC requests per minute per caller (default 60). */
  rpcMaxPerMinute?: number;
  /** Max card requests per minute per caller (default 300). */
  cardMaxPerMinute?: number;
}

/**
 * Create the A2A routes. Mount at the app root: they answer at
 * `/.well-known/agent-card.json`, `/.well-known/agent.json` and under `/a2a`.
 *
 * - `GET /.well-known/agent-card.json` (and the legacy `agent.json`): the
 *   fleet card
 * - `GET /a2a/agents/:id/card`: one agent's card (404 if not found)
 * - `POST /a2a/agents/:id`: one agent's JSON-RPC endpoint, the `url` on its
 *   card; binds the target agent from the URL
 * - `POST /a2a`: the fleet JSON-RPC endpoint (requires `metadata.agentId`)
 *
 * @param deps - Services required for A2A gateway operation
 * @returns The routes.
 */
export function createA2aRoutes(deps: A2aRouteDeps): Hono<ApiEnv> {
  const gateway = createA2aGateway({
    agentRegistry: deps.meshCore,
    relay: deps.relay,
    db: deps.db,
    config: { baseUrl: deps.baseUrl, version: deps.version },
    // A cancelled or timed-out turn the gateway could not stop is reported
    // nowhere else (DOR-791) — it belongs in the server's own log, not on a
    // bare console.
    logger,
  });
  const { rpc: rpcLimiter, card: cardLimiter } = buildA2aRateLimiters({
    rpcMaxPerMinute: deps.rpcMaxPerMinute,
    cardMaxPerMinute: deps.cardMaxPerMinute,
  });
  const auth = honoMcpAuth('a2a');
  // The body the chain parsed. The gateway never reads the stream again.
  const rpcOptions = (c: Parameters<typeof readJsonBody>[0]) => ({ parsedBody: readJsonBody(c) });

  const routes = new Hono<ApiEnv>();
  // The fleet card at the spec well-known path (AGENT_CARD_PATH in the A2A
  // SDK — standard clients discover the card here), and the legacy path kept
  // during the transition. The discovery limiter runs before the credential
  // check, so unauthenticated scraping is throttled too.
  for (const path of ['/.well-known/agent-card.json', '/.well-known/agent.json']) {
    routes.get(path, cardLimiter, auth, () => gateway.fleetCard());
  }
  routes.get('/a2a/agents/:id/card', auth, cardLimiter, (c) =>
    gateway.agentCard(c.req.param('id'))
  );
  routes.post('/a2a/agents/:id', auth, rpcLimiter, (c) =>
    gateway.agentJsonRpc(c.req.param('id'), c.req.raw, rpcOptions(c))
  );
  routes.post('/a2a', auth, rpcLimiter, (c) => gateway.jsonRpc(c.req.raw, rpcOptions(c)));
  return routes;
}
