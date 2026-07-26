/**
 * The single registration point for the read-only `dorkos://` MCP resources
 * ("what is the state of my world"), shared by BOTH MCP servers.
 *
 * These four resources (`dorkos://sessions`, `dorkos://agents`,
 * `dorkos://skills`, `dorkos://capabilities`, each with a per-id template) used to
 * be registered only on the external `/mcp` server, so every third-party MCP
 * client could ask a running DorkOS what sessions were active and the user's own
 * agent could not. That is the exact inversion the agents-as-operators program
 * exists to fix (spec `agents-as-operators` §Background), so registration lives
 * here, above both servers, and is called by each of them, never duplicated by
 * hand.
 *
 * ## Auth posture
 *
 * The in-session surface is deliberately NOT more restricted than the external
 * one. On `/mcp`, `resources/list` is tokenless and `resources/read` requires the
 * per-instance local token in the login-off posture (`middleware/mcp-auth.ts`),
 * because that surface is reachable over the network by callers DorkOS knows
 * nothing about. In-session tools run IN PROCESS inside a session the user
 * started, with no HTTP hop and therefore no token to present; the caller is
 * structurally the agent whose session it is. Every read here is scoped to that
 * session's own project directory, and every payload is data the same agent can
 * already reach through the `mesh_*` tools, `GET /api/sessions`, or its own
 * filesystem. So there is nothing for an in-session gate to protect.
 *
 * ## `listChanged` is advertised as false
 *
 * The MCP SDK's `registerResource()` unconditionally advertises
 * `resources.listChanged: true` the moment any resource is registered, with no
 * public opt-out. Neither server ever calls `sendResourceListChanged`: the
 * external one is rebuilt per request (it cannot outlive the response it was made
 * for), and the in-session one registers a fixed set that never changes during a
 * query. {@link registerDorkOsResources} therefore corrects the flag to `false`
 * rather than promising a push channel nothing delivers. Resource
 * *subscriptions* are never wired at all, so that capability is never advertised
 * in the first place.
 *
 * @module services/core/mcp-resources
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { McpToolDeps } from '../../runtimes/claude-code/mcp-tools/types.js';
import type { CapabilityRegistry } from '../capabilities/index.js';
import { registerSessionResources } from './session-resources.js';
import { registerAgentResources } from './agent-resources.js';
import { registerSkillResources } from './skill-resources.js';
import { registerCapabilitiesResource } from './capabilities-resource.js';

/**
 * Register every read-only `dorkos://` resource against `server`.
 *
 * Must run BEFORE the server is connected to a transport: registration is what
 * sets the resources capability, and `registerCapabilities` throws once a
 * transport is attached.
 *
 * @param server - The `McpServer` to register against. For the in-session server
 *   this is the `instance` returned by `createSdkMcpServer`.
 * @param deps - Shared MCP tool dependencies (runtime registry, Mesh).
 * @param registry - The composed capability registry, whose catalog backs
 *   `dorkos://capabilities`.
 * @param projectDir - Absolute directory the session and skill reads are scoped
 *   to: the session's own working directory in-session, the server's default
 *   project on the external surface.
 */
export function registerDorkOsResources(
  server: McpServer,
  deps: McpToolDeps,
  registry: CapabilityRegistry,
  projectDir: string
): void {
  registerSessionResources(server, deps, projectDir);
  registerAgentResources(server, deps);
  registerSkillResources(server, projectDir);
  registerCapabilitiesResource(server, registry);

  // Correct the SDK's auto-advertised `listChanged: true`. See the module TSDoc.
  server.server.registerCapabilities({ resources: { listChanged: false } });
}

/**
 * The `dorkos://` URIs {@link registerDorkOsResources} always registers as
 * concrete (listable) resources, in registration order.
 *
 * Exported so a test can assert that both servers expose exactly this set through
 * `resources/list`: the drift guard that keeps the in-session surface from
 * silently falling behind the external one again. The per-id templates
 * (`dorkos://sessions/{id}` and friends) are deliberately absent: each is
 * registered with `list: undefined`, because its parent list resource already
 * enumerates every valid id.
 */
export const DORKOS_RESOURCE_URIS: readonly string[] = [
  'dorkos://sessions',
  'dorkos://agents',
  'dorkos://skills',
  'dorkos://capabilities',
];
