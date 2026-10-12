/**
 * The A2A endpoints as fetch-style handlers: a web `Request` in, a web
 * `Response` out, with no web framework in between.
 *
 * Encapsulates all `@a2a-js/sdk` integration so the consuming server never
 * imports the SDK directly — avoiding pnpm dual-instance type mismatches when
 * dependency versions differ. A host mounts the four handlers on whatever
 * router it runs (the DorkOS server mounts them on Hono, `routes/a2a.ts`).
 *
 * Routing model: every request must target one agent. The per-agent
 * endpoint ({@link A2aGateway.agentJsonRpc}, mounted at `/a2a/agents/:id`)
 * binds the agent from the URL — it is the `url` advertised on each per-agent
 * card. The fleet endpoint ({@link A2aGateway.jsonRpc}, mounted at `/a2a`)
 * requires an explicit `metadata.agentId` (or a `taskId` whose stored task
 * carries one) and rejects untargeted messages with an actionable JSON-RPC
 * error instead of guessing.
 *
 * The JSON-RPC handling is the SDK's own `JsonRpcTransportHandler` (and its
 * v0.3 twin), driven the way the SDK's Express adapter drives it: the same
 * content-type guard, version check, extension headers, error mapping and SSE
 * framing, so a client sees the same answers it saw when the gateway was an
 * Express router.
 *
 * @module a2a-gateway/http-handlers
 */
import {
  A2A_VERSION_HEADER,
  AgentCard,
  Extensions,
  HTTP_EXTENSION_HEADER,
  SSE_HEADERS,
  formatSSEErrorEvent,
  formatSSEEvent,
} from '@a2a-js/sdk';
import { ContentTypeNotSupportedError } from '@a2a-js/sdk/errors';
import {
  DefaultRequestHandler,
  JsonRpcTransportHandler,
  UnauthenticatedUser,
  defaultServerCallContextBuilder,
  validateVersion,
  type ServerCallContext,
} from '@a2a-js/sdk/server';
import { LegacyJsonRpcTransportHandler } from '@a2a-js/sdk/compat/v0_3/server';
import type { RelayCore } from '@dorkos/relay';
import type { Logger } from '@dorkos/shared/logger';
import type { Db } from '@dorkos/db';
import { generateAgentCard, generateFleetCard } from './agent-card-generator.js';
import { SqliteTaskStore, BOUND_AGENT_STATE_KEY } from './task-store.js';
import { DorkOSAgentExecutor } from './dorkos-executor.js';
import type { AgentRegistryLike, CardGeneratorConfig } from './types.js';

/** Dependencies for {@link createA2aGateway}. */
export interface A2aGatewayDeps {
  /** Agent registry (or MeshCore) for looking up agents. */
  agentRegistry: AgentRegistryLike;
  /** Relay core for routing A2A messages to agents. */
  relay: RelayCore;
  /** Drizzle database instance for A2A task persistence. */
  db: Db;
  /** Card generation configuration (baseUrl, version). */
  config: CardGeneratorConfig;
  /**
   * Where the gateway reports what went wrong off the wire: a turn it could not
   * stop, an error it answered with a JSON-RPC 500, a stream that broke.
   *
   * Optional, defaulting to `console`. Hosts should pass their own: a turn the
   * gateway timed out and then failed to stop is invisible on the wire — the
   * caller has already been told the request timed out — so that warning only
   * exists in the log the host collects.
   */
  logger?: Logger;
}

/** Options for a JSON-RPC handler call. */
export interface A2aRpcOptions {
  /**
   * The request body, when the host already read the request stream (a host
   * that parses JSON for every route, as the DorkOS server does). Pass the key
   * even when the value is `undefined`: that says "the host read no JSON body",
   * and the gateway does not try to read the stream again.
   *
   * Leave the key out and the gateway reads the body itself, parsing it only
   * when its content type is `application/json`.
   */
  parsedBody?: unknown;
}

/** The A2A endpoints, as returned by {@link createA2aGateway}. */
export interface A2aGateway {
  /** The fleet Agent Card, built from the registry as it is now. */
  fleetCard(): Response;
  /** One agent's Agent Card, or a `404` when no such agent is registered. */
  agentCard(agentId: string): Response;
  /**
   * The fleet JSON-RPC endpoint. Messages must carry `metadata.agentId` (or a
   * `taskId` continuing a targeted task); untargeted messages are rejected
   * with an actionable JSON-RPC error.
   */
  jsonRpc(request: Request, options?: A2aRpcOptions): Promise<Response>;
  /**
   * One agent's JSON-RPC endpoint. Binds the target agent from the URL so
   * clients that discovered an agent's card talk to exactly that agent.
   */
  agentJsonRpc(agentId: string, request: Request, options?: A2aRpcOptions): Promise<Response>;
}

/** JSON-RPC 2.0 "invalid params" error code, used for routing rejections. */
const JSONRPC_INVALID_PARAMS = -32602;

/** JSON-RPC 2.0 "parse error" code, for a body that is not JSON. */
const JSONRPC_PARSE_ERROR = -32700;

/** The content type every JSON answer goes out with: what Express's `res.json` wrote. */
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

/** The v0.3 spelling of {@link HTTP_EXTENSION_HEADER}. */
const LEGACY_EXTENSION_HEADER = 'X-A2A-Extensions';

/** The v0.3 method that streams even when the caller did not ask for a stream. */
const LEGACY_RESUBSCRIBE = 'tasks/resubscribe';

/**
 * The JSON-RPC methods that carry a message needing a target agent.
 *
 * Both spellings, deliberately: A2A v1.0 renamed these methods, and the
 * gateway accepts the v0.3 names too (see {@link createA2aGateway}). The
 * routing check below runs before the SDK's own dispatch, so it has to
 * recognize every name the SDK will go on to accept — miss one and a
 * v0.3 client's untargeted message sails past the check that exists to
 * give it an actionable error.
 */
const MESSAGE_METHODS = new Set([
  // v1.0
  'SendMessage',
  'SendStreamingMessage',
  // v0.3
  'message/send',
  'message/stream',
]);

/**
 * The v1.0 JSON-RPC method names. A request naming anything else is handed to
 * the v0.3 handler, as the SDK's Express adapter does with compat on: that
 * handler knows the v0.3 names, and answers an unknown one in v0.3's shape.
 */
const V1_METHODS = new Set([
  'SendMessage',
  'SendStreamingMessage',
  'GetTask',
  'ListTasks',
  'CancelTask',
  'SubscribeToTask',
  'CreateTaskPushNotificationConfig',
  'GetTaskPushNotificationConfig',
  'ListTaskPushNotificationConfigs',
  'DeleteTaskPushNotificationConfig',
  'GetExtendedAgentCard',
]);

/** JSON-RPC request id extracted for error responses. */
type JsonRpcId = string | number | null;

/** The subset of a JSON-RPC A2A message the routing layer inspects/mutates. */
interface RoutableMessage {
  taskId?: unknown;
  metadata?: Record<string, unknown>;
}

/** A JSON answer, typed as Express's `res.json` typed it. */
function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  const response = new Response(JSON.stringify(body), { status, headers });
  response.headers.set('Content-Type', JSON_CONTENT_TYPE);
  return response;
}

/** Extract the JSON-RPC request id from a parsed body, or `null`. */
function extractRpcId(body: unknown): JsonRpcId {
  if (typeof body !== 'object' || body === null) return null;
  const id = (body as { id?: unknown }).id;
  return typeof id === 'string' || typeof id === 'number' ? id : null;
}

/**
 * The id an SDK-level error answer carries: whatever the body named, unless
 * it is falsy — the SDK's Express adapter wrote `req.body?.id || null`.
 */
function sdkErrorId(body: unknown): unknown {
  if (typeof body !== 'object' || body === null) return null;
  return (body as { id?: unknown }).id || null;
}

/** The JSON-RPC method a parsed body names, if it names one. */
function methodOf(body: unknown): unknown {
  return typeof body === 'object' && body !== null
    ? (body as { method?: unknown }).method
    : undefined;
}

/**
 * Extract the A2A message from a message-sending request body, or `undefined`
 * for any other method (or a malformed body — the SDK produces its own
 * invalid-params error for those).
 */
function extractRoutableMessage(body: unknown): RoutableMessage | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const { method, params } = body as { method?: unknown; params?: unknown };
  if (typeof method !== 'string' || !MESSAGE_METHODS.has(method)) return undefined;
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
function rpcError(status: number, id: JsonRpcId, message: string): Response {
  return json({ jsonrpc: '2.0', id, error: { code: JSONRPC_INVALID_PARAMS, message } }, status);
}

/** The media type of a request, lower-cased, without its parameters. */
function mediaTypeOf(request: Request): string | null {
  const raw = request.headers.get('content-type');
  return raw === null ? null : (raw.split(';', 1)[0] ?? '').trim().toLowerCase();
}

/**
 * Read the request body, the way the SDK's Express adapter read it: JSON only
 * when the content type says so, nothing at all otherwise.
 *
 * @returns The body, or a ready `400` answer when it was not JSON.
 */
async function readBody(
  request: Request,
  options: A2aRpcOptions | undefined
): Promise<{ body: unknown } | { refusal: Response }> {
  if (options && 'parsedBody' in options) return { body: options.parsedBody };
  if (mediaTypeOf(request) !== 'application/json') return { body: undefined };
  const text = await request.text();
  if (text.length === 0) return { body: undefined };
  try {
    return { body: JSON.parse(text) as unknown };
  } catch {
    return {
      refusal: json(
        {
          jsonrpc: '2.0',
          id: null,
          error: { code: JSONRPC_PARSE_ERROR, message: 'Invalid JSON payload.' },
        },
        400
      ),
    };
  }
}

/** The request headers as a plain object, lower-case names: what the SDK reads. */
function headerRecord(request: Request): Record<string, string> {
  const record: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    record[name] = value;
  });
  return record;
}

/**
 * Create the A2A endpoints as fetch-style handlers.
 *
 * Bundles the fleet card, per-agent card, fleet JSON-RPC, and per-agent
 * JSON-RPC handlers so the consuming server only needs to mount them on the
 * desired paths.
 *
 * @param deps - Services and configuration required for A2A operation
 * @returns The endpoints ({@link A2aGateway})
 */
export function createA2aGateway(deps: A2aGatewayDeps): A2aGateway {
  const { agentRegistry, relay, db, config } = deps;
  const logger: Pick<Logger, 'error'> = deps.logger ?? console;

  const taskStore = new SqliteTaskStore(db);
  const executor = new DorkOSAgentExecutor({
    relay,
    agentRegistry,
    ...(deps.logger ? { logger: deps.logger } : {}),
  });

  // The DefaultRequestHandler uses this card for protocol introspection (which
  // versions and capabilities the endpoint declares); the served cards are
  // built fresh on each request so they reflect current state.
  const requestHandler = new DefaultRequestHandler(
    generateFleetCard(agentRegistry.list(), config),
    taskStore,
    executor
  );
  // Agents built against A2A v0.3 keep working: a request in the older method
  // names and message shapes goes to the SDK's compat handler, which answers in
  // the shape the caller asked in — so an external peer that has not moved to
  // v1.0 is not cut off by our upgrading. The cards advertise the v0.3
  // interface to match (see `agent-card-generator.ts`); the SDK refuses a
  // protocol version its card does not declare, so the two go together.
  const v1Transport = new JsonRpcTransportHandler(requestHandler);
  const legacyTransport = new LegacyJsonRpcTransportHandler(requestHandler);

  // Cards go out through `AgentCard.toJSON`, never as the raw object. A2A
  // v1.0's types are protobuf-derived, so the in-memory shape is not the wire
  // shape: a security scheme is a `{ $case, value }` union in memory and a
  // `{ httpAuthSecurityScheme: … }` key on the wire, and unset fields are
  // dropped rather than serialized as empty. Serializing the object straight
  // would publish a card no A2A client can read.
  const fleetCard = (): Response =>
    json(AgentCard.toJSON(generateFleetCard(agentRegistry.list(), config)));

  const agentCard = (agentId: string): Response => {
    const agent = agentRegistry.get(agentId);
    if (!agent) return json({ error: 'Agent not found' }, 404);
    return json(AgentCard.toJSON(generateAgentCard(agent, config)));
  };

  /**
   * Run one JSON-RPC request through the SDK's transport handlers, as the
   * SDK's Express adapter does.
   *
   * @param boundAgentId - The agent the URL bound, if any. `ListTasks` has no
   *   field for the endpoint it arrived on, so the binding rides in the call
   *   context's state bag — which is what that bag is for — and
   *   {@link SqliteTaskStore.list} reads it there.
   */
  const dispatch = async (
    request: Request,
    body: unknown,
    boundAgentId: string | undefined
  ): Promise<Response> => {
    const mediaType = mediaTypeOf(request);
    if (mediaType !== null && mediaType !== 'application/json') {
      const raw = request.headers.get('content-type');
      return json(
        {
          jsonrpc: '2.0',
          id: null,
          error: JsonRpcTransportHandler.mapToJSONRPCError(
            new ContentTypeNotSupportedError(
              `Unsupported Content-Type "${raw}"; expected application/json.`
            )
          ),
        },
        400
      );
    }

    const method = methodOf(body);
    // Any parsed body that names no v1.0 method, a missing method included.
    const useLegacy =
      typeof body === 'object' &&
      body !== null &&
      !(typeof method === 'string' && V1_METHODS.has(method));
    const mapToError = useLegacy
      ? LegacyJsonRpcTransportHandler.mapToLegacyJSONRPCError
      : JsonRpcTransportHandler.mapToJSONRPCError;
    const errorEnvelope = (error: unknown) => ({
      jsonrpc: '2.0',
      id: sdkErrorId(body),
      error: mapToError(error),
    });

    try {
      const extensionsHeader = useLegacy
        ? (request.headers.get(LEGACY_EXTENSION_HEADER) ??
          request.headers.get(HTTP_EXTENSION_HEADER))
        : request.headers.get(HTTP_EXTENSION_HEADER);
      const context: ServerCallContext = defaultServerCallContextBuilder({
        extensions: Extensions.parseServiceParameter(extensionsHeader ?? undefined),
        user: new UnauthenticatedUser(),
        headers: headerRecord(request),
        requestedVersion: request.headers.get(A2A_VERSION_HEADER) || undefined,
      });
      if (boundAgentId) context.state.set(BOUND_AGENT_STATE_KEY, boundAgentId);
      validateVersion(context.requestedVersion, await requestHandler.getAgentCard(), 'JSONRPC');

      const transport = useLegacy ? legacyTransport : v1Transport;
      const answer = await transport.handle(body as Record<string, unknown>, context);
      const headers = new Headers();
      if (context.activatedExtensions) {
        headers.set(
          useLegacy ? LEGACY_EXTENSION_HEADER : HTTP_EXTENSION_HEADER,
          Array.from(context.activatedExtensions).join(', ')
        );
      }

      if (!isAsyncIterable(answer)) return json(answer, 200, headers);

      const iterator = answer[Symbol.asyncIterator]();
      // A v0.3 resubscribe streams from the first byte. Anything else waits
      // for its first event, so an error before the stream starts is still a
      // plain JSON answer rather than a stream holding one error event.
      let first: IteratorResult<unknown> | undefined;
      if (!(useLegacy && method === LEGACY_RESUBSCRIBE)) {
        try {
          first = await iterator.next();
        } catch (error) {
          logger.error(
            `[a2a] stream for request ${String(sdkErrorId(body))} failed to start`,
            error
          );
          return json(errorEnvelope(error), 200, headers);
        }
      }
      for (const [name, value] of Object.entries(SSE_HEADERS)) headers.set(name, value);
      return new Response(sseBody(iterator, first, errorEnvelope, logger), {
        status: 200,
        headers,
      });
    } catch (error) {
      logger.error('[a2a] unhandled error in a JSON-RPC request', error);
      return json(errorEnvelope(error), 500);
    }
  };

  const missingTargetError =
    "No target agent specified. POST to a specific agent's endpoint at " +
    `${config.baseUrl}/a2a/agents/{agentId} — the url advertised on its agent card — or set ` +
    'metadata.agentId on the message. Discover agents via the fleet card at ' +
    '/.well-known/agent-card.json (each skill id is an agent id).';

  const jsonRpc = async (request: Request, options?: A2aRpcOptions): Promise<Response> => {
    const read = await readBody(request, options);
    if ('refusal' in read) return read.refusal;
    const message = extractRoutableMessage(read.body);
    if (message && !hasTarget(message)) {
      return rpcError(400, extractRpcId(read.body), missingTargetError);
    }
    // Nothing is bound here: this endpoint answers for the whole fleet.
    return dispatch(request, read.body, undefined);
  };

  const agentJsonRpc = async (
    agentId: string,
    request: Request,
    options?: A2aRpcOptions
  ): Promise<Response> => {
    const agent = agentRegistry.get(agentId);
    if (!agent) {
      return rpcError(
        404,
        null,
        `Agent '${agentId}' not found. Discover agents via /.well-known/agent-card.json.`
      );
    }
    const read = await readBody(request, options);
    if ('refusal' in read) return read.refusal;
    const message = extractRoutableMessage(read.body);
    if (message) {
      const requested = message.metadata?.agentId;
      if (typeof requested === 'string' && requested.length > 0 && requested !== agent.id) {
        return rpcError(
          400,
          extractRpcId(read.body),
          `metadata.agentId '${requested}' conflicts with this endpoint's agent ` +
            `'${agent.id}'. Drop metadata.agentId or POST to the fleet endpoint /a2a.`
        );
      }
      message.metadata = { ...(message.metadata ?? {}), agentId: agent.id };
    }
    // The URL is the binding. Every method on this endpoint is about this
    // agent: messages are routed to it (above), and `ListTasks` is scoped to
    // it (in the task store).
    return dispatch(request, read.body, agent.id);
  };

  return { fleetCard, agentCard, jsonRpc, agentJsonRpc };
}

/** Whether a transport answer is an event stream rather than one envelope. */
function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function'
  );
}

/**
 * The SSE body: each JSON-RPC envelope as one `data:` event, and an error
 * partway through as one `event: error` frame before the stream ends.
 *
 * A client that leaves cancels the body, which stops reading the SDK's event
 * stream; the turn behind it is the executor's to finish or time out.
 */
function sseBody(
  iterator: AsyncIterator<unknown>,
  first: IteratorResult<unknown> | undefined,
  errorEnvelope: (error: unknown) => unknown,
  logger: Pick<Logger, 'error'>
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let pending = first;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = pending ?? (await iterator.next());
        pending = undefined;
        if (next.done) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(formatSSEEvent(next.value)));
      } catch (error) {
        logger.error('[a2a] error during an SSE stream', error);
        controller.enqueue(encoder.encode(formatSSEErrorEvent(errorEnvelope(error))));
        controller.close();
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}
