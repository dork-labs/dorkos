/**
 * Registers the `relay_*` and `binding_*`-adjacent external MCP tools —
 * message send/inbox, endpoints, adapters, and trace/metrics — against a
 * live `McpServer` instance. Split out of `mcp-server.ts` — see
 * `core-tools.ts` in this directory for why.
 *
 * @module services/core/external-mcp/relay-tools
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DeliveryMetricsSchema } from '@dorkos/shared/relay-schemas';
import type { McpToolDeps } from '../../runtimes/claude-code/mcp-tools/types.js';
import {
  createRelaySendHandler,
  createRelayInboxHandler,
  createRelayListEndpointsHandler,
  createRelayRegisterEndpointHandler,
  createRelayQueryHandler,
  createRelayDispatchHandler,
  createRelayUnregisterEndpointHandler,
} from '../../runtimes/claude-code/mcp-tools/relay-tools.js';
import type { SenderIdentity } from '../../runtimes/claude-code/mcp-tools/relay-helpers.js';
import {
  createRelayListAdaptersHandler,
  createRelayEnableAdapterHandler,
  createRelayDisableAdapterHandler,
  createRelayReloadAdaptersHandler,
} from '../../runtimes/claude-code/mcp-tools/adapter-tools.js';
import {
  createRelayGetTraceHandler,
  createRelayGetMetricsHandler,
} from '../../runtimes/claude-code/mcp-tools/trace-tools.js';
import { ToolAnnotationPresets } from '../mcp-tool-metadata.js';

const A = ToolAnnotationPresets;

/**
 * Register every `relay_*` tool (send/inbox/endpoints, adapters, trace and
 * metrics — 13 tools total) against `server`.
 *
 * @param server - The external `McpServer` instance to register tools against.
 * @param deps - Shared MCP tool dependencies.
 * @param identity - Server-resolved sender identity injected as the publish
 *   `from` for every send tool, so the LLM cannot assert (spoof) its own
 *   identity to bypass namespace access rules.
 */
export function registerRelayTools(
  server: McpServer,
  deps: McpToolDeps,
  identity: SenderIdentity
): void {
  // ── Send / inbox / endpoints ─────────────────────────────────────────────
  server.registerTool(
    'relay_send',
    {
      description:
        'Send a message to a Relay subject. Delivers to all endpoints matching the subject pattern. ' +
        'Returns { messageId, deliveredTo, queued }. queued:true means no live consumer matched — ' +
        'the message was buffered for a late subscriber or dead-lettered, not delivered. ' +
        'Rejected sends (e.g. rate-limited) return an error with code REJECTED; they are NOT queued.',
      inputSchema: {
        subject: z.string().describe('Target subject (e.g., "relay.agent.backend")'),
        payload: z.unknown().describe('Message payload (any JSON-serializable value)'),
        replyTo: z.string().optional().describe('Subject to send replies to'),
        budget: z
          .object({
            maxHops: z.number().int().min(1).optional().describe('Max hop count'),
            ttl: z.number().int().optional().describe('Unix timestamp (ms) expiry'),
            callBudgetRemaining: z
              .number()
              .int()
              .min(0)
              .optional()
              .describe('Remaining call budget'),
          })
          .optional()
          .describe('Optional budget constraints'),
      },
      annotations: A.mutateCreateLocal,
    },
    createRelaySendHandler(deps, identity)
  );
  server.registerTool(
    'relay_inbox',
    {
      description:
        'Read inbox messages for a Relay endpoint. Each message includes the sender payload: ' +
        '{ id, subject, status, createdAt, sender, payload }. For agent dispatch inboxes the payload is ' +
        'a progress event { type: "progress", step, step_type, text, done: false } or the final ' +
        '{ type: "agent_result", text, done: true }. Pass ack=true when polling so returned unread ' +
        'messages are marked read and the next poll only returns new ones.',
      inputSchema: {
        endpoint_subject: z.string().describe('Subject of the endpoint to read inbox for'),
        limit: z.number().int().min(1).max(100).optional().describe('Max messages to return'),
        status: z
          .string()
          .optional()
          .describe(
            'Filter by status. Use "unread" (or "new"/"pending") for unread messages, "read" (or "cur"/"delivered") for processed messages, "failed" for delivery failures. Omit to return all.'
          ),
        ack: z
          .boolean()
          .optional()
          .describe(
            'Acknowledge returned unread messages (mark them read). Set true when polling a dispatch inbox so each message is returned exactly once.'
          ),
      },
      // Not read-only: ack:true marks returned messages read, mutating inbox state.
      annotations: A.mutateUpdateLocal,
    },
    createRelayInboxHandler(deps)
  );
  server.registerTool(
    'relay_list_endpoints',
    {
      description:
        'List all registered Relay endpoints. Each endpoint includes subject, hash, maildirPath, ' +
        "registeredAt, type ('dispatch'|'query'|'persistent'|'agent'|'unknown'), and expiresAt " +
        '(ISO timestamp for dispatch endpoints indicating 30-min TTL expiry; null for others).',
      inputSchema: {},
      annotations: A.readOnlyLocal,
    },
    createRelayListEndpointsHandler(deps)
  );
  server.registerTool(
    'relay_register_endpoint',
    {
      description: 'Register a new Relay endpoint to receive messages on a subject.',
      inputSchema: {
        subject: z.string().describe('Subject for the new endpoint (e.g., "relay.agent.mybot")'),
        description: z.string().optional().describe('Human-readable description of the endpoint'),
      },
      // Throws "already registered" on a duplicate subject rather than upserting — not idempotent.
      annotations: A.mutateCreateLocal,
    },
    createRelayRegisterEndpointHandler(deps)
  );
  server.registerTool(
    'relay_send_and_wait',
    {
      description:
        'Send a message to an agent and WAIT for the reply in a single call. Preferred over relay_send + relay_inbox polling for request/reply patterns. Internally registers an ephemeral inbox, sends the message with replyTo set, and blocks until the target agent replies or the timeout elapses. ' +
        'Response shape: { reply, progress, from, replyMessageId, sentMessageId }. ' +
        'progress: array of intermediate steps emitted before the final reply (empty [] for quick replies; populated for multi-step CCA tasks). ' +
        'Each progress step: { type: "progress", step: number, step_type: "message"|"tool_result", text: string, done: false }. ' +
        'Callers that only use { reply, from, replyMessageId } are unaffected — progress is additive.',
      inputSchema: {
        to_subject: z
          .string()
          .describe('Target subject for the message (e.g., "relay.agent.{agentId}")'),
        payload: z.unknown().describe('Message payload (any JSON-serializable value)'),
        timeout_ms: z
          .number()
          .int()
          .min(1000)
          .max(600000)
          .optional()
          .describe(
            'Max milliseconds to wait for a reply (default: 60000, max: 600000). For tasks longer than 10 min, use relay_send_async instead.'
          ),
        budget: z
          .object({
            maxHops: z.number().int().min(1).optional().describe('Max hop count'),
            ttl: z.number().int().optional().describe('Unix timestamp (ms) expiry'),
            callBudgetRemaining: z
              .number()
              .int()
              .min(0)
              .optional()
              .describe('Remaining call budget'),
          })
          .optional()
          .describe('Optional budget constraints'),
      },
      annotations: A.mutateCreateLocal,
    },
    createRelayQueryHandler(deps, identity)
  );
  server.registerTool(
    'relay_send_async',
    {
      description:
        'Dispatch a message to an agent and return IMMEDIATELY with a dispatch inbox subject. ' +
        'Unlike relay_send_and_wait (which blocks), relay_send_async returns { messageId, inboxSubject } at once. ' +
        'Agent B runs asynchronously; CCA publishes incremental progress events and a final agent_result ' +
        'to the inbox. Poll relay_inbox(endpoint_subject=inboxSubject, status="unread", ack=true) for updates. ' +
        'When you receive a payload with done:true, call relay_unregister_endpoint(inboxSubject) to clean up.',
      inputSchema: {
        to_subject: z.string().describe('Target subject (e.g., "relay.agent.{agentId}")'),
        payload: z.unknown().describe('Message payload'),
        budget: z
          .object({
            maxHops: z.number().int().min(1).optional(),
            ttl: z.number().int().optional(),
            callBudgetRemaining: z.number().int().min(0).optional(),
          })
          .optional(),
      },
      annotations: A.mutateCreateLocal,
    },
    createRelayDispatchHandler(deps, identity)
  );
  server.registerTool(
    'relay_unregister_endpoint',
    {
      description:
        'Unregister a Relay endpoint. Use to clean up dispatch inboxes after relay_send_async completes (when done:true received).',
      inputSchema: {
        subject: z.string().describe('Subject of the endpoint to unregister'),
      },
      annotations: A.mutateDeleteLocal,
    },
    createRelayUnregisterEndpointHandler(deps)
  );

  // ── Adapters ──────────────────────────────────────────────────────────────
  server.registerTool(
    'relay_list_adapters',
    {
      description:
        'List all Relay external adapters with their current status (connected, disconnected, error).',
      inputSchema: {},
      annotations: A.readOnlyLocal,
    },
    createRelayListAdaptersHandler(deps)
  );
  server.registerTool(
    'relay_enable_adapter',
    {
      description:
        'Enable a Relay external adapter by ID. Starts the adapter and persists the change to config.',
      inputSchema: {
        id: z.string().describe('Adapter ID to enable'),
      },
      // Opens a live connection to an external chat platform (Telegram, Slack, ...).
      annotations: A.mutateUpdateOpenWorld,
    },
    createRelayEnableAdapterHandler(deps)
  );
  server.registerTool(
    'relay_disable_adapter',
    {
      description:
        'Disable a Relay external adapter by ID. Stops the adapter and persists the change to config.',
      inputSchema: {
        id: z.string().describe('Adapter ID to disable'),
      },
      annotations: A.mutateUpdateLocal,
    },
    createRelayDisableAdapterHandler(deps)
  );
  server.registerTool(
    'relay_reload_adapters',
    {
      description:
        'Reload Relay adapter configuration from disk. Hot-reloads adapter state without server restart.',
      inputSchema: {},
      // Restarts connections to every enabled external chat platform.
      annotations: A.mutateUpdateOpenWorld,
    },
    createRelayReloadAdaptersHandler(deps)
  );

  // ── Trace & metrics ───────────────────────────────────────────────────────
  server.registerTool(
    'relay_get_trace',
    {
      description:
        'Get the full delivery trace for a Relay message. Returns all spans in the trace chain.',
      inputSchema: {
        messageId: z.string().describe('Message ID to look up the trace for'),
      },
      annotations: A.readOnlyLocal,
    },
    createRelayGetTraceHandler(deps)
  );
  server.registerTool(
    'relay_get_metrics',
    {
      description:
        'Get aggregate delivery metrics for the Relay message bus. Includes counts, latency stats, and budget rejections.',
      inputSchema: {},
      annotations: A.readOnlyLocal,
      outputSchema: DeliveryMetricsSchema,
    },
    createRelayGetMetricsHandler(deps)
  );
}
