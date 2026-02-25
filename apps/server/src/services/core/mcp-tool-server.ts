import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { TranscriptReader } from '../session/transcript-reader.js';
import type { PulseStore } from '../pulse/pulse-store.js';
import type { RelayCore } from '@dorkos/relay';
import type { AdapterManager } from '../relay/adapter-manager.js';

/**
 * Explicit dependency interface for MCP tool handlers.
 * All service dependencies are typed here and injected at server startup.
 */
export interface McpToolDeps {
  transcriptReader: TranscriptReader;
  /** The default working directory for the server */
  defaultCwd: string;
  /** Optional Pulse store — undefined when Pulse is disabled */
  pulseStore?: PulseStore;
  /** Optional RelayCore — undefined when Relay is disabled */
  relayCore?: RelayCore;
  /** Optional AdapterManager — undefined when Relay adapters are not configured */
  adapterManager?: AdapterManager;
}

/**
 * Ping handler — validates the MCP tool injection pipeline is working.
 * Returns a pong response with timestamp and server identifier.
 */
export async function handlePing() {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          status: 'pong',
          timestamp: new Date().toISOString(),
          server: 'dorkos',
        }),
      },
    ],
  };
}

/**
 * Server info handler — returns DorkOS server metadata.
 * Validates Zod optional fields and env var access from tool handlers.
 */
export async function handleGetServerInfo(args: { include_uptime?: boolean }) {
  const info: Record<string, unknown> = {
    product: 'DorkOS',
    port: process.env.DORKOS_PORT ?? '4242',
    version: process.env.DORKOS_VERSION ?? 'development',
  };
  if (args.include_uptime) {
    info.uptime_seconds = Math.floor(process.uptime());
  }
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(info, null, 2),
      },
    ],
  };
}

/**
 * Session count handler factory — returns the number of sessions from SDK transcripts.
 * Validates the dependency injection pattern needed for future service-dependent tools.
 */
export function createGetSessionCountHandler(deps: McpToolDeps) {
  return async function handleGetSessionCount() {
    try {
      const sessions = await deps.transcriptReader.listSessions(deps.defaultCwd);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              count: sessions.length,
              cwd: deps.defaultCwd,
            }),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              error: err instanceof Error ? err.message : 'Failed to list sessions',
            }),
          },
        ],
        isError: true,
      };
    }
  };
}

/** Helper to return a JSON content block for MCP tool responses. */
function jsonContent(data: unknown, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    ...(isError && { isError: true }),
  };
}

/** Guard that returns an error response when Pulse is disabled. */
function requirePulse(deps: McpToolDeps) {
  if (!deps.pulseStore) {
    return jsonContent({ error: 'Pulse scheduler is not enabled' }, true);
  }
  return null;
}

/** List all Pulse scheduled jobs. */
export function createListSchedulesHandler(deps: McpToolDeps) {
  return async (args: { enabled_only?: boolean }) => {
    const err = requirePulse(deps);
    if (err) return err;
    let schedules = deps.pulseStore!.getSchedules();
    if (args.enabled_only) {
      schedules = schedules.filter((s) => s.enabled);
    }
    return jsonContent({ schedules, count: schedules.length });
  };
}

/** Create a new scheduled job — always sets status to pending_approval. */
export function createCreateScheduleHandler(deps: McpToolDeps) {
  return async (args: {
    name: string;
    prompt: string;
    cron: string;
    cwd?: string;
    timezone?: string;
    maxRuntime?: number;
    permissionMode?: string;
  }) => {
    const err = requirePulse(deps);
    if (err) return err;
    const schedule = deps.pulseStore!.createSchedule({
      name: args.name,
      prompt: args.prompt,
      cron: args.cron,
      cwd: args.cwd ?? null,
      timezone: args.timezone ?? null,
      maxRuntime: args.maxRuntime ?? null,
    });
    // Agent-created schedules always require user approval
    deps.pulseStore!.updateSchedule(schedule.id, { status: 'pending_approval' });
    const updated = deps.pulseStore!.getSchedule(schedule.id);
    return jsonContent({ schedule: updated, note: 'Schedule created with pending_approval status. User must approve before it runs.' });
  };
}

/** Update an existing schedule. */
export function createUpdateScheduleHandler(deps: McpToolDeps) {
  return async (args: {
    id: string;
    name?: string;
    prompt?: string;
    cron?: string;
    enabled?: boolean;
    timezone?: string;
    maxRuntime?: number;
    permissionMode?: string;
  }) => {
    const err = requirePulse(deps);
    if (err) return err;
    const { id, permissionMode, ...rest } = args;
    const updated = deps.pulseStore!.updateSchedule(id, {
      ...rest,
      ...(permissionMode !== undefined && {
        permissionMode: permissionMode as 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions',
      }),
    });
    if (!updated) return jsonContent({ error: `Schedule ${id} not found` }, true);
    return jsonContent({ schedule: updated });
  };
}

/** Delete a schedule. */
export function createDeleteScheduleHandler(deps: McpToolDeps) {
  return async (args: { id: string }) => {
    const err = requirePulse(deps);
    if (err) return err;
    const deleted = deps.pulseStore!.deleteSchedule(args.id);
    if (!deleted) return jsonContent({ error: `Schedule ${args.id} not found` }, true);
    return jsonContent({ success: true, id: args.id });
  };
}

/** Get recent runs for a schedule. */
export function createGetRunHistoryHandler(deps: McpToolDeps) {
  return async (args: { schedule_id: string; limit?: number }) => {
    const err = requirePulse(deps);
    if (err) return err;
    const runs = deps.pulseStore!.listRuns({
      scheduleId: args.schedule_id,
      limit: args.limit ?? 20,
    });
    return jsonContent({ runs, count: runs.length });
  };
}

// --- Relay Tools ---

/** Guard that returns an error response when Relay is disabled. */
function requireRelay(deps: McpToolDeps) {
  if (!deps.relayCore) {
    return jsonContent({ error: 'Relay is not enabled', code: 'RELAY_DISABLED' }, true);
  }
  return null;
}

/** Send a message via Relay. */
export function createRelaySendHandler(deps: McpToolDeps) {
  return async (args: {
    subject: string;
    payload: unknown;
    from: string;
    replyTo?: string;
    budget?: { maxHops?: number; ttl?: number; callBudgetRemaining?: number };
  }) => {
    const err = requireRelay(deps);
    if (err) return err;
    try {
      const result = await deps.relayCore!.publish(args.subject, args.payload, {
        from: args.from,
        replyTo: args.replyTo,
        budget: args.budget,
      });
      return jsonContent({ messageId: result.messageId, deliveredTo: result.deliveredTo });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Publish failed';
      const code = message.includes('Access denied')
        ? 'ACCESS_DENIED'
        : message.includes('Invalid subject')
          ? 'INVALID_SUBJECT'
          : 'PUBLISH_FAILED';
      return jsonContent({ error: message, code }, true);
    }
  };
}

/** Read inbox messages for a Relay endpoint. */
export function createRelayInboxHandler(deps: McpToolDeps) {
  return async (args: { endpoint_subject: string; limit?: number; status?: string }) => {
    const err = requireRelay(deps);
    if (err) return err;
    try {
      const result = deps.relayCore!.readInbox(args.endpoint_subject, {
        limit: args.limit,
        status: args.status,
      });
      return jsonContent({ messages: result.messages, nextCursor: result.nextCursor });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Inbox read failed';
      const code = message.includes('Endpoint not found') ? 'ENDPOINT_NOT_FOUND' : 'INBOX_READ_FAILED';
      return jsonContent({ error: message, code }, true);
    }
  };
}

/** List all registered Relay endpoints. */
export function createRelayListEndpointsHandler(deps: McpToolDeps) {
  return async () => {
    const err = requireRelay(deps);
    if (err) return err;
    const endpoints = deps.relayCore!.listEndpoints();
    return jsonContent({ endpoints, count: endpoints.length });
  };
}

/** Register a new Relay endpoint. */
export function createRelayRegisterEndpointHandler(deps: McpToolDeps) {
  return async (args: { subject: string; description?: string }) => {
    const err = requireRelay(deps);
    if (err) return err;
    try {
      const info = await deps.relayCore!.registerEndpoint(args.subject);
      return jsonContent({ endpoint: info, note: args.description ?? 'Endpoint registered' });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Registration failed';
      const code = message.includes('Invalid subject') ? 'INVALID_SUBJECT' : 'REGISTRATION_FAILED';
      return jsonContent({ error: message, code }, true);
    }
  };
}

// --- Adapter Tools ---

/** Guard that returns an error response when adapters are not available. */
function requireAdapterManager(deps: McpToolDeps) {
  if (!deps.adapterManager) {
    return jsonContent({ error: 'Relay adapters are not enabled', code: 'ADAPTERS_DISABLED' }, true);
  }
  return null;
}

/** List all Relay adapters with their current status. */
export function createRelayListAdaptersHandler(deps: McpToolDeps) {
  return async () => {
    const err = requireAdapterManager(deps);
    if (err) return err;
    const adapters = deps.adapterManager!.listAdapters();
    return jsonContent({ adapters, count: adapters.length });
  };
}

/** Enable a Relay adapter by ID. */
export function createRelayEnableAdapterHandler(deps: McpToolDeps) {
  return async (args: { id: string }) => {
    const err = requireAdapterManager(deps);
    if (err) return err;
    try {
      await deps.adapterManager!.enable(args.id);
      return jsonContent({ ok: true, id: args.id, action: 'enabled' });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Enable failed';
      return jsonContent({ error: message, code: 'ENABLE_FAILED' }, true);
    }
  };
}

/** Disable a Relay adapter by ID. */
export function createRelayDisableAdapterHandler(deps: McpToolDeps) {
  return async (args: { id: string }) => {
    const err = requireAdapterManager(deps);
    if (err) return err;
    try {
      await deps.adapterManager!.disable(args.id);
      return jsonContent({ ok: true, id: args.id, action: 'disabled' });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Disable failed';
      return jsonContent({ error: message, code: 'DISABLE_FAILED' }, true);
    }
  };
}

/** Reload Relay adapter configuration from disk. */
export function createRelayReloadAdaptersHandler(deps: McpToolDeps) {
  return async () => {
    const err = requireAdapterManager(deps);
    if (err) return err;
    try {
      await deps.adapterManager!.reload();
      const adapters = deps.adapterManager!.listAdapters();
      return jsonContent({ ok: true, adapterCount: adapters.length });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Reload failed';
      return jsonContent({ error: message, code: 'RELOAD_FAILED' }, true);
    }
  };
}

/**
 * Create the DorkOS MCP tool server with all registered tools.
 * Called once at server startup. The returned server instance is injected
 * into AgentManager and passed to every SDK query() call.
 */
export function createDorkOsToolServer(deps: McpToolDeps) {
  const handleGetSessionCount = createGetSessionCountHandler(deps);

  const pulseTools = [
    tool(
      'list_schedules',
      'List all Pulse scheduled jobs. Returns schedule definitions with status and configuration.',
      { enabled_only: z.boolean().optional().describe('Only return enabled schedules') },
      createListSchedulesHandler(deps)
    ),
    tool(
      'create_schedule',
      'Create a new Pulse scheduled job. The schedule will be created with pending_approval status and must be approved by the user before it can run.',
      {
        name: z.string().describe('Name for the scheduled job'),
        prompt: z.string().describe('The prompt to send to the agent on each run'),
        cron: z.string().describe('Cron expression (e.g., "0 2 * * *" for daily at 2am)'),
        cwd: z.string().optional().describe('Working directory for the agent'),
        timezone: z.string().optional().describe('IANA timezone (e.g., "America/New_York")'),
        maxRuntime: z.number().optional().describe('Maximum run time in milliseconds'),
        permissionMode: z.string().optional().describe('Permission mode: acceptEdits or bypassPermissions'),
      },
      createCreateScheduleHandler(deps)
    ),
    tool(
      'update_schedule',
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
      createUpdateScheduleHandler(deps)
    ),
    tool(
      'delete_schedule',
      'Delete a Pulse schedule permanently.',
      { id: z.string().describe('Schedule ID to delete') },
      createDeleteScheduleHandler(deps)
    ),
    tool(
      'get_run_history',
      'Get recent run history for a Pulse schedule.',
      {
        schedule_id: z.string().describe('Schedule ID to get runs for'),
        limit: z.number().optional().describe('Max runs to return (default 20)'),
      },
      createGetRunHistoryHandler(deps)
    ),
  ];

  const relayTools = [
    tool(
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
            callBudgetRemaining: z.number().int().min(0).optional().describe('Remaining call budget'),
          })
          .optional()
          .describe('Optional budget constraints'),
      },
      createRelaySendHandler(deps)
    ),
    tool(
      'relay_inbox',
      'Read inbox messages for a Relay endpoint. Returns messages delivered to that endpoint.',
      {
        endpoint_subject: z.string().describe('Subject of the endpoint to read inbox for'),
        limit: z.number().int().min(1).max(100).optional().describe('Max messages to return'),
        status: z.string().optional().describe('Filter by status: new, cur, or failed'),
      },
      createRelayInboxHandler(deps)
    ),
    tool(
      'relay_list_endpoints',
      'List all registered Relay endpoints.',
      {},
      createRelayListEndpointsHandler(deps)
    ),
    tool(
      'relay_register_endpoint',
      'Register a new Relay endpoint to receive messages on a subject.',
      {
        subject: z.string().describe('Subject for the new endpoint (e.g., "relay.agent.mybot")'),
        description: z.string().optional().describe('Human-readable description of the endpoint'),
      },
      createRelayRegisterEndpointHandler(deps)
    ),
  ];

  // Adapter tools — only registered when adapterManager is provided
  const adapterTools = deps.adapterManager
    ? [
        tool(
          'relay_list_adapters',
          'List all Relay external adapters with their current status (connected, disconnected, error).',
          {},
          createRelayListAdaptersHandler(deps)
        ),
        tool(
          'relay_enable_adapter',
          'Enable a Relay external adapter by ID. Starts the adapter and persists the change to config.',
          { id: z.string().describe('Adapter ID to enable') },
          createRelayEnableAdapterHandler(deps)
        ),
        tool(
          'relay_disable_adapter',
          'Disable a Relay external adapter by ID. Stops the adapter and persists the change to config.',
          { id: z.string().describe('Adapter ID to disable') },
          createRelayDisableAdapterHandler(deps)
        ),
        tool(
          'relay_reload_adapters',
          'Reload Relay adapter configuration from disk. Hot-reloads adapter state without server restart.',
          {},
          createRelayReloadAdaptersHandler(deps)
        ),
      ]
    : [];

  return createSdkMcpServer({
    name: 'dorkos',
    version: '1.0.0',
    tools: [
      tool(
        'ping',
        'Check that the DorkOS server MCP integration is working. Returns pong with a timestamp.',
        {},
        handlePing
      ),
      tool(
        'get_server_info',
        'Returns DorkOS server metadata including version, port, and optionally uptime.',
        { include_uptime: z.boolean().optional().describe('Include server uptime in seconds') },
        handleGetServerInfo
      ),
      tool(
        'get_session_count',
        'Returns the number of sessions visible in the SDK transcript directory.',
        {},
        handleGetSessionCount
      ),
      ...pulseTools,
      ...relayTools,
      ...adapterTools,
    ],
  });
}
