/**
 * The `mcp.*` capability domain (spec `mcp-server-management` §5): the eight
 * agent-facing verbs that let a user (or an agent acting for one) manage the MCP
 * servers a specific agent runs — list, add, import, update, remove, enable,
 * disable, and test.
 *
 * Every verb is a thin wrapper over {@link AgentMcpServerService}, which owns the
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
import type { AgentRegistry } from '@dorkos/mesh';
import {
  McpServerTransportSchema,
  ManagedMcpServerSchema,
  ManagedMcpServerViewSchema,
} from '@dorkos/shared/mesh-schemas';
import type { McpAppServerConnection } from '@dorkos/shared/agent-runtime';

import { defineCapability, type CapabilityDomain } from '../core/capabilities/index.js';
import type { CapabilityDeps, CapabilityHandlerContext } from '../core/capabilities/index.js';
import { CapabilityToolError } from '../core/capabilities/mcp-envelope.js';
import { AgentMcpServerError, type AgentMcpServerService } from './agent-mcp-server-service.js';
import { mcpOAuthCustodyDisclosure, type AgentMcpOAuthService } from './agent-mcp-oauth-service.js';

/** The service bundle the `mcp.*` capabilities read. */
export interface McpCapabilityDeps {
  /** The single source of truth for the management verbs (spec §2). */
  service: AgentMcpServerService;
  /** The mesh agent registry — the same instance the service resolves workspace paths through. */
  agents: AgentRegistry;
  /**
   * The managed-MCP OAuth engine backing `mcp.signin`/`mcp.poll_signin` (DOR-942).
   * Optional so a registry composed without it still exposes the management verbs;
   * a sign-in call with it absent fails with a clear "sign-in unavailable" error.
   */
  oauth?: AgentMcpOAuthService;
  /**
   * Fallback connection resolver for `mcp.import`, used only when the agent's
   * workspace `.mcp.json` cannot resolve the named server. Boot wires it to the
   * runtime's `getMcpServerConfig`; omitted in tests, which exercise the
   * `.mcp.json` path directly.
   */
  resolveDiscoveredFallback?: (agentId: string, name: string) => McpAppServerConnection | null;
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

/**
 * Resolve the remote URL of a managed server that can take an OAuth sign-in: it
 * must exist on the agent, and it must be an http/sse (remote) transport — a
 * stdio server has no OAuth endpoint. Errors are the caller-facing
 * {@link CapabilityToolError} shape.
 *
 * @param service - The managed-server service (resolves the agent + its servers).
 * @param agentId - The agent whose server is being signed into.
 * @param name - The managed server's name.
 * @returns The server's remote URL.
 */
async function resolveOAuthServerUrl(
  service: AgentMcpServerService,
  agentId: string,
  name: string
): Promise<string> {
  let servers;
  try {
    servers = await service.list(agentId);
  } catch (err) {
    rethrowAsCapabilityError(err);
  }
  const server = servers.find((s) => s.name === name);
  if (!server) {
    throw new CapabilityToolError({
      error: `Agent ${agentId} has no managed MCP server named "${name}".`,
      code: 'SERVER_NOT_FOUND',
    });
  }
  if (server.connection.transport === 'stdio') {
    throw new CapabilityToolError({
      error: `"${name}" is a local (stdio) server, which has no OAuth sign-in.`,
      code: 'NOT_OAUTH_SERVER',
    });
  }
  return server.connection.url;
}

/**
 * Narrow the deps to the OAuth engine, failing with a clear error when a registry
 * that owns `mcp.signin`/`mcp.poll_signin` was composed without one.
 *
 * @param deps - The registry's shared dependency bag.
 * @returns The managed-MCP OAuth engine.
 */
function requireOAuth(deps: CapabilityDeps): AgentMcpOAuthService {
  const { oauth } = requireMcpDeps(deps);
  if (!oauth) {
    throw new CapabilityToolError({
      error: 'MCP sign-in is not available on this server.',
      code: 'SIGNIN_UNAVAILABLE',
    });
  }
  return oauth;
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
        'connection.authKind "oauth2", the server needs a sign-in: call mcp_signin for it ' +
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
    defineCapability({
      id: 'mcp.signin',
      title: 'Start OAuth sign-in for a managed MCP server',
      description:
        'Begin signing in to an OAuth-protected managed server. In a DorkOS conversation the ' +
        'sign-in card is shown to the user automatically — say ONE short line naming what you ' +
        'are connecting, then stop. Do not repeat the link or the disclosure, do not ask the ' +
        'user to tell you when they are done, and do not call mcp_poll_signin: you are brought ' +
        'back automatically once the sign-in lands, with the server named and its tools ready. ' +
        'On surfaces with no card the result’s message field carries the link and the custody ' +
        'disclosure instead — show BOTH verbatim there. DorkOS obtains and refreshes the token ' +
        'for you either way.',
      // `act`, not `destructive`: the operator already approved this server at
      // `mcp.add` (a command-diff gate). Sign-in introduces no new command — it
      // only stores a token for a server that is already trusted — so it needs no
      // second approval, exactly like connector.start_connect.
      tier: 'act',
      input: AgentServerInput,
      output: z.object({
        flowId: z.string().describe('The sign-in flow id to pass to mcp_poll_signin.'),
        authorizeUrl: z
          .string()
          .optional()
          .describe('The sign-in link to open; absent when the server was already connected.'),
        alreadyConnected: z
          .boolean()
          .describe('True when a live token already existed, so no browser step is needed.'),
        disclosure: z.string().describe('The custody disclosure to show verbatim before the link.'),
        message: z.string().describe('Ready-to-render markdown carrying the link and disclosure.'),
      }),
      surfaces: {
        mcp: {
          toolName: 'mcp_signin',
          servers: ['in-session', 'external'],
          annotations: { openWorldHint: true },
        },
      },
      // In a conversation the link and the disclosure belong on a card, not in
      // the agent's prose (DOR-1004). The in-session projection draws it and
      // rewrites `message` accordingly; every sessionless surface never reaches
      // that code and keeps the full link-carrying markdown below.
      inSessionCard: 'signin',
      invoke: async (deps, input) => {
        const { service } = requireMcpDeps(deps);
        const oauth = requireOAuth(deps);
        const serverUrl = await resolveOAuthServerUrl(service, input.agentId, input.name);
        const disclosure = mcpOAuthCustodyDisclosure(input.name);
        let started;
        try {
          started = await oauth.startSignin({
            agentId: input.agentId,
            serverName: input.name,
            serverUrl,
          });
        } catch (err) {
          throw new CapabilityToolError({
            error: err instanceof Error ? err.message : 'Could not start the sign-in.',
          });
        }
        // Getting this far means the provider's OAuth discovery answered, so the
        // server really is OAuth-protected — record it, so the row keeps offering
        // a sign-in after a restart even before any turn runs (DOR-985). The
        // sign-in itself is what the caller asked for, so a failed write is
        // reported and shrugged off rather than failing the call.
        await service.learnOAuthAuthKind(input.agentId, input.name).catch((err: unknown) => {
          deps.logger.warn(
            `[mcp.signin] could not record authKind for "${input.name}": ${
              err instanceof Error ? err.message : String(err)
            }`
          );
          return false;
        });
        const message = started.alreadyConnected
          ? `You’re already signed in to ${input.name}. ${disclosure}`
          : `[Sign in to ${input.name}](${started.authorizeUrl})\n\n${disclosure}\n\n` +
            `Tell me when you’ve signed in, then I’ll check.`;
        return {
          flowId: started.flowId,
          ...(started.authorizeUrl ? { authorizeUrl: started.authorizeUrl } : {}),
          alreadyConnected: started.alreadyConnected,
          disclosure,
          message,
        };
      },
    }),
    defineCapability({
      id: 'mcp.poll_signin',
      title: 'Check an MCP sign-in flow',
      description:
        'Check whether an MCP sign-in the user was sent to complete has finished. Returns ' +
        'pending, connected, or failed. Call after the user says they have signed in; once ' +
        'connected, the server’s tools are injected on the next turn. When it returns a ' +
        'toolCount, tell the user what they just unlocked — "Connected — 12 tools." — and ' +
        'say plain "Connected." when no count came back (absent means uncounted, not zero).',
      tier: 'act',
      input: z.object({
        flowId: z.string().min(1).describe('The flow id from mcp_signin.'),
      }),
      output: z.object({
        status: z
          .enum(['pending', 'connected', 'failed'])
          .describe('Whether the sign-in is still waiting, done, or failed.'),
        error: z.string().optional().describe('The failure reason, when the status is failed.'),
        toolCount: z
          .number()
          .optional()
          .describe('How many tools the server exposes, counted once the sign-in connected.'),
      }),
      surfaces: {
        mcp: {
          toolName: 'mcp_poll_signin',
          servers: ['in-session', 'external'],
          annotations: { idempotentHint: true, openWorldHint: true },
        },
      },
      // A terminal answer here retires the conversation's sign-in card, for the
      // path where the agent — not the person's own browser tab — is what
      // learns the sign-in landed (DOR-1004).
      inSessionCard: 'signin_resolved',
      invoke: async (deps, input) => {
        const oauth = requireOAuth(deps);
        return oauth.pollSignin(input.flowId);
      },
    }),
  ],
};
