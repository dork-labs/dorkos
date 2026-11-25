/**
 * Relay message bus routes — send messages, manage endpoints, query inbox, SSE stream,
 * and external adapter management.
 *
 * @module routes/relay
 */
import type { ServerResponse } from 'node:http';
import { Hono } from 'hono';
import type { AgentSessionStoreLike, RelayCore, DeadLetterEntry } from '@dorkos/relay';
import {
  extractSessionIdFromSubject,
  isServerManagedSubject,
  SERVER_MANAGED_PREFIXES,
  withoutCarriedTurnLimits,
} from '@dorkos/relay';
import {
  SendMessageRequestSchema,
  MessageListQuerySchema,
  InboxQuerySchema,
  DeadLetterQuerySchema,
  EndpointRegistrationSchema,
  reachesServerDestination,
} from '@dorkos/shared/relay-schemas';
import { initSSEStream } from '../services/core/streams/stream-adapter.js';
import type { ApiEnv } from '../http/api-chain.js';
import { problem, readJsonBody, validationProblem } from '@dorkos/http-kit';
import { readQuery } from '../http/request-query.js';
import { streamToNodeResponse } from '../http/raw-node-stream.js';
import { DEFAULT_CWD } from '../lib/resolve-root.js';
import type { TraceStore } from '../services/relay/trace-store.js';
import { resolveSubjectLabels, type SubjectLabel } from '../services/relay/subject-resolver.js';
import { isServerOnlyPrincipal } from '../services/relay/initiate-consent.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { isFromWifi, WIFI_ACTION_REFUSAL } from '../services/core/auth/sessions/wifi-level.js';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import { readHomeManifest } from '../services/core/agent-identity/index.js';
import { createAdapterRoutes } from './relay-adapters.js';
import { createRelayWebhookRoutes } from './relay-webhooks.js';
import { logger } from '../lib/logger.js';
import { TRACING_OFF } from './relay-problems.js';
import {
  createReceiptStatusHandler,
  publishRelayMessage,
  type RelayPublishDeps,
} from './relay-delivery-receipts.js';
import {
  personSenderRefusal,
  relayMessageSender,
  type AgentSubjectLookup,
} from './relay-message-sender.js';
import {
  relayChatPlaceRefusal,
  relayChatReach,
  relayNewChatPlace,
  type RelayChatMesh,
} from './relay-chat-place.js';
import { launchRefusalReply } from './session-route-replies.js';

/** Allowed subject prefixes for SSE subscription patterns. */
const ALLOWED_PREFIXES = ['relay.human.console.', 'relay.system.', 'relay.signal.'];

/** Maximum characters for conversation preview text. */
const PREVIEW_MAX_CHARS = 120;

/** Minimal relay message shape used by conversation builder. */
interface RelayMsg {
  id: string;
  subject: string;
  status: string;
  createdAt: string;
}

/** Structured conversation returned by the conversations endpoint. */
interface Conversation {
  id: string;
  direction: 'outbound';
  status: 'delivered' | 'failed' | 'pending';
  from: SubjectLabel;
  to: SubjectLabel;
  preview: string;
  payload: unknown;
  responseCount: number;
  sentAt: string;
  completedAt: string | undefined;
  durationMs: number | undefined;
  subject: string;
  sessionId: string | undefined;
  traceId: string;
  failureReason: string | undefined;
}

/** Validate that a subscription pattern starts with an allowed prefix. */
function validateSubscriptionPattern(pattern: string): boolean {
  if (pattern === '>') return false;
  return ALLOWED_PREFIXES.some((prefix) => pattern.startsWith(prefix));
}

/**
 * Build structured conversations from relay messages, dead letters, and subject labels.
 *
 * Uses a pre-built Map for O(1) dead-letter lookups instead of repeated Array.find() calls.
 *
 * @param messages - Flat list of relay messages (newest first)
 * @param deadLetters - Dead letter entries for failed/expired messages
 * @param labelMap - Resolved human-readable labels keyed by subject string
 * @internal Exported for testing only.
 */
export function buildConversations(
  messages: RelayMsg[],
  deadLetters: DeadLetterEntry[],
  labelMap: Map<string, SubjectLabel>
): Conversation[] {
  // O(1) dead-letter lookup by messageId
  const deadLetterMap = new Map(deadLetters.map((dl) => [dl.messageId, dl]));

  // Separate requests from response chunks
  const requests: RelayMsg[] = [];
  const responseChunksBySubject = new Map<string, RelayMsg[]>();

  for (const msg of messages) {
    if (msg.subject.startsWith('relay.agent.') || msg.subject.startsWith('relay.system.')) {
      requests.push(msg);
    } else if (msg.subject.startsWith('relay.human.console.')) {
      const existing = responseChunksBySubject.get(msg.subject) ?? [];
      existing.push(msg);
      responseChunksBySubject.set(msg.subject, existing);
    }
  }

  // Build per-request from subjects using the Map for O(1) lookup
  const fromSubjects = new Map<string, string>();
  for (const req of requests) {
    const dl = deadLetterMap.get(req.id);
    let from = dl?.envelope?.from ?? '';
    if (!from) {
      if (req.subject.startsWith('relay.agent.')) {
        from = 'relay.human.console.inferred';
      } else if (req.subject.startsWith('relay.system.tasks.')) {
        from = 'relay.system.console';
      }
    }
    fromSubjects.set(req.id, from);
  }

  return requests.map((req) => {
    const deadLetter = deadLetterMap.get(req.id);
    const fromSubject = fromSubjects.get(req.id) ?? '';
    const responseChunks = responseChunksBySubject.get(fromSubject) ?? [];
    const lastChunk = responseChunks[0]; // messages are sorted newest-first

    // Build preview from dead letter envelope (has full payload)
    let preview = '';
    let payload: unknown = undefined;
    if (deadLetter?.envelope?.payload) {
      // The sender's words, never the limits the server carried on them (DOR-5151).
      payload = withoutCarriedTurnLimits(deadLetter.envelope.payload);
      const p = payload as Record<string, unknown>;
      const text = p?.content ?? p?.text ?? p?.message;
      preview =
        typeof text === 'string'
          ? text.slice(0, PREVIEW_MAX_CHARS)
          : JSON.stringify(payload).slice(0, PREVIEW_MAX_CHARS);
    }

    // Use the shared parser so conversation session IDs are extracted
    // correctly from both the legacy shape (`relay.agent.<sessionId>`) and
    // the new runtime-scoped shape (`relay.agent.<runtimeType>.<sessionId>`).
    const sessionId = req.subject.startsWith('relay.agent.')
      ? (extractSessionIdFromSubject(req.subject) ?? undefined)
      : undefined;

    return {
      id: req.id,
      direction: 'outbound' as const,
      status:
        req.status === 'delivered'
          ? ('delivered' as const)
          : req.status === 'failed'
            ? ('failed' as const)
            : ('pending' as const),
      from: labelMap.get(fromSubject) ?? { label: 'Unknown', raw: fromSubject },
      to: labelMap.get(req.subject) ?? { label: req.subject, raw: req.subject },
      preview,
      payload,
      responseCount: responseChunks.length,
      sentAt: req.createdAt,
      completedAt: lastChunk?.createdAt as string | undefined,
      durationMs: lastChunk
        ? new Date(lastChunk.createdAt as string).getTime() - new Date(req.createdAt).getTime()
        : undefined,
      subject: req.subject,
      sessionId,
      traceId: req.id,
      failureReason: deadLetter?.reason as string | undefined,
    };
  });
}

/** What the Relay routes read. */
export interface RelayRouteDeps extends RelayPublishDeps {
  /** Delivery traces, behind the trace reads and a connection's events and chats. */
  traceStore?: TraceStore;
  /**
   * Whether a session is a room's conversation (a channel's or a Direct chat's), so a message
   * can't be published straight into it past the room (DOR-3088, Security's G2).
   */
  isRoomSession: (sessionId: string) => boolean;
  /** The registry's relay address for the agent at a home, so its message goes from it (DOR-5151). */
  agentSubjectOf?: AgentSubjectLookup;
  /** Mesh, read at request time, so an agent's message into a chat meets the chat route's place rule (DOR-5200). */
  chatMesh?: () => RelayChatMesh | undefined;
  /** The relay adapter's conversation map, so the place rule asks of the chat a turn would run in. */
  agentSessions?: () => AgentSessionStoreLike | undefined;
}

/** Why a message addressed to a room's own conversation is refused. */
const ROOM_SESSION_REFUSAL = 'That conversation belongs to a room. Post in the room instead.';

/** A mailbox address that names no mailbox. */
const ENDPOINT_NOT_FOUND = 'That address has no mailbox.';

/** Why a message to, or a reply address at, a server-owned destination is refused. */
const RESERVED_SUBJECT_REFUSAL = 'DorkOS keeps that address for itself. Send somewhere else.';

/**
 * The Relay routes, mounted at `/api/relay`: messages, endpoints, dead letters,
 * metrics, traces and the event stream, plus the connection routes when an
 * adapter manager is handed over.
 *
 * @param deps - The bus, and the optional adapter manager, traces and activity feed.
 * @returns The routes.
 */
export function createRelayRoutes(deps: RelayRouteDeps): Hono<ApiEnv> {
  const { relayCore, adapterManager, traceStore } = deps;
  const router = new Hono<ApiEnv>();

  // POST /messages — Send a message
  router.post('/messages', async (c) => {
    const result = SendMessageRequestSchema.safeParse(readJsonBody(c));
    if (!result.success) return validationProblem(c, result.error);

    // This route takes a client-supplied `from`. It must not let an untrusted
    // caller assert a principal the initiate-consent gate trusts as exempt
    // (reply-forwarding, system, inbound adapter echo) — doing so would let a
    // local caller deliver to a bound human channel with `canInitiate` off,
    // bypassing DOR-277. Server-injected principals never travel this route, so
    // rejecting them here is safe. Ordinary principals go on to the sender rule
    // below, which keeps them only for the person, and remain subject to the gate.
    //
    // DOR-871: also rejects `relay.bridge.*`, which the gate evaluates
    // (non-exempt) rather than skips — see `isServerOnlyPrincipal`'s doc for
    // why that principal must still be unassertable here.
    if (isServerOnlyPrincipal(result.data.from)) {
      return problem(c, 'reserved_sender', {
        detail: 'DorkOS keeps that sender for itself. Send as yourself instead.',
      });
    }

    // DOR-3037: a person's sender shapes the turn it starts and runs it at the
    // agent's own level (`isTurnShapingSender` in the relay's agent handler; the
    // other two shaping senders are reserved above). From Wi-Fi a turn runs at
    // the runtime's default at most, so it is refused there; any other sender
    // is already held to that default.
    if (isFromWifi(honoRequestFacts(c)) && result.data.from.startsWith('relay.human.')) {
      return problem(c, 'not_from_wifi', { detail: WIFI_ACTION_REFUSAL });
    }

    // DOR-2432: nothing on this route is a server publisher — the scheduler,
    // the stop paths and the approval bridges publish in process — and the
    // route cannot tell an agent with a shell from the person at the keyboard,
    // so a server-owned destination or reply address is refused for everyone.
    const refused = [result.data.subject, result.data.replyTo].find(
      (subject): subject is string => subject !== undefined && reachesServerDestination(subject)
    );
    if (refused !== undefined) {
      return problem(c, 'reserved_subject', { detail: RESERVED_SUBJECT_REFUSAL });
    }

    // DOR-3088 (G2): a room's conversation takes its turns from the room, which holds what an
    // unproven caller says there. Publishing to its session id straight from here would skip that,
    // so it is refused, as the session relay and an extension's agent-send refuse it.
    const sessionId = extractSessionIdFromSubject(result.data.subject);
    if (sessionId !== null && deps.isRoomSession(sessionId)) {
      return problem(c, 'room_conversation', { detail: ROOM_SESSION_REFUSAL });
    }

    // DOR-5200: a verified agent's message into a chat follows the chat route's place rule.
    const facts = honoRequestFacts(c);
    const sources = { mesh: deps.chatMesh?.(), agentSessions: deps.agentSessions?.() };
    const reach = await relayChatReach(facts, result.data, sources);
    const placeRefused = await relayChatPlaceRefusal(facts, reach, sources);
    if (placeRefused)
      return problem(c, 'desk_not_own', { detail: placeRefused.error, status: 403 });
    // DOR-5151: only the person sends from a person's address.
    const personOnly = personSenderRefusal(facts, result.data.from);
    if (personOnly) return problem(c, 'person_only', personOnly);
    // DOR-5209: a new chat opens where the sessions route would open it, or is refused as there.
    const newChat = await relayNewChatPlace(facts, reach, sources);
    if ('refused' in newChat) return launchRefusalReply(c, newChat.refused);

    // DOR-5151: the server sets the sender, by the chat route's own reading of the caller.
    const sent = relayMessageSender(facts, result.data, deps.agentSubjectOf, newChat.place);
    return publishRelayMessage(c, deps, { ...result.data, ...sent });
  });

  router.get('/messages/:messageId/status', createReceiptStatusHandler(relayCore));

  // GET /messages — List with filters and cursor pagination
  router.get('/messages', (c) => {
    const result = MessageListQuerySchema.safeParse(readQuery(c));
    if (!result.success) return validationProblem(c, result.error);
    return c.json(relayCore.listMessages(result.data));
  });

  // GET /conversations — Grouped request/response exchanges with human labels
  router.get('/conversations', async (c) => {
    try {
      const messages = relayCore.listMessages({});
      const deadLetters = await relayCore.getDeadLetters();

      // Collect all unique subjects and resolve human-readable labels
      const allSubjects = [...new Set(messages.messages.map((m) => m.subject))];
      const vaultRoot = DEFAULT_CWD;
      const resolverDeps = {
        getSession: async (id: string) => {
          // Label resolution is best-effort. If the session's runtime is not
          // currently registered (e.g., a stored codex session pre-rollout),
          // skip labeling rather than 500-ing the whole /conversations response.
          try {
            const runtime = await runtimeRegistry.resolveForSession(id);
            return runtime.getSession(vaultRoot, id);
          } catch {
            return null;
          }
        },
        readManifest: readHomeManifest,
      };
      const labelMap = await resolveSubjectLabels(allSubjects, resolverDeps);

      const conversations = buildConversations(messages.messages, deadLetters, labelMap);
      return c.json({ conversations });
    } catch (err) {
      logger.error('[relay] GET /conversations failed', { err });
      return problem(c, 'internal_error', {
        detail: 'Couldn’t list message exchanges. Try again.',
      });
    }
  });

  // GET /messages/:id — Get single message with its full per-endpoint delivery
  // breakdown (all rows join on the envelope id after identity unification).
  router.get('/messages/:id', (c) => {
    const message = relayCore.getMessageDetail(c.req.param('id'));
    if (!message) return problem(c, 'not_found', { detail: 'That message doesn’t exist.' });
    return c.json(message);
  });

  // GET /endpoints — List registered endpoints
  router.get('/endpoints', (c) => c.json(relayCore.listEndpoints()));

  // POST /endpoints — Register an endpoint
  router.post('/endpoints', async (c) => {
    const result = EndpointRegistrationSchema.safeParse(readJsonBody(c));
    if (!result.success) return validationProblem(c, result.error);

    // This route takes a client-supplied subject and, with login off by
    // default, is reachable by anything that can reach the port. A mailbox in a
    // namespace the server manages intercepts mail addressed to an agent, to
    // the person, or to the server — and on a subject the server publishes
    // control signals to it manufactures a false confirmation (see
    // `isControlSubject`). The same list the agent tool surface enforces, asked
    // here too rather than trusted to a caller.
    if (isServerManagedSubject(result.data.subject)) {
      return problem(c, 'reserved_subject', {
        detail: 'DorkOS manages that address. Use one outside its own prefixes.',
        extensions: { reservedPrefixes: SERVER_MANAGED_PREFIXES },
      });
    }

    try {
      const endpoint = await relayCore.registerEndpoint(result.data.subject);
      return c.json(endpoint, 201);
    } catch (err) {
      logger.info('[relay] POST /endpoints refused', { err });
      return problem(c, 'invalid_request', {
        detail: 'Couldn’t register that address. Check it, then try again.',
      });
    }
  });

  // GET /endpoints/:subject/inbox — Read inbox. The subject takes every
  // remaining segment but the last, as dots and slashes alike may sit in it.
  router.get('/endpoints/:subject{.+}/inbox', async (c) => {
    const result = InboxQuerySchema.safeParse(readQuery(c));
    if (!result.success) return validationProblem(c, result.error);
    try {
      const messages = await relayCore.readInbox(c.req.param('subject'), result.data);
      return c.json(messages);
    } catch (err) {
      if ((err as Error & { code?: string })?.code === 'ENDPOINT_NOT_FOUND') {
        return problem(c, 'not_found', { detail: ENDPOINT_NOT_FOUND });
      }
      logger.error('[relay] GET /endpoints/:subject/inbox failed', { err });
      return problem(c, 'internal_error', { detail: 'Couldn’t read that inbox. Try again.' });
    }
  });

  // DELETE /endpoints/:subject — Unregister endpoint (the subject takes every
  // remaining segment)
  router.delete('/endpoints/:subject{.+}', async (c) => {
    const removed = await relayCore.unregisterEndpoint(c.req.param('subject'));
    if (!removed) return problem(c, 'not_found', { detail: ENDPOINT_NOT_FOUND });
    return c.json({ success: true });
  });

  // GET /dead-letters — List dead-letter messages
  router.get('/dead-letters', async (c) => {
    const result = DeadLetterQuerySchema.safeParse(readQuery(c));
    if (!result.success) return validationProblem(c, result.error);
    const { endpointHash } = result.data;
    const deadLetters = await relayCore.getDeadLetters(endpointHash ? { endpointHash } : undefined);
    return c.json(deadLetters);
  });

  // GET /dead-letters/aggregated — Dead letters grouped by source + reason
  router.get('/dead-letters/aggregated', async (c) => {
    const deadLetters = await relayCore.getDeadLetters();

    const groups = new Map<
      string,
      {
        source: string;
        reason: string;
        count: number;
        firstSeen: string;
        lastSeen: string;
        sample: unknown;
      }
    >();

    for (const dl of deadLetters) {
      const source = dl.envelope?.from ?? 'unknown';
      const key = `${source}::${dl.reason}`;
      const existing = groups.get(key);
      if (existing) {
        existing.count++;
        if (dl.failedAt < existing.firstSeen) existing.firstSeen = dl.failedAt;
        if (dl.failedAt > existing.lastSeen) existing.lastSeen = dl.failedAt;
      } else {
        groups.set(key, {
          source,
          reason: dl.reason,
          count: 1,
          firstSeen: dl.failedAt,
          lastSeen: dl.failedAt,
          sample: dl.envelope,
        });
      }
    }

    return c.json({ groups: [...groups.values()] });
  });

  // DELETE /dead-letters — Remove dead letters matching a source + reason group
  router.delete('/dead-letters', async (c) => {
    const { source, reason } = readJsonBody(c, { emptyAs: {} }) as {
      source: string;
      reason: string;
    };
    if (!source || !reason) {
      return problem(c, 'invalid_request', { detail: 'Send both `source` and `reason`.' });
    }
    const deadLetters = await relayCore.getDeadLetters();
    const toRemove = deadLetters.filter(
      (dl) => (dl.envelope?.from ?? 'unknown') === source && dl.reason === reason
    );
    for (const dl of toRemove) {
      await relayCore.removeDeadLetter(dl.endpointHash, dl.messageId);
    }
    return c.json({ removed: toRemove.length });
  });

  // GET /metrics — Relay system metrics (from RelayCore)
  router.get('/metrics', (c) => c.json(relayCore.getMetrics()));

  // GET /messages/:id/trace — Full trace for a message
  router.get('/messages/:id/trace', (c) => {
    if (!traceStore) return problem(c, 'not_found', { detail: TRACING_OFF });
    const span = traceStore.getSpanByMessageId(c.req.param('id'));
    if (!span) return problem(c, 'not_found', { detail: 'No trace for that message.' });
    const spans = traceStore.getTrace(span.traceId);
    return c.json({ traceId: span.traceId, spans });
  });

  // GET /trace/metrics — Aggregate delivery metrics from TraceStore
  router.get('/trace/metrics', (c) => {
    if (!traceStore) return problem(c, 'not_found', { detail: TRACING_OFF });
    return c.json(traceStore.getMetrics());
  });

  // GET /stream — SSE event stream with server-side subject filtering
  router.get('/stream', (c) => {
    logger.warn('[DEPRECATED] GET /api/relay/stream — use GET /api/events instead');
    const pattern = (readQuery(c).subject as string) || 'relay.human.console.>';
    if (!validateSubscriptionPattern(pattern)) {
      return problem(c, 'invalid_request', {
        detail: 'That subject pattern isn’t one this stream allows.',
        extensions: { allowedPrefixes: ALLOWED_PREFIXES },
      });
    }
    return streamToNodeResponse(c, (res, { signal }) =>
      streamRelayEvents(relayCore, pattern, res, signal)
    );
  });

  // --- Adapter Management Routes ---
  if (adapterManager) {
    router.route('/', createAdapterRoutes({ adapterManager, traceStore, activity: deps.activity }));
    router.route('/', createRelayWebhookRoutes(adapterManager));
  }

  return router;
}

/**
 * Write relay messages and signals matching `pattern` as an event stream until
 * the client leaves.
 */
function streamRelayEvents(
  relayCore: RelayCore,
  pattern: string,
  res: ServerResponse,
  signal: AbortSignal
): Promise<void> {
  initSSEStream(res);
  res.write(`event: relay_connected\n`);
  res.write(`data: ${JSON.stringify({ pattern, connectedAt: new Date().toISOString() })}\n\n`);

  // Backpressure: skip events until the client drains its buffer
  let paused = false;

  const unsubMessages = relayCore.subscribe(pattern, (envelope) => {
    if (res.writableEnded || paused) return;
    try {
      res.write(`id: ${envelope.id}\n`);
      res.write(`event: relay_message\n`);
      const canContinue = res.write(`data: ${JSON.stringify(envelope)}\n\n`);
      if (!canContinue) {
        paused = true;
        res.once('drain', () => {
          paused = false;
        });
      }
    } catch {
      // Write failure — cleaned up on close
    }
  });

  const unsubSignals = relayCore.onSignal(pattern, (_subject, relaySignal) => {
    if (res.writableEnded || paused) return;
    try {
      const eventType = relaySignal.type === 'backpressure' ? 'relay_backpressure' : 'relay_signal';
      res.write(`event: ${eventType}\n`);
      const canContinue = res.write(`data: ${JSON.stringify(relaySignal)}\n\n`);
      if (!canContinue) {
        paused = true;
        res.once('drain', () => {
          paused = false;
        });
      }
    } catch {
      // Write failure — cleaned up on close
    }
  });

  const keepalive = setInterval(() => {
    if (res.writableEnded) {
      clearInterval(keepalive);
      return;
    }
    try {
      res.write(`: keepalive\n\n`);
    } catch {
      clearInterval(keepalive);
    }
  }, 15_000);

  return new Promise((resolve) => {
    const stop = (): void => {
      clearInterval(keepalive);
      unsubMessages();
      unsubSignals();
      resolve();
    };
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
  });
}
