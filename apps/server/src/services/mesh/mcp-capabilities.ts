/**
 * The `mcp.*` capability domain (spec `mcp-server-management` §5): the seven
 * agent-facing verbs that let a user (or an agent acting for one) manage the MCP
 * servers a specific agent runs — list, add, update, remove, enable, disable,
 * and test.
 *
 * Every verb is a thin wrapper over {@link AgentMcpServerService}, which owns the
 * manifest CRUD and the trust model (spec §4). The domain declares each verb once
 * and the Capability Registry projects it onto both MCP servers, the `dorkos call
 * mcp.*` CLI path, and the OpenAPI document — with the tier gate enforced once in
 * `registry.invoke`.
 *
 * Trust posture (spec §4): `list` is `observe` (a free read with the read-only
 * carve-out); `add` and `update` are `destructive` because they introduce or
 * change a command that will run in the agent's environment, so a person approves
 * them at a card that shows the exact `command`/`args`/`url` first; `remove`,
 * `enable`, `disable`, and `test` are `act` (no new command is introduced, and
 * `test` only ever probes an already-approved entry).
 *
 * Input is keyed by **agent id**; the service resolves the id to the agent's
 * workspace path and reads/writes its manifest there. A domain error from the
 * service ({@link AgentMcpServerError}) is re-raised as a {@link CapabilityToolError}
 * so every surface reports the same structured `{ error, code }` payload.
 *
 * @module services/mesh/mcp-capabilities
 */
import { z } from 'zod';
import type { AgentRegistry } from '@dorkos/mesh';
import { McpServerTransportSchema, ManagedMcpServerSchema } from '@dorkos/shared/mesh-schemas';

import { defineCapability, type CapabilityDomain } from '../core/capabilities/index.js';
import type { CapabilityDeps, CapabilityHandlerContext } from '../core/capabilities/index.js';
import { CapabilityToolError } from '../core/capabilities/mcp-envelope.js';
import { AgentMcpServerError, type AgentMcpServerService } from './agent-mcp-server-service.js';

/** The service bundle the `mcp.*` capabilities read. */
export interface McpCapabilityDeps {
  /** The single source of truth for the management verbs (spec §2). */
  service: AgentMcpServerService;
  /** The mesh agent registry — the same instance the service resolves workspace paths through. */
  agents: AgentRegistry;
}

/**
 * Extend the shared dependency bag with the MCP domain's service bundle. Optional
 * so a registry composed from other domains alone need not supply it; every
 * `mcp.*` `invoke` narrows through {@link requireMcpDeps}.
 */
declare module '../core/capabilities/capability-definition.js' {
  interface CapabilityDeps {
    /** MCP-server-management service bundle consumed by the `mcp.*` capabilities. */
    mcpDeps?: McpCapabilityDeps;
  }
}

/**
 * Narrow the shared bag to the MCP service bundle, throwing if a registry that
 * owns `mcp.*` capabilities was composed without it (a wiring bug caught at boot).
 *
 * @param deps - The registry's shared dependency bag.
 * @returns The MCP service bundle.
 */
function requireMcpDeps(deps: CapabilityDeps): McpCapabilityDeps {
  if (!deps.mcpDeps) {
    throw new Error('MCP capability invoked without mcpDeps in the registry bag.');
  }
  return deps.mcpDeps;
}

/**
 * Re-raise an {@link AgentMcpServerError} as a {@link CapabilityToolError} so every
 * surface returns the service's own message + code; rethrow anything else as-is.
 *
 * @param err - The error a service call threw.
 */
function rethrowAsCapabilityError(err: unknown): never {
  if (err instanceof AgentMcpServerError) {
    throw new CapabilityToolError({ error: err.message, code: err.code });
  }
  throw err;
}

/**
 * Resolve the audit principal recorded on an added server: the calling agent's
 * path when one presented an identity, otherwise the human operator.
 *
 * @param context - The capability handler context.
 * @returns The `addedBy` value for the manifest entry.
 */
function resolveAddedBy(context: CapabilityHandlerContext): string {
  return context.identity?.agentPath ?? 'operator';
}

/** The `agentId` every verb is keyed by. */
const agentIdField = z
  .string()
  .min(1)
  .describe('The id of the agent whose managed MCP servers this acts on.');

/** The server `name` the mutating verbs target — unique within the agent, never `dorkos`. */
const serverNameField = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_-]+$/, 'Must be alphanumeric with dashes/underscores')
  .describe('The managed server name, unique within the agent.');

/** `{ agentId, name }` — the shape the single-server verbs share. */
const AgentServerInput = z.object({ agentId: agentIdField, name: serverNameField });

/** The updated managed-server list every mutating verb returns. */
const ManagedServerListOutput = z.array(ManagedMcpServerSchema);

/**
 * The card an `add`/`update` approval shows: the transport plus whichever
 * connection fields the chosen transport carries, so a person sees the exact
 * command or URL that will run before approving (spec §4 guarantee 2).
 *
 * These are paths into the parsed INPUT object (`readInputPath` in
 * `approval-summary.ts` walks them from the input directly), so they are
 * `connection.*`, not `input.connection.*` — the spec's `input.` prefix names the
 * input the paths are read from, not a literal first segment.
 */
const CONNECTION_APPROVAL_FIELDS = [
  'connection.transport',
  'connection.command',
  'connection.args',
  'connection.url',
] as const;

/**
 * The `mcp.*` domain: a read (`list`), the two gated command-introducing writes
 * (`add`, `update`), the reversible lifecycle verbs (`remove`, `enable`,
 * `disable`), and the reachability probe (`test`).
 */
export const mcpDomain: CapabilityDomain = {
  name: 'mcp',
  assertDeps: requireMcpDeps,
  capabilities: [
    defineCapability({
      id: 'mcp.list',
      title: 'List an agent’s managed MCP servers',
      description:
        'List the MCP servers DorkOS manages for an agent, each with its transport, enabled ' +
        'state, and audit record. A free read — use it before add/update/remove to see what is ' +
        'already configured.',
      tier: 'observe',
      input: z.object({ agentId: agentIdField }),
      output: ManagedServerListOutput,
      surfaces: {
        mcp: {
          toolName: 'mcp_list_server',
          servers: ['in-session', 'external'],
          readOnlyCarveOut: true,
          annotations: { idempotentHint: true },
        },
        http: { method: 'get', path: '/api/agents/{agentId}/mcp-servers' },
      },
      invoke: async (deps, input) => {
        const { service } = requireMcpDeps(deps);
        try {
          return await service.list(input.agentId);
        } catch (err) {
          rethrowAsCapabilityError(err);
        }
      },
    }),
    defineCapability({
      id: 'mcp.add',
      title: 'Add a managed MCP server to an agent',
      description:
        'Add an MCP server to an agent and enable it. This introduces a command (stdio) or ' +
        'remote endpoint (http/sse) that will run in the agent’s environment, so a person ' +
        'approves it first at a card showing the exact command/args/url. Rejects the reserved ' +
        'name "dorkos" and any name the agent already uses.',
      tier: 'destructive',
      input: z.object({
        agentId: agentIdField,
        name: serverNameField,
        connection: McpServerTransportSchema.describe('How to reach the server (stdio/http/sse).'),
        enabled: z
          .boolean()
          .optional()
          .describe('Whether the server is enabled on add. Defaults to enabled (spec §4).'),
      }),
      output: ManagedServerListOutput,
      approvalDisplayFields: CONNECTION_APPROVAL_FIELDS,
      surfaces: {
        mcp: { toolName: 'mcp_add_server', servers: ['in-session', 'external'] },
        http: { method: 'post', path: '/api/agents/{agentId}/mcp-servers' },
      },
      invoke: async (deps, input, context) => {
        const { service } = requireMcpDeps(deps);
        try {
          return await service.add({
            agentId: input.agentId,
            name: input.name,
            connection: input.connection,
            addedBy: resolveAddedBy(context),
            ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
          });
        } catch (err) {
          rethrowAsCapabilityError(err);
        }
      },
    }),
    defineCapability({
      id: 'mcp.update',
      title: 'Update a managed MCP server',
      description:
        'Change a managed server’s connection and/or enabled state. Changing the connection ' +
        'introduces a new command/endpoint, so it is approved at a card showing the exact ' +
        'command/args/url, exactly like add.',
      tier: 'destructive',
      input: z.object({
        agentId: agentIdField,
        name: serverNameField,
        connection: McpServerTransportSchema.optional().describe(
          'Replacement connection. Omit to leave the connection unchanged.'
        ),
        enabled: z.boolean().optional().describe('New enabled state. Omit to leave it unchanged.'),
      }),
      output: ManagedServerListOutput,
      approvalDisplayFields: CONNECTION_APPROVAL_FIELDS,
      surfaces: {
        mcp: {
          toolName: 'mcp_update_server',
          servers: ['in-session', 'external'],
          annotations: { idempotentHint: true },
        },
        http: { method: 'patch', path: '/api/agents/{agentId}/mcp-servers/{name}' },
      },
      invoke: async (deps, input) => {
        const { service } = requireMcpDeps(deps);
        try {
          return await service.update({
            agentId: input.agentId,
            name: input.name,
            ...(input.connection ? { connection: input.connection } : {}),
            ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
          });
        } catch (err) {
          rethrowAsCapabilityError(err);
        }
      },
    }),
    defineCapability({
      id: 'mcp.remove',
      title: 'Remove a managed MCP server',
      description:
        'Remove a managed server from an agent. Reversible by adding it again (which re-prompts ' +
        'for approval).',
      tier: 'act',
      input: AgentServerInput,
      output: ManagedServerListOutput,
      surfaces: {
        mcp: { toolName: 'mcp_remove_server', servers: ['in-session', 'external'] },
        http: { method: 'delete', path: '/api/agents/{agentId}/mcp-servers/{name}' },
      },
      invoke: async (deps, input) => {
        const { service } = requireMcpDeps(deps);
        try {
          return await service.remove(input.agentId, input.name);
        } catch (err) {
          rethrowAsCapabilityError(err);
        }
      },
    }),
    defineCapability({
      id: 'mcp.enable',
      title: 'Enable a managed MCP server',
      description:
        'Enable a managed server so it is injected into the agent’s next session. No new ' +
        'command is introduced (it was approved at add), so no approval is needed.',
      tier: 'act',
      input: AgentServerInput,
      output: ManagedServerListOutput,
      surfaces: {
        mcp: {
          toolName: 'mcp_enable_server',
          servers: ['in-session', 'external'],
          annotations: { idempotentHint: true },
        },
        http: { method: 'post', path: '/api/agents/{agentId}/mcp-servers/{name}/enable' },
      },
      invoke: async (deps, input) => {
        const { service } = requireMcpDeps(deps);
        try {
          return await service.enable(input.agentId, input.name);
        } catch (err) {
          rethrowAsCapabilityError(err);
        }
      },
    }),
    defineCapability({
      id: 'mcp.disable',
      title: 'Disable a managed MCP server',
      description:
        'Disable a managed server, removing it from future session injection while keeping its ' +
        'already-approved configuration on the manifest.',
      tier: 'act',
      input: AgentServerInput,
      output: ManagedServerListOutput,
      surfaces: {
        mcp: {
          toolName: 'mcp_disable_server',
          servers: ['in-session', 'external'],
          annotations: { idempotentHint: true },
        },
        http: { method: 'post', path: '/api/agents/{agentId}/mcp-servers/{name}/disable' },
      },
      invoke: async (deps, input) => {
        const { service } = requireMcpDeps(deps);
        try {
          return await service.disable(input.agentId, input.name);
        } catch (err) {
          rethrowAsCapabilityError(err);
        }
      },
    }),
    defineCapability({
      id: 'mcp.test',
      title: 'Test a managed MCP server',
      description:
        'Probe whether a managed server is reachable and how many tools it exposes. Safe by ' +
        'construction: it only ever connects to an already-approved entry, so it cannot run an ' +
        'arbitrary command and bypass add’s gate. A failure is reported in-band.',
      tier: 'act',
      input: AgentServerInput,
      output: z.object({
        ok: z.boolean().describe('Whether the server connected and listed its tools.'),
        toolCount: z.number().optional().describe('How many tools it exposes, when reachable.'),
        error: z.string().optional().describe('The failure reason, when unreachable.'),
      }),
      surfaces: {
        mcp: {
          toolName: 'mcp_test_server',
          servers: ['in-session', 'external'],
          annotations: { idempotentHint: true, openWorldHint: true },
        },
        http: { method: 'post', path: '/api/agents/{agentId}/mcp-servers/{name}/test' },
      },
      invoke: async (deps, input) => {
        const { service } = requireMcpDeps(deps);
        try {
          return await service.test(input.agentId, input.name);
        } catch (err) {
          rethrowAsCapabilityError(err);
        }
      },
    }),
  ],
};
