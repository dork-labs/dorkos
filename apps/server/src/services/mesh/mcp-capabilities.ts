/**
 * The `mcp.*` capability domain (spec `mcp-server-management` §5): the eight
 * agent-facing verbs that let a user (or an agent acting for one) manage the MCP
 * servers a specific agent runs — list, add, import, update, remove, enable,
 * disable, and test — plus the sign-in verbs, which are declared next door in
 * `mcp-signin-capabilities.ts` and spread in here.
 *
 * Every verb is a thin wrapper over `AgentMcpServerService`, which owns the
 * manifest CRUD and the trust model (spec §4). The domain declares each verb once
 * and the Capability Registry projects it onto both MCP servers, the `dorkos call
 * mcp.*` CLI path, and the OpenAPI document — with the tier gate enforced once in
 * `registry.invoke`.
 *
 * Trust posture (spec §4): `list` is `observe` (a free read with the read-only
 * carve-out); `add`, `import`, and `update` are `destructive` because they
 * introduce or change a command that will run in the agent's environment, so a
 * person approves them first (`add`/`update` at a card that shows the exact
 * `command`/`args`/`url`; `import` promotes an existing `.mcp.json` server, so
 * its card names the agent and server being brought under management); `remove`,
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
import {
  McpServerTransportSchema,
  ManagedMcpServerSchema,
  ManagedMcpServerViewSchema,
} from '@dorkos/shared/mesh-schemas';

import { defineCapability, type CapabilityDomain } from '../core/capabilities/index.js';
import {
  AgentServerInput,
  agentIdField,
  requireMcpDeps,
  rethrowAsCapabilityError,
  resolveAddedBy,
  serverNameField,
} from './mcp-capability-deps.js';
import { mcpSigninCapabilities } from './mcp-signin-capabilities.js';

/** The updated managed-server list every mutating verb returns. */
const ManagedServerListOutput = z.array(ManagedMcpServerSchema);

/**
 * What `mcp.list` returns: the same entries plus the derived `authStatus`. Only
 * the read carries it — a mutating verb reports what it wrote, and `authStatus`
 * is never written.
 */
const ManagedServerViewListOutput = z.array(ManagedMcpServerViewSchema);

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
 * The `mcp.*` domain: a read (`list`), the gated command-introducing writes
 * (`add`, `import`, `update`), the reversible lifecycle verbs (`remove`,
 * `enable`, `disable`), and the reachability probe (`test`).
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
        'state, audit record, and — for a remote server — whether DorkOS holds a live sign-in ' +
        'for it (authStatus). A free read — use it before add/update/remove to see what is ' +
        'already configured.',
      tier: 'observe',
      input: z.object({ agentId: agentIdField }),
      output: ManagedServerViewListOutput,
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
        'name "dorkos" and any name the agent already uses. If the added entry comes back with ' +
        'connection.authKind "oauth2", the server needs a sign-in: call the MCP sign-in tool ' +
        'for it ' +
        'immediately, in the same turn, rather than asking permission first — the person ' +
        'already approved this endpoint at the card above, and nothing leaves this machine ' +
        'until they open the sign-in link. Its tools are live on the next turn once they ' +
        'finish.',
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
      id: 'mcp.import',
      title: 'Import a discovered MCP server into DorkOS management',
      description:
        'Bring a server DorkOS discovered in a project’s .mcp.json under DorkOS management: ' +
        'resolve its transport, then add it as an enabled, editable managed server. Routed ' +
        'through the same approval gate as add, because the imported entry will run in the ' +
        'agent’s environment. Rejects the reserved name "dorkos" and any name already managed; ' +
        'reports a clear error when no such discovered server can be resolved.',
      tier: 'destructive',
      input: z.object({ agentId: agentIdField, name: serverNameField }),
      output: ManagedServerListOutput,
      // The card names the AGENT and the discovered SERVER being promoted — not
      // connection.* like `add`. The connection is resolved server-side, AFTER
      // the gate runs, and stdio command/env are never sent to a caller, so no
      // `connection.*` value exists in the pre-gate input to render (it would
      // read "not set"). Naming what the operator actually decides — "promote
      // this .mcp.json server they already have" — is the honest card. Unlike
      // add, import introduces no new command: the entry already runs under the
      // bare CLI from the project's own .mcp.json.
      approvalDisplayFields: ['agentId', 'name'],
      surfaces: {
        mcp: { toolName: 'mcp_import_server', servers: ['in-session', 'external'] },
        http: { method: 'post', path: '/api/agents/{agentId}/mcp-servers/{name}/import' },
      },
      invoke: async (deps, input, context) => {
        const { service, resolveDiscoveredFallback } = requireMcpDeps(deps);
        try {
          return await service.import({
            agentId: input.agentId,
            name: input.name,
            addedBy: resolveAddedBy(context),
            ...(resolveDiscoveredFallback
              ? { resolveFallback: () => resolveDiscoveredFallback(input.agentId, input.name) }
              : {}),
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
        'Change a managed server’s transport and/or enabled state. Changing the transport ' +
        'introduces a new command/endpoint, so it is approved at a card showing the exact ' +
        'command/args/url, exactly like add.',
      tier: 'destructive',
      input: z.object({
        agentId: agentIdField,
        name: serverNameField,
        connection: McpServerTransportSchema.optional().describe(
          'Replacement transport. Omit to leave the server’s transport unchanged.'
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
        'Enable a managed server so its tools are injected on the agent’s next turn — no ' +
        'restart, a server enabled mid-conversation is live on the next message. No new ' +
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
        'Disable a managed server, removing its tools from the next turn’s injection while ' +
        'keeping its already-approved configuration on the manifest.',
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
        'arbitrary command and bypass add’s gate. A failure is reported in-band; an OAuth ' +
        'server that needs sign-in reports needsAuth so the caller can offer mcp.signin.',
      tier: 'act',
      input: AgentServerInput,
      output: z.object({
        ok: z.boolean().describe('Whether the server connected and listed its tools.'),
        toolCount: z.number().optional().describe('How many tools it exposes, when reachable.'),
        error: z.string().optional().describe('The failure reason, when unreachable.'),
        needsAuth: z
          .boolean()
          .optional()
          .describe('True when the probe failed with a 401 and the server needs OAuth sign-in.'),
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
    ...mcpSigninCapabilities,
  ],
};
