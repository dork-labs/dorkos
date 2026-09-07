/**
 * Project registry capabilities into in-session `dorkos` MCP tool definitions
 * (spec `capability-registry`, task 2.2).
 *
 * This is the Claude Agent SDK half of the MCP projection. Ordinary in-session
 * capabilities become the `tools` array passed to `createSdkMcpServer`. The five
 * principal-bound connector capabilities use the real returned `McpServer`
 * instead, because its full-schema registration preserves strict unknown-field
 * rejection that the Agent SDK's raw-shape `tool()` helper would erase. All
 * transport-neutral invocation work still lives in
 * `core/capabilities/mcp-projection.ts`.
 *
 * @module services/runtimes/claude-code/mcp-tools/capability-mcp-tools
 */
import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { searchHintFrom, toolExposure } from './tool-exposure.js';
import type { McpServerId } from '@dorkos/shared/capabilities';

import type {
  CapabilityInvocationContext,
  CapabilityRegistry,
} from '../../../core/capabilities/index.js';
import {
  capabilitiesForMcpServer,
  approvalTokenArgument,
  capabilityInputShape,
  deriveMcpAnnotations,
  invokeCapabilityAsMcpResult,
  type InSessionSurface,
} from '../../../core/capabilities/mcp-projection.js';
import type { CapabilityHoldSession } from '../../../core/capabilities/capability-approval-hold.js';
import type { ApprovalService } from '../../../core/approvals/index.js';
import { CONNECTOR_RUNTIME_CAPABILITY_IDS } from '../../../connectors/runtime-capability-scope.js';

/**
 * The in-session seam: the live session inline cards are rendered into, plus the
 * approval primitive a destructive hold waits on (DOR-939). Absent on the
 * external `/mcp` surface and in tests, which then keep the token/poll flow and
 * draw no cards (DOR-1004).
 */
export interface InSessionCapabilityHold {
  /** The live session whose event queue carries the inline cards. */
  session: CapabilityHoldSession;
  /** The approval primitive — reads the card and waits for the decision. */
  approvals: Pick<ApprovalService, 'awaitDecision' | 'getPending'>;
}

/**
 * Recover the SDK tool call's abort signal from the MCP handler's `extra`, so a
 * mid-turn interrupt ends any in-session hold. Typed `unknown` by the SDK, so it
 * is narrowed defensively — a surface without one simply holds to its own cap.
 */
function abortSignalOf(extra: unknown): AbortSignal | undefined {
  if (extra && typeof extra === 'object' && 'signal' in extra) {
    const signal = (extra as { signal?: unknown }).signal;
    if (signal instanceof AbortSignal) return signal;
  }
  return undefined;
}

/**
 * Build the in-session `dorkos` server tool definitions for every registry
 * capability advertised on the in-session surface.
 *
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
 * @returns SDK tool definitions to spread into `createSdkMcpServer({ tools })`.
 */
export function capabilityMcpTools(
  registry: CapabilityRegistry,
  transport: McpServerId = 'in-session',
  resolveContext?: (
    capabilityId: string,
    signal?: AbortSignal
  ) => Promise<CapabilityInvocationContext | undefined>,
  hold?: InSessionCapabilityHold
) {
  return capabilitiesForMcpServer(registry, transport).map((capability) =>
    tool(
      capability.surfaces.mcp!.toolName,
      capability.description,
      capabilityInputShape(capability),
      async (args: Record<string, unknown>, extra: unknown) => {
        const signal = abortSignalOf(extra);
        const perCall: InSessionSurface | undefined = hold
          ? {
              approvals: hold.approvals,
              session: hold.session,
              ...(signal ? { signal } : {}),
            }
          : undefined;
        return invokeCapabilityAsMcpResult(
          registry,
          capability.id,
          args,
          await resolveContext?.(capability.id, signal),
          perCall
        );
      },
      // The hint comes from the capability's TITLE, not its description: a title
      // is already the curated one-liner ("React to a message") that a search
      // wants, where a description opens with whatever detail it needs to lead
      // with. Hand-registered tools have no title and fall back to their
      // description's first sentence — see `tool-exposure.ts`.
      toolExposure(capability.surfaces.mcp!.toolName, capability.title)
    )
  );
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
 * Register the five principal-bound connector tools on Claude's in-process MCP server.
 *
 * These capabilities deliberately declare no ordinary MCP surface. They are added
 * only when a live Claude agent session owns a turn context, and their full strict
 * Zod schemas are passed to the MCP SDK so unknown owner, agent, session, or provider
 * selectors reach validation instead of being stripped by the Agent SDK's raw-shape
 * `tool()` helper.
 *
 * @param server - The real MCP server returned by `createSdkMcpServer`.
 * @param registry - The composed capability registry containing the exact five ids.
 * @param resolveContext - Per-call resolver that mints the current turn's principal.
 * @param hold - Optional in-session approval hold for destructive execution.
 */
export function registerClaudeConnectorCapabilityTools(
  server: McpServer,
  registry: CapabilityRegistry,
  resolveContext: (
    capabilityId: string,
    signal?: AbortSignal
  ) => Promise<CapabilityInvocationContext | undefined>,
  hold?: InSessionCapabilityHold
): void {
  for (const capabilityId of CONNECTOR_RUNTIME_CAPABILITY_IDS) {
    const capability = registry.get(capabilityId);
    if (!capability) {
      throw new Error(`Connector runtime capability '${capabilityId}' is not registered.`);
    }
    const searchHint = searchHintFrom(capability.title ?? capability.description);
    server.registerTool(
      capability.id,
      {
        description: capability.description,
        inputSchema: strictConnectorInputSchema(registry, capabilityId),
        annotations: deriveMcpAnnotations(capability),
        ...(searchHint ? { _meta: { 'anthropic/searchHint': searchHint } } : {}),
      },
      async (args: Record<string, unknown>, extra: unknown) => {
        const signal = abortSignalOf(extra);
        const perCall: InSessionSurface | undefined = hold
          ? {
              approvals: hold.approvals,
              session: hold.session,
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
}
