/**
 * Express middleware factories for mounting A2A endpoints.
 *
 * Encapsulates all `@a2a-js/sdk` Express integration so the consuming
 * server package never imports the SDK directly — avoiding pnpm
 * dual-instance type mismatches when peer dependency versions differ.
 *
 * @module a2a-gateway/express-handlers
 */
import type { RequestHandler } from 'express';
import { DefaultRequestHandler } from '@a2a-js/sdk/server';
import { jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import type { RelayCore } from '@dorkos/relay';
import type { Db } from '@dorkos/db';
import { generateAgentCard, generateFleetCard } from './agent-card-generator.js';
import { SqliteTaskStore } from './task-store.js';
import { DorkOSAgentExecutor } from './dorkos-executor.js';
import type { AgentRegistryLike, CardGeneratorConfig } from './types.js';

/** Dependencies for creating A2A Express handlers. */
export interface A2aHandlerDeps {
  /** Agent registry (or MeshCore) for looking up agents. */
  agentRegistry: AgentRegistryLike;
  /** Relay core for routing A2A messages to agents. */
  relay: RelayCore;
  /** Drizzle database instance for A2A task persistence. */
  db: Db;
  /** Card generation configuration (baseUrl, version). */
  config: CardGeneratorConfig;
}

/** Express handlers returned by {@link createA2aHandlers}. */
export interface A2aHandlers {
  /** Returns the fleet Agent Card JSON. */
  fleetCard: RequestHandler;
  /** Returns a per-agent Agent Card JSON (expects `req.params.id`). */
  agentCard: RequestHandler;
  /** JSON-RPC handler for the A2A protocol. */
  jsonRpc: RequestHandler;
}

/**
 * Create Express request handlers for A2A protocol endpoints.
 *
 * Bundles the fleet card, per-agent card, and JSON-RPC handlers so the
 * consuming server only needs to mount them on the desired paths.
 *
 * @param deps - Services and configuration required for A2A operation
 * @returns Object with fleet card, agent card, and JSON-RPC handlers
 */
export function createA2aHandlers(deps: A2aHandlerDeps): A2aHandlers {
  const { agentRegistry, relay, db, config } = deps;

  const taskStore = new SqliteTaskStore(db);
  const executor = new DorkOSAgentExecutor({ relay, agentRegistry });

  // Build the fleet card lazily on each request so it reflects current state.
  // The DefaultRequestHandler uses this card for protocol introspection.
  const initialFleetCard = generateFleetCard(agentRegistry.list(), config);
  const requestHandler = new DefaultRequestHandler(initialFleetCard, taskStore, executor);

  const fleetCard: RequestHandler = (_req, res) => {
    const manifests = agentRegistry.list();
    const card = generateFleetCard(manifests, config);
    res.json(card);
  };

  const agentCard: RequestHandler = (req, res) => {
    const id = req.params.id;
    if (typeof id !== 'string') {
      res.status(400).json({ error: 'Invalid agent ID' });
      return;
    }
    const agent = agentRegistry.get(id);
    if (!agent) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    const card = generateAgentCard(agent, config);
    res.json(card);
  };

  const jsonRpc = jsonRpcHandler({
    requestHandler,
    userBuilder: UserBuilder.noAuthentication,
  });

  return { fleetCard, agentCard, jsonRpc };
}
