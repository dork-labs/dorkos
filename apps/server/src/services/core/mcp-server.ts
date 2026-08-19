import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpToolDeps } from '../runtimes/claude-code/mcp-tools/types.js';
import { resolveSenderIdentity } from '../runtimes/claude-code/mcp-tools/relay-helpers.js';
import { registerCoreTools } from './external-mcp/core-tools.js';
import { registerTaskTools } from './external-mcp/task-tools.js';
import { registerRelayTools } from './external-mcp/relay-tools.js';
import { registerBindingTools } from './external-mcp/binding-tools.js';
import { registerMeshTools } from './external-mcp/mesh-tools.js';
import { registerAgentAndExtensionTools } from './external-mcp/agent-extension-tools.js';
import { registerDorkOsResources } from './mcp-resources/index.js';
import type { MarketplaceMcpDeps } from '../marketplace-mcp/marketplace-mcp-tools.js';
import { registerCapabilitiesAsMcpTools } from './external-mcp/capability-mcp-tools.js';
import { composeDorkOsCapabilityRegistry } from './self-description/dorkos-registry.js';
import type { CapabilityRegistry } from './capabilities/index.js';
import type { AgentIdentity } from './agent-identity/agent-identity-service.js';
import { logger } from '../../lib/logger.js';
import { SERVER_ICONS } from './mcp-tool-metadata.js';
import { gatedToolRegistrar } from './mcp-tool-gate.js';

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
 * Every tool is registered via `registerTool()` (not the deprecated `tool()`
 * overloads) so it carries `ToolAnnotations` (`readOnlyHint`,
 * `destructiveHint`, `idempotentHint`, `openWorldHint`) — see
 * `mcp-tool-metadata.ts` for the annotation presets and the PR description
 * for the full per-tool matrix. Registration itself is split by domain into
 * `external-mcp/*.ts` (core, tasks, relay, binding, mesh, agent+extension) so
 * this file stays a thin composer rather than a 700+ line registration
 * dispatch table. A handful of read/list tools with an exact existing Zod
 * schema also declare `outputSchema` and return matching `structuredContent`
 * (via `structuredJsonContent()` in the shared handlers).
 *
 * The operator, marketplace, and self-description tool surfaces are generated
 * from the Capability Registry: {@link registerCapabilitiesAsMcpTools} walks the
 * registry once and registers every capability advertised on the `external`
 * server (operator + marketplace + `list_capabilities`). The registry is either
 * the shared boot-composed one passed in `registry`, or — when omitted, e.g. in
 * unit tests — composed on the spot from `deps` and `marketplaceDeps` via
 * {@link composeDorkOsCapabilityRegistry}. The marketplace surface is included
 * only when `marketplaceDeps` is present, so a relay-disabled instance simply
 * omits those capabilities from the registry (and thus the tool list).
 *
 * The read-only `dorkos://` resources (sessions, agents, skills, capabilities)
 * come from {@link registerDorkOsResources}, the SAME call the in-session tool
 * server makes (`services/core/mcp-resources/`), so neither surface can drift
 * ahead of the other. That module also documents the auth posture and why
 * `resources.listChanged` is advertised as `false`; this server is stateless per
 * request (a fresh `McpServer` per `/mcp` call, see the router in `index.ts`), so
 * it could never deliver such a push anyway.
 *
 * @param deps - Service dependencies shared with the internal tool path
 * @param marketplaceDeps - Optional marketplace dependency bundle. When
 *   provided, the marketplace capabilities join the registry (and the tool list).
 * @param registry - The shared boot-composed capability registry. When omitted
 *   (unit tests), one is composed on the spot from `deps` + `marketplaceDeps`.
 * @param identity - The calling agent's resolved identity, when the request
 *   carried an `X-DorkOS-Agent` token. This server is rebuilt per request, so
 *   the identity is captured by every capability tool handler it registers and
 *   the resulting invocations are attributed to that agent.
 * @param userId - The signed-in person behind the call, when the surface
 *   verified one. Its ABSENCE is a distinct fact from "the owner".
 * @param agentIdentityPresented - Whether an `X-DorkOS-Agent` header was there
 *   at all, resolved or not. Carried SEPARATELY from `identity` because a
 *   revoked or expired token leaves that empty while still meaning a machine is
 *   calling — see `CapabilityInvocationContext.agentIdentityPresented`
 *   (DOR-1361).
 */
export function createExternalMcpServer(
  deps: McpToolDeps,
  marketplaceDeps?: MarketplaceMcpDeps,
  registry?: CapabilityRegistry,
  identity?: AgentIdentity,
  userId?: string,
  agentIdentityPresented?: boolean
): McpServer {
  const server = new McpServer({
    name: 'dorkos',
    version: '1.0.0',
    icons: SERVER_ICONS,
  });

  // The external /mcp surface has no per-session context, so every relay send
  // acts as a single, server-controlled external principal — the LLM never
  // asserts its own `from`.
  const relayIdentity = resolveSenderIdentity(deps, undefined);

  // Every hand-registered tool goes on through the gated registrar, never onto
  // `server` directly: that is what puts the permission tier in front of each one
  // (DOR-468). The per-domain functions take a `ToolRegistrar`, so a new domain
  // file has nothing ungated to register against.
  const registrar = gatedToolRegistrar(server, identity);
  registerCoreTools(registrar, deps);
  registerTaskTools(registrar, deps);
  registerRelayTools(registrar, deps, relayIdentity);
  registerBindingTools(registrar, deps);
  registerMeshTools(registrar, deps);
  registerAgentAndExtensionTools(registrar, deps);

  // ── Registry-backed tools (operator + marketplace + self-description) ─────
  const capabilityRegistry =
    registry ??
    composeDorkOsCapabilityRegistry({
      logger,
      operatorDeps: deps,
      ...(marketplaceDeps && { marketplaceDeps }),
    });
  // All three facts ride, and the absence of each is a fact too: a capability
  // that acts on somebody's own data reads `userId` to know WHICH person is
  // asking, and reads its absence as "this surface could name nobody" rather
  // than as "the owner" (see `CapabilityInvocationContext.userId`).
  //
  // `agentIdentityPresented` is in the guard as well as in the object, and that
  // is the whole of DOR-1361 on this surface: a revoked agent presents a token
  // that resolves to nothing and signs in as nobody, so it produced neither of
  // the other two facts and the context collapsed to `undefined` — leaving
  // `callerAuthor` to answer with the install owner.
  const caller =
    identity || userId || agentIdentityPresented
      ? {
          ...(identity ? { identity } : {}),
          ...(agentIdentityPresented ? { agentIdentityPresented } : {}),
          ...(userId ? { userId } : {}),
        }
      : undefined;
  registerCapabilitiesAsMcpTools(server, capabilityRegistry, 'external', caller);

  // ── Read-only resources ──────────────────────────────────────────────────
  // Same call the in-session server makes. This surface has no per-request `cwd`
  // to key on, so reads are scoped to the server's own default project.
  registerDorkOsResources(server, deps, capabilityRegistry, deps.defaultCwd);

  return server;
}
