/**
 * What the `mcp.*` capability domain is built out of: its service bundle, the
 * narrowing helpers every verb starts with, and the input fields they share.
 *
 * Split out of `mcp-capabilities.ts` when the sign-in verbs moved to their own
 * module (DOR-982) — the management verbs and the sign-in verbs are two
 * cohesive groups over ONE dependency bag, and this is the bag.
 *
 * @module services/mesh/mcp-capability-deps
 */
import { z } from 'zod';
import type { AgentRegistry } from '@dorkos/mesh';
import type { McpAppServerConnection } from '@dorkos/shared/agent-runtime';

import type { CapabilityDeps, CapabilityHandlerContext } from '../core/capabilities/index.js';
import { CapabilityToolError } from '../core/capabilities/mcp-envelope.js';
import { AgentMcpServerError, type AgentMcpServerService } from './agent-mcp-server-service.js';
import type { AgentMcpOAuthService } from './agent-mcp-oauth-service.js';

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
export function requireMcpDeps(deps: CapabilityDeps): McpCapabilityDeps {
  if (!deps.mcpDeps) {
    throw new Error('MCP capability invoked without mcpDeps in the registry bag.');
  }
  return deps.mcpDeps;
}

/**
 * Narrow the deps to the OAuth engine, failing with a clear error when a registry
 * that owns the sign-in verbs was composed without one.
 *
 * @param deps - The registry's shared dependency bag.
 * @returns The managed-MCP OAuth engine.
 */
export function requireOAuth(deps: CapabilityDeps): AgentMcpOAuthService {
  const { oauth } = requireMcpDeps(deps);
  if (!oauth) {
    throw new CapabilityToolError({
      error: 'MCP sign-in is not available on this server.',
      code: 'SIGNIN_UNAVAILABLE',
    });
  }
  return oauth;
}

/**
 * Re-raise an {@link AgentMcpServerError} as a {@link CapabilityToolError} so every
 * surface returns the service's own message + code; rethrow anything else as-is.
 *
 * @param err - The error a service call threw.
 */
export function rethrowAsCapabilityError(err: unknown): never {
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
export function resolveAddedBy(context: CapabilityHandlerContext): string {
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
export async function resolveOAuthServerUrl(
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

/** The `agentId` every verb is keyed by. */
export const agentIdField = z
  .string()
  .min(1)
  .describe('The id of the agent whose managed MCP servers this acts on.');

/** The server `name` the mutating verbs target — unique within the agent, never `dorkos`. */
export const serverNameField = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_-]+$/, 'Must be alphanumeric with dashes/underscores')
  .describe('The managed server name, unique within the agent.');

/** `{ agentId, name }` — the shape the single-server verbs share. */
export const AgentServerInput = z.object({ agentId: agentIdField, name: serverNameField });
