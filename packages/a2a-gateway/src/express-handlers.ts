/**
 * Express middleware factories for mounting A2A endpoints.
 *
 * Encapsulates all `@a2a-js/sdk` Express integration so the consuming
 * server package never imports the SDK directly — avoiding pnpm
 * dual-instance type mismatches when peer dependency versions differ.
 *
 * Routing model: every request must target one agent. The per-agent
 * endpoint (`agentJsonRpc`, mounted at `/a2a/agents/:id`) binds the agent
 * from the URL — it is the `url` advertised on each per-agent card. The
 * fleet endpoint (`jsonRpc`, mounted at `/a2a`) requires an explicit
 * `metadata.agentId` (or a `taskId` whose stored task carries one) and
 * rejects untargeted messages with an actionable JSON-RPC error instead of
 * guessing.
 *
 * @module a2a-gateway/express-handlers
 */
import express, { type RequestHandler, type Response } from 'express';
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
  /** Card generation configuration (baseUrl, version, authRequired). */
  config: CardGeneratorConfig;
}

/** Express handlers returned by {@link createA2aHandlers}. */
export interface A2aHandlers {
  /** Returns the fleet Agent Card JSON. */
  fleetCard: RequestHandler;
  /** Returns a per-agent Agent Card JSON (expects `req.params.id`). */
  agentCard: RequestHandler;
  /**
   * Fleet JSON-RPC handler. Messages must carry `metadata.agentId` (or a
   * `taskId` continuing a targeted task); untargeted messages are rejected
   * with an actionable JSON-RPC error.
   */
  jsonRpc: RequestHandler;
  /**
   * Per-agent JSON-RPC handler (expects `req.params.id`). Binds the target
   * agent from the URL so clients that discovered an agent's card talk to
   * exactly that agent.
   */
  agentJsonRpc: RequestHandler;
}

/** JSON-RPC 2.0 "invalid params" error code, used for routing rejections. */
const JSONRPC_INVALID_PARAMS = -32602;

/** JSON-RPC request id extracted for error responses. */
type JsonRpcId = string | number | null;

/** The subset of a JSON-RPC A2A message the routing layer inspects/mutates. */
interface RoutableMessage {
  taskId?: unknown;
  metadata?: Record<string, unknown>;
}

/** Extract the JSON-RPC request id from a parsed body, or `null`. */
function extractRpcId(body: unknown): JsonRpcId {
  if (typeof body !== 'object' || body === null) return null;
  const id = (body as { id?: unknown }).id;
  return typeof id === 'string' || typeof id === 'number' ? id : null;
}

/**
 * Extract the A2A message from a `message/send` / `message/stream` request
 * body, or `undefined` for any other method (or a malformed body — the SDK
 * produces its own invalid-params error for those).
 */
function extractRoutableMessage(body: unknown): RoutableMessage | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const { method, params } = body as { method?: unknown; params?: unknown };
  if (method !== 'message/send' && method !== 'message/stream') return undefined;
  if (typeof params !== 'object' || params === null) return undefined;
  const message = (params as { message?: unknown }).message;
  if (typeof message !== 'object' || message === null) return undefined;
  return message as RoutableMessage;
}

/** Whether a message names a target: a non-empty `metadata.agentId` or a `taskId`. */
function hasTarget(message: RoutableMessage): boolean {
  const agentId = message.metadata?.agentId;
  if (typeof agentId === 'string' && agentId.length > 0) return true;
  return typeof message.taskId === 'string' && message.taskId.length > 0;
}

/** Respond with a JSON-RPC error object (routing-layer rejections). */
function sendRpcError(res: Response, status: number, id: JsonRpcId, message: string): void {
  res.status(status).json({
    jsonrpc: '2.0',
    id,
    error: { code: JSONRPC_INVALID_PARAMS, message },
  });
}

/**
 * Create Express request handlers for A2A protocol endpoints.
 *
 * Bundles the fleet card, per-agent card, fleet JSON-RPC, and per-agent
 * JSON-RPC handlers so the consuming server only needs to mount them on the
 * desired paths.
 *
 * @param deps - Services and configuration required for A2A operation
 * @returns Object with card and JSON-RPC handlers ({@link A2aHandlers})
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

  // The SDK's handler is an Express router serving POST '/' with its own
  // express.json() — safe to run after ours (body-parser skips an
  // already-parsed body), so routing checks below see the same object the
  // SDK will consume and metadata mutations stick.
  const sdkJsonRpc = jsonRpcHandler({
    requestHandler,
    userBuilder: UserBuilder.noAuthentication,
  });
  const parseJson = express.json();

  const missingTargetError =
    "No target agent specified. POST to a specific agent's endpoint at " +
    `${config.baseUrl}/a2a/agents/{agentId} — the url advertised on its agent card — or set ` +
    'metadata.agentId on the message. Discover agents via the fleet card at ' +
    '/.well-known/agent-card.json (each skill id is an agent id).';

  const jsonRpc: RequestHandler = (req, res, next) => {
    parseJson(req, res, (err?: unknown) => {
      if (err) {
        next(err);
        return;
      }
      const message = extractRoutableMessage(req.body);
      if (message && !hasTarget(message)) {
        sendRpcError(res, 400, extractRpcId(req.body), missingTargetError);
        return;
      }
      sdkJsonRpc(req, res, next);
    });
  };

  const agentJsonRpc: RequestHandler = (req, res, next) => {
    const id = req.params.id;
    const agent = typeof id === 'string' ? agentRegistry.get(id) : undefined;
    if (!agent) {
      sendRpcError(
        res,
        404,
        null,
        `Agent '${String(id)}' not found. Discover agents via /.well-known/agent-card.json.`
      );
      return;
    }
    parseJson(req, res, (err?: unknown) => {
      if (err) {
        next(err);
        return;
      }
      const message = extractRoutableMessage(req.body);
      if (message) {
        const requested = message.metadata?.agentId;
        if (typeof requested === 'string' && requested.length > 0 && requested !== agent.id) {
          sendRpcError(
            res,
            400,
            extractRpcId(req.body),
            `metadata.agentId '${requested}' conflicts with this endpoint's agent ` +
              `'${agent.id}'. Drop metadata.agentId or POST to the fleet endpoint /a2a.`
          );
          return;
        }
        message.metadata = { ...(message.metadata ?? {}), agentId: agent.id };
      }
      // The SDK router serves POST '/'; this handler is mounted at a nested
      // path ('/a2a/agents/:id'), so rebase the url before delegating.
      req.url = '/';
      sdkJsonRpc(req, res, next);
    });
  };

  return { fleetCard, agentCard, jsonRpc, agentJsonRpc };
}
