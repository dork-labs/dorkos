import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { McpToolDeps } from '../runtimes/claude-code/mcp-tools/types.js';
import {
  handlePing,
  handleGetServerInfo,
  createGetSessionCountHandler,
  createGetCurrentAgentHandler,
} from '../runtimes/claude-code/mcp-tools/core-tools.js';
import {
  createListSchedulesHandler,
  createCreateScheduleHandler,
  createUpdateScheduleHandler,
  createDeleteScheduleHandler,
  createGetRunHistoryHandler,
} from '../runtimes/claude-code/mcp-tools/pulse-tools.js';
import {
  createRelaySendHandler,
  createRelayInboxHandler,
  createRelayListEndpointsHandler,
  createRelayRegisterEndpointHandler,
  createRelayQueryHandler,
  createRelayDispatchHandler,
  createRelayUnregisterEndpointHandler,
} from '../runtimes/claude-code/mcp-tools/relay-tools.js';
import {
  createRelayListAdaptersHandler,
  createRelayEnableAdapterHandler,
  createRelayDisableAdapterHandler,
  createRelayReloadAdaptersHandler,
} from '../runtimes/claude-code/mcp-tools/adapter-tools.js';
import {
  createBindingListHandler,
  createBindingCreateHandler,
  createBindingDeleteHandler,
} from '../runtimes/claude-code/mcp-tools/binding-tools.js';
import {
  createRelayGetTraceHandler,
  createRelayGetMetricsHandler,
} from '../runtimes/claude-code/mcp-tools/trace-tools.js';
import {
  createMeshDiscoverHandler,
  createMeshRegisterHandler,
  createMeshListHandler,
  createMeshDenyHandler,
  createMeshUnregisterHandler,
  createMeshStatusHandler,
  createMeshInspectHandler,
  createMeshQueryTopologyHandler,
} from '../runtimes/claude-code/mcp-tools/mesh-tools.js';

/**
 * Create the external MCP server instance with all DorkOS tools registered.
 *
 * Uses the `@modelcontextprotocol/sdk` McpServer API (Streamable HTTP transport).
 * This is the external counterpart to `createDorkOsToolServer()` which uses the
 * Claude Agent SDK for internal agent tool injection.
 *
 * All tools are always registered regardless of feature flag state. Feature-guarded
 * handlers already return descriptive errors when their service is disabled.
 *
 * @param deps - Service dependencies shared with the internal tool path
 */
export function createExternalMcpServer(deps: McpToolDeps): McpServer {
  const server = new McpServer({
    name: 'dorkos',
    version: '1.0.0',
  });

  // ── Core tools ──────────────────────────────────────────────────────────
  server.tool(
    'ping',
    'Check that the DorkOS server is running. Returns pong with a timestamp.',
    {},
    handlePing,
  );
  server.tool(
    'get_server_info',
    'Returns DorkOS server metadata including version, port, and optionally uptime.',
    {
      include_uptime: z.boolean().optional().describe('Include server uptime in seconds'),
    },
    handleGetServerInfo,
  );
  server.tool(
    'get_session_count',
    'Returns the number of sessions visible in the SDK transcript directory.',
    {},
    createGetSessionCountHandler(deps),
  );
  server.tool(
    'get_current_agent',
    'Get the agent identity for the current working directory. Returns the agent manifest from .dork/agent.json if one exists, or null if no agent is registered.',
    {},
    createGetCurrentAgentHandler(deps),
  );

  // ── Pulse tools ─────────────────────────────────────────────────────────
  server.tool(
    'pulse_list_schedules',
    'List all Pulse scheduled jobs. Returns schedule definitions with status and configuration.',
    {
      enabled_only: z.boolean().optional().describe('Only return enabled schedules'),
    },
    createListSchedulesHandler(deps),
  );
  server.tool(
    'pulse_create_schedule',
    'Create a new Pulse scheduled job. The schedule will be created with pending_approval status and must be approved by the user before it can run.',
    {
      name: z.string().describe('Name for the scheduled job'),
      prompt: z.string().describe('The prompt to send to the agent on each run'),
      cron: z.string().describe('Cron expression (e.g., "0 2 * * *" for daily at 2am)'),
      cwd: z.string().optional().describe('Working directory for the agent'),
      timezone: z.string().optional().describe('IANA timezone (e.g., "America/New_York")'),
      maxRuntime: z.number().optional().describe('Maximum run time in milliseconds'),
      permissionMode: z
        .string()
        .optional()
        .describe('Permission mode: acceptEdits or bypassPermissions'),
    },
    createCreateScheduleHandler(deps),
  );
  server.tool(
    'pulse_update_schedule',
    'Update an existing Pulse schedule. Only provided fields are updated.',
    {
      id: z.string().describe('Schedule ID to update'),
      name: z.string().optional().describe('New name'),
      prompt: z.string().optional().describe('New prompt'),
      cron: z.string().optional().describe('New cron expression'),
      enabled: z.boolean().optional().describe('Enable or disable the schedule'),
      timezone: z.string().optional().describe('New timezone'),
      maxRuntime: z.number().optional().describe('New max runtime in ms'),
      permissionMode: z.string().optional().describe('New permission mode'),
    },
    createUpdateScheduleHandler(deps),
  );
  server.tool(
    'pulse_delete_schedule',
    'Delete a Pulse schedule permanently.',
    {
      id: z.string().describe('Schedule ID to delete'),
    },
    createDeleteScheduleHandler(deps),
  );
  server.tool(
    'pulse_get_run_history',
    'Get recent run history for a Pulse schedule.',
    {
      schedule_id: z.string().describe('Schedule ID to get runs for'),
      limit: z.number().optional().describe('Max runs to return (default 20)'),
    },
    createGetRunHistoryHandler(deps),
  );

  // ── Relay tools ─────────────────────────────────────────────────────────
  server.tool(
    'relay_send',
    'Send a message to a Relay subject. Delivers to all endpoints matching the subject pattern.',
    {
      subject: z.string().describe('Target subject (e.g., "relay.agent.backend")'),
      payload: z.unknown().describe('Message payload (any JSON-serializable value)'),
      from: z.string().describe('Sender subject identifier'),
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
    createRelaySendHandler(deps),
  );
  server.tool(
    'relay_inbox',
    'Read inbox messages for a Relay endpoint. Returns messages delivered to that endpoint.',
    {
      endpoint_subject: z.string().describe('Subject of the endpoint to read inbox for'),
      limit: z.number().int().min(1).max(100).optional().describe('Max messages to return'),
      status: z
        .string()
        .optional()
        .describe(
          'Filter by status. Use "unread" (or "new"/"pending") for unread messages, "read" (or "cur"/"delivered") for processed messages, "failed" for delivery failures. Omit to return all.',
        ),
    },
    createRelayInboxHandler(deps),
  );
  server.tool(
    'relay_list_endpoints',
    'List all registered Relay endpoints. Each endpoint includes subject, hash, maildirPath, ' +
      "registeredAt, type ('dispatch'|'query'|'persistent'|'agent'|'unknown'), and expiresAt " +
      '(ISO timestamp for dispatch endpoints indicating 30-min TTL expiry; null for others).',
    {},
    createRelayListEndpointsHandler(deps),
  );
  server.tool(
    'relay_register_endpoint',
    'Register a new Relay endpoint to receive messages on a subject.',
    {
      subject: z.string().describe('Subject for the new endpoint (e.g., "relay.agent.mybot")'),
      description: z.string().optional().describe('Human-readable description of the endpoint'),
    },
    createRelayRegisterEndpointHandler(deps),
  );
  server.tool(
    'relay_query',
    'Send a message to an agent and WAIT for the reply in a single call. Preferred over relay_send + relay_inbox polling for request/reply patterns. Internally registers an ephemeral inbox, sends the message with replyTo set, and blocks until the target agent replies or the timeout elapses. ' +
      'Response shape: { reply, progress, from, replyMessageId, sentMessageId }. ' +
      'progress: array of intermediate steps emitted before the final reply (empty [] for quick replies; populated for multi-step CCA tasks). ' +
      'Each progress step: { type: "progress", step: number, step_type: "message"|"tool_result", text: string, done: false }. ' +
      'Callers that only use { reply, from, replyMessageId } are unaffected — progress is additive.',
    {
      to_subject: z
        .string()
        .describe('Target subject for the message (e.g., "relay.agent.{agentId}")'),
      payload: z.unknown().describe('Message payload (any JSON-serializable value)'),
      from: z.string().describe('Sender subject identifier'),
      timeout_ms: z
        .number()
        .int()
        .min(1000)
        .max(600000)
        .optional()
        .describe(
          'Max milliseconds to wait for a reply (default: 60000, max: 600000). For tasks longer than 10 min, use relay_dispatch instead.',
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
    createRelayQueryHandler(deps),
  );
  server.tool(
    'relay_dispatch',
    'Dispatch a message to an agent and return IMMEDIATELY with a dispatch inbox subject. ' +
      'Unlike relay_query (which blocks), relay_dispatch returns { messageId, inboxSubject } at once. ' +
      'Agent B runs asynchronously; CCA publishes incremental progress events and a final agent_result ' +
      'to the inbox. Poll relay_inbox(endpoint_subject=inboxSubject) for updates. ' +
      'When you receive a message with done:true, call relay_unregister_endpoint(inboxSubject) to clean up.',
    {
      to_subject: z.string().describe('Target subject (e.g., "relay.agent.{agentId}")'),
      payload: z.unknown().describe('Message payload'),
      from: z.string().describe('Sender subject identifier'),
      budget: z
        .object({
          maxHops: z.number().int().min(1).optional(),
          ttl: z.number().int().optional(),
          callBudgetRemaining: z.number().int().min(0).optional(),
        })
        .optional(),
    },
    createRelayDispatchHandler(deps),
  );
  server.tool(
    'relay_unregister_endpoint',
    'Unregister a Relay endpoint. Use to clean up dispatch inboxes after relay_dispatch completes (when done:true received).',
    {
      subject: z.string().describe('Subject of the endpoint to unregister'),
    },
    createRelayUnregisterEndpointHandler(deps),
  );

  // ── Adapter tools ───────────────────────────────────────────────────────
  server.tool(
    'relay_list_adapters',
    'List all Relay external adapters with their current status (connected, disconnected, error).',
    {},
    createRelayListAdaptersHandler(deps),
  );
  server.tool(
    'relay_enable_adapter',
    'Enable a Relay external adapter by ID. Starts the adapter and persists the change to config.',
    {
      id: z.string().describe('Adapter ID to enable'),
    },
    createRelayEnableAdapterHandler(deps),
  );
  server.tool(
    'relay_disable_adapter',
    'Disable a Relay external adapter by ID. Stops the adapter and persists the change to config.',
    {
      id: z.string().describe('Adapter ID to disable'),
    },
    createRelayDisableAdapterHandler(deps),
  );
  server.tool(
    'relay_reload_adapters',
    'Reload Relay adapter configuration from disk. Hot-reloads adapter state without server restart.',
    {},
    createRelayReloadAdaptersHandler(deps),
  );

  // ── Binding tools ───────────────────────────────────────────────────────
  server.tool(
    'binding_list',
    'List all adapter-to-agent bindings.',
    {},
    createBindingListHandler(deps),
  );
  server.tool(
    'binding_create',
    'Create a new adapter-to-agent binding. Maps an external adapter to a specific agent directory.',
    {
      adapterId: z.string().describe('ID of the adapter to bind'),
      agentId: z.string().describe('Agent ID to route messages to'),
      projectPath: z.string().describe('Filesystem path to the agent working directory'),
      sessionStrategy: z
        .string()
        .optional()
        .describe('Session strategy: per-chat, per-user, or stateless (default per-chat)'),
      chatId: z.string().optional().describe('Optional chat ID for targeted routing'),
      channelType: z
        .string()
        .optional()
        .describe('Optional channel type filter: dm, group, channel, or thread'),
      label: z.string().optional().describe('Optional human-readable label for this binding'),
    },
    createBindingCreateHandler(deps),
  );
  server.tool(
    'binding_delete',
    'Delete an adapter-to-agent binding by ID.',
    {
      id: z.string().describe('Binding UUID to delete'),
    },
    createBindingDeleteHandler(deps),
  );

  // ── Trace tools ─────────────────────────────────────────────────────────
  server.tool(
    'relay_get_trace',
    'Get the full delivery trace for a Relay message. Returns all spans in the trace chain.',
    {
      messageId: z.string().describe('Message ID to look up the trace for'),
    },
    createRelayGetTraceHandler(deps),
  );
  server.tool(
    'relay_get_metrics',
    'Get aggregate delivery metrics for the Relay message bus. Includes counts, latency stats, and budget rejections.',
    {},
    createRelayGetMetricsHandler(deps),
  );

  // ── Mesh tools ──────────────────────────────────────────────────────────
  server.tool(
    'mesh_discover',
    'Scan directories for agent candidates. Returns paths with detected runtime, capabilities, and suggested names.',
    {
      roots: z.array(z.string()).describe('Root directories to scan for agents'),
      maxDepth: z.number().int().min(1).optional().describe('Maximum directory depth (default 3)'),
    },
    createMeshDiscoverHandler(deps),
  );
  server.tool(
    'mesh_register',
    'Register an agent from a filesystem path. Creates a .dork/agent.json manifest and adds the agent to the registry.',
    {
      path: z.string().describe('Filesystem path to the agent directory'),
      name: z.string().optional().describe('Display name override'),
      description: z.string().optional().describe('Agent description'),
      runtime: z.string().optional().describe('Runtime: claude-code, cursor, codex, or other'),
      capabilities: z.array(z.string()).optional().describe('Agent capabilities'),
    },
    createMeshRegisterHandler(deps),
  );
  server.tool(
    'mesh_list',
    'List all registered agents with optional filters.',
    {
      runtime: z.string().optional().describe('Filter by runtime'),
      capability: z.string().optional().describe('Filter by capability'),
      callerNamespace: z.string().optional().describe('Filter by namespace visibility'),
    },
    createMeshListHandler(deps),
  );
  server.tool(
    'mesh_deny',
    'Deny a candidate path from future discovery scans.',
    {
      path: z.string().describe('Path to deny'),
      reason: z.string().optional().describe('Reason for denial'),
    },
    createMeshDenyHandler(deps),
  );
  server.tool(
    'mesh_unregister',
    'Unregister an agent by ID, removing it from the registry.',
    {
      agentId: z.string().describe('Agent ID to unregister'),
    },
    createMeshUnregisterHandler(deps),
  );
  server.tool(
    'mesh_status',
    'Get aggregate mesh health status — total agents, active/inactive/stale counts, by runtime, by project.',
    {},
    createMeshStatusHandler(deps),
  );
  server.tool(
    'mesh_inspect',
    'Inspect a specific agent — manifest, health status, relay endpoint.',
    {
      agentId: z.string().describe('The agent ULID to inspect'),
    },
    createMeshInspectHandler(deps),
  );
  server.tool(
    'mesh_query_topology',
    'Query the agent network topology visible to a given namespace. Returns namespaces, agents, and access rules.',
    {
      namespace: z.string().optional().describe('Caller namespace (omit for admin view)'),
    },
    createMeshQueryTopologyHandler(deps),
  );

  return server;
}
