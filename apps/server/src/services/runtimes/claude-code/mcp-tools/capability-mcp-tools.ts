/**
 * Project registry capabilities into in-session `dorkos` MCP tool definitions
 * (spec `capability-registry`, task 2.2).
 *
 * This is the Claude Agent SDK half of the MCP projection. Ordinary in-session
 * capabilities and principal-bound connector capabilities register full objects
 * on the real `McpServer` returned by `createSdkMcpServer`, retaining strict
 * unknown-field rejection and object refinements. All
 * transport-neutral invocation work still lives in
 * `core/capabilities/mcp-projection.ts`.
 *
 * @module services/runtimes/claude-code/mcp-tools/capability-mcp-tools
 */
import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { searchHintFrom, toolExposure } from './tool-exposure.js';
import type { ToolSurfaceEntry } from './tool-surface.js';
import type { McpServerId } from '@dorkos/shared/capabilities';

import type {
  CapabilityInvocationContext,
  CapabilityRegistry,
} from '../../../core/capabilities/index.js';
import {
  capabilitiesForMcpServer,
  approvalTokenArgument,
  capabilityMcpInputObject,
  deriveMcpAnnotations,
  invokeCapabilityAsMcpResult,
  type InSessionSurface,
} from '../../../core/capabilities/mcp-projection.js';
import type { CapabilityHoldSession } from '../../../core/capabilities/capability-approval-hold.js';
import type { ApprovalService } from '../../../core/approvals/index.js';
import { CONNECTOR_RUNTIME_CAPABILITY_IDS } from '../../../connectors/runtime-capability-scope.js';
import { abortSignalOf } from '../../../core/capabilities/index.js';

/**
 * The in-session seam: the live session inline cards are rendered into, plus the
 * approval primitive a destructive hold waits on (DOR-939). Absent on the
 * external `/mcp` surface and in tests, which then keep the token/poll flow and
 * draw no cards (DOR-1004).
 */
export interface InSessionCapabilityHold {
  /** The live session whose event queue carries the inline cards. */
  session: CapabilityHoldSession;
  /**
   * The approval primitive — reads the card, waits for the decision, and owns the
   * single-delivery claim while it waits (spec `approval-verdict-delivery`).
   */
  approvals: Pick<
    ApprovalService,
    'awaitDecision' | 'getPending' | 'claimVerdictDelivery' | 'releaseVerdictDelivery'
  >;
  /**
   * Whether nobody can answer a card inside the current turn, read per call
   * (spec `agent-permissions` D6). Handed on to the hold, which then does not.
   */
  unattended?: () => boolean;
}

/**
 * Register full input objects on the in-session `dorkos` server for every registry
 * capability advertised on the in-session surface.
 *
 * @param server - The real MCP server returned by `createSdkMcpServer`.
 * @param registry - The composed capability registry.
 * @param transport - Which server's tool surface to project (defaults to
 *   `in-session`).
 * @param resolveContext - Optional resolver for the invocation context, awaited
 *   per tool call and told the exact capability id plus call signal. This
 *   surface has no request to read a token from, so the
 *   caller's identity is derived from the session instead (see
 *   `createInSessionContextResolver`); the resolver memoizes, so many tool calls
 *   in one session cost one lookup. Omitted in tests and introspection paths,
 *   which then invoke unattributed exactly as before.
 * @param hold - Optional in-session seam (DOR-939, DOR-1004). When present, a
 *   fresh destructive ask HOLDS inline awaiting the operator's decision and
 *   resumes on a grant, and a capability declaring `inSessionCard` draws its card
 *   in the conversation. Omitted on the external `/mcp` surface and in tests,
 *   which keep the token/poll flow and draw no cards. A per-call
 *   {@link InSessionSurface} is assembled from it plus the SDK abort signal on
 *   each invocation.
 * @param alwaysLoaded - The session's eager-loading set (see `tool-exposure.ts`).
 *   An agent session passes the wider set, so the capability-projected
 *   agent-to-agent tools (`chat_send`, `chat_read`) load from turn 1 there just
 *   as the hand-registered ones do. Defaults to the standing set.
 * @param hiddenToolNames - Tools omitted before registration.
 * @returns The exact registered schemas for the complete tool-surface digest.
 */
export function registerClaudeCapabilityTools(
  server: McpServer,
  registry: CapabilityRegistry,
  transport: McpServerId = 'in-session',
  resolveContext?: (
    capabilityId: string,
    signal?: AbortSignal
  ) => Promise<CapabilityInvocationContext | undefined>,
  hold?: InSessionCapabilityHold,
  alwaysLoaded?: ReadonlySet<string>,
  hiddenToolNames: ReadonlySet<string> = new Set()
): ToolSurfaceEntry[] {
  const registered: ToolSurfaceEntry[] = [];
  for (const capability of capabilitiesForMcpServer(registry, transport)) {
    const name = capability.surfaces.mcp!.toolName;
    if (hiddenToolNames.has(name)) continue;
    const inputSchema = capabilityMcpInputObject(capability);
    // Let the SDK encode its own loading metadata; this descriptor is never
    // registered. The full object, not its raw shape, crosses registration.
    const exposure = tool(
      name,
      capability.description,
      {},
      async () => ({ content: [] }),
      toolExposure(name, capability.title, alwaysLoaded)
    );
    server.registerTool(
      name,
      {
        description: capability.description,
        inputSchema,
        ...(exposure._meta ? { _meta: exposure._meta } : {}),
      },
      async (args: Record<string, unknown>, extra: unknown) => {
        const signal = abortSignalOf(extra);
        const perCall: InSessionSurface | undefined = hold
          ? {
              approvals: hold.approvals,
              session: hold.session,
              ...(hold.unattended ? { unattended: hold.unattended } : {}),
              ...(signal ? { signal } : {}),
            }
          : undefined;
        return invokeCapabilityAsMcpResult(
          registry,
          capability.id,
          args,
          // The server this tool list belongs to rides along, so the request
          // tool reaches only what this surface lists (spec D8).
          { ...(await resolveContext?.(capability.id, signal)), mcpServer: transport },
          perCall
        );
      }
    );
    registered.push({ name, description: capability.description, inputSchema });
  }
  return registered;
}

function strictConnectorInputSchema(registry: CapabilityRegistry, capabilityId: string) {
  const capability = registry.get(capabilityId);
  if (!capability || !(capability.input instanceof z.ZodObject)) {
    throw new Error(`Connector runtime capability '${capabilityId}' has no object input schema.`);
  }
  return capability.tier === 'destructive'
    ? capability.input.extend(approvalTokenArgument())
    : capability.input;
}

/**
 * Register the principal-bound connector tools on Claude's in-process MCP server.
 *
 * These capabilities deliberately declare no ordinary MCP surface. They are added
 * only when a live Claude agent session owns a turn context, and their full strict
 * Zod schemas are passed to the MCP SDK so unknown owner, agent, session, or provider
 * selectors reach validation instead of being stripped by the Agent SDK's raw-shape
 * `tool()` helper.
 *
 * @param server - The real MCP server returned by `createSdkMcpServer`.
 * @param registry - The composed capability registry containing the runtime capability ids.
 * @param resolveContext - Per-call resolver that mints the current turn's principal.
 * @param hold - Optional in-session approval hold for destructive execution.
 * @returns Each registered tool as the server's tool-surface digest reads it
 *   (`tool-surface.ts`).
 */
export function registerClaudeConnectorCapabilityTools(
  server: McpServer,
  registry: CapabilityRegistry,
  resolveContext: (
    capabilityId: string,
    signal?: AbortSignal
  ) => Promise<CapabilityInvocationContext | undefined>,
  hold?: InSessionCapabilityHold
): ToolSurfaceEntry[] {
  const registered: ToolSurfaceEntry[] = [];
  for (const capabilityId of CONNECTOR_RUNTIME_CAPABILITY_IDS) {
    const capability = registry.get(capabilityId);
    if (!capability) {
      throw new Error(`Connector runtime capability '${capabilityId}' is not registered.`);
    }
    const searchHint = searchHintFrom(capability.title ?? capability.description);
    const inputSchema = strictConnectorInputSchema(registry, capabilityId);
    registered.push({ name: capability.id, description: capability.description, inputSchema });
    server.registerTool(
      capability.id,
      {
        description: capability.description,
        inputSchema,
        annotations: deriveMcpAnnotations(capability),
        ...(searchHint ? { _meta: { 'anthropic/searchHint': searchHint } } : {}),
      },
      async (args: Record<string, unknown>, extra: unknown) => {
        const signal = abortSignalOf(extra);
        const perCall: InSessionSurface | undefined = hold
          ? {
              approvals: hold.approvals,
              session: hold.session,
              ...(hold.unattended ? { unattended: hold.unattended } : {}),
              ...(signal ? { signal } : {}),
            }
          : undefined;
        return invokeCapabilityAsMcpResult(
          registry,
          capability.id,
          args,
          await resolveContext(capability.id, signal),
          perCall
        );
      }
    );
  }
  return registered;
}
